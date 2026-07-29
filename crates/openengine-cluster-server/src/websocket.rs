//! Production WebSocket transport binding the backend-neutral [`Dispatcher`] and generic
//! subscription framing to the wire. One JSON-RPC object per text message; this module reuses the
//! transport-neutral connection core's exact admission and subscription-streaming machinery so
//! results, events, and errors stay byte-equivalent between the NDJSON and WebSocket bindings.
//! Framing rules unique to WebSocket -- binary rejection, the 1,048,576 UTF-8 byte bound, and
//! cooperative, ownership-safe `$/cancelRequest` -- live only here.

use std::collections::HashMap;
use std::io;
use std::sync::Arc;

use futures_util::stream::SplitStream;
use futures_util::{Sink, SinkExt, StreamExt};
use openengine_cluster_protocol::RequestId;
use parking_lot::Mutex;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::{mpsc, oneshot, Notify, OwnedSemaphorePermit};
use tokio::task::JoinSet;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::protocol::{CloseFrame, WebSocketConfig};
use tokio_tungstenite::tungstenite::{Error as WsError, Message, Utf8Bytes};
use tokio_tungstenite::WebSocketStream;

use crate::connection::{
    dispatch_classified_request, new_connection_setup, race_cancel_or_next, shutdown_connection,
    ConnectionSetup, ConnectionState, DecodedFrame, DecodedOutcome, DecodedRequest, DispatchCtx,
    RequestDispatch, RequestKind, ShutdownArgs,
};
use crate::{ClusterBackend, Dispatcher};

/// Bounded WebSocket text-frame length: a text message whose UTF-8 byte length exceeds this
/// closes the connection with code 1009 (message too big), matching `stdio::serve_ndjson`'s
/// NDJSON line bound.
pub const MAX_FRAME_BYTES: usize = 1_048_576;

/// Bounded per-connection outbound queue, matching `stdio::serve_ndjson`'s bound.
const OUTBOUND_QUEUE_CAPACITY: usize = 256;

/// Per-connection registry of cooperative cancellation signals for in-flight passthrough (unary)
/// request tasks, keyed by their [`RequestId`]. [`spawn_passthrough`] registers a task's entry
/// synchronously *before* spawning it, so the entry always exists before the task can possibly run
/// or complete -- no scheduling race. `$/cancelRequest` looks an id up here and notifies it; an
/// absent id (unknown, or already completed and cleaned up) is silently a no-op. A task's own
/// cleanup (`run_passthrough_request`) removes only its own registration, verified via
/// `Arc::ptr_eq` against the entry currently stored under its id, so an old request's cleanup can
/// never delete a newer same-id request's fresh registration. Establishing requests (`watch`/
/// `logs`/`agent/attach`) are not registered here -- their in-flight lifetime is already covered by
/// `subscription/cancel` once established, and is intentionally short.
type CancelRegistry = Arc<Mutex<HashMap<RequestId, Arc<Notify>>>>;

/// WebSocket configuration enforcing [`MAX_FRAME_BYTES`] as the incoming message size bound, so
/// tungstenite itself rejects an oversized message during frame reassembly rather than buffering
/// it without limit ahead of this binding's own explicit length check.
#[must_use]
pub fn websocket_config() -> WebSocketConfig {
    WebSocketConfig::default().max_message_size(Some(MAX_FRAME_BYTES))
}

/// Serves one already-handshaken WebSocket connection: demultiplexes unary requests and `watch`/
/// `logs`/`agent/attach` subscriptions sharing this connection exactly like `stdio::serve_ndjson`,
/// plus per-connection cooperative `$/cancelRequest`. Binary frames close with code 1003;
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
/// WebSocket binding (the cooperative `$/cancelRequest` registry and the deterministic-close
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

