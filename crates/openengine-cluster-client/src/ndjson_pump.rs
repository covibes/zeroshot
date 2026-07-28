//! Non-blocking pumped-message routing shared by every transport's response pump
//! ([`NdjsonTransport`](crate::NdjsonTransport)'s NDJSON-line pump and
//! [`WebSocketTransport`](crate::websocket::WebSocketTransport)'s `Message::Text`-frame pump):
//! resolving a unary response's pending oneshot (registering a freshly minted subscription's
//! channel first, so no `event` racing the response can be missed), or forwarding a `watch`/
//! `logs`/`agent_attach` notification to its already-registered subscription channel.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use openengine_cluster_protocol::{RequestId, SubscriptionId};
use serde_json::Value;
use tokio::sync::mpsc;

use super::{
    PendingMap, PumpedResponse, PumpedSubscription, SubscriptionMap, SubscriptionRegistration,
    SUBSCRIPTION_QUEUE_CAPACITY,
};

/// Decodes and routes one pumped line: a notification is forwarded live (see
/// [`forward_notification`]); a unary response resolves its pending oneshot, registering a
/// freshly minted subscription's channel first when the response is a successful `watch`-shaped
/// result carrying `result.subscriptionId`. Malformed JSON, a notification/response with no
/// resolvable identity, or an unknown/already-resolved request id are silently dropped -- the
/// same permissive handling `run_pump` always applied inline before this was extracted. Returns
/// the subscription id the caller must write a `subscription/cancel` for, exactly like
/// [`forward_notification`], when a live notification could not be delivered.
pub(super) fn route_pumped_message(
    line: String,
    pending: &PendingMap,
    subscriptions: &SubscriptionMap,
) -> Option<SubscriptionId> {
    let Ok(value) = serde_json::from_str::<Value>(&line) else {
        return None;
    };
    if value.get("method").is_some() {
        return forward_notification(&value, line, subscriptions);
    }
    let id = value.get("id").and_then(RequestId::from_json_value)?;
    let sender = pending.lock().remove(&id)?;
    let subscription = value
        .get("result")
        .and_then(|result| result.get("subscriptionId"))
        .and_then(Value::as_str)
        .map(|subscription_id| {
            let (sender, receiver) = mpsc::channel(SUBSCRIPTION_QUEUE_CAPACITY);
            let overflowed = Arc::new(AtomicBool::new(false));
            subscriptions.lock().insert(
                SubscriptionId::new(subscription_id),
                SubscriptionRegistration {
                    sender,
                    overflowed: Arc::clone(&overflowed),
                },
            );
            PumpedSubscription {
                receiver,
                overflowed,
            }
        });
    let _ = sender.send(PumpedResponse { line, subscription });
    None
}

/// Forwards one `event`/`subscription/closed` notification without waiting on a consumer.
/// Returns the subscription id when the local receiver is full or gone and the server must be
/// cancelled. A full receiver retains its buffered events; once drained, the stream emits one
/// local `SLOW_CONSUMER` close from its exact last caller-delivered cursor.
pub(super) fn forward_notification(
    value: &Value,
    line: String,
    subscriptions: &SubscriptionMap,
) -> Option<SubscriptionId> {
    let subscription_id = value
        .get("params")
        .and_then(|params| params.get("subscriptionId"))
        .and_then(Value::as_str)?;
    let subscription_id = SubscriptionId::new(subscription_id);
    let terminal = value.get("method").and_then(Value::as_str) == Some("subscription/closed");
    let registration = subscriptions.lock().get(&subscription_id).cloned()?;

    match registration.sender.try_send(line) {
        Ok(()) => {
            if terminal {
                subscriptions.lock().remove(&subscription_id);
            }
            None
        }
        Err(mpsc::error::TrySendError::Full(_)) => {
            registration.overflowed.store(true, Ordering::Release);
            subscriptions.lock().remove(&subscription_id);
            (!terminal).then_some(subscription_id)
        }
        Err(mpsc::error::TrySendError::Closed(_)) => {
            subscriptions.lock().remove(&subscription_id);
            (!terminal).then_some(subscription_id)
        }
    }
}
