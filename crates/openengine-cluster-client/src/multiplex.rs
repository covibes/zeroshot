//! Shared request/subscription demultiplexing machinery, implemented once and reused verbatim by
//! [`crate::NdjsonTransport`] (NDJSON lines) and [`crate::websocket::WebSocketTransport`]
//! (`Message::Text` frames) so both wire bindings drive this crate's [`crate::JsonRpcTransport`]/
//! [`crate::SubscriptionTransport`] methods through identical code regardless of frame shape.

use std::collections::hash_map::Entry;
use std::sync::atomic::{AtomicU64, Ordering};

use async_trait::async_trait;
use openengine_cluster_protocol::{
    CancelRequestParams, JsonRpcNotification, RequestId, SubscriptionCancelParams, SubscriptionId,
    JSON_RPC_VERSION,
};
use tokio::sync::oneshot;
use tokio::task::JoinHandle;

use crate::ndjson_pump::route_pumped_message;
use crate::{
    extract_request_id, JsonRpcTransport, PendingMap, PumpedResponse, PumpedSubscription,
    SubscriptionMap, SubscriptionTransport, TransportError,
};

/// Abstraction over "write one already-serialized JSON-RPC frame to the peer", implemented once
/// per wire transport ([`crate::NdjsonFrameSink`], [`crate::websocket::WebSocketFrameSink`]) so
/// the demultiplexing logic below is implemented exactly once regardless of the underlying frame
/// shape (NDJSON line vs. `Message::Text`).
#[async_trait]
pub(crate) trait FrameSink: Send + Sync {
    async fn send_frame(&self, frame: String) -> Result<(), TransportError>;
}

/// Registers `id` as pending, writes `request`, and awaits its demultiplexed response. Shared body
/// of `NdjsonTransport::send_request` and `WebSocketTransport::send_request`.
pub(crate) async fn send_request<F: FrameSink>(
    sink: &F,
    pending: &PendingMap,
    request: String,
    id: RequestId,
) -> Result<PumpedResponse, TransportError> {
    let (sender, receiver) = oneshot::channel();
    {
        let mut pending = pending.lock();
        match pending.entry(id.clone()) {
            Entry::Vacant(entry) => {
                entry.insert(sender);
            }
            Entry::Occupied(_) => {
                return Err(TransportError::Protocol(format!(
                    "request id is already pending: {id:?}"
                )));
            }
        }
    }
    if let Err(error) = sink.send_frame(request).await {
        pending.lock().remove(&id);
        return Err(error);
    }
    receiver.await.map_err(|_| {
        TransportError::Protocol("server closed the connection before responding".to_owned())
    })
}

/// Shared body of both transports' [`crate::JsonRpcTransport::request`] impl.
pub(crate) async fn request<F: FrameSink>(
    sink: &F,
    pending: &PendingMap,
    request: String,
) -> Result<String, TransportError> {
    let id = extract_request_id(&request)?;
    Ok(send_request(sink, pending, request, id).await?.line)
}

/// Shared body of both transports' [`crate::SubscriptionTransport::open_subscription`] impl.
pub(crate) async fn open_subscription<F: FrameSink>(
    sink: &F,
    pending: &PendingMap,
    request: String,
    id: RequestId,
) -> Result<(String, Option<PumpedSubscription>), TransportError> {
    let response = send_request(sink, pending, request, id).await?;
    Ok((response.line, response.subscription))
}

/// Shared body of both transports' [`crate::SubscriptionTransport::cancel_subscription`] impl.
pub(crate) async fn cancel_subscription<F: FrameSink>(
    sink: &F,
    subscription_id: SubscriptionId,
) -> Result<(), TransportError> {
    let notification = serde_json::to_string(&JsonRpcNotification {
        jsonrpc: JSON_RPC_VERSION.to_owned(),
        method: "subscription/cancel".to_owned(),
        params: SubscriptionCancelParams { subscription_id },
    })
    .map_err(|error| TransportError::Protocol(error.to_string()))?;
    sink.send_frame(notification).await
}

/// Shared body of both transports' [`crate::SubscriptionTransport::cancel_request`] impl.
pub(crate) async fn cancel_request<F: FrameSink>(
    sink: &F,
    id: RequestId,
) -> Result<(), TransportError> {
    let notification = serde_json::to_string(&JsonRpcNotification {
        jsonrpc: JSON_RPC_VERSION.to_owned(),
        method: "$/cancelRequest".to_owned(),
        params: CancelRequestParams { id },
    })
    .map_err(|error| TransportError::Protocol(error.to_string()))?;
    sink.send_frame(notification).await
}

/// Shared body of both transports' [`crate::SubscriptionTransport::next_watch_request_id`] impl.
pub(crate) fn next_watch_id(counter: &AtomicU64) -> RequestId {
    RequestId::String(format!("watch-{}", counter.fetch_add(1, Ordering::Relaxed)))
}

/// Routes one decoded message body via [`route_pumped_message`] and, if it named a subscription
/// whose local queue has overflowed or been abandoned, best-effort sends its cancellation --
/// shared by both transports' pump loops.
pub(crate) async fn route_and_maybe_cancel<F: FrameSink>(
    line: String,
    pending: &PendingMap,
    subscriptions: &SubscriptionMap,
    sink: &F,
) {
    if let Some(subscription_id) = route_pumped_message(line, pending, subscriptions) {
        let _ = cancel_subscription(sink, subscription_id).await;
    }
}

