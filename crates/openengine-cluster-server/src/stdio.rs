//! NDJSON stdio transport: multiplexes unary JSON-RPC request/response traffic and generic
//! `watch`/`logs`/`agent/attach` subscription notifications over one bounded-frame connection.

mod admission;
mod agent_attach;
mod logs;
mod subscription;

use admission::{acquire_task_slot, reject_duplicate, run_writer, InFlightIds, MAX_CONNECTION_TASKS};

use std::collections::{HashMap, HashSet};
use std::io;
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use openengine_cluster_protocol::{
    DomainErrorData, EventNotification, JsonRpcNotification, JsonRpcRequest, RequestId,
    SubscriptionCancelParams, SubscriptionClosedNotification, SubscriptionId, WatchParams,
    INVALID_PARAMS, JSON_RPC_VERSION, PARSE_ERROR, SCHEMA_VIOLATION,
};
use serde_json::Value;
use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt};
use tokio::sync::{mpsc, Notify, Semaphore};
use tokio::task::JoinSet;
use tokio_stream::StreamExt;
use tokio_util::codec::{Framed, LinesCodec, LinesCodecError};

use crate::watch::{WatchEventStream, WatchHandle, WatchStreamItem};
use crate::{serialize_backend_error, serialize_error, serialize_success, ClusterBackend, Dispatcher};

/// Bounded NDJSON frame length. A line exceeding this (with no terminating newline found first)
/// is rejected with a `PARSE_ERROR` frame rather than buffered without limit.
const MAX_FRAME_BYTES: usize = 1_048_576;

/// Bounded per-connection outbound queue: unary responses and subscription notifications share
/// this single writer queue, so one pathologically slow peer backpressures further writes rather
/// than growing memory without bound.
const OUTBOUND_QUEUE_CAPACITY: usize = 256;

/// Grace period given to already-spawned bounded backend dispatches to finish once the connection
/// closes. Subscription tasks are notified through their cancellation handles before shutdown;
/// any backend operation that does not finish inside this bound is force-aborted.
const SHUTDOWN_GRACE_PERIOD: Duration = Duration::from_millis(200);

/// Per-subscription cancellation signal: notifying it wakes `run_watch_subscription`'s streaming
/// loop immediately, even while parked awaiting the next live event, instead of relying solely on
/// `WatchEventStream`'s own cancelled flag, which is only re-checked at the top of `next()` and so
/// never observed on an idle run once the task is parked inside `next_live`'s
/// `receiver.recv().await`.
type SubscriptionMap = Arc<Mutex<HashMap<SubscriptionId, Arc<Notify>>>>;

/// Per-connection state shared by every spawned request/subscription task: the outbound write
/// queue and the tracking maps used for cancellation and duplicate-id rejection.
#[derive(Clone)]
struct ConnectionState {
    outbound_tx: mpsc::Sender<String>,
    subscriptions: SubscriptionMap,
    in_flight_ids: InFlightIds,
}

/// Races `next` against `cancel`, `biased` toward the cancellation so a `subscription/cancel` that
/// arrives while parked awaiting the next live event wakes the loop immediately instead of only
/// being observed the next time the stream is polled -- which never happens again on an idle run.
/// `biased` also ensures a pending cancellation is never starved by an unbounded run of
/// already-buffered stream items. Shared by `run_watch_subscription` and
/// `subscription::run_bounded_event_subscription`.
pub(super) async fn race_cancel_or_next<T>(
    cancel: &Notify,
    next: impl std::future::Future<Output = Option<T>>,
) -> Option<T> {
    tokio::select! {
        biased;
        () = cancel.notified() => None,
        item = next => item,
    }
}

