//! `logs` subscription NDJSON streaming and dispatch, split out from `stdio.rs` to keep that
//! file's `watch` counterpart readable -- mirrors `run_watch_subscription`/`dispatch_watch`
//! exactly, sharing the same generic `subscriptions` cancellation map and outbound queue, since
//! `logs` reuses the identical wire notification methods and cancellation framing.

use openengine_cluster_protocol::{
    DomainErrorData, JsonRpcNotification, LogEventNotification, LogsClosedNotification, LogsParams,
    RequestId, SubscriptionId, INVALID_PARAMS, JSON_RPC_VERSION, SCHEMA_VIOLATION,
};
use serde_json::Value;

use super::subscription::{run_bounded_event_subscription, BoundedEventSubscriptionRequest};
use super::ConnectionState;
use crate::logs::{LogEventStream, LogsHandle};
use crate::{serialize_backend_error, serialize_error, serialize_success, ClusterBackend, Dispatcher};

/// Establishes a `logs` subscription and, on success, streams its `event`/`subscription/closed`
/// notifications until the stream ends (overflow, backend close, or cancellation). See
/// `run_watch_subscription` for the identical registration-ordering and cancellation-race notes
/// [`run_bounded_event_subscription`] mirrors. Reused verbatim by the sibling `websocket`
/// transport module.
pub(crate) async fn run_logs_subscription<B>(
    dispatcher: Dispatcher<B>,
    id: RequestId,
    params: Value,
    state: ConnectionState,
) where
    B: ClusterBackend,
{
    let (response, established) = dispatcher.dispatch_logs(id.clone(), params).await;
    run_bounded_event_subscription(
        BoundedEventSubscriptionRequest {
            id,
            response,
            established,
            state,
        },
        |subscription_id, record| {
            serde_json::to_string(&JsonRpcNotification {
                jsonrpc: JSON_RPC_VERSION.to_owned(),
                method: "event".to_owned(),
                params: LogEventNotification {
                    subscription_id,
                    record,
                },
            })
        },
        |subscription_id, reason| {
            serde_json::to_string(&JsonRpcNotification {
                jsonrpc: JSON_RPC_VERSION.to_owned(),
                method: "subscription/closed".to_owned(),
                params: LogsClosedNotification {
                    subscription_id,
                    reason,
                },
            })
        },
    )
    .await;
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
