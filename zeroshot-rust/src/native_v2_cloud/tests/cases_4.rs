use super::*;

#[tokio::test]
async fn force_waits_for_in_flight_allocation_then_destroys_without_a_post_force_leak() {
    let GatedHarness {
        controller,
        ledger,
        cleanup,
        allocator,
    } = gated_harness().await;

    let submit_controller = controller.clone();
    let submit = tokio::spawn(async move {
        submit_test_request(&submit_controller, request(Value::Null))
            .await
            .assert_value_with("submit")
    });
    allocator.wait_started().await;
    let run_id = ledger
        .list()
        .await
        .assert_value_with("list")
        .into_iter()
        .next()
        .assert_value_with("durable run")
        .run_id;
    let force_controller = controller.clone();
    let force_run_id = run_id.clone();
    let mut force = tokio::spawn(async move {
        force_controller
            .force(RunForceParams {
                run_id: force_run_id,
            })
            .await
            .assert_value_with("force")
    });

    assert!(
        tokio::time::timeout(Duration::from_millis(25), &mut force)
            .await
            .is_err()
    );
    assert_eq!(allocator.allocation_count(), 1);
    assert!(cleanup.exits().is_empty());

    allocator.release();
    assert_eq!(submit.await.assert_value_with("submit task").run_id, run_id);
    let forced = tokio::time::timeout(Duration::from_secs(2), force)
        .await
        .assert_value_with("force completed")
        .assert_value_with("force task");
    assert!(matches!(forced.status, RunStatus::Finished { .. }));
    assert_eq!(allocator.allocation_count(), 1);
    assert_eq!(cleanup.exits().len(), 1);
    assert_eq!(cleanup.terminal_seen(), vec![false]);
}

#[tokio::test]
async fn capsule_loss_confirms_absence_then_terminalizes_without_replacement() {
    let (harness, receipt) = started_harness(Behavior::Hang).await;
    harness.allocator.lose_capsule();
    assert_failed_cleanup(
        &harness,
        &receipt.run_id,
        "runtime_lost",
        RunRuntimeExit::RuntimeLost,
    )
    .await;
    let replay = submit_test_request(&harness.controller, request(Value::Null))
        .await
        .assert_value_with("resubmit");
    assert!(replay.deduped);
    assert_eq!(replay.run_id, receipt.run_id);
    assert_eq!(harness.allocator.allocation_count(), 1);
}

#[tokio::test]
async fn exact_resubmit_of_controller_reconstructed_run_confirms_absence_without_allocation() {
    let harness = harness(Behavior::Complete).await;
    let run_id = seed_controller_reconstructed_run(&harness.ledger, "run-orphaned").await;
    let replay = submit_test_request(&harness.controller, request(Value::Null))
        .await
        .assert_value_with("resubmit");
    assert!(replay.deduped);
    assert_eq!(replay.run_id, run_id);
    assert_eq!(harness.allocator.allocation_count(), 0);
    assert_failed_cleanup(
        &harness,
        &run_id,
        "runtime_lost",
        RunRuntimeExit::RuntimeLost,
    )
    .await;
}

use openengine_cluster_testkit::assertions::{AssertValue};
