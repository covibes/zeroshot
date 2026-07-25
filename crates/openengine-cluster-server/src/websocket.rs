//! Production WebSocket transport binding the backend-neutral [`Dispatcher`] and generic
//! subscription framing to the wire. One JSON-RPC object per text message; this module reuses
//! `stdio::serve_ndjson`'s exact classification, admission, and subscription-streaming machinery
//! ([`crate::stdio::ConnectionState`], `classify_ndjson_line`, `dispatch_classified_line`) so
//! results, events, and errors stay byte-equivalent between the stdio and WebSocket bindings.
//! Framing rules unique to WebSocket -- binary rejection, the 1,048,576 UTF-8 byte bound, and
//! race-free `$/cancelRequest` -- live only here; `stdio::serve_ndjson` itself is untouched.

use std::collections::HashMap;
use std::io;
use std::sync::Arc;

use futures_util::stream::SplitStream;
use futures_util::{Sink, SinkExt, StreamExt};
use openengine_cluster_protocol::{CancelRequestParams, JsonRpcNotification, RequestId};
use parking_lot::Mutex;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::{mpsc, oneshot, OwnedSemaphorePermit};
use tokio::task::{AbortHandle, JoinSet};
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::protocol::{CloseFrame, WebSocketConfig};
use tokio_tungstenite::tungstenite::{Error as WsError, Message, Utf8Bytes};
use tokio_tungstenite::WebSocketStream;

use crate::stdio::{
    classify_ndjson_line, dispatch_classified_line, new_connection_setup, shutdown_connection,
    ConnectionSetup, ConnectionState, DispatchCtx, LineDispatch, ShutdownArgs,
};
use crate::{ClusterBackend, Dispatcher};

/// Bounded WebSocket text-frame length: a text message whose UTF-8 byte length exceeds this
/// closes the connection with code 1009 (message too big), matching `stdio::serve_ndjson`'s
/// NDJSON line bound.
pub const MAX_FRAME_BYTES: usize = 1_048_576;

/// Bounded per-connection outbound queue, matching `stdio::serve_ndjson`'s bound.
const OUTBOUND_QUEUE_CAPACITY: usize = 256;

/// Per-connection registry of abort handles for in-flight passthrough (unary) request tasks, keyed
/// by their [`RequestId`]. Registration happens-before the spawned task can perform any work --
/// including completing -- via `spawn_passthrough`'s readiness gate, and release is unconditional
/// on every exit path (normal completion, cancellation, or panic) via [`PassthroughGuard`]'s
/// `Drop` impl, so no stale or leaked entry is possible. `$/cancelRequest` looks an id up here and
/// aborts it; an absent id (unknown, or already completed) is silently a no-op. Establishing
/// requests (`watch`/`logs`/`agent/attach`) are not registered here -- their in-flight lifetime is
/// already covered by `subscription/cancel` once established, and is intentionally short.
type CancelRegistry = Arc<Mutex<HashMap<RequestId, AbortHandle>>>;

/// WebSocket configuration enforcing [`MAX_FRAME_BYTES`] as the incoming message size bound, so
/// tungstenite itself rejects an oversized message during frame reassembly rather than buffering
/// it without limit ahead of this binding's own explicit length check.
#[must_use]
pub fn websocket_config() -> WebSocketConfig {
    WebSocketConfig::default().max_message_size(Some(MAX_FRAME_BYTES))
}

