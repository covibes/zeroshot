use super::*;

async fn assert_active_submission_conflicts(
    controller: &NativeV2CloudController,
    ledger: &FakeRunLedger,
    allocator: &FakeAllocator,
    first: &CloudRunReceipt,
) {
    let exact = submit_test_request(controller, request_with_key(Value::Null, "cloud-first"))
        .await
        .assert_value();
    assert!(exact.deduped);
    assert_eq!(exact.run_id, first.run_id);

    let mut conflicting_reuse = request_with_key(Value::Null, "cloud-first");
    let mut graph = serde_json::to_value(&conflicting_reuse.submission.graph).assert_value();
    *graph
        .pointer_mut("/root/children/0/timeoutMs")
        .assert_value() = json!(9_999);
    conflicting_reuse.submission.graph = serde_json::from_value(graph).assert_value();
    let conflict = submit_test_request(controller, conflicting_reuse)
        .await
        .assert_error();
    assert!(matches!(
        conflict,
        NativeV2CloudError::Ledger(RunLedgerError::SubmissionConflict { existing_run_id })
            if existing_run_id == first.run_id
    ));

    assert_eq!(allocator.allocation_count(), 1);
    assert_eq!(ledger.list().await.assert_value().len(), 1);
}

async fn gated_controller(
    ledger: Arc<FakeRunLedger>,
    allocator: Arc<GatedAllocator>,
) -> NativeV2CloudController {
    NativeV2CloudController::new(ledger, allocator)
        .await
        .assert_value_with("controller startup")
}

#[tokio::test]
async fn distinct_nonterminal_runs_are_both_admitted() {
    let ledger = Arc::new(FakeRunLedger::new());
    let driver = Arc::new(FakeDriver::new(Behavior::Hang));
    let cleanup = Arc::new(FakeCleanup::new(ledger.clone()));
    let allocator = Arc::new(GatedAllocator::new(driver, cleanup));
    let controller = gated_controller(ledger.clone(), allocator.clone()).await;
    let first_request = request_with_key(Value::Null, "cloud-first");
    let second_request = request_with_key(Value::Null, "cloud-second");

    let first_controller = controller.clone();
    let first =
        tokio::spawn(
            async move { submit_test_request(&first_controller, first_request.clone()).await },
        );
    allocator.wait_started().await;
    let second_controller = controller.clone();
    let second =
        tokio::spawn(async move { submit_test_request(&second_controller, second_request).await });

    tokio::task::yield_now().await;
    assert_eq!(allocator.allocation_count(), 1);

    allocator.release();
    let first = first
        .await
        .assert_value_with("first task")
        .assert_value_with("first submission");
    let second = second
        .await
        .assert_value_with("second task")
        .assert_value_with("second submission");
    assert_ne!(second.run_id, first.run_id);
    assert_eq!(allocator.allocation_count(), 2);
    assert_eq!(
        ledger
            .list()
            .await
            .assert_value_with("list after concurrent submissions")
            .len(),
        2
    );

    controller
        .force(RunForceParams {
            run_id: first.run_id.clone(),
        })
        .await
        .assert_value_with("first force stop");
    terminal(&controller, &first.run_id).await;

    controller
        .force(RunForceParams {
            run_id: second.run_id.clone(),
        })
        .await
        .assert_value_with("second force stop");
    terminal(&controller, &second.run_id).await;
}

#[tokio::test]
async fn exact_retry_dedupes_and_changed_retry_conflicts() {
    let harness = harness(Behavior::Hang).await;
    let first = submit_test_request(
        &harness.controller,
        request_with_key(Value::Null, "cloud-first"),
    )
    .await
    .assert_value_with("first submission");
    assert_active_submission_conflicts(
        &harness.controller,
        harness.ledger.as_ref(),
        harness.allocator.as_ref(),
        &first,
    )
    .await;
    harness
        .controller
        .force(RunForceParams {
            run_id: first.run_id.clone(),
        })
        .await
        .assert_value_with("cleanup");
}

