//! White-box coverage for the cooperative `$/cancelRequest` lifecycle that cannot be observed
//! through the wire-level harness in `tests/websocket.rs`: structural guarantees that must hold
//! regardless of scheduling (registration precedes spawn, cleanup never disturbs a newer same-id
//! registration) plus the fastest-completion schedule.

use std::sync::Arc;

use async_trait::async_trait;
use openengine_cluster_protocol::{
    GetParams, GetResult, InitializeParams, InitializeResult, RequestId, RunId,
};
use tokio::sync::{Notify, Semaphore};

use super::*;
use crate::watch::fixtures::{FixtureBackend, FixtureStore};
use crate::{BackendError, ConnectionContext};

/// Wraps [`FixtureBackend`] so `get` blocks on an explicit [`Notify`] gate, making the
/// registration-precedes-spawn assertion deterministic instead of racing a real dispatch.
struct GatedBackend {
    inner: FixtureBackend,
    gate: Arc<Notify>,
}

#[async_trait]
impl ClusterBackend for GatedBackend {
    async fn initialize(
        &self,
        context: &ConnectionContext,
        params: InitializeParams,
    ) -> Result<InitializeResult, BackendError> {
        self.inner.initialize(context, params).await
    }

    async fn get(
        &self,
        context: &ConnectionContext,
        params: GetParams,
    ) -> Result<GetResult, BackendError> {
        self.gate.notified().await;
        self.inner.get(context, params).await
    }
}

fn fixture_backend() -> FixtureBackend {
    let store = Arc::new(FixtureStore::new(RunId::new("run-1"), Vec::new(), 8));
    FixtureBackend::new(store)
}

fn get_request_line(id: i64) -> String {
    format!(r#"{{"jsonrpc":"2.0","id":{id},"method":"get","params":{{}}}}"#)
}

fn test_permit(task_slots: &Arc<Semaphore>) -> OwnedSemaphorePermit {
    Arc::clone(task_slots)
        .try_acquire_owned()
        .expect("fresh semaphore must have a free permit")
}

/// Regression test for race 2 (spawn-before-register): the old code called `tasks.spawn(...)`
/// before inserting the abort handle into `cancel_registry`, so a pathologically fast dispatch
/// could self-remove a not-yet-present entry and the caller would then insert a stale handle for
/// an already-finished task. `spawn_passthrough` now inserts synchronously before spawning, so the
/// entry is provably present the instant the call returns -- checked here before the spawned task
/// (blocked on `gate`) can possibly have run any code, proving this holds structurally rather than
/// typically.
#[tokio::test]
async fn spawn_passthrough_registers_cancellation_before_the_task_can_run() {
    let (outbound_tx, _outbound_rx) = mpsc::channel::<String>(4);
    let ConnectionSetup {
        task_slots,
        mut tasks,
        state,
        ..
    } = new_connection_setup(&outbound_tx);
    let cancel_registry: CancelRegistry = Arc::new(Mutex::new(HashMap::new()));
    let mut close_tx: Option<oneshot::Sender<CloseFrame>> = None;

    let backend = GatedBackend {
        inner: fixture_backend(),
        gate: Arc::new(Notify::new()),
    };
    let dispatcher = Dispatcher::new(backend, ConnectionContext::default());
    let permit = test_permit(&task_slots);
    let id = RequestId::Integer(1);

    {
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
        spawn_passthrough(&mut ctx, Some(id.clone()), permit, get_request_line(1));
    }

    // `spawn_passthrough` has no `.await` of its own, so returning here happens strictly after the
    // synchronous registry insert and strictly before the runtime has had any opportunity to poll
    // the just-spawned task -- this assertion cannot observe a not-yet-registered entry.
    assert!(
        cancel_registry.lock().contains_key(&id),
        "cancel_registry must contain the entry the instant spawn_passthrough returns"
    );

    // Let the still-gated task be aborted by JoinSet shutdown rather than leak past the test.
    tasks.shutdown().await;
}

/// Regression test for the fastest-completion schedule (acceptance criterion 2): a request that
/// completes without ever being cancelled must leave neither an in-flight id nor a cancel-registry
/// entry behind.
#[tokio::test]
async fn run_passthrough_request_on_instant_completion_leaves_registry_empty() {
    let (outbound_tx, mut outbound_rx) = mpsc::channel::<String>(4);
    let ConnectionSetup { state, .. } = new_connection_setup(&outbound_tx);
    let dispatcher = Dispatcher::new(fixture_backend(), ConnectionContext::default());
    let cancel_registry: CancelRegistry = Arc::new(Mutex::new(HashMap::new()));
    let cancel_notify = Arc::new(Notify::new());
    let id = RequestId::Integer(7);
    cancel_registry
        .lock()
        .insert(id.clone(), Arc::clone(&cancel_notify));
    state.in_flight_ids.lock().insert(id.clone());

    run_passthrough_request(PassthroughRequest {
        dispatcher,
        id: Some(id.clone()),
        line: get_request_line(7),
        state: state.clone(),
        cancel_registry: Arc::clone(&cancel_registry),
        cancel_notify,
    })
    .await;

    assert!(
        cancel_registry.lock().is_empty(),
        "a completed request must leave no cancel-registry entry"
    );
    assert!(
        state.in_flight_ids.lock().is_empty(),
        "a completed request must leave no in-flight id"
    );
    let response = outbound_rx
        .recv()
        .await
        .expect("a completed (non-cancelled) request must still enqueue exactly one response");
    assert!(response.contains("\"result\""), "{response}");
}

/// Direct, deterministic proof of race 3's safety property (acceptance criterion 4): an old
/// request's ownership-checked cleanup must never remove a newer same-id request's fresh
/// registration. Exercised at the unit level -- rather than by trying to win a genuine
/// scheduler race between two tokio tasks, which the underlying code makes impossible to force
/// deterministically since neither lock acquisition in the cleanup path has an intervening
/// `.await` -- so this proves the guard is correct under any possible interleaving, not just one
/// a test happened to schedule.
#[test]
fn release_owned_cancel_entry_never_removes_a_newer_registration() {
    let cancel_registry: CancelRegistry = Arc::new(Mutex::new(HashMap::new()));
    let id = RequestId::Integer(1);
    let old_notify = Arc::new(Notify::new());
    let new_notify = Arc::new(Notify::new());

    // Simulate: the old request registered first, then a same-id retry already overwrote the
    // entry with its own fresh registration before the old request's cleanup ran.
    cancel_registry
        .lock()
        .insert(id.clone(), Arc::clone(&old_notify));
    cancel_registry
        .lock()
        .insert(id.clone(), Arc::clone(&new_notify));

    release_owned_cancel_entry(&cancel_registry, &id, &old_notify);

    let registry = cancel_registry.lock();
    let current = registry
        .get(&id)
        .expect("the newer registration must survive the older request's cleanup");
    assert!(
        Arc::ptr_eq(current, &new_notify),
        "cleanup must leave the newer registration untouched, not just non-empty"
    );
}

/// Baseline counterpart: when it *is* still the same registration, cleanup does remove it -- the
/// registry must not grow unbounded across ordinary (non-raced) request lifetimes.
#[test]
fn release_owned_cancel_entry_removes_its_own_untouched_registration() {
    let cancel_registry: CancelRegistry = Arc::new(Mutex::new(HashMap::new()));
    let id = RequestId::Integer(1);
    let notify = Arc::new(Notify::new());
    cancel_registry
        .lock()
        .insert(id.clone(), Arc::clone(&notify));

    release_owned_cancel_entry(&cancel_registry, &id, &notify);

    assert!(cancel_registry.lock().is_empty());
}