/// Serves one already-handshaken WebSocket connection: demultiplexes unary requests and `watch`/
/// `logs`/`agent/attach` subscriptions sharing this connection exactly like `stdio::serve_ndjson`,
/// plus per-connection race-free `$/cancelRequest`. Binary frames close with code 1003;
/// oversized or capacity-rejected text frames close with code 1009. Never returns an `Err`:
/// transport failures close the connection and this simply returns once torn down.
pub async fn serve_websocket<B, S>(
    dispatcher: Dispatcher<B>,
    ws: WebSocketStream<S>,
) -> io::Result<()>
where
    B: ClusterBackend,
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let (sink, mut stream) = ws.split();
    let (outbound_tx, outbound_rx) = mpsc::channel::<String>(OUTBOUND_QUEUE_CAPACITY);
    let (close_tx, close_rx) = oneshot::channel::<CloseFrame>();
    let writer_task = tokio::spawn(run_writer(sink, outbound_rx, close_rx));

    let ConnectionSetup {
        subscriptions,
        task_slots,
        mut tasks,
        state,
    } = new_connection_setup(&outbound_tx);
    let cancel_registry: CancelRegistry = Arc::new(Mutex::new(HashMap::new()));
    let mut close_tx = Some(close_tx);

    while let Some(message) = next_incoming_message(&mut tasks, &mut stream, &mut close_tx).await {
        let mut ctx = WsCtx {
            dispatch: DispatchCtx {
                dispatcher: &dispatcher,
                state: &state,
                task_slots: &task_slots,
                tasks: &mut tasks,
            },
            cancel_registry: &cancel_registry,
            close_tx: &mut close_tx,
        };
        if matches!(handle_message(message, &mut ctx).await, FrameOutcome::Break) {
            break;
        }
    }

    shutdown_connection(ShutdownArgs {
        subscriptions,
        tasks,
        outbound_tx,
        state,
        writer_task,
    })
    .await;
    Ok(())
}

/// Awaits the next inbound message, reaping completed request tasks in the meantime exactly like
/// `stdio::serve_ndjson` -- a concurrency cap alone is insufficient since `JoinSet` retains every
/// completed output until it is joined. Returns `None` once the stream ends or a transport-level
/// capacity error forces a close (signalled via `close_tx` beforehand, per [`signal_close`]).
async fn next_incoming_message<S>(
    tasks: &mut JoinSet<()>,
    stream: &mut SplitStream<WebSocketStream<S>>,
    close_tx: &mut Option<oneshot::Sender<CloseFrame>>,
) -> Option<Message>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let next_message = loop {
        tokio::select! {
            completed = tasks.join_next(), if !tasks.is_empty() => {
                let _ = completed;
            }
            message = stream.next() => break message,
        }
    };
    match next_message {
        Some(Ok(message)) => Some(message),
        Some(Err(error)) => {
            if matches!(error, WsError::Capacity(_)) {
                signal_close(close_tx, CloseCode::Size, "message too big");
            }
            None
        }
        None => None,
    }
}

/// Whether the connection loop should keep reading after handling one frame.
enum FrameOutcome {
    Continue,
    Break,
}

/// Per-frame handling context: the shared [`DispatchCtx`] plus the two handles unique to this
/// WebSocket binding (the race-free `$/cancelRequest` registry and the deterministic-close
/// signal), bundled so [`handle_message`] and its helpers take one argument instead of an
/// ever-growing list.
struct WsCtx<'a, B> {
    dispatch: DispatchCtx<'a, B>,
    cancel_registry: &'a CancelRegistry,
    close_tx: &'a mut Option<oneshot::Sender<CloseFrame>>,
}

