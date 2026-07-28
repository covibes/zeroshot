use std::sync::Arc;

#[path = "support/scheduler.rs"]
mod scheduler_support;

use tokio::time::Duration;
use zeroshot_engine::execution::WorkspaceAccessMode;
use zeroshot_engine::scheduler::{FairScheduler, SchedulerConfig, SchedulerError};

use scheduler_support::{BlockingRuntime, CommandSpec, RunningRuntime, command};

#[tokio::test]
async fn provider_lane_then_cluster_round_robin_is_exact() {
    let runtime = Arc::new(BlockingRuntime::default());
    let scheduler = scheduler(
        runtime.clone(),
        SchedulerConfig {
            global_active: 1,
            per_cluster_active: 1,
            per_lane_active: 1,
            max_queued: 16,
        },
    );

    let first = command(spec(1, "lane.alpha", "cluster.a", "workspace.1"));
    let second = command(spec(2, "lane.alpha", "cluster.b", "workspace.2"));
    let third = command(spec(3, "lane.beta", "cluster.a", "workspace.3"));
    let fourth = command(spec(4, "lane.beta", "cluster.b", "workspace.4"));
    scheduler.submit(first.clone()).await.unwrap();
    runtime.wait_for_started(1).await;
    scheduler.submit(second.clone()).await.unwrap();
    scheduler.submit(third.clone()).await.unwrap();
    scheduler.submit(fourth.clone()).await.unwrap();

    complete_and_release(&scheduler, &runtime, &first, 2).await;
    complete_and_release(&scheduler, &runtime, &third, 3).await;
    complete_and_release(&scheduler, &runtime, &second, 4).await;
    runtime.release(4);
    runtime.wait_for_completed(4).await;
    assert!(scheduler.release_terminal(&fourth.control()).await);

    assert_eq!(runtime.order(), vec![1, 3, 2, 4]);
}

#[tokio::test]
async fn work_conserving_skips_blocked_entries_and_read_only_coexists() {
    exclusive_workspace_conflicts_only_until_release().await;
    shared_read_only_leases_block_exclusive_followups().await;
}

#[tokio::test]
async fn queue_bounds_and_cancellation_keep_fairness_cursors_stable() {
    assert_queue_bound_is_enforced().await;
    assert_cancellation_does_not_advance_fairness().await;
}

#[tokio::test]
async fn non_terminal_dispatch_keeps_lane_and_global_permits_until_terminal_release() {
    let runtime = Arc::new(RunningRuntime::default());
    let scheduler = scheduler(
        runtime.clone(),
        SchedulerConfig {
            global_active: 2,
            per_cluster_active: 2,
            per_lane_active: 1,
            max_queued: 16,
        },
    );

    let first = command(spec(50, "lane.alpha", "cluster.a", "workspace.50"));
    let blocked_same_lane = command(spec(51, "lane.alpha", "cluster.b", "workspace.51"));
    let other_lane = command(spec(52, "lane.beta", "cluster.a", "workspace.52"));

    scheduler.submit(first.clone()).await.unwrap();
    runtime.wait_for_started(1).await;
    scheduler.submit(blocked_same_lane.clone()).await.unwrap();
    scheduler.submit(other_lane.clone()).await.unwrap();
    runtime.wait_for_started(2).await;
    tokio::time::sleep(Duration::from_millis(50)).await;

    assert_eq!(runtime.order(), vec![50, 52]);
    assert_eq!(scheduler.active_len().await, 2);

    assert!(scheduler.release_terminal(&first.control()).await);
    runtime.wait_for_started(3).await;
    assert_eq!(runtime.order(), vec![50, 52, 51]);
    assert!(scheduler.release_terminal(&other_lane.control()).await);
    assert!(
        scheduler
            .release_terminal(&blocked_same_lane.control())
            .await
    );
    assert_eq!(scheduler.active_len().await, 0);
}

async fn exclusive_workspace_conflicts_only_until_release() {
    let runtime = Arc::new(BlockingRuntime::default());
    let scheduler = scheduler(
        runtime.clone(),
        SchedulerConfig {
            global_active: 2,
            per_cluster_active: 2,
            per_lane_active: 2,
            max_queued: 16,
        },
    );

    submit_all(
        &scheduler,
        [
            spec(10, "lane.alpha", "cluster.a", "workspace.shared"),
            spec(11, "lane.alpha", "cluster.a", "workspace.shared"),
            spec(12, "lane.beta", "cluster.a", "workspace.free"),
        ],
    )
    .await;

    runtime.wait_for_started(2).await;
    assert_eq!(runtime.order(), vec![10, 12]);
    let first = command(spec(10, "lane.alpha", "cluster.a", "workspace.shared"));
    let second = command(spec(11, "lane.alpha", "cluster.a", "workspace.shared"));
    let third = command(spec(12, "lane.beta", "cluster.a", "workspace.free"));
    complete_and_release(&scheduler, &runtime, &first, 3).await;
    assert_eq!(runtime.order(), vec![10, 12, 11]);
    runtime.release(11);
    runtime.wait_for_completion(11).await;
    assert!(scheduler.release_terminal(&second.control()).await);
    runtime.release(12);
    runtime.wait_for_completion(12).await;
    assert!(scheduler.release_terminal(&third.control()).await);
}