pub async fn serve_ndjson<B, R, W, E>(
    dispatcher: Dispatcher<B>,
    reader: R,
    writer: W,
    mut diagnostics: E,
) -> io::Result<()>
where
    B: ClusterBackend,
    R: AsyncRead + Send + Unpin + 'static,
    W: AsyncWrite + Send + Unpin + 'static,
    E: AsyncWrite + Send + Unpin + 'static,
{
    let (outbound_tx, outbound_rx) = mpsc::channel::<String>(OUTBOUND_QUEUE_CAPACITY);
    let writer_task = tokio::spawn(run_writer(writer, outbound_rx));

    let subscriptions: SubscriptionMap = Arc::new(Mutex::new(HashMap::new()));
    let in_flight_ids: InFlightIds = Arc::new(Mutex::new(HashSet::new()));
    let task_slots = Arc::new(Semaphore::new(MAX_CONNECTION_TASKS));
    let mut tasks: JoinSet<()> = JoinSet::new();
    let state = ConnectionState {
        outbound_tx: outbound_tx.clone(),
        subscriptions: Arc::clone(&subscriptions),
        in_flight_ids: Arc::clone(&in_flight_ids),
    };

    let mut lines = Framed::new(reader, LinesCodec::new_with_max_length(MAX_FRAME_BYTES));
    loop {
        // Reap completed request tasks even while the connection remains idle. A concurrency cap
        // alone is insufficient: `JoinSet` retains every completed output until it is joined.
        let next_line = loop {
            tokio::select! {
                completed = tasks.join_next(), if !tasks.is_empty() => {
                    let _ = completed;
                }
                line = lines.next() => break line,
            }
        };
        let line = match next_line {
            Some(Ok(line)) => line,
            Some(Err(LinesCodecError::MaxLineLengthExceeded)) => {
                let _ = outbound_tx
                    .send(serialize_error(None, PARSE_ERROR, "Parse error", None))
                    .await;
                // `Framed`'s stream terminates for good after yielding any decode error (it
                // never calls `decode` again), so `LinesCodec`'s own discard-until-next-newline
                // resync would otherwise never run. Rebuilding via `from_parts`/`into_parts`
                // (rather than `Framed::new` + manually restoring the read buffer) matters: the
                // buffer's leftover bytes may already contain one or more complete lines past the
                // discarded one, and only `from_parts` marks the rebuilt reader immediately
                // readable from that carried-over buffer — reconstructing via `new` and copying
                // the buffer in by hand leaves it believing the buffer is empty, so it blocks on
                // a fresh read instead of decoding what is already buffered.
                lines = Framed::from_parts(lines.into_parts());
                continue;
            }
            Some(Err(LinesCodecError::Io(error))) => {
                diagnostics
                    .write_all(format!("cluster protocol input error: {error}\n").as_bytes())
                    .await?;
                diagnostics.flush().await?;
                break;
            }
            None => break,
        };

        match classify_ndjson_line(&line) {
            NdjsonLineKind::Cancel(subscription_id) => {
                if let Some(cancel) = subscriptions.lock().remove(&subscription_id) {
                    cancel.notify_one();
                }
            }
            NdjsonLineKind::Watch { id, params } => {
                if reject_duplicate(&in_flight_ids, &outbound_tx, id.clone()).await {
                    continue;
                }
                let Some(permit) =
                    acquire_task_slot(&task_slots, &outbound_tx, Some(id.clone())).await
                else {
                    in_flight_ids.lock().remove(&id);
                    continue;
                };
                let task_dispatcher = dispatcher.clone();
                let task_state = state.clone();
                tasks.spawn(async move {
                    let _permit = permit;
                    run_watch_subscription(task_dispatcher, id, params, task_state).await;
                });
            }
            NdjsonLineKind::Logs { id, params } => {
                if reject_duplicate(&in_flight_ids, &outbound_tx, id.clone()).await {
                    continue;
                }
                let Some(permit) =
                    acquire_task_slot(&task_slots, &outbound_tx, Some(id.clone())).await
                else {
                    in_flight_ids.lock().remove(&id);
                    continue;
                };
                let task_dispatcher = dispatcher.clone();
                let task_state = state.clone();
                tasks.spawn(async move {
                    let _permit = permit;
                    logs::run_logs_subscription(task_dispatcher, id, params, task_state).await;
                });
            }
            NdjsonLineKind::AgentAttach { id, params } => {
                if reject_duplicate(&in_flight_ids, &outbound_tx, id.clone()).await {
                    continue;
                }
                let Some(permit) =
                    acquire_task_slot(&task_slots, &outbound_tx, Some(id.clone())).await
                else {
                    in_flight_ids.lock().remove(&id);
                    continue;
                };
                let task_dispatcher = dispatcher.clone();
                let task_state = state.clone();
                tasks.spawn(async move {
                    let _permit = permit;
                    agent_attach::run_agent_attach_subscription(
                        task_dispatcher,
                        id,
                        params,
                        task_state,
                    )
                    .await;
                });
            }
            NdjsonLineKind::Passthrough { id } => {
                if let Some(id) = id.clone() {
                    if reject_duplicate(&in_flight_ids, &outbound_tx, id).await {
                        continue;
                    }
                }
                let Some(permit) = acquire_task_slot(&task_slots, &outbound_tx, id.clone()).await
                else {
                    if let Some(id) = id {
                        in_flight_ids.lock().remove(&id);
                    }
                    continue;
                };
                let task_dispatcher = dispatcher.clone();
                let task_state = state.clone();
                tasks.spawn(async move {
                    let _permit = permit;
                    run_passthrough_request(task_dispatcher, id, line, task_state).await;
                });
            }
        }
    }

    for cancel in subscriptions.lock().drain().map(|(_, cancel)| cancel) {
        cancel.notify_one();
    }

    let drain_naturally = async { while tasks.join_next().await.is_some() {} };
    if tokio::time::timeout(SHUTDOWN_GRACE_PERIOD, drain_naturally)
        .await
        .is_err()
    {
        tasks.shutdown().await;
    }
    drop(subscriptions);
    drop(outbound_tx);
    drop(state);
    let _ = writer_task.await;
    Ok(())
}

