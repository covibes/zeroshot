//! Transport-neutral per-connection request, admission, and subscription core shared by wire
//! bindings.

pub(crate) mod admission;
pub(crate) mod agent_attach;
pub(crate) mod dispatch;
mod frame;
pub(crate) mod logs;
pub(crate) mod native_v2;
pub(crate) mod subscription;

pub(crate) use dispatch::{
    dispatch_classified_request, new_connection_setup, shutdown_connection, ConnectionSetup,
    DispatchCtx, RequestDispatch, ShutdownArgs,
};
pub(crate) use frame::DecodedFrame;

use admission::InFlightIds;

use std::collections::HashMap;
use std::future::Future;
use std::sync::Arc;

use openengine_cluster_protocol::{
    DomainErrorData, EventNotification, JsonRpcNotification, RequestId,
    SubscriptionClosedNotification, SubscriptionId, WatchParams, INVALID_PARAMS, INVALID_REQUEST,
    JSON_RPC_VERSION, SCHEMA_VIOLATION,
};
use parking_lot::Mutex;
use serde_json::Value;
use tokio::sync::{mpsc, Notify};

use crate::method_registry::SubscriptionKind;
use crate::watch::{WatchEventStream, WatchHandle, WatchStreamItem};
use crate::{serialize_backend_error, serialize_error, serialize_success, ClusterBackend, Dispatcher};

/// A JSON-RPC request after transport framing and envelope decoding, but before method lookup or
/// typed parameter decoding.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct DecodedRequest {
    pub(crate) id: RequestId,
    pub(crate) method: String,
    pub(crate) params: Value,
}

impl DecodedRequest {
    pub(crate) fn decode(input: &str) -> Result<Self, String> {
        DecodedFrame::decode(input).and_then(|frame| Self::from_value(frame.into_value()))
    }

    pub(crate) fn from_value(value: Value) -> Result<Self, String> {
        let Value::Object(mut object) = value else {
            return Err(serialize_error(
                None,
                INVALID_REQUEST,
                "Invalid Request",
                None,
            ));
        };

        if object.remove("jsonrpc") != Some(Value::String(JSON_RPC_VERSION.to_owned())) {
            return Err(serialize_error(
                None,
                INVALID_REQUEST,
                "Invalid Request",
                None,
            ));
        }
        let Some(Value::String(method)) = object.remove("method") else {
            return Err(serialize_error(
                None,
                INVALID_REQUEST,
                "Invalid Request",
                None,
            ));
        };
        let Some(id_value) = object.remove("id") else {
            return Err(serialize_error(
                None,
                INVALID_REQUEST,
                "Invalid Request",
                None,
            ));
        };
        let Some(id) = RequestId::from_json_value(&id_value) else {
            return Err(serialize_error(
                None,
                INVALID_REQUEST,
                "Invalid Request",
                None,
            ));
        };

        Ok(Self {
            id,
            method,
            params: object.remove("params").unwrap_or(Value::Null),
        })
    }
}

/// Per-subscription cancellation signal: notifying it wakes `run_watch_subscription`'s streaming
/// loop immediately, even while parked awaiting the next live event, instead of relying solely on
/// `WatchEventStream`'s own cancelled flag, which is only re-checked at the top of `next()` and so
/// never observed on an idle run once the task is parked inside `next_live`'s
/// `receiver.recv().await`.
pub(crate) type SubscriptionMap = Arc<Mutex<HashMap<SubscriptionId, Arc<Notify>>>>;

/// Per-connection state shared by every spawned request/subscription task: the outbound write
/// queue and the tracking maps used for cancellation and duplicate-id rejection. Shared verbatim
/// by each wire binding so they drive the exact same subscription-establishment and cancellation
/// machinery.
#[derive(Clone)]
pub(crate) struct ConnectionState {
    pub(crate) outbound_tx: mpsc::Sender<String>,
    pub(crate) subscriptions: SubscriptionMap,
    pub(crate) in_flight_ids: InFlightIds,
}

/// Races `next` against `cancel`, `biased` toward the cancellation so a `subscription/cancel` that
/// arrives while parked awaiting the next live event wakes the loop immediately instead of only
/// being observed the next time the stream is polled -- which never happens again on an idle run.
/// `biased` also ensures a pending cancellation is never starved by an unbounded run of
/// already-buffered stream items. Shared by `run_watch_subscription`,
/// `subscription::run_bounded_event_subscription`, and every binding's subscription runner.
pub(crate) async fn race_cancel_or_next<T>(
    cancel: &Notify,
    next: impl Future<Output = Option<T>>,
) -> Option<T> {
    tokio::select! {
        biased;
        () = cancel.notified() => None,
        item = next => item,
    }
}