async fn shared_read_only_leases_block_exclusive_followups() {
    let runtime = Arc::new(BlockingRuntime::default());
    let scheduler = scheduler(
        runtime.clone(),
        SchedulerConfig {
            global_active: 2,
            per_cluster_active: 2,
            per_lane_active: 2,
            max_queued: 16,
        },
    );

    submit_all(
        &scheduler,
        [
            read_only_spec(20, "lane.alpha", "cluster.a", "workspace.read"),
            read_only_spec(21, "lane.beta", "cluster.a", "workspace.read"),
            spec(22, "lane.alpha", "cluster.b", "workspace.read"),
        ],
    )
    .await;

    runtime.wait_for_started(2).await;
    assert_eq!(runtime.order(), vec![20, 21]);
    let first = command(read_only_spec(
        20,
        "lane.alpha",
        "cluster.a",
        "workspace.read",
    ));
    let second = command(read_only_spec(
        21,
        "lane.beta",
        "cluster.a",
        "workspace.read",
    ));
    let third = command(spec(22, "lane.alpha", "cluster.b", "workspace.read"));
    runtime.release(20);
    runtime.wait_for_completed(1).await;
    assert!(scheduler.release_terminal(&first.control()).await);
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(runtime.order(), vec![20, 21]);
    complete_and_release(&scheduler, &runtime, &second, 3).await;
    assert_eq!(runtime.order(), vec![20, 21, 22]);
    runtime.release(22);
    runtime.wait_for_completion(22).await;
    assert!(scheduler.release_terminal(&third.control()).await);
}

async fn assert_queue_bound_is_enforced() {
    let runtime = Arc::new(BlockingRuntime::default());
    let scheduler = scheduler(
        runtime.clone(),
        SchedulerConfig {
            global_active: 1,
            per_cluster_active: 1,
            per_lane_active: 1,
            max_queued: 1,
        },
    );

    let first = command(spec(30, "lane.alpha", "cluster.a", "workspace.30"));
    let second = command(spec(31, "lane.beta", "cluster.a", "workspace.31"));
    scheduler.submit(first.clone()).await.unwrap();
    runtime.wait_for_started(1).await;
    scheduler.submit(second.clone()).await.unwrap();
    assert_eq!(
        scheduler
            .submit(command(spec(32, "lane.beta", "cluster.b", "workspace.32")))
            .await,
        Err(SchedulerError::QueueFull)
    );
    complete_and_release(&scheduler, &runtime, &first, 2).await;
    runtime.release(31);
    runtime.wait_for_completion(31).await;
    assert!(scheduler.release_terminal(&second.control()).await);
}

async fn assert_cancellation_does_not_advance_fairness() {
    let runtime = Arc::new(BlockingRuntime::default());
    let scheduler = scheduler(
        runtime.clone(),
        SchedulerConfig {
            global_active: 1,
            per_cluster_active: 1,
            per_lane_active: 1,
            max_queued: 16,
        },
    );

    let running = command(spec(40, "lane.alpha", "cluster.a", "workspace.40"));
    let cancelled = command(spec(41, "lane.alpha", "cluster.b", "workspace.41"));
    let survivor = command(spec(42, "lane.beta", "cluster.a", "workspace.42"));
    scheduler.submit(running.clone()).await.unwrap();
    runtime.wait_for_started(1).await;
    scheduler.submit(cancelled.clone()).await.unwrap();
    scheduler.submit(survivor.clone()).await.unwrap();
    assert!(scheduler.cancel_queued(&cancelled.control()).await);
    complete_and_release(&scheduler, &runtime, &running, 2).await;
    assert_eq!(runtime.order(), vec![40, 42]);
    runtime.release(42);
    runtime.wait_for_completion(42).await;
    assert!(scheduler.release_terminal(&survivor.control()).await);
}

fn scheduler(
    runtime: Arc<dyn zeroshot_engine::execution::ExecutionRuntime>,
    config: SchedulerConfig,
) -> FairScheduler {
    FairScheduler::new(runtime, config).unwrap()
}

async fn submit_all<const N: usize>(scheduler: &FairScheduler, specs: [CommandSpec<'_>; N]) {
    for spec in specs {
        scheduler.submit(command(spec)).await.unwrap();
    }
}

async fn complete_and_release(
    scheduler: &FairScheduler,
    runtime: &BlockingRuntime,
    command: &zeroshot_engine::execution::ExecutionCommand,
    expected_started: usize,
) {
    runtime.release(command.execution().get());
    runtime.wait_for_completion(command.execution().get()).await;
    assert!(scheduler.release_terminal(&command.control()).await);
    runtime.wait_for_started(expected_started).await;
}

fn spec<'a>(
    execution: u64,
    lane: &'a str,
    cluster: &'a str,
    workspace: &'a str,
) -> CommandSpec<'a> {
    CommandSpec {
        execution,
        lane,
        cluster,
        workspace,
        mode: WorkspaceAccessMode::Exclusive,
    }
}

fn read_only_spec<'a>(
    execution: u64,
    lane: &'a str,
    cluster: &'a str,
    workspace: &'a str,
) -> CommandSpec<'a> {
    CommandSpec {
        execution,
        lane,
        cluster,
        workspace,
        mode: WorkspaceAccessMode::ReadOnly,
    }
}