/// Fails every still-pending request and ends every open subscription (dropping its sender) once
/// a pump's read half ends -- shared tail of both transports' pump loops.
pub(crate) fn finish_pump(pending: &PendingMap, subscriptions: &SubscriptionMap) {
    for (_, sender) in pending.lock().drain() {
        drop(sender);
    }
    subscriptions.lock().clear();
}

/// Owns one connection's demultiplexing state -- write sink, pending-request map, read-half pump
/// task, and per-connection watch-id counter -- and implements [`crate::JsonRpcTransport`]/
/// [`crate::SubscriptionTransport`] exactly once against it. [`crate::NdjsonTransport`] and
/// [`crate::websocket::WebSocketTransport`] each hold one of these behind their public,
/// frame-shape-specific type and forward every trait method to it single-line, so the demux
/// wiring -- not just the routing logic in the free functions above -- is implemented once
/// regardless of frame shape. (A blanket `impl<F: FrameSink> JsonRpcTransport for
/// MultiplexedTransport<F>` cannot itself satisfy `NdjsonTransport`/`WebSocketTransport`'s trait
/// bounds without a wrapper: Rust's coherence rules reject a second blanket impl over an
/// unconstrained type parameter alongside the existing `impl<T: JsonRpcTransport + ?Sized>
/// JsonRpcTransport for &T` forwarding impl, since `T` could unify with `&_`.)
pub(crate) struct MultiplexedTransport<F> {
    sink: F,
    pending: PendingMap,
    pump: JoinHandle<()>,
    next_watch_id: AtomicU64,
}

impl<F: FrameSink> MultiplexedTransport<F> {
    pub(crate) fn new(sink: F, pending: PendingMap, pump: JoinHandle<()>) -> Self {
        Self {
            sink,
            pending,
            pump,
            next_watch_id: AtomicU64::new(1),
        }
    }
}

impl<F> Drop for MultiplexedTransport<F> {
    fn drop(&mut self) {
        self.pump.abort();
    }
}

#[async_trait]
impl<F: FrameSink> JsonRpcTransport for MultiplexedTransport<F> {
    async fn request(&self, req: String) -> Result<String, TransportError> {
        request(&self.sink, &self.pending, req).await
    }
}

#[async_trait]
impl<F: FrameSink> SubscriptionTransport for MultiplexedTransport<F> {
    async fn open_subscription(
        &self,
        req: String,
        id: RequestId,
    ) -> Result<(String, Option<PumpedSubscription>), TransportError> {
        open_subscription(&self.sink, &self.pending, req, id).await
    }

    async fn cancel_subscription(
        &self,
        subscription_id: SubscriptionId,
    ) -> Result<(), TransportError> {
        cancel_subscription(&self.sink, subscription_id).await
    }

    async fn cancel_request(&self, id: RequestId) -> Result<(), TransportError> {
        cancel_request(&self.sink, id).await
    }

    fn next_watch_request_id(&self) -> RequestId {
        next_watch_id(&self.next_watch_id)
    }
}

/// Generates `JsonRpcTransport`/`SubscriptionTransport` for a wire-transport wrapper type holding
/// an `inner: MultiplexedTransport<_>` field, forwarding every method to it. Written once here (as
/// a macro, not a blanket impl -- see [`MultiplexedTransport`]'s doc comment for why a blanket impl
/// does not typecheck) so [`crate::NdjsonTransport`] and [`crate::websocket::WebSocketTransport`]
/// each get one macro invocation instead of hand-writing the same forwarding source twice.
macro_rules! impl_multiplexed_transport {
    ($ty:ident < $($generic:ident),+ > where $($bound:tt)+) => {
        #[async_trait::async_trait]
        impl<$($generic),+> crate::JsonRpcTransport for $ty<$($generic),+>
        where
            $($bound)+
        {
            async fn request(&self, request: String) -> Result<String, crate::TransportError> {
                self.inner.request(request).await
            }
        }

        #[async_trait::async_trait]
        impl<$($generic),+> crate::SubscriptionTransport for $ty<$($generic),+>
        where
            $($bound)+
        {
            /// Establishment can legitimately fail with a JSON-RPC error (for example
            /// `agent/attach` rejecting an unknown or inactive `ExecutionRef`) -- that case
            /// carries no `subscriptionId` but is not a transport fault, so it is left for the
            /// caller's response parser to surface as a typed `ClientError::Rpc` rather than
            /// being collapsed into a generic `TransportError` here.
            async fn open_subscription(
                &self,
                request: String,
                id: openengine_cluster_protocol::RequestId,
            ) -> Result<(String, Option<crate::PumpedSubscription>), crate::TransportError> {
                self.inner.open_subscription(request, id).await
            }

            async fn cancel_subscription(
                &self,
                subscription_id: openengine_cluster_protocol::SubscriptionId,
            ) -> Result<(), crate::TransportError> {
                self.inner.cancel_subscription(subscription_id).await
            }

            async fn cancel_request(
                &self,
                id: openengine_cluster_protocol::RequestId,
            ) -> Result<(), crate::TransportError> {
                self.inner.cancel_request(id).await
            }

            fn next_watch_request_id(&self) -> openengine_cluster_protocol::RequestId {
                self.inner.next_watch_request_id()
            }
        }
    };
}

pub(crate) use impl_multiplexed_transport;