/// A decoded passthrough result. Envelope failures are pre-encoded so they can retain the legacy
/// admission boundary without reparsing the frame in a dispatcher task.
pub(crate) enum DecodedOutcome {
    Request(DecodedRequest),
    Response(String),
}

/// A decoded request classified for the shared connection multiplexer.
pub(crate) enum RequestKind {
    Subscription {
        kind: SubscriptionKind,
        id: RequestId,
        params: Value,
    },
    Cancel(SubscriptionId),
    Passthrough {
        admission_id: Option<RequestId>,
        outcome: DecodedOutcome,
    },
}

/// Establishes a `watch` subscription and, on success, streams its `event`/`subscription/closed`
/// notifications until the stream ends (overflow, backend close, or cancellation), via
/// `subscription::run_established_subscription` -- the same shared establish/loop/cleanup
/// `subscription::run_bounded_event_subscription` uses. The established [`WatchHandle`] is kept
/// alive for the duration purely to hold its backing flag false: dropping it early would trip
/// [`WatchEventStream`]'s own cancellation check before anything ever streams.
pub(crate) async fn run_watch_subscription<B>(
    dispatcher: Dispatcher<B>,
    id: RequestId,
    params: Value,
    state: ConnectionState,
) where
    B: ClusterBackend,
{
    let ConnectionState {
        outbound_tx,
        subscriptions,
        in_flight_ids,
    } = state;
    let (response, established) = dispatcher.dispatch_watch(id.clone(), params).await;
    in_flight_ids.lock().remove(&id);
    let channels = subscription::SubscriptionChannels {
        outbound_tx,
        subscriptions,
    };
    let Some((established, _handle)) =
        subscription::establish_subscription(&channels, response, established).await
    else {
        return;
    };

    let encode_subscription_id = established.subscription_id.clone();
    subscription::run_established_subscription(established, channels, move |item| match item {
        WatchStreamItem::Record(record) => serde_json::to_string(&JsonRpcNotification {
            jsonrpc: JSON_RPC_VERSION.to_owned(),
            method: "event".to_owned(),
            params: EventNotification {
                subscription_id: encode_subscription_id.clone(),
                run_id: record.run_id,
                cursor: record.cursor,
                event: record.event,
            },
        })
        .ok(),
        WatchStreamItem::Closed {
            reason,
            last_delivered_cursor,
        } => serde_json::to_string(&JsonRpcNotification {
            jsonrpc: JSON_RPC_VERSION.to_owned(),
            method: "subscription/closed".to_owned(),
            params: SubscriptionClosedNotification {
                subscription_id: encode_subscription_id.clone(),
                reason,
                last_delivered_cursor,
            },
        })
        .ok(),
    })
    .await;
}

impl<B> Dispatcher<B>
where
    B: ClusterBackend,
{
    /// Connection-core counterpart to [`Dispatcher::dispatch`] for the `watch` method: returns the
    /// response frame plus, on success, the minted subscription identity and stream/handle to
    /// register for event fan-out. Never called from [`Dispatcher::dispatch`] since `watch` is a
    /// subscription establishment method, not a plain unary one.
    pub(crate) async fn dispatch_watch(
        &self,
        id: RequestId,
        params: Value,
    ) -> (
        String,
        Option<(SubscriptionId, WatchEventStream, WatchHandle)>,
    ) {
        let params = match serde_json::from_value::<WatchParams>(params) {
            Ok(params) => params,
            Err(_) => {
                return (
                    serialize_error(
                        Some(id),
                        INVALID_PARAMS,
                        "Invalid params",
                        Some(DomainErrorData::new(SCHEMA_VIOLATION)),
                    ),
                    None,
                );
            }
        };
        match self.watch(params).await {
            Ok((result, stream, handle)) => {
                let subscription_id = result.subscription_id.clone();
                (
                    serialize_success(id, result),
                    Some((subscription_id, stream, handle)),
                )
            }
            Err(error) => (serialize_backend_error(id, error), None),
        }
    }
}

#[cfg(test)]
mod tests;
