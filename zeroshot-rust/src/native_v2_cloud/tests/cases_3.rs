use super::*;

async fn assert_active_submission_conflicts(
    controller: &NativeV2CloudController,
    ledger: &FakeRunLedger,
    allocator: &GatedAllocator,
    first: &CloudRunReceipt,
) {
    let exact = controller
        .submit(request_with_key(Value::Null, "cloud-first"))
        .await
        .assert_value();
    assert!(exact.deduped);
    assert_eq!(exact.run_id, first.run_id);

    let mut conflicting_reuse = request_with_key(Value::Null, "cloud-first");
    let mut graph = serde_json::to_value(&conflicting_reuse.graph).assert_value();
    *graph
        .pointer_mut("/root/children/0/timeoutMs")
        .assert_value() = json!(9_999);
    conflicting_reuse.graph = serde_json::from_value(graph).assert_value();
    let conflict = controller.submit(conflicting_reuse).await.assert_error();
    assert!(matches!(
        conflict,
        NativeV2CloudError::Ledger(RunLedgerError::SubmissionConflict { existing_run_id })
            if existing_run_id == first.run_id
    ));

    let request = request_with_key(Value::Null, "cloud-backend-conflict");
    let conflict = ClusterBackend::run_submit(
        controller,
        &ConnectionContext::default(),
        RunSubmitParams {
            graph: request.graph,
            initial_input: request.initial_input,
            ship: request.ship,
            submission_key: request.submission_key,
        },
    )
    .await
    .assert_error();
    assert_eq!(conflict.code, RUN_CONFLICT);
    assert_eq!(conflict.details, Some(json!({ "runId": first.run_id })));
    assert_eq!(allocator.allocation_count(), 1);
    assert_eq!(ledger.list().await.assert_value().len(), 1);
}

async fn exclusive_controller(
    ledger: Arc<FakeRunLedger>,
    allocator: Arc<GatedAllocator>,
) -> NativeV2CloudController {
    NativeV2CloudController::new(
        ledger,
        runtime(),
        ControllerEnvironment::new(BTreeMap::from([(
            EnvironmentVariableName::new("NODE_TOKEN").assert_value_with("environment name"),
            "declared-secret".to_owned(),
        )])),
        allocator,
    )
    .await
    .assert_value_with("controller startup")
}

#[tokio::test]
async fn distinct_submissions_never_overlap_and_next_admits_after_terminal_cleanup() {
    let ledger = Arc::new(FakeRunLedger::new());
    let driver = Arc::new(FakeDriver::new(Behavior::Hang));
    let cleanup = Arc::new(FakeCleanup::new(ledger.clone()));
    let allocator = Arc::new(GatedAllocator::new(driver, cleanup));
    let controller = exclusive_controller(ledger.clone(), allocator.clone()).await;
    let first_request = request_with_key(Value::Null, "cloud-first");
    let second_request = request_with_key(Value::Null, "cloud-second");

    let first_controller = controller.clone();
    let first = tokio::spawn(async move { first_controller.submit(first_request.clone()).await });
    allocator.wait_started().await;
    let second_controller = controller.clone();
    let retry_request = second_request.clone();
    let second = tokio::spawn(async move { second_controller.submit(second_request).await });

    tokio::task::yield_now().await;
    assert_eq!(allocator.allocation_count(), 1);

    allocator.release();
    let first = first
        .await
        .assert_value_with("first task")
        .assert_value_with("first submission");
    let conflict = second
        .await
        .assert_value_with("second task")
        .assert_error_with("distinct submission must be rejected");
    assert!(matches!(
        conflict,
        NativeV2CloudError::RunActive { run_id } if run_id == first.run_id
    ));
    assert_eq!(allocator.allocation_count(), 1);
    assert_eq!(
        ledger
            .list()
            .await
            .assert_value_with("list after conflict")
            .len(),
        1
    );

    assert_active_submission_conflicts(&controller, ledger.as_ref(), allocator.as_ref(), &first)
        .await;

    controller
        .force(RunForceParams {
            run_id: first.run_id.clone(),
        })
        .await
        .assert_value_with("first force stop");
    terminal(&controller, &first.run_id).await;

    let next = controller
        .submit(retry_request)
        .await
        .assert_value_with("next submission after cleanup");
    assert!(!next.deduped);
    assert_ne!(next.run_id, first.run_id);
    assert_eq!(allocator.allocation_count(), 2);
    assert_eq!(
        ledger
            .list()
            .await
            .assert_value_with("list after next run")
            .len(),
        2
    );

    controller
        .force(RunForceParams {
            run_id: next.run_id.clone(),
        })
        .await
        .assert_value_with("next force stop");
    terminal(&controller, &next.run_id).await;
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
        abandoned_controller
            .submit(request_with_key(Value::Null, "cloud-abandoned"))
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

    let distinct = controller
        .submit(request_with_key(Value::Null, "cloud-distinct"))
        .await
        .assert_error_with("durable nonterminal run remains exclusive");
    assert!(matches!(
        distinct,
        NativeV2CloudError::RunActive { run_id: active } if active == run_id
    ));
    assert_eq!(allocator.allocation_count(), 1);

    let exact = controller
        .submit(request_with_key(Value::Null, "cloud-abandoned"))
        .await
        .assert_value_with("exact retry reconciles abandoned allocation");
    assert!(exact.deduped);
    assert_eq!(exact.run_id, run_id);
    assert_eq!(allocator.allocation_count(), 1);
    assert_eq!(
        terminal(&controller, &run_id).await,
        TerminalResult::Failed {
            reason: EnumLabel::new("runtime_lost").assert_value_with("label")
        }
    );
    assert_eq!(cleanup.exits(), vec![RunRuntimeExit::RuntimeLost]);
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
