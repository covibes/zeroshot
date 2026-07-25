use std::time::Duration;

use openengine_cluster_protocol::RunId;
use serde_json::{json, Value};

use super::*;
use crate::stdio::{
    classify_ndjson_line, dispatch_classified_line, new_connection_setup, ConnectionSetup,
    DispatchCtx, LineDispatch,
};
use crate::watch::fixtures::{FixtureBackend, FixtureStore};
use crate::ConnectionContext;

/// Regression test for the spawn-before-register race in `spawn_passthrough`: pre-fix, the newly
/// spawned passthrough task starts running immediately once handed to the scheduler and, once its
/// (near-instant, in-memory) dispatch resolves, removes its own `cancel_registry` entry as part of
/// normal cleanup -- a no-op if that happens before the caller's `insert` for the same id has run.
/// Nothing in the pre-fix code establishes a happens-before relationship between "the task is
/// schedulable" and "the caller's insert completes", so if the removal is observed first, the
/// caller's later insert leaves a stale handle for an already-finished request that nothing will
/// ever clean up.
///
/// Real scheduling alone essentially never reproduces this: the caller attempts its insert within
/// nanoseconds of spawning (no other work in between), while the spawned task needs a genuine
/// cross-thread scheduling round-trip before it can even begin dispatch, so the safe
/// insert-then-remove ordering dominates overwhelmingly by default (independently confirmed by
/// running an all-real-timing version of this test hundreds of times against the pre-fix code
/// without once observing the race). To make the test actually exercise the interleaving the issue
/// requires proving fixed, `spawn_passthrough` widens that window under `#[cfg(test)]` only (a
/// no-op in every real binary and in `tests/websocket.rs`'s separate-crate integration coverage),
/// giving the spawned task's cleanup a deterministic chance to run first.
///
/// Post-fix, `spawn_passthrough`'s readiness gate means the spawned task cannot attempt *any* work
/// -- including reaching its own cleanup -- until a readiness signal fires, which is sent only
/// after the caller's insert has already completed. Widening the same window therefore cannot move
/// the outcome post-fix: the spawned task is still parked behind the gate regardless of how long
/// the caller takes to reach its insert, so registration remains happens-before any request work by
/// construction. That asymmetry -- reliably broken pre-fix, structurally unbreakable post-fix -- is
/// exactly what this test proves.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn fast_completion_race_cannot_leave_stale_registry_entry() {
    let store = Arc::new(FixtureStore::new(RunId::new("run-1"), Vec::new(), 8));
    let dispatcher = Dispatcher::new(FixtureBackend::new(store), ConnectionContext::default());
    let (outbound_tx, mut outbound_rx) = mpsc::channel::<String>(256);
    let ConnectionSetup {
        task_slots,
        mut tasks,
        state,
        ..
    } = new_connection_setup(&outbound_tx);
    let cancel_registry: CancelRegistry = Arc::new(Mutex::new(HashMap::new()));

    const TRIALS: i64 = 20;
    for trial in 0..TRIALS {
        let id = RequestId::Integer(trial);
        let line =
            json!({"jsonrpc": "2.0", "id": trial, "method": "get", "params": {}}).to_string();

        let kind = classify_ndjson_line(&line);
        let mut dispatch_ctx = DispatchCtx {
            dispatcher: &dispatcher,
            state: &state,
            task_slots: &task_slots,
            tasks: &mut tasks,
        };
        let LineDispatch::Passthrough { id: got_id, permit } =
            dispatch_classified_line(kind, &mut dispatch_ctx).await
        else {
            panic!("expected a passthrough dispatch for a `get` request");
        };
        assert_eq!(got_id.as_ref(), Some(&id));

        let mut close_tx: Option<oneshot::Sender<CloseFrame>> = None;
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
        spawn_passthrough(&mut ctx, got_id, permit, line);

        // Drain this trial's task to completion (its post-dispatch cleanup, whichever way the
        // race landed, has therefore already run) before inspecting registry state.
        while tasks.join_next().await.is_some() {}

        let response = tokio::time::timeout(Duration::from_secs(1), outbound_rx.recv())
            .await
            .expect("the request must receive its response promptly")
            .expect("outbound channel must not close mid-test");
        let response: Value = serde_json::from_str(&response).unwrap();
        assert_eq!(response["id"], trial);
        assert!(response.get("result").is_some(), "{response}");

        assert!(
            cancel_registry.lock().is_empty(),
            "trial {trial}: a stale cancel_registry entry survived a fast completion racing the \
             caller's registration -- insert is not guaranteed to happen-before the spawned task \
             can observe/complete its own cleanup"
        );
    }
}
