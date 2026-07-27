//! Shared per-connection dispatch/setup/shutdown machinery driving both `serve_ndjson`'s and the
//! sibling `websocket` transport module's `serve_websocket`'s classify-then-spawn loop, so
//! results, events, and errors stay byte-equivalent between the stdio and WebSocket bindings.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use openengine_cluster_protocol::RequestId;
use parking_lot::Mutex;
use serde_json::Value;
use tokio::sync::{mpsc, OwnedSemaphorePermit, Semaphore};
use tokio::task::{JoinHandle, JoinSet};

use super::admission::{acquire_task_slot, reject_duplicate, InFlightIds, MAX_CONNECTION_TASKS};
use super::{
    agent_attach, logs, run_watch_subscription, ConnectionState, NdjsonLineKind, SubscriptionMap,
};
use crate::{ClusterBackend, Dispatcher};

/// Grace period given to already-spawned bounded backend dispatches to finish once the connection
/// closes. Subscription tasks are notified through their cancellation handles before shutdown;
/// any backend operation that does not finish inside this bound is force-aborted.
const SHUTDOWN_GRACE_PERIOD: Duration = Duration::from_millis(200);

/// Result of [`dispatch_classified_line`]'s shared subscription/cancel/admission handling for one
/// classified line, identical between `serve_ndjson` and the sibling `websocket` transport
/// module's `serve_websocket`. `Passthrough` is handed back to the caller -- after its own
/// duplicate-id rejection and task-slot acquisition have already run here -- only because each
/// binding's actual passthrough dispatch differs: the WebSocket binding additionally tracks a
/// best-effort `$/cancelRequest` registry stdio has no notion of.
pub(crate) enum LineDispatch {
    Handled,
    Passthrough {
        id: Option<RequestId>,
        permit: OwnedSemaphorePermit,
    },
}

/// Bundles the four per-connection handles [`dispatch_classified_line`] and its helpers thread
/// through, so callers -- `serve_ndjson` here and the sibling `websocket` transport module's
/// `serve_websocket` -- pass one context value instead of an ever-growing parameter list.
pub(crate) struct DispatchCtx<'a, B> {
    pub(crate) dispatcher: &'a Dispatcher<B>,
    pub(crate) state: &'a ConnectionState,
    pub(crate) task_slots: &'a Arc<Semaphore>,
    pub(crate) tasks: &'a mut JoinSet<()>,
}

/// Spawns `run` as a bounded, duplicate-id-rejecting, admission-controlled subscription task for
/// `id`/`params` -- shared by `dispatch_classified_line`'s `Watch`/`Logs`/`AgentAttach` arms, which
/// otherwise differ only in which subscription runner they spawn.
async fn spawn_subscription_task<B, F, Fut>(
    ctx: &mut DispatchCtx<'_, B>,
    id: RequestId,
    params: Value,
    run: F,
) where
    B: ClusterBackend,
    F: FnOnce(Dispatcher<B>, RequestId, Value, ConnectionState) -> Fut + Send + 'static,
    Fut: std::future::Future<Output = ()> + Send + 'static,
{
    if reject_duplicate(&ctx.state.in_flight_ids, &ctx.state.outbound_tx, id.clone()).await {
        return;
    }
    let Some(permit) =
        acquire_task_slot(ctx.task_slots, &ctx.state.outbound_tx, Some(id.clone())).await
    else {
        ctx.state.in_flight_ids.lock().remove(&id);
        return;
    };
    let task_dispatcher = ctx.dispatcher.clone();
    let task_state = ctx.state.clone();
    ctx.tasks.spawn(async move {
        let _permit = permit;
        run(task_dispatcher, id, params, task_state).await;
    });
}