/// Handles one `Message::Text` frame: enforces [`MAX_FRAME_BYTES`], decodes exactly once, routes a
/// valid `$/cancelRequest` notification inline, and otherwise admits the decoded outcome.
async fn handle_text_frame<B>(text: Utf8Bytes, ctx: &mut WsCtx<'_, B>) -> FrameOutcome
where
    B: ClusterBackend,
{
    if text.len() > MAX_FRAME_BYTES {
        signal_close(ctx.close_tx, CloseCode::Size, "message too big");
        return FrameOutcome::Break;
    }
    let kind = match DecodedFrame::decode(&text) {
        Ok(frame) => {
            if let Some(cancel_id) = frame.cancel_request_id() {
                // Notify only -- never remove here. Removal happens exactly once, in the owning
                // task's ownership-checked cleanup.
                if let Some(notify) = ctx.cancel_registry.lock().get(&cancel_id) {
                    notify.notify_one();
                }
                return FrameOutcome::Continue;
            }
            frame.into_request_kind()
        }
        Err(response) => RequestKind::Passthrough {
            admission_id: None,
            outcome: DecodedOutcome::Response(response),
        },
    };
    if let RequestDispatch::Passthrough {
        admission_id,
        outcome,
        permit,
    } = dispatch_classified_request(kind, &mut ctx.dispatch).await
    {
        spawn_passthrough(ctx, admission_id, outcome, permit);
    }
    FrameOutcome::Continue
}

/// Spawns an admitted passthrough outcome, registering cooperative cancellation under the legacy
/// classification id synchronously before the task can run.
fn spawn_passthrough<B>(
    ctx: &mut WsCtx<'_, B>,
    admission_id: Option<RequestId>,
    outcome: DecodedOutcome,
    permit: OwnedSemaphorePermit,
) where
    B: ClusterBackend,
{
    let task_dispatcher = ctx.dispatch.dispatcher.clone();
    let task_state = ctx.dispatch.state.clone();
    let task_cancel_registry = Arc::clone(ctx.cancel_registry);
    let cancel_notify = Arc::new(Notify::new());
    if let Some(id) = &admission_id {
        ctx.cancel_registry
            .lock()
            .insert(id.clone(), Arc::clone(&cancel_notify));
    }
    ctx.dispatch.tasks.spawn(async move {
        let _permit = permit;
        run_passthrough_request(PassthroughRequest {
            dispatcher: task_dispatcher,
            admission_id,
            outcome,
            state: task_state,
            cancel_registry: task_cancel_registry,
            cancel_notify,
        })
        .await;
    });
}

/// Grouped arguments for [`run_passthrough_request`].
struct PassthroughRequest<B> {
    dispatcher: Dispatcher<B>,
    admission_id: Option<RequestId>,
    outcome: DecodedOutcome,
    state: ConnectionState,
    cancel_registry: CancelRegistry,
    cancel_notify: Arc<Notify>,
}

/// Resolves one admitted outcome, racing it against cooperative `$/cancelRequest` and applying
/// ownership-checked cleanup.
async fn run_passthrough_request<B>(request: PassthroughRequest<B>)
where
    B: ClusterBackend,
{
    let PassthroughRequest {
        dispatcher,
        admission_id,
        outcome,
        state,
        cancel_registry,
        cancel_notify,
    } = request;
    let response = race_cancel_or_next(&cancel_notify, async {
        Some(match outcome {
            DecodedOutcome::Request(DecodedRequest { id, method, params }) => {
                dispatcher.dispatch_decoded(id, &method, params).await
            }
            DecodedOutcome::Response(response) => response,
        })
    })
    .await;
    if let Some(id) = &admission_id {
        state.in_flight_ids.lock().remove(id);
        release_owned_cancel_entry(&cancel_registry, id, &cancel_notify);
    }
    if let Some(response) = response {
        let _ = state.outbound_tx.send(response).await;
    }
}

/// Removes `cancel_registry`'s entry for `id` only if it is still owned by `notify`.
fn release_owned_cancel_entry(
    cancel_registry: &CancelRegistry,
    id: &RequestId,
    notify: &Arc<Notify>,
) {
    let mut registry = cancel_registry.lock();
    if registry
        .get(id)
        .is_some_and(|existing| Arc::ptr_eq(existing, notify))
    {
        registry.remove(id);
    }
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
