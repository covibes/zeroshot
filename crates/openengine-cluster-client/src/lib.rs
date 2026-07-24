//! Typed transport-neutral Cluster Protocol client.

mod ndjson_pump;
mod ndjson_subscription;

use ndjson_pump::forward_notification;

pub mod agent_attach;
pub mod logs;
pub mod ndjson_agent_attach;
pub mod ndjson_logs;
pub mod ndjson_watch;
pub mod watch;
pub use agent_attach::*;
pub use logs::*;
pub use ndjson_agent_attach::*;
pub use ndjson_logs::*;
pub use ndjson_watch::*;
pub use watch::*;

use std::collections::{hash_map::Entry, HashMap};
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering};
use std::sync::Arc;

use parking_lot::Mutex as ParkingMutex;
use async_trait::async_trait;
use openengine_cluster_protocol::{
    ApplyParams, ApplyResult, DeleteParams, DeleteResult, GetParams, GetResult, InitializeParams,
    InitializeResult, JsonRpcError, JsonRpcErrorResponse, JsonRpcNotification, JsonRpcRequest,
    JsonRpcSuccess, PlanParams, PlanResult, RequestId, ResubmitParams, ResubmitResult, RetryParams,
    RetryResult, StopParams, StopResult, SubscriptionCancelParams, SubscriptionId, UpdateParams,
    UpdateResult, JSON_RPC_VERSION, PROTOCOL_VERSION,
};
use openengine_cluster_server::{ClusterBackend, Dispatcher};
use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::Value;
use thiserror::Error;
use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt};
use tokio::sync::{mpsc, oneshot, Mutex};
use tokio::task::JoinHandle;
use tokio_stream::StreamExt;
use tokio_util::codec::{FramedRead, LinesCodec};

