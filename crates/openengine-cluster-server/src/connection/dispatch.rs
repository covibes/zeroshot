//! Shared per-connection dispatch, setup, and shutdown machinery driving every wire binding's
//! classify-then-spawn loop so results, events, and errors stay byte-equivalent between bindings.

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use openengine_cluster_protocol::{RequestId, SubscriptionId};
use parking_lot::Mutex;
use serde_json::Value;
use tokio::sync::{mpsc, OwnedSemaphorePermit, Semaphore};
use tokio::task::{JoinHandle, JoinSet};

use super::admission::{acquire_task_slot, reject_duplicate, InFlightIds, MAX_CONNECTION_TASKS};
use super::{
    agent_attach, logs, native_v2, run_watch_subscription, ConnectionState, DecodedOutcome,
    RequestKind, SubscriptionMap,
};
use crate::method_registry::SubscriptionKind;
use crate::{ClusterBackend, Dispatcher};

/// Grace period given to already-spawned bounded backend dispatches to finish once the connection
/// closes. Subscription tasks are notified through their cancellation handles before shutdown;
/// any backend operation that does not finish inside this bound is force-aborted.
const SHUTDOWN_GRACE_PERIOD: Duration = Duration::from_millis(200);

/// Result of [`dispatch_classified_request`]'s shared subscription/cancel/admission handling for
/// one classified request. `Passthrough` is handed back to the caller -- after its own
/// duplicate-id rejection and task-slot acquisition have already run here -- only because each
/// binding's actual passthrough dispatch may have additional transport-specific bookkeeping.
pub(crate) enum RequestDispatch {
    Handled,
    Passthrough {
        admission_id: Option<RequestId>,
        outcome: DecodedOutcome,
        permit: OwnedSemaphorePermit,
    },
}

/// Bundles the four per-connection handles [`dispatch_classified_request`] and its helpers thread
/// through, so bindings pass one context value instead of an ever-growing parameter list.
pub(crate) struct DispatchCtx<'a, B> {
    pub(crate) dispatcher: &'a Dispatcher<B>,
    pub(crate) state: &'a ConnectionState,
    pub(crate) task_slots: &'a Arc<Semaphore>,
    pub(crate) tasks: &'a mut JoinSet<()>,
}

/// Spawns `run` as a bounded, duplicate-id-rejecting, admission-controlled subscription task for
/// `id`/`params`.
async fn spawn_subscription_task<B, F, Fut>(
    ctx: &mut DispatchCtx<'_, B>,
    id: RequestId,
    params: Value,
    run: F,
) where
    B: ClusterBackend,
    F: FnOnce(Dispatcher<B>, RequestId, Value, ConnectionState) -> Fut + Send + 'static,
    Fut: Future<Output = ()> + Send + 'static,
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

/// Handles the transport-neutral core for one classified request: `subscription/cancel` and
/// subscription establishment, including duplicate-id rejection and task-slot admission. Only
/// [`RequestKind::Passthrough`] is handed back to the caller as
/// [`RequestDispatch::Passthrough`], with its own admission already applied, so each binding can
/// run its own passthrough dispatch.
pub(crate) async fn dispatch_classified_request<B>(
    kind: RequestKind,
    ctx: &mut DispatchCtx<'_, B>,
) -> RequestDispatch
where
    B: ClusterBackend,
{
    match kind {
        RequestKind::Cancel(subscription_id) => handle_cancel(ctx, &subscription_id),
        RequestKind::Subscription { kind, id, params } => {
            dispatch_subscription(kind, id, params, ctx).await;
            RequestDispatch::Handled
        }
        RequestKind::Passthrough {
            admission_id,
            outcome,
        } => admit_passthrough(admission_id, outcome, ctx).await,
    }
}

fn handle_cancel<B>(ctx: &DispatchCtx<'_, B>, subscription_id: &SubscriptionId) -> RequestDispatch {
    if let Some(cancel) = ctx.state.subscriptions.lock().remove(subscription_id) {
        cancel.notify_one();
    }
    RequestDispatch::Handled
}

async fn dispatch_subscription<B>(
    kind: SubscriptionKind,
    id: RequestId,
    params: Value,
    ctx: &mut DispatchCtx<'_, B>,
) where
    B: ClusterBackend,
{
    match kind {
        SubscriptionKind::Watch => {
            spawn_subscription_task(ctx, id, params, run_watch_subscription).await;
        }
        SubscriptionKind::Logs => {
            spawn_subscription_task(ctx, id, params, logs::run_logs_subscription).await;
        }
        SubscriptionKind::AgentAttach => {
            spawn_subscription_task(ctx, id, params, agent_attach::run_agent_attach_subscription)
                .await;
        }
        SubscriptionKind::RunWatch => {
            spawn_subscription_task(ctx, id, params, native_v2::run_run_watch_subscription).await;
        }
        SubscriptionKind::RunLogs => {
            spawn_subscription_task(ctx, id, params, native_v2::run_run_logs_subscription).await;
        }
        SubscriptionKind::RunAttach => {
            spawn_subscription_task(ctx, id, params, native_v2::run_run_attach_subscription).await;
        }
    }
}

async fn admit_passthrough<B>(
    admission_id: Option<RequestId>,
    outcome: DecodedOutcome,
    ctx: &DispatchCtx<'_, B>,
) -> RequestDispatch
where
    B: ClusterBackend,
{
    if let Some(id) = admission_id.clone() {
        if reject_duplicate(&ctx.state.in_flight_ids, &ctx.state.outbound_tx, id).await {
            return RequestDispatch::Handled;
        }
    }
    let Some(permit) =
        acquire_task_slot(ctx.task_slots, &ctx.state.outbound_tx, admission_id.clone()).await
    else {
        if let Some(id) = admission_id {
            ctx.state.in_flight_ids.lock().remove(&id);
        }
        return RequestDispatch::Handled;
    };
    RequestDispatch::Passthrough {
        admission_id,
        outcome,
        permit,
    }
}

/// The per-connection tracking state shared by every spawned task, freshly constructed identically
/// by every binding except for the outbound queue itself, which each binding supplies.
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

/// Tears down one connection identically for every binding: wakes every live subscription's
/// cancellation, gives already-spawned tasks [`SHUTDOWN_GRACE_PERIOD`] to finish naturally before
/// force-aborting the rest, then drops every sender so the writer task drains and exits.
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