#[tokio::test]
async fn branch_override_participates_in_pre_resolution_retry_identity() {
    let harness = harness(Behavior::Hang).await;
    let request = request_with_key(Value::Null, "cloud-branch");
    let mut intent = crate::native_v2_contract::RunSubmissionIntent::from(&request.submission);
    intent.branch = Some(SourceBranchId::new("feature").assert_value_with("branch"));
    let digest = run_intent_digest(&intent).assert_value_with("branch intent digest");
    let environment = exact_test_environment(&request).assert_value_with("branch test environment");
    let first = harness
        .controller
        .submit_with_intent_digest_and_exact_environment(request, digest.clone(), environment)
        .await
        .assert_value_with("first branch submission");

    let exact = harness
        .controller
        .resolve_intent(&intent.submission_key, &digest)
        .await
        .assert_value_with("exact retry lookup")
        .assert_value_with("exact retry receipt");
    assert_eq!(exact.run_id, first.run_id);

    intent.branch = Some(SourceBranchId::new("release").assert_value_with("branch"));
    let changed = run_intent_digest(&intent).assert_value_with("changed branch digest");
    assert!(matches!(
        harness
            .controller
            .resolve_intent(&intent.submission_key, &changed)
            .await,
        Err(NativeV2CloudError::Ledger(
            RunLedgerError::SubmissionConflict { .. }
        ))
    ));
    assert_eq!(harness.allocator.allocation_count(), 1);
    harness
        .controller
        .force(RunForceParams {
            run_id: first.run_id,
        })
        .await
        .assert_value_with("cleanup");
}

#[tokio::test]
async fn aborted_allocation_leaves_durable_run_exclusive_and_exact_retry_reconciles_it() {
    let GatedHarness {
        controller,
        ledger,
        cleanup,
        allocator,
    } = gated_harness().await;

    let abandoned_controller = controller.clone();
    let abandoned = tokio::spawn(async move {
        submit_test_request(
            &abandoned_controller,
            request_with_key(Value::Null, "cloud-abandoned"),
        )
        .await
    });
    allocator.wait_started().await;
    let run_id = ledger
        .list()
        .await
        .assert_value_with("list after durable create")
        .into_iter()
        .next()
        .assert_value_with("durable run")
        .run_id;
    abandoned.abort();
    assert!(
        abandoned
            .await
            .assert_error_with("submit was aborted")
            .is_cancelled()
    );

    allocator.release();
    let distinct =
        submit_test_request(&controller, request_with_key(Value::Null, "cloud-distinct"))
            .await
            .assert_value_with("distinct run is independently admitted");
    assert_ne!(distinct.run_id, run_id);
    assert_eq!(allocator.allocation_count(), 2);

    let exact = submit_test_request(
        &controller,
        request_with_key(Value::Null, "cloud-abandoned"),
    )
    .await
    .assert_value_with("exact retry reconciles abandoned allocation");
    assert!(exact.deduped);
    assert_eq!(exact.run_id, run_id);
    assert_eq!(allocator.allocation_count(), 2);
    assert_eq!(
        terminal(&controller, &run_id).await,
        TerminalResult::Failed {
            reason: EnumLabel::new("runtime_lost").assert_value_with("label")
        }
    );
    assert_eq!(cleanup.exits(), vec![RunRuntimeExit::RuntimeLost]);
    controller
        .force(RunForceParams {
            run_id: distinct.run_id,
        })
        .await
        .assert_value_with("distinct cleanup");
}

#[tokio::test]
async fn force_destroys_live_capsule_before_one_terminal_result() {
    let (harness, receipt) = started_harness(Behavior::Hang).await;
    harness
        .controller
        .force(RunForceParams {
            run_id: receipt.run_id.clone(),
        })
        .await
        .assert_value_with("force");
    assert_failed_cleanup(
        &harness,
        &receipt.run_id,
        "force_stopped",
        RunRuntimeExit::ForceStopped,
    )
    .await;
    let tail = harness
        .ledger
        .snapshot_and_tail(&receipt.run_id, None)
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

use openengine_cluster_testkit::assertions::{AssertValue, AssertError};