#[derive(Debug, Error)]
pub enum TransportError {
    #[error("transport I/O failed: {0}")]
    Io(#[from] std::io::Error),
    #[error("transport protocol failed: {0}")]
    Protocol(String),
}

#[async_trait]
pub trait JsonRpcTransport: Send + Sync {
    async fn request(&self, request: String) -> Result<String, TransportError>;
}

/// Forwarding impl so one transport (e.g. an [`NdjsonTransport`]) can back a
/// [`ClusterClient`] and a subscription client (e.g. [`NdjsonWatchClient`]) at the same time,
/// each holding only a shared reference to it.
#[async_trait]
impl<T> JsonRpcTransport for &T
where
    T: JsonRpcTransport + ?Sized,
{
    async fn request(&self, request: String) -> Result<String, TransportError> {
        (**self).request(request).await
    }
}

pub struct InProcessTransport<B> {
    dispatcher: Dispatcher<B>,
}

impl<B> InProcessTransport<B>
where
    B: ClusterBackend,
{
    #[must_use]
    pub const fn new(dispatcher: Dispatcher<B>) -> Self {
        Self { dispatcher }
    }
}

#[async_trait]
impl<B> JsonRpcTransport for InProcessTransport<B>
where
    B: ClusterBackend,
{
    async fn request(&self, request: String) -> Result<String, TransportError> {
        Ok(self.dispatcher.dispatch(&request).await)
    }
}

/// Bounded NDJSON frame length, matching the server's `serve_ndjson` bound.
const MAX_FRAME_BYTES: usize = 1_048_576;

/// Bounded per-subscription local buffer of raw notification lines awaiting
/// [`NdjsonReconnectingEventStream::next`]. Delivery into this queue is non-blocking so one
/// abandoned subscription cannot stall the connection's sole response pump.
const SUBSCRIPTION_QUEUE_CAPACITY: usize = 1024;

/// One demultiplexed unary response: the raw response line plus, only for a successful `watch`
/// response, the freshly registered receiver for that subscription's `event`/`subscription/closed`
/// notifications.
struct PumpedResponse {
    line: String,
    subscription: Option<PumpedSubscription>,
}

pub(crate) struct PumpedSubscription {
    pub(crate) receiver: mpsc::Receiver<String>,
    pub(crate) overflowed: Arc<AtomicBool>,
}

#[derive(Clone)]
struct SubscriptionRegistration {
    sender: mpsc::Sender<String>,
    overflowed: Arc<AtomicBool>,
}

type PendingMap = Arc<ParkingMutex<HashMap<RequestId, oneshot::Sender<PumpedResponse>>>>;
type SubscriptionMap = Arc<ParkingMutex<HashMap<SubscriptionId, SubscriptionRegistration>>>;

/// NDJSON stdio transport that demultiplexes unary request/response traffic and generic `watch`
/// subscription notifications sharing one connection, correlating by request id and subscription
/// id respectively. A background pump task owns the read half; [`Self::request`] and the
/// subscription-establishing/cancelling methods below only ever take the write half's lock.
pub struct NdjsonTransport<R, W> {
    writer: Arc<Mutex<W>>,
    pending: PendingMap,
    pump: JoinHandle<()>,
    next_watch_id: AtomicU64,
    _reader: std::marker::PhantomData<fn() -> R>,
}

impl<R, W> NdjsonTransport<R, W>
where
    R: AsyncRead + Send + Unpin + 'static,
    W: AsyncWrite + Send + Unpin + 'static,
{
    #[must_use]
    pub fn new(reader: R, writer: W) -> Self {
        let pending: PendingMap = Arc::new(ParkingMutex::new(HashMap::new()));
        let subscriptions: SubscriptionMap = Arc::new(ParkingMutex::new(HashMap::new()));
        let writer = Arc::new(Mutex::new(writer));
        let pump = tokio::spawn(run_pump(
            reader,
            Arc::clone(&pending),
            subscriptions,
            Arc::clone(&writer),
        ));
        Self {
            writer,
            pending,
            pump,
            next_watch_id: AtomicU64::new(1),
            _reader: std::marker::PhantomData,
        }
    }

    async fn write_line(&self, line: &str) -> Result<(), TransportError> {
        write_shared_line(&self.writer, line).await
    }

    /// Registers `id` as pending, writes `request`, and awaits its demultiplexed response.
    async fn send_request(
        &self,
        request: String,
        id: RequestId,
    ) -> Result<PumpedResponse, TransportError> {
        let (sender, receiver) = oneshot::channel();
        {
            let mut pending = self.pending.lock();
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
        if let Err(error) = self.write_line(&request).await {
            self.pending.lock().remove(&id);
            return Err(error);
        }
        receiver.await.map_err(|_| {
            TransportError::Protocol("server closed the connection before responding".to_owned())
        })
    }

    /// Sends a subscription-establishing request and returns its response line plus, only on
    /// success, the receiver registered for its subscription's notifications. Establishment can
    /// legitimately fail with a JSON-RPC error (for example `agent/attach` rejecting an unknown or
    /// inactive `ExecutionRef`) -- that case carries no `subscriptionId` but is not a transport
    /// fault, so it is left for the caller's response parser to surface as a typed
    /// [`crate::ClientError::Rpc`] rather than being collapsed into a generic [`TransportError`]
    /// here.
    pub(crate) async fn open_subscription(
        &self,
        request: String,
        id: RequestId,
    ) -> Result<(String, Option<PumpedSubscription>), TransportError> {
        let response = self.send_request(request, id).await?;
        Ok((response.line, response.subscription))
    }

    pub(crate) fn next_watch_request_id(&self) -> RequestId {
        RequestId::String(format!(
            "watch-{}",
            self.next_watch_id.fetch_add(1, Ordering::Relaxed)
        ))
    }

    /// Sends a `subscription/cancel` notification. Fire-and-forget: cancellation has no response
    /// on the wire, so this only reports a write failure.
    pub async fn cancel_subscription(
        &self,
        subscription_id: SubscriptionId,
    ) -> Result<(), TransportError> {
        let notification = serde_json::to_string(&JsonRpcNotification {
            jsonrpc: JSON_RPC_VERSION.to_owned(),
            method: "subscription/cancel".to_owned(),
            params: SubscriptionCancelParams { subscription_id },
        })
        .expect("subscription cancel notification serialization must succeed");
        self.write_line(&notification).await
    }
}

impl<R, W> Drop for NdjsonTransport<R, W> {
    fn drop(&mut self) {
        self.pump.abort();
    }
}

#[async_trait]
impl<R, W> JsonRpcTransport for NdjsonTransport<R, W>
where
    R: AsyncRead + Send + Unpin + 'static,
    W: AsyncWrite + Send + Unpin + 'static,
{
    async fn request(&self, request: String) -> Result<String, TransportError> {
        let id = extract_request_id(&request);
        let response = self.send_request(request, id).await?;
        Ok(response.line)
    }
}

/// Extracts the `id` from an outgoing request this crate serialized itself. Panics on a malformed
/// id, since that indicates an internal bug in request construction rather than bad external
/// input.
fn extract_request_id(request: &str) -> RequestId {
    let value: Value = serde_json::from_str(request).expect("outgoing request must be valid JSON");
    match value.get("id").expect("outgoing request must carry an id") {
        Value::String(id) => RequestId::String(id.clone()),
        Value::Number(id) => RequestId::Integer(
            id.as_i64()
                .expect("outgoing request id must be representable as an i64"),
        ),
        other => panic!("outgoing request id must be a string or integer, got {other}"),
    }
}

/// Drives the read half: decodes bounded NDJSON lines and demultiplexes each one by request id
/// (unary responses, resolving the matching pending oneshot) or by `params.subscriptionId`
/// (subscription notifications, forwarded to the matching registered channel). A `watch`
/// response carrying a `result.subscriptionId` registers that subscription's channel before
/// resolving the pending oneshot, so no `event` racing the response can be missed. On stream end
/// every pending request fails and every open subscription ends (dropping its sender).
async fn run_pump<R, W>(
    reader: R,
    pending: PendingMap,
    subscriptions: SubscriptionMap,
    writer: Arc<Mutex<W>>,
) where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let mut lines = FramedRead::new(reader, LinesCodec::new_with_max_length(MAX_FRAME_BYTES));
    while let Some(Ok(line)) = lines.next().await {
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if value.get("method").is_some() {
            if let Some(subscription_id) = forward_notification(&value, line, &subscriptions) {
                let _ = write_subscription_cancel(&writer, subscription_id).await;
            }
            continue;
        }
        let Some(id) = value.get("id").and_then(RequestId::from_json_value) else {
            continue;
        };
        let Some(sender) = pending.lock().remove(&id) else {
            continue;
        };
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
    }
    for (_, sender) in pending.lock().drain() {
        drop(sender);
    }
    subscriptions.lock().clear();
}

async fn write_subscription_cancel<W>(
    writer: &Arc<Mutex<W>>,
    subscription_id: SubscriptionId,
) -> Result<(), TransportError>
where
    W: AsyncWrite + Unpin,
{
    let notification = serde_json::to_string(&JsonRpcNotification {
        jsonrpc: JSON_RPC_VERSION.to_owned(),
        method: "subscription/cancel".to_owned(),
        params: SubscriptionCancelParams { subscription_id },
    })
    .expect("subscription cancel notification serialization must succeed");
    write_shared_line(writer, &notification).await
}

async fn write_shared_line<W>(writer: &Arc<Mutex<W>>, line: &str) -> Result<(), TransportError>
where
    W: AsyncWrite + Unpin,
{
    let mut writer = writer.lock().await;
    writer.write_all(line.as_bytes()).await?;
    writer.write_all(b"\n").await?;
    writer.flush().await?;
    Ok(())
}

pub struct ClusterClient<T> {
    transport: T,
    next_id: AtomicI64,
}

impl<T> ClusterClient<T>
where
    T: JsonRpcTransport,
{
    #[must_use]
    pub const fn new(transport: T) -> Self {
        Self {
            transport,
            next_id: AtomicI64::new(1),
        }
    }

    pub async fn initialize(&self) -> Result<InitializeResult, ClientError> {
        self.initialize_with_version(PROTOCOL_VERSION).await
    }

    pub async fn initialize_with_version(
        &self,
        protocol_version: impl Into<String> + Send,
    ) -> Result<InitializeResult, ClientError> {
        let protocol_version = protocol_version.into();
        let result: InitializeResult = self
            .call(
                "initialize",
                InitializeParams {
                    protocol_version: protocol_version.clone(),
                },
            )
            .await?;
        if result.protocol_version != protocol_version {
            return Err(ClientError::InvalidResponse(format!(
                "protocol version mismatch: requested {protocol_version}, received {}",
                result.protocol_version
            )));
        }
        result
            .validate_protocol_version()
            .map_err(|error| ClientError::InvalidResponse(error.to_string()))?;
        Ok(result)
    }

    pub async fn plan(&self, params: PlanParams) -> Result<PlanResult, ClientError> {
        self.call("plan", params).await
    }

    pub async fn apply(&self, params: ApplyParams) -> Result<ApplyResult, ClientError> {
        self.call("apply", params).await
    }

    pub async fn get(&self, params: GetParams) -> Result<GetResult, ClientError> {
        self.call("get", params).await
    }

    pub async fn update(&self, params: UpdateParams) -> Result<UpdateResult, ClientError> {
        self.call("update", params).await
    }

    pub async fn stop(&self, params: StopParams) -> Result<StopResult, ClientError> {
        self.call("stop", params).await
    }

    pub async fn retry(&self, params: RetryParams) -> Result<RetryResult, ClientError> {
        self.call("retry", params).await
    }

    pub async fn resubmit(&self, params: ResubmitParams) -> Result<ResubmitResult, ClientError> {
        self.call("resubmit", params).await
    }

    pub async fn delete(&self, params: DeleteParams) -> Result<DeleteResult, ClientError> {
        self.call("delete", params).await
    }

    async fn call<P, R>(&self, method: &str, params: P) -> Result<R, ClientError>
    where
        P: Serialize + Send,
        R: DeserializeOwned,
    {
        let id = RequestId::Integer(self.next_id.fetch_add(1, Ordering::Relaxed));
        let request = serde_json::to_string(&JsonRpcRequest {
            jsonrpc: JSON_RPC_VERSION.to_owned(),
            id: id.clone(),
            method: method.to_owned(),
            params,
        })?;
        let response = self.transport.request(request).await?;
        let value: Value = serde_json::from_str(&response)
            .map_err(|error| ClientError::InvalidResponse(error.to_string()))?;

        if value.get("error").is_some() {
            let response: JsonRpcErrorResponse = serde_json::from_value(value)
                .map_err(|error| ClientError::InvalidResponse(error.to_string()))?;
            validate_response_identity(&response.jsonrpc, response.id.as_ref(), &id)?;
            return Err(ClientError::Rpc(response.error));
        }

        let response: JsonRpcSuccess<R> = serde_json::from_value(value)
            .map_err(|error| ClientError::InvalidResponse(error.to_string()))?;
        validate_response_identity(&response.jsonrpc, Some(&response.id), &id)?;
        Ok(response.result)
    }
}

fn validate_response_identity(
    jsonrpc: &str,
    actual_id: Option<&RequestId>,
    expected_id: &RequestId,
) -> Result<(), ClientError> {
    if jsonrpc != JSON_RPC_VERSION {
        return Err(ClientError::InvalidResponse(format!(
            "expected jsonrpc {JSON_RPC_VERSION}, received {jsonrpc}"
        )));
    }
    if actual_id != Some(expected_id) {
        return Err(ClientError::InvalidResponse(format!(
            "response id mismatch: expected {expected_id:?}, received {actual_id:?}"
        )));
    }
    Ok(())
}

#[derive(Debug, Error)]
pub enum ClientError {
    #[error(transparent)]
    Transport(#[from] TransportError),
    #[error("request serialization failed: {0}")]
    Serialization(#[from] serde_json::Error),
    #[error("server returned JSON-RPC error {0:?}")]
    Rpc(JsonRpcError),
    #[error("invalid JSON-RPC response: {0}")]
    InvalidResponse(String),
    #[error(transparent)]
    Backend(#[from] openengine_cluster_server::BackendError),
}
