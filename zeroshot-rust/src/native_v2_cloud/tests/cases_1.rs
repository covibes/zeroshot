use super::*;

#[tokio::test]
async fn invalid_submission_has_no_durable_or_allocation_effect() {
    let harness = harness(Behavior::Complete).await;
    assert!(matches!(
        harness.controller.submit(request(json!({}))).await,
        Err(NativeV2CloudError::Admission(_))
    ));
    assert_eq!(harness.allocator.allocation_count(), 0);
    assert!(
        harness
            .controller
            .list()
            .await
            .assert_value_with("list")
            .is_empty()
    );
}

#[tokio::test]
async fn startup_reconciles_every_persisted_nonterminal_before_status_is_visible() {
    let ledger = Arc::new(FakeRunLedger::new());
    let run_id = seed_controller_reconstructed_run(&ledger, "run-restart").await;
    let driver = Arc::new(FakeDriver::new(Behavior::Complete));
    let cleanup = Arc::new(FakeCleanup::new(ledger.clone()));
    let allocator = Arc::new(FakeAllocator::new(driver, cleanup.clone()));
    let controller = NativeV2CloudController::new(
        ledger,
        runtime(),
        ControllerEnvironment::default(),
        allocator.clone(),
    )
    .await
    .assert_value_with("reconciled startup");

    let status = controller
        .status(RunStatusParams {
            run_id: run_id.clone(),
        })
        .await
        .assert_value_with("status after startup");
    assert_eq!(
        status.status,
        RunStatus::Finished {
            terminal_result: TerminalResult::Failed {
                reason: EnumLabel::new("runtime_lost").assert_value_with("label")
            }
        }
    );
    assert_eq!(controller.list().await.assert_value_with("list").len(), 1);
    assert_eq!(allocator.allocation_count(), 0);
    assert_eq!(cleanup.exits(), vec![RunRuntimeExit::RuntimeLost]);
    assert_eq!(cleanup.terminal_seen(), vec![false]);
}

#[tokio::test]
async fn allocator_rejects_a_second_live_controller_for_the_same_target() {
    let ledger = Arc::new(FakeRunLedger::new());
    let driver = Arc::new(FakeDriver::new(Behavior::Complete));
    let cleanup = Arc::new(FakeCleanup::new(ledger.clone()));
    let allocator = Arc::new(FakeAllocator::new(driver, cleanup));
    let first = NativeV2CloudController::new(
        ledger.clone(),
        runtime(),
        ControllerEnvironment::default(),
        allocator.clone(),
    )
    .await
    .assert_value_with("first controller");
    assert!(matches!(
        NativeV2CloudController::new(
            ledger.clone(),
            runtime(),
            ControllerEnvironment::default(),
            allocator.clone(),
        )
        .await,
        Err(NativeV2CloudError::ControllerClaim(_))
    ));
    drop(first);
    NativeV2CloudController::new(
        ledger,
        runtime(),
        ControllerEnvironment::default(),
        allocator,
    )
    .await
    .assert_value_with("claim released with controller lifetime");
}

use openengine_cluster_testkit::assertions::{AssertValue};
