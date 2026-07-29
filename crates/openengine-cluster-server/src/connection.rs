//! Transport-neutral per-connection request, admission, and subscription core shared by wire
//! bindings.

pub(crate) mod admission;
pub(crate) mod agent_attach;
pub(crate) mod dispatch;
pub(crate) mod logs;
pub(crate) mod subscription;

pub(crate) use dispatch::{
    dispatch_classified_request, new_connection_setup, shutdown_connection, ConnectionSetup,
    DispatchCtx, RequestDispatch, ShutdownArgs,
};

use admission::InFlightIds;

use std::collections::HashMap;
use std::future::Future;
use std::sync::Arc;

use openengine_cluster_protocol::{
    DomainErrorData, EventNotification, JsonRpcNotification, RequestId,
    SubscriptionClosedNotification, SubscriptionId, WatchParams, INVALID_PARAMS, JSON_RPC_VERSION,
    SCHEMA_VIOLATION,
};
use parking_lot::Mutex;
use serde_json::Value;
use tokio::sync::{mpsc, Notify};

use crate::watch::{WatchEventStream, WatchHandle, WatchStreamItem};
use crate::{serialize_backend_error, serialize_error, serialize_success, ClusterBackend, Dispatcher};

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

/// A decoded request classified for the shared connection multiplexer. `Passthrough` carries the
/// request id when the input was a well-formed non-subscription request, so the connection can
/// apply duplicate-in-flight-id detection to ordinary unary methods; it is `None` for malformed
/// inputs or notifications, which [`Dispatcher::dispatch`] handles on its own.
pub(crate) enum RequestKind {
    Watch { id: RequestId, params: Value },
    Logs { id: RequestId, params: Value },
    AgentAttach { id: RequestId, params: Value },
    Cancel(SubscriptionId),
    Passthrough { id: Option<RequestId> },
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
    subscription::run_established_subscription(established, channels, move |item| {
        Some(match item {
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
            .expect("event notification serialization must succeed"),
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
            .expect("subscription closed notification serialization must succeed"),
        })
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
