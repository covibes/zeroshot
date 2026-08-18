use super::*;

#[tokio::test]
async fn internal_submission_and_oecp_listing_share_the_same_public_run_identity() {
    let harness = harness(Behavior::Complete).await;
    let submitted = submit_test_request(&harness.controller, request(Value::Null))
        .await
        .assert_value_with("trusted submit");
    terminal(&harness.controller, &submitted.run_id).await;
    let listed = ClusterBackend::run_list(
        &harness.controller,
        &ConnectionContext::default(),
        RunListParams::default(),
    )
    .await
    .assert_value_with("OECP list");
    assert_eq!(listed.runs.len(), 1);
    assert_eq!(listed.runs.assert_at(0).run_id, submitted.run_id);
}

#[tokio::test]
async fn one_capsule_drives_worker_parallel_verifiers_and_loop() {
    let ledger = Arc::new(FakeRunLedger::new());
    let driver = Arc::new(GraphDriver::default());
    let cleanup = Arc::new(FakeCleanup::new(ledger.clone()));
    let allocator = Arc::new(FakeAllocator::new(driver.clone(), cleanup.clone()));
    let controller = NativeV2CloudController::new(ledger, allocator.clone())
        .await
        .assert_value_with("controller startup");
    let receipt = submit_test_request(&controller, complex_request())
        .await
        .assert_value_with("submit complex graph");
    let result = terminal(&controller, &receipt.run_id).await;
    assert!(
        matches!(result, TerminalResult::Succeeded { .. }),
        "unexpected terminal result: {result:?}"
    );
    assert_eq!(allocator.allocation_count(), 1);
    assert_eq!(driver.starts("worker"), 1);
    assert_eq!(driver.starts("left"), 1);
    assert_eq!(driver.starts("right"), 1);
    assert_eq!(driver.starts("loop_fresh"), 2);
    assert_eq!(driver.starts("loop_check"), 2);
    assert_eq!(allocator.sessions().opens("loop_fresh"), 2);
    assert_eq!(allocator.sessions().opens("loop_check"), 1);
    assert!(driver.max_active.load(Ordering::SeqCst) >= 2);
    assert_eq!(cleanup.exits(), vec![RunRuntimeExit::Completed]);
}

#[tokio::test]
async fn valid_run_injects_only_declared_environment_and_dedupes() {
    let harness = harness(Behavior::Complete).await;
    let first = submit_test_request(&harness.controller, request(Value::Null))
        .await
        .assert_value_with("submit");
    assert!(!first.deduped);
    let result = terminal(&harness.controller, &first.run_id).await;
    assert!(
        matches!(result, TerminalResult::Succeeded { .. }),
        "unexpected terminal result: {result:?}"
    );
    let second = submit_test_request(&harness.controller, request(Value::Null))
        .await
        .assert_value_with("dedupe");
    assert!(second.deduped);
    assert_eq!(second.run_id, first.run_id);
    assert_eq!(harness.allocator.allocation_count(), 1);
    assert_eq!(
        harness.driver.environments().as_slice(),
        &[
            BTreeMap::from([("NODE_TOKEN".to_owned(), "declared-secret".to_owned())]),
            BTreeMap::new()
        ]
    );
    assert_eq!(harness.cleanup.exits(), vec![RunRuntimeExit::Completed]);
    assert_eq!(harness.cleanup.terminal_seen(), vec![false]);
    let stored = harness
        .ledger
        .get(&first.run_id)
        .await
        .assert_value_with("ledger")
        .assert_value_with("stored");
    assert!(
        !serde_json::to_string(&stored)
            .assert_value_with("stored JSON")
            .contains("declared-secret")
    );
}

use openengine_cluster_testkit::assertions::{AssertAt, AssertValue};
