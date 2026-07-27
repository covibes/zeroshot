use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;

#[path = "support/execution_contract.rs"]
mod execution_contract;
#[path = "support/execution_runtime.rs"]
mod execution_runtime;

use tokio::sync::Notify;
use zeroshot_engine::execution::local::LocalExecutionRuntime;
use zeroshot_engine::execution::{
    DispatchObservation, ExecutionObservation, ExecutionRuntime, SessionScope,
};
use zeroshot_engine::fault::EvidenceClass;

use execution_contract::{agent_target, builtin_target};
use execution_runtime::{
    CommandSpec, FakeResolver, ResolverOutcome, Scenario, command, empty_driver, fault, result,
    runtime_for,
};

#[tokio::test]
async fn recovery_is_registered_before_launch_and_prelaunch_failure_is_definite() {
    let prelaunch_fault = fault(EvidenceClass::Unavailable);
    let runtime_slot = Arc::new(tokio::sync::Mutex::new(None));
    let recovery_checked = Arc::new(AtomicBool::new(false));
    let resolver = Arc::new(FakeResolver {
        driver: empty_driver(),
        runtime_slot: Arc::clone(&runtime_slot),
        recovery_checked: Arc::clone(&recovery_checked),
        outcome: ResolverOutcome::DefinitelyNotStarted(prelaunch_fault),
    });
    let runtime = LocalExecutionRuntime::new(resolver);
    *runtime_slot.lock().await = Some(runtime.clone());

    let observation = runtime
        .dispatch(command(CommandSpec {
            execution: 11,
            fence: 1,
            recovery: "recovery-11",
            target: agent_target(true),
            scope: SessionScope::Execution,
        }))
        .await;
    assert!(matches!(
        observation,
        DispatchObservation::DefinitelyNotStarted { .. }
    ));
    assert!(recovery_checked.load(Ordering::SeqCst));
}

#[tokio::test]
async fn resolver_indeterminate_stays_indeterminate() {
    let runtime_slot = Arc::new(tokio::sync::Mutex::new(None));
    let resolver = Arc::new(FakeResolver {
        driver: empty_driver(),
        runtime_slot: Arc::clone(&runtime_slot),
        recovery_checked: Arc::new(AtomicBool::new(false)),
        outcome: ResolverOutcome::Indeterminate(fault(EvidenceClass::Timeout)),
    });
    let runtime = LocalExecutionRuntime::new(resolver);
    *runtime_slot.lock().await = Some(runtime.clone());

    let observation = runtime
        .dispatch(command(CommandSpec {
            execution: 18,
            fence: 1,
            recovery: "recovery-18",
            target: agent_target(true),
            scope: SessionScope::Execution,
        }))
        .await;
    assert!(matches!(
        observation,
        DispatchObservation::Indeterminate { .. }
    ));
}

#[tokio::test]
async fn may_have_started_becomes_completed_on_inspect() {
    let runtime = runtime_for(vec![Scenario::MayHaveStarted {
        fault: Some(fault(EvidenceClass::ProcessExited)),
        result: result("complete-after-maybe-started"),
    }])
    .await;
    let command = command(CommandSpec {
        execution: 12,
        fence: 1,
        recovery: "recovery-12",
        target: agent_target(true),
        scope: SessionScope::Execution,
    });
    let observation = runtime.dispatch(command.clone()).await;
    assert!(matches!(
        observation,
        DispatchObservation::MayHaveStarted { .. }
    ));
    tokio::task::yield_now().await;
    assert!(matches!(
        runtime.inspect(command.control()).await,
        ExecutionObservation::Completed { .. }
    ));
}

#[tokio::test]
async fn post_launch_panic_before_return_is_inspectable() {
    let launched = Arc::new(AtomicBool::new(false));
    let runtime = runtime_for(vec![Scenario::PanicAfterLaunchBeforeReturn {
        launched: Arc::clone(&launched),
    }])
    .await;
    let command = command(CommandSpec {
        execution: 19,
        fence: 1,
        recovery: "recovery-19",
        target: agent_target(true),
        scope: SessionScope::Execution,
    });

    let observation = runtime.dispatch(command.clone()).await;
    assert!(launched.load(Ordering::SeqCst));
    assert!(matches!(
        observation,
        DispatchObservation::Indeterminate { fault: Some(_), .. }
    ));
    assert!(matches!(
        runtime.inspect(command.control()).await,
        ExecutionObservation::Indeterminate { fault: Some(_), .. }
    ));
    assert!(matches!(
        runtime.dispatch(command.clone()).await,
        DispatchObservation::Indeterminate { fault: Some(_), .. }
    ));
    assert_eq!(runtime.tracked_counts().await, (0, 0, 1));
    assert!(runtime.release_terminal(&command.control()).await);
    assert_eq!(runtime.tracked_counts().await, (0, 0, 0));
}

#[tokio::test]
async fn terminal_executions_release_live_tracking_and_allow_explicit_terminal_release() {
    let mut scenarios = Vec::new();
    for index in 0..70 {
        scenarios.push(Scenario::Completed(result(&format!("terminal-{index}"))));
    }
    let runtime = runtime_for(scenarios).await;
    let mut commands = Vec::new();

    for execution in 30..100 {
        let recovery = format!("recovery-{execution}");
        let command = command(CommandSpec {
            execution,
            fence: 1,
            recovery: &recovery,
            target: builtin_target(),
            scope: SessionScope::Execution,
        });
        let observation = runtime.dispatch(command.clone()).await;
        assert!(matches!(observation, DispatchObservation::Completed { .. }));
        commands.push(command);
    }

    assert_eq!(runtime.tracked_counts().await, (0, 0, 70));
    for command in [commands.first().unwrap(), commands.last().unwrap()] {
        assert!(matches!(
            runtime.inspect(command.control()).await,
            ExecutionObservation::Completed { .. }
        ));
        assert!(matches!(
            runtime.dispatch((*command).clone()).await,
            DispatchObservation::Completed { .. }
        ));
    }
    for command in &commands {
        assert!(runtime.release_terminal(&command.control()).await);
    }
    assert_eq!(runtime.tracked_counts().await, (0, 0, 0));
}