/// Handles everything shared between `serve_ndjson` and `serve_websocket` for one classified line:
/// `subscription/cancel` notifications and `watch`/`logs`/`agent/attach` establishment, including
/// their admission control (duplicate-id rejection, task-slot acquisition). Only
/// [`NdjsonLineKind::Passthrough`] is handed back to the caller as [`LineDispatch::Passthrough`],
/// with its own admission already applied, so each binding can run its own passthrough dispatch.
pub(crate) async fn dispatch_classified_line<B>(
    kind: NdjsonLineKind,
    ctx: &mut DispatchCtx<'_, B>,
) -> LineDispatch
where
    B: ClusterBackend,
{
    match kind {
        NdjsonLineKind::Cancel(subscription_id) => {
            if let Some(cancel) = ctx.state.subscriptions.lock().remove(&subscription_id) {
                cancel.notify_one();
            }
            LineDispatch::Handled
        }
        NdjsonLineKind::Watch { id, params } => {
            spawn_subscription_task(ctx, id, params, run_watch_subscription).await;
            LineDispatch::Handled
        }
        NdjsonLineKind::Logs { id, params } => {
            spawn_subscription_task(ctx, id, params, logs::run_logs_subscription).await;
            LineDispatch::Handled
        }
        NdjsonLineKind::AgentAttach { id, params } => {
            spawn_subscription_task(ctx, id, params, agent_attach::run_agent_attach_subscription)
                .await;
            LineDispatch::Handled
        }
        NdjsonLineKind::Passthrough { id } => {
            if let Some(id) = id.clone() {
                if reject_duplicate(&ctx.state.in_flight_ids, &ctx.state.outbound_tx, id).await {
                    return LineDispatch::Handled;
                }
            }
            let Some(permit) =
                acquire_task_slot(ctx.task_slots, &ctx.state.outbound_tx, id.clone()).await
            else {
                if let Some(id) = id {
                    ctx.state.in_flight_ids.lock().remove(&id);
                }
                return LineDispatch::Handled;
            };
            LineDispatch::Passthrough { id, permit }
        }
    }
}

/// The per-connection tracking state shared by every spawned task, freshly constructed identically
/// by `serve_ndjson` and the sibling `websocket` transport module's `serve_websocket` -- everything
/// except the outbound queue itself (each binding constructs that differently: a plain
/// `mpsc::channel` here vs. one paired with a close-signal channel there).
pub(crate) struct ConnectionSetup {
    pub(crate) subscriptions: SubscriptionMap,
    pub(crate) task_slots: Arc<Semaphore>,
    pub(crate) tasks: JoinSet<()>,
    pub(crate) state: ConnectionState,
}

pub(crate) fn new_connection_setup(outbound_tx: &mpsc::Sender<String>) -> ConnectionSetup {
    let subscriptions: SubscriptionMap = Arc::new(Mutex::new(HashMap::new()));
    let in_flight_ids: InFlightIds = Arc::new(Mutex::new(HashSet::new()));
    let task_slots = Arc::new(Semaphore::new(MAX_CONNECTION_TASKS));
    let state = ConnectionState {
        outbound_tx: outbound_tx.clone(),
        subscriptions: Arc::clone(&subscriptions),
        in_flight_ids,
    };
    ConnectionSetup {
        subscriptions,
        task_slots,
        tasks: JoinSet::new(),
        state,
    }
}

/// Grouped arguments for [`shutdown_connection`], keeping that function's argument count
/// reasonable.
pub(crate) struct ShutdownArgs {
    pub(crate) subscriptions: SubscriptionMap,
    pub(crate) tasks: JoinSet<()>,
    pub(crate) outbound_tx: mpsc::Sender<String>,
    pub(crate) state: ConnectionState,
    pub(crate) writer_task: JoinHandle<()>,
}

/// Tears down one connection identically for `serve_ndjson` and `serve_websocket`: wakes every
/// live subscription's cancellation, gives already-spawned tasks [`SHUTDOWN_GRACE_PERIOD`] to
/// finish naturally before force-aborting the rest, then drops every sender so the writer task
/// drains and exits.
pub(crate) async fn shutdown_connection(args: ShutdownArgs) {
    let ShutdownArgs {
        subscriptions,
        mut tasks,
        outbound_tx,
        state,
        writer_task,
    } = args;
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
}
