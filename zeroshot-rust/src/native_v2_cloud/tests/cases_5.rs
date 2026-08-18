use super::*;

#[tokio::test]
async fn force_of_controller_reconstructed_run_confirms_absence_and_finishes() {
    let harness = harness(Behavior::Complete).await;
    let run_id = seed_controller_reconstructed_run(&harness.ledger, "run-force-orphaned").await;
    let forced = harness
        .controller
        .force(RunForceParams {
            run_id: run_id.clone(),
        })
        .await
        .assert_value_with("force");
    assert!(matches!(forced.status, RunStatus::Finished { .. }));
    assert_eq!(harness.allocator.allocation_count(), 0);
    assert_eq!(harness.cleanup.exits(), vec![RunRuntimeExit::ForceStopped]);
    assert_eq!(harness.cleanup.terminal_seen(), vec![false]);
}

#[tokio::test]
async fn concurrent_force_of_reconstructed_run_cleans_up_and_terminalizes_once() {
    let harness = harness(Behavior::Complete).await;
    let run_id = seed_controller_reconstructed_run(&harness.ledger, "run-concurrent-force").await;
    let left_controller = harness.controller.clone();
    let left_id = run_id.clone();
    let left = tokio::spawn(async move {
        left_controller
            .force(RunForceParams { run_id: left_id })
            .await
    });
    let right_controller = harness.controller.clone();
    let right_id = run_id.clone();
    let right = tokio::spawn(async move {
        right_controller
            .force(RunForceParams { run_id: right_id })
            .await
    });
    let (left, right) = tokio::join!(left, right);
    assert!(matches!(
        left.assert_value_with("left task")
            .assert_value_with("left force")
            .status,
        RunStatus::Finished { .. }
    ));
    assert!(matches!(
        right
            .assert_value_with("right task")
            .assert_value_with("right force")
            .status,
        RunStatus::Finished { .. }
    ));
    assert_eq!(harness.cleanup.exits(), vec![RunRuntimeExit::ForceStopped]);
    let tail = harness
        .ledger
        .snapshot_and_tail(&run_id, None)
        .await
        .assert_value_with("tail");
    assert_eq!(
        tail.events
            .iter()
            .filter(|event| matches!(event.event, RunEvent::Terminal { .. }))
            .count(),
        1
    );
}

#[tokio::test]
async fn force_retries_cleanup_after_a_drive_cleanup_failure() {
    let harness = harness(Behavior::Complete).await;
    harness.cleanup.fail_next();
    let receipt = submit_test_request(&harness.controller, request(Value::Null))
        .await
        .assert_value_with("submit");
    tokio::time::timeout(Duration::from_secs(2), async {
        while harness.cleanup.exits().is_empty() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .assert_value_with("first cleanup attempted");
    assert!(
        harness
            .ledger
            .get(&receipt.run_id)
            .await
            .assert_value_with("ledger")
            .assert_value_with("stored")
            .snapshot
            .terminal
            .is_none()
    );

    harness
        .controller
        .force(RunForceParams {
            run_id: receipt.run_id.clone(),
        })
        .await
        .assert_value_with("force retries cleanup");
    assert_eq!(
        terminal(&harness.controller, &receipt.run_id).await,
        TerminalResult::Failed {
            reason: EnumLabel::new("force_stopped").assert_value_with("label")
        }
    );
    assert_eq!(
        harness.cleanup.exits(),
        vec![RunRuntimeExit::Completed, RunRuntimeExit::ForceStopped]
    );
    assert_eq!(harness.cleanup.terminal_seen(), vec![false, false]);
}

use openengine_cluster_testkit::assertions::{AssertValue};
