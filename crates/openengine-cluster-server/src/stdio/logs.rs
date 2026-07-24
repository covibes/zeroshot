//! `logs` subscription NDJSON streaming and dispatch, split out from `stdio.rs` to keep that
//! file's `watch` counterpart readable -- mirrors `run_watch_subscription`/`dispatch_watch`
//! exactly, sharing the same generic `subscriptions` cancellation map and outbound queue, since
//! `logs` reuses the identical wire notification methods and cancellation framing.

use std::sync::Arc;

use openengine_cluster_protocol::{
    DomainErrorData, JsonRpcNotification, LogEventNotification, LogsClosedNotification, LogsParams,
    RequestId, SubscriptionId, INVALID_PARAMS, JSON_RPC_VERSION, SCHEMA_VIOLATION,
};
use serde_json::Value;
use tokio::sync::Notify;

use super::ConnectionState;
use crate::logs::{LogEventStream, LogStreamItem, LogsHandle};
use crate::{serialize_backend_error, serialize_error, serialize_success, ClusterBackend, Dispatcher};

/// Establishes a `logs` subscription and, on success, streams its `event`/`subscription/closed`
/// notifications until the stream ends (overflow, backend close, or cancellation). See
/// `run_watch_subscription` for the identical registration-ordering and cancellation-race notes
/// this mirrors.
pub(super) async fn run_logs_subscription<B>(
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
    let (response, established) = dispatcher.dispatch_logs(id.clone(), params).await;
    in_flight_ids.lock().remove(&id);
    let Some((subscription_id, mut stream, _handle)) = established else {
        let _ = outbound_tx.send(response).await;
        return;
    };
    let cancel = Arc::new(Notify::new());
    // Register before sending the response: see `run_watch_subscription`'s identical ordering
    // note -- a `subscription/cancel` racing in during a backpressured response send must always
    // find the subscription already cancellable.
    subscriptions
        .lock()
        .insert(subscription_id.clone(), Arc::clone(&cancel));
    if outbound_tx.send(response).await.is_err() {
        subscriptions.lock().remove(&subscription_id);
        return;
    }

    loop {
        // See `run_watch_subscription`'s identical `select!` for why this is `biased` on `cancel`.
        let item = tokio::select! {
            biased;
            () = cancel.notified() => None,
            item = stream.next() => item,
        };
        let Some(item) = item else {
            break;
        };
        let encoded = match item {
            LogStreamItem::Record(record) => serde_json::to_string(&JsonRpcNotification {
                jsonrpc: JSON_RPC_VERSION.to_owned(),
                method: "event".to_owned(),
                params: LogEventNotification {
                    subscription_id: subscription_id.clone(),
                    record,
                },
            }),
            LogStreamItem::Closed { reason } => serde_json::to_string(&JsonRpcNotification {
                jsonrpc: JSON_RPC_VERSION.to_owned(),
                method: "subscription/closed".to_owned(),
                params: LogsClosedNotification {
                    subscription_id: subscription_id.clone(),
                    reason,
                },
            }),
        };
        // A bounded oversized/unserializable event (e.g. driven by a pathologically large
        // backend-supplied subscription id) must never panic the server task -- drop it and end
        // only this subscription through the existing cleanup below, never falling back to an
        // unbounded or raw wire representation.
        let notification = match encoded {
            Ok(line) => line,
            Err(_) => break,
        };
        if outbound_tx.send(notification).await.is_err() {
            break;
        }
    }
    subscriptions.lock().remove(&subscription_id);
}

impl<B> Dispatcher<B>
where
    B: ClusterBackend,
{
    /// NDJSON-only counterpart to [`Dispatcher::dispatch`] for the `logs` method. Mirrors
    /// [`Dispatcher::dispatch_watch`] exactly; only the Rust param/result types differ.
    pub(crate) async fn dispatch_logs(
        &self,
        id: RequestId,
        params: Value,
    ) -> (String, Option<(SubscriptionId, LogEventStream, LogsHandle)>) {
        let params = match serde_json::from_value::<LogsParams>(params) {
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
        match self.logs(params).await {
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