/// Dispatches a non-`watch` request or notification line, releasing its in-flight id (if any)
/// once the backend call returns and before the response is enqueued.
async fn run_passthrough_request<B>(
    dispatcher: Dispatcher<B>,
    id: Option<RequestId>,
    line: String,
    state: ConnectionState,
) where
    B: ClusterBackend,
{
    let response = dispatcher.dispatch(&line).await;
    if let Some(id) = id {
        state.in_flight_ids.lock().remove(&id);
    }
    let _ = state.outbound_tx.send(response).await;
}

/// Establishes a `watch` subscription and, on success, streams its `event`/`subscription/closed`
/// notifications until the stream ends (overflow, backend close, or cancellation), via
/// `subscription::run_established_subscription` -- the same shared establish/loop/cleanup
/// `subscription::run_bounded_event_subscription` uses. The established [`WatchHandle`] is kept
/// alive for the duration purely to hold its backing flag false: dropping it early would trip
/// `WatchEventStream`'s own cancellation check before anything ever streams.
async fn run_watch_subscription<B>(
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

pub async fn serve_stdio<B>(dispatcher: Dispatcher<B>) -> io::Result<()>
where
    B: ClusterBackend,
{
    serve_ndjson(
        dispatcher,
        tokio::io::stdin(),
        tokio::io::stdout(),
        tokio::io::stderr(),
    )
    .await
}

impl<B> Dispatcher<B>
where
    B: ClusterBackend,
{
    /// NDJSON-only counterpart to [`Dispatcher::dispatch`] for the `watch` method: returns the
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

/// Result of classifying one decoded NDJSON line for [`serve_ndjson`]'s multiplexer. `Passthrough`
/// carries the request id when the line parsed as a well-formed non-`watch` request, so the
/// multiplexer can still apply duplicate-in-flight-id detection to ordinary unary methods; it is
/// `None` for malformed lines or notifications, which [`Dispatcher::dispatch`] handles on its own.
pub(crate) enum NdjsonLineKind {
    Watch { id: RequestId, params: Value },
    Logs { id: RequestId, params: Value },
    AgentAttach { id: RequestId, params: Value },
    Cancel(SubscriptionId),
    Passthrough { id: Option<RequestId> },
}

/// Classifies a decoded NDJSON line without fully deserializing its params: a `watch`/`logs`/
/// `agent/attach` request is pulled out for subscription handling, a `subscription/cancel`
/// notification is pulled out for inline cancellation, and everything else (including malformed
/// JSON) passes through to [`Dispatcher::dispatch`] unchanged.
pub(crate) fn classify_ndjson_line(line: &str) -> NdjsonLineKind {
    if let Ok(request) = serde_json::from_str::<JsonRpcRequest<Value>>(line) {
        if request.method == "watch" {
            return NdjsonLineKind::Watch {
                id: request.id,
                params: request.params,
            };
        }
        if request.method == "logs" {
            return NdjsonLineKind::Logs {
                id: request.id,
                params: request.params,
            };
        }
        if request.method == "agent/attach" {
            return NdjsonLineKind::AgentAttach {
                id: request.id,
                params: request.params,
            };
        }
        return NdjsonLineKind::Passthrough {
            id: Some(request.id),
        };
    }
    if let Ok(notification) =
        serde_json::from_str::<JsonRpcNotification<SubscriptionCancelParams>>(line)
    {
        if notification.method == "subscription/cancel" {
            return NdjsonLineKind::Cancel(notification.params.subscription_id);
        }
    }
    NdjsonLineKind::Passthrough { id: None }
}

#[cfg(test)]
mod tests;
