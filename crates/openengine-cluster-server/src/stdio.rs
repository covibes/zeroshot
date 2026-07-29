//! NDJSON framing and stdin/stdout binding for the transport-neutral connection core.

use std::io;

use openengine_cluster_protocol::{
    JsonRpcNotification, JsonRpcRequest, RequestId, SubscriptionCancelParams, PARSE_ERROR,
};
use serde_json::Value;
use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt};
use tokio::sync::mpsc;
use tokio_stream::StreamExt;
use tokio_util::codec::{Framed, LinesCodec, LinesCodecError};

use crate::connection::{
    dispatch_classified_request, new_connection_setup, shutdown_connection, ConnectionSetup,
    ConnectionState, DispatchCtx, RequestDispatch, RequestKind, ShutdownArgs,
};
use crate::{serialize_error, ClusterBackend, Dispatcher};

/// Bounded NDJSON frame length. A line exceeding this (with no terminating newline found first)
/// is rejected with a `PARSE_ERROR` frame rather than buffered without limit.
const MAX_FRAME_BYTES: usize = 1_048_576;

/// Bounded per-connection outbound queue: unary responses and subscription notifications share
/// this single writer queue, so one pathologically slow peer backpressures further writes rather
/// than growing memory without bound.
const OUTBOUND_QUEUE_CAPACITY: usize = 256;

/// Drains the bounded outbound queue until the peer closes or every sender is dropped.
async fn run_writer<W>(mut writer: W, mut outbound_rx: mpsc::Receiver<String>)
where
    W: AsyncWrite + Unpin,
{
    while let Some(line) = outbound_rx.recv().await {
        if writer.write_all(line.as_bytes()).await.is_err()
            || writer.write_all(b"\n").await.is_err()
            || writer.flush().await.is_err()
        {
            break;
        }
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

    let ConnectionSetup {
        subscriptions,
        task_slots,
        mut tasks,
        state,
    } = new_connection_setup(&outbound_tx);

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
                // `Framed`'s stream terminates for good after yielding any decode error, so
                // `LinesCodec`'s discard-until-next-newline resync would otherwise never run.
                // Rebuilding via `from_parts`/`into_parts` matters: the buffer's leftover bytes
                // may already contain complete lines past the discarded one, and only
                // `from_parts` marks the rebuilt reader immediately readable from that buffer.
                // Reconstructing via `Framed::new` and copying the buffer leaves it believing the
                // buffer is empty, so it blocks on a fresh read instead of decoding buffered data.
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

        let mut ctx = DispatchCtx {
            dispatcher: &dispatcher,
            state: &state,
            task_slots: &task_slots,
            tasks: &mut tasks,
        };
        dispatch_ndjson_line(line, &mut ctx).await;
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

/// Classifies and dispatches one decoded NDJSON line, spawning passthrough work after the shared
/// connection core applies duplicate-id rejection and task admission.
async fn dispatch_ndjson_line<B>(line: String, ctx: &mut DispatchCtx<'_, B>)
where
    B: ClusterBackend,
{
    let kind = classify_ndjson_line(&line);
    if let RequestDispatch::Passthrough { id, permit } =
        dispatch_classified_request(kind, ctx).await
    {
        let task_dispatcher = ctx.dispatcher.clone();
        let task_state = ctx.state.clone();
        ctx.tasks.spawn(async move {
            let _permit = permit;
            run_passthrough_request(task_dispatcher, id, line, task_state).await;
        });
    }
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

/// Classifies a decoded NDJSON line without fully deserializing its params: a `watch`/`logs`/
/// `agent/attach` request is pulled out for subscription handling, a `subscription/cancel`
/// notification is pulled out for inline cancellation, and everything else (including malformed
/// JSON) passes through to [`Dispatcher::dispatch`] unchanged.
pub(crate) fn classify_ndjson_line(line: &str) -> RequestKind {
    if let Ok(request) = serde_json::from_str::<JsonRpcRequest<Value>>(line) {
        if request.method == "watch" {
            return RequestKind::Watch {
                id: request.id,
                params: request.params,
            };
        }
        if request.method == "logs" {
            return RequestKind::Logs {
                id: request.id,
                params: request.params,
            };
        }
        if request.method == "agent/attach" {
            return RequestKind::AgentAttach {
                id: request.id,
                params: request.params,
            };
        }
        return RequestKind::Passthrough {
            id: Some(request.id),
        };
    }
    if let Ok(notification) =
        serde_json::from_str::<JsonRpcNotification<SubscriptionCancelParams>>(line)
    {
        if notification.method == "subscription/cancel" {
            return RequestKind::Cancel(notification.params.subscription_id);
        }
    }
    RequestKind::Passthrough { id: None }
}