/// Dispatches one inbound frame by kind. Binary frames and a peer-initiated close both end the
/// connection; ping/pong/raw frames are ignored (tungstenite auto-answers pings); text frames are
/// handled by [`handle_text_frame`].
async fn handle_message<B>(message: Message, ctx: &mut WsCtx<'_, B>) -> FrameOutcome
where
    B: ClusterBackend,
{
    match message {
        Message::Text(text) => handle_text_frame(text, ctx).await,
        Message::Binary(_) => {
            signal_close(
                ctx.close_tx,
                CloseCode::Unsupported,
                "binary frames are not supported",
            );
            FrameOutcome::Break
        }
        Message::Ping(_) | Message::Pong(_) | Message::Frame(_) => FrameOutcome::Continue,
        Message::Close(_) => FrameOutcome::Break,
    }
}

/// Handles one `Message::Text` frame: enforces [`MAX_FRAME_BYTES`], routes a `$/cancelRequest`
/// notification inline, and otherwise classifies and dispatches the line exactly like
/// `stdio::serve_ndjson` via [`dispatch_classified_line`] -- spawning this binding's own
/// passthrough task (with `cancel_registry` tracking) for a [`LineDispatch::Passthrough`] result.
async fn handle_text_frame<B>(text: Utf8Bytes, ctx: &mut WsCtx<'_, B>) -> FrameOutcome
where
    B: ClusterBackend,
{
    if text.len() > MAX_FRAME_BYTES {
        signal_close(ctx.close_tx, CloseCode::Size, "message too big");
        return FrameOutcome::Break;
    }
    if let Some(cancel_id) = parse_cancel_request(&text) {
        if let Some(handle) = ctx.cancel_registry.lock().remove(&cancel_id) {
            handle.abort();
        }
        return FrameOutcome::Continue;
    }
    let kind = classify_ndjson_line(&text);
    if let LineDispatch::Passthrough { id, permit } =
        dispatch_classified_line(kind, &mut ctx.dispatch).await
    {
        spawn_passthrough(ctx, id, permit, text.as_str().to_owned());
    }
    FrameOutcome::Continue
}

/// Spawns the passthrough (non-subscription) request task for an admission-approved line,
/// registering its abort handle under `id` in `cancel_registry` for `$/cancelRequest`. The spawned
/// task cannot perform any work -- including completing -- until the caller has finished inserting
/// that handle: a request that carries an `id` gates its own start on a one-shot readiness signal
/// the caller only fires after the insert, making registration happen-before any task work
/// deterministically regardless of which worker thread the scheduler picks it up on. A bare
/// notification (`id.is_none()`) has nothing to register and keeps starting immediately.
///
/// [`PassthroughGuard`] is constructed here -- synchronously, on the connection task -- and moved
/// into the spawned future's captured environment rather than built inside the task's own body.
/// This matters because a task can be aborted before the runtime ever polls it even once (e.g. a
/// `$/cancelRequest` that lands while still parked behind the readiness gate above): such a task
/// never executes a single statement of its own body, so a guard created *inside* that body would
/// never come into existence and cleanup would silently never run. A value captured by an `async
/// move` block, by contrast, is part of the future's state from the moment the block is
/// constructed, so Rust drops it normally when the never-polled future itself is dropped.
fn spawn_passthrough<B>(
    ctx: &mut WsCtx<'_, B>,
    id: Option<RequestId>,
    permit: OwnedSemaphorePermit,
    line: String,
) where
    B: ClusterBackend,
{
    let task_dispatcher = ctx.dispatch.dispatcher.clone();
    let task_state = ctx.dispatch.state.clone();
    let task_cancel_registry = Arc::clone(ctx.cancel_registry);
    let guard = id.clone().map(|id| PassthroughGuard {
        id,
        state: task_state.clone(),
        cancel_registry: Arc::clone(&task_cancel_registry),
    });
    let (ready_tx, ready_rx) = if id.is_some() {
        let (tx, rx) = oneshot::channel::<()>();
        (Some(tx), Some(rx))
    } else {
        (None, None)
    };
    let abort_handle = ctx.dispatch.tasks.spawn(async move {
        if let Some(ready_rx) = ready_rx {
            let _ = ready_rx.await;
        }
        let _permit = permit;
        run_passthrough_request(PassthroughRequest {
            dispatcher: task_dispatcher,
            line,
            state: task_state,
            guard,
        })
        .await;
    });
    // Test-only: widens the window between the spawned task being handed to the scheduler and
    // this registration completing, so `tests::fast_completion_race_cannot_leave_stale_registry_entry`
    // can deterministically manufacture -- rather than hope to get lucky on -- the exact adverse
    // interleaving the readiness gate above exists to close. `cfg(test)` only activates while
    // compiling this crate's own lib unit tests, so this never runs in a real binary or in
    // `tests/websocket.rs`'s integration coverage (a separate crate that links this one normally).
    #[cfg(test)]
    std::thread::sleep(std::time::Duration::from_millis(2));
    if let Some(id) = id {
        ctx.cancel_registry.lock().insert(id, abort_handle);
    }
    if let Some(ready_tx) = ready_tx {
        let _ = ready_tx.send(());
    }
}

/// Grouped arguments for [`run_passthrough_request`], keeping that function's argument count
/// reasonable.
struct PassthroughRequest<B> {
    dispatcher: Dispatcher<B>,
    line: String,
    state: ConnectionState,
    guard: Option<PassthroughGuard>,
}

/// Releases a passthrough request's `in_flight_ids` and `cancel_registry` entries exactly once, on
/// every exit path -- including `$/cancelRequest`'s task abortion, which drops this future in
/// place (whether at its current await point, or -- if aborted before ever being polled -- as part
/// of dropping the future's captured-but-never-executed initial state) instead of resuming past
/// it, so cleanup cannot depend on falling off the end of `run_passthrough_request`.
struct PassthroughGuard {
    id: RequestId,
    state: ConnectionState,
    cancel_registry: CancelRegistry,
}

impl Drop for PassthroughGuard {
    fn drop(&mut self) {
        self.state.in_flight_ids.lock().remove(&self.id);
        self.cancel_registry.lock().remove(&self.id);
    }
}

/// Dispatches a non-subscription request or notification frame, releasing its in-flight id and
/// cancel registration (if any, via the already-constructed [`PassthroughGuard`]) once the backend
/// call returns and before the response is enqueued -- unconditionally, even if the task is
/// aborted mid-flight. Mirrors `stdio::run_passthrough_request`, plus the `cancel_registry` cleanup
/// that binding has no notion of.
async fn run_passthrough_request<B>(request: PassthroughRequest<B>)
where
    B: ClusterBackend,
{
    let PassthroughRequest {
        dispatcher,
        line,
        state,
        guard,
    } = request;
    let response = dispatcher.dispatch(&line).await;
    drop(guard);
    let _ = state.outbound_tx.send(response).await;
}

/// Parses `text` as a `$/cancelRequest` notification, returning the target `RequestId` only when
/// both the JSON-RPC method matches and the body deserializes -- anything else (including every
/// other recognized or unrecognized method) is left for `classify_ndjson_line` to route.
fn parse_cancel_request(text: &str) -> Option<RequestId> {
    let notification: JsonRpcNotification<CancelRequestParams> = serde_json::from_str(text).ok()?;
    (notification.method == "$/cancelRequest").then_some(notification.params.id)
}

/// Sends `code`/`reason` on `close_tx` exactly once -- a no-op if a close was already signalled --
/// so the writer task emits one deterministic `Message::Close` and stops.
fn signal_close(
    close_tx: &mut Option<oneshot::Sender<CloseFrame>>,
    code: CloseCode,
    reason: &'static str,
) {
    if let Some(tx) = close_tx.take() {
        let _ = tx.send(CloseFrame {
            code,
            reason: Utf8Bytes::from_static(reason),
        });
    }
}

/// Drains the bounded outbound queue, writing each line as a `Message::Text` frame, until the
/// peer closes, every sender is dropped, or `close_tx` (see [`signal_close`]) fires -- in which
/// case one `Message::Close` is sent and the writer stops immediately without draining further
/// queued lines, mirroring `stdio::run_writer`'s "drain until torn down" shape plus the close
/// frame WebSocket framing requires that NDJSON has no equivalent of.
async fn run_writer<Si>(
    mut sink: Si,
    mut outbound_rx: mpsc::Receiver<String>,
    mut close_rx: oneshot::Receiver<CloseFrame>,
) where
    Si: Sink<Message, Error = WsError> + Unpin,
{
    loop {
        // Biased: once a close is signalled it must win even if `outbound_tx` is dropped in the
        // same tick (the caller drops it immediately after signalling close during shutdown) --
        // otherwise an unbiased `select!` picks between two simultaneously ready branches at
        // random, sometimes discarding this deterministic close code for `sink.close()`'s generic
        // code-less fallback below.
        tokio::select! {
            biased;
            close = &mut close_rx => {
                if let Ok(frame) = close {
                    let _ = sink.send(Message::Close(Some(frame))).await;
                }
                break;
            }
            line = outbound_rx.recv() => {
                match line {
                    Some(line) => {
                        if sink.send(Message::text(line)).await.is_err() {
                            break;
                        }
                    }
                    None => break,
                }
            }
        }
    }
    let _ = sink.close().await;
}

#[cfg(test)]
mod tests;