#[tokio::test]
async fn dropped_dispatch_future_does_not_drop_launched_work() {
    let start = Arc::new(Notify::new());
    let waiting = Arc::new(AtomicBool::new(false));
    let completion = Arc::new(Notify::new());
    let runtime = runtime_for(vec![Scenario::WaitStartThenRun {
        start: Arc::clone(&start),
        waiting: Arc::clone(&waiting),
        completion: Arc::clone(&completion),
        result: result("finished-after-drop"),
    }])
    .await;
    let command = command(CommandSpec {
        execution: 13,
        fence: 1,
        recovery: "recovery-13",
        target: agent_target(true),
        scope: SessionScope::Execution,
    });

    let task = tokio::spawn({
        let runtime = runtime.clone();
        let command = command.clone();
        async move { runtime.dispatch(command).await }
    });
    let deadline = tokio::time::Instant::now() + tokio::time::Duration::from_secs(1);
    while !runtime.is_recovery_registered(command.recovery_ref()).await
        || !waiting.load(Ordering::SeqCst)
    {
        assert!(tokio::time::Instant::now() < deadline);
        tokio::task::yield_now().await;
    }
    task.abort();
    start.notify_waiters();
    loop {
        if matches!(
            runtime.inspect(command.control()).await,
            ExecutionObservation::Running { .. }
        ) {
            break;
        }
        assert!(tokio::time::Instant::now() < deadline);
        tokio::task::yield_now().await;
    }
    completion.notify_waiters();
    loop {
        if matches!(
            runtime.inspect(command.control()).await,
            ExecutionObservation::Completed { .. }
        ) {
            break;
        }
        assert!(tokio::time::Instant::now() < deadline);
        tokio::task::yield_now().await;
    }
}

#[tokio::test]
async fn completion_before_inspect_and_cancel_are_fence_scoped() {
    let completion = Arc::new(Notify::new());
    let cancel_hits = Arc::new(AtomicUsize::new(0));
    let runtime = runtime_for(vec![
        Scenario::Completed(result("completed-immediately")),
        Scenario::CancelAware {
            completion: Arc::clone(&completion),
            cancelled_result: result("cancelled"),
            completed_result: result("finished"),
            hits: Arc::clone(&cancel_hits),
        },
        Scenario::Running {
            completion: Arc::clone(&completion),
            result: result("finished-second"),
        },
    ])
    .await;

    let completed = command(CommandSpec {
        execution: 14,
        fence: 1,
        recovery: "recovery-14",
        target: builtin_target(),
        scope: SessionScope::Execution,
    });
    assert!(matches!(
        runtime.dispatch(completed.clone()).await,
        DispatchObservation::Completed { .. }
    ));
    assert!(matches!(
        runtime.inspect(completed.control()).await,
        ExecutionObservation::Completed { .. }
    ));

    let cancelled = command(CommandSpec {
        execution: 15,
        fence: 1,
        recovery: "recovery-15a",
        target: agent_target(true),
        scope: SessionScope::Execution,
    });
    let other_fence = command(CommandSpec {
        execution: 15,
        fence: 2,
        recovery: "recovery-15b",
        target: agent_target(true),
        scope: SessionScope::Execution,
    });
    let _ = runtime.dispatch(cancelled.clone()).await;
    let _ = runtime.dispatch(other_fence.clone()).await;
    let cancel_observation = runtime.cancel(cancelled.control()).await;
    assert!(matches!(
        cancel_observation,
        zeroshot_engine::execution::CancelObservation::MayHaveStarted { .. }
    ));
    tokio::task::yield_now().await;
    assert!(matches!(
        runtime.inspect(cancelled.control()).await,
        ExecutionObservation::Completed { .. }
    ));
    assert!(matches!(
        runtime.inspect(other_fence.control()).await,
        ExecutionObservation::Running { .. }
    ));
    assert_eq!(cancel_hits.load(Ordering::SeqCst), 1);
    completion.notify_waiters();
}

#[tokio::test]
async fn session_lost_never_yields_definitely_not_started_and_node_instance_is_checked() {
    let runtime = runtime_for(vec![Scenario::DefinitelyNotStarted(Some(fault(
        EvidenceClass::SessionLost,
    )))])
    .await;
    let observation = runtime
        .dispatch(command(CommandSpec {
            execution: 16,
            fence: 1,
            recovery: "recovery-16",
            target: agent_target(true),
            scope: SessionScope::Execution,
        }))
        .await;
    assert!(matches!(
        observation,
        DispatchObservation::Indeterminate { .. }
    ));

    let node_instance_runtime = runtime_for(Vec::new()).await;
    let observation = node_instance_runtime
        .dispatch(command(CommandSpec {
            execution: 17,
            fence: 1,
            recovery: "recovery-17",
            target: agent_target(false),
            scope: SessionScope::NodeInstance,
        }))
        .await;
    assert!(matches!(
        observation,
        DispatchObservation::DefinitelyNotStarted { .. }
    ));
}
