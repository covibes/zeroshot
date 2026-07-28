#[path = "support/ledger.rs"]
mod ledger;
#[path = "support/ledger_admission.rs"]
mod ledger_admission;

use std::sync::Arc;

use ledger::{key, owner, resource, temp_root};
use ledger_admission::admission_request;
use zeroshot_engine::cluster_ledger::mutations::{AdmissionRequest, SafeFaultConsequence};
use zeroshot_engine::cluster_ledger::record::{CanonicalDigest, RecordPayload, StoredRecord};
use zeroshot_engine::cluster_ledger::store::fake::{FakeLedgerStore, ManualLedgerClock};
use zeroshot_engine::cluster_ledger::store::sqlite::SqliteLedgerStore;
use zeroshot_engine::cluster_ledger::store::{
    AppendBatch, AppendOutcome, FailPoint, LedgerStore, Position, ResourceId, StoreError,
};
use zeroshot_engine::cluster_ledger::ClusterLedger;
use zeroshot_engine::fault::{EvidenceClass, FaultContext, FaultFactory, FaultModule, ModuleEvidence};
use zeroshot_engine::observability::NoopObservationSink;

fn admission() -> AdmissionRequest {
    admission_request(
        b"canonical-graph".to_vec(),
        br#"{"verified":true}"#.to_vec(),
        b"compiled".to_vec(),
        10_000,
    )
}

fn safe_fault() -> zeroshot_engine::fault::EngineFault {
    FaultFactory::new(&NoopObservationSink).create(ModuleEvidence::new(
        FaultModule::Worker,
        FaultContext::Execution,
        EvidenceClass::ProcessExited,
    ))
}

async fn before_commit_matrix(store: Arc<dyn LedgerStore>, fail: impl Fn(FailPoint), label: &str) {
    let ledger = ClusterLedger::create(
        Arc::clone(&store),
        resource(label),
        owner("before-owner"),
        10_000,
    )
    .await
    .unwrap();
    before_admission_dispatch_settlement(&ledger, &fail).await;
    before_effect_reconciliation(&ledger, &fail).await;
    before_safe_fault(&ledger, &fail).await;
    before_terminal_removal(store.as_ref(), &ledger, &fail).await;
}

async fn before_admission_dispatch_settlement(ledger: &ClusterLedger, fail: &impl Fn(FailPoint)) {
    fail(FailPoint::BeforeCommit);
    assert!(
        ledger
            .admit(key("admit-before"), [1; 32], admission())
            .await
            .is_err()
    );
    assert_eq!(ledger.state().await.unwrap().position.get(), 0);
    ledger
        .admit(key("admit"), [2; 32], admission())
        .await
        .unwrap();

    let before = ledger.state().await.unwrap().position;
    fail(FailPoint::BeforeCommit);
    assert!(
        ledger
            .dispatch(key("dispatch-before"), [3; 32])
            .await
            .is_err()
    );
    assert_eq!(ledger.state().await.unwrap().position, before);
    let dispatch = ledger.dispatch(key("dispatch"), [4; 32]).await.unwrap();

    let before = ledger.state().await.unwrap().position;
    fail(FailPoint::BeforeCommit);
    assert!(
        ledger
            .settle(
                key("settle-before"),
                [5; 32],
                dispatch.value.execution,
                CanonicalDigest::of(b"settled"),
                None,
            )
            .await
            .is_err()
    );
    assert_eq!(ledger.state().await.unwrap().position, before);
    ledger
        .settle(
            key("settle"),
            [6; 32],
            dispatch.value.execution,
            CanonicalDigest::of(b"settled"),
            None,
        )
        .await
        .unwrap();
}

async fn before_effect_reconciliation(ledger: &ClusterLedger, fail: &impl Fn(FailPoint)) {
    let before = ledger.state().await.unwrap().position;
    fail(FailPoint::BeforeCommit);
    assert!(
        ledger
            .record_effect_intent(
                key("effect-intent-before"),
                [7; 32],
                CanonicalDigest::of(b"request"),
            )
            .await
            .is_err()
    );
    assert_eq!(ledger.state().await.unwrap().position, before);
    let effect = ledger
        .record_effect_intent(
            key("effect-intent"),
            [8; 32],
            CanonicalDigest::of(b"request"),
        )
        .await
        .unwrap();

    let before = ledger.state().await.unwrap().position;
    fail(FailPoint::BeforeCommit);
    assert!(
        ledger
            .reconcile_effect(
                key("effect-receipt-before"),
                [9; 32],
                effect.value.effect,
                CanonicalDigest::of(b"receipt"),
            )
            .await
            .is_err()
    );
    assert_eq!(ledger.state().await.unwrap().position, before);
    ledger
        .reconcile_effect(
            key("effect-receipt"),
            [10; 32],
            effect.value.effect,
            CanonicalDigest::of(b"receipt"),
        )
        .await
        .unwrap();
}

async fn before_safe_fault(ledger: &ClusterLedger, fail: &impl Fn(FailPoint)) {
    let dispatch = ledger
        .dispatch(key("fault-dispatch"), [11; 32])
        .await
        .unwrap();
    let before = ledger.state().await.unwrap().position;
    fail(FailPoint::BeforeCommit);
    assert!(
        ledger
            .record_safe_fault(
                key("fault-before"),
                [12; 32],
                &safe_fault(),
                SafeFaultConsequence::Settle {
                    execution: dispatch.value.execution,
                    outcome_digest: CanonicalDigest::of(b"faulted"),
                },
            )
            .await
            .is_err()
    );
    assert_eq!(ledger.state().await.unwrap().position, before);
    ledger
        .record_safe_fault(
            key("fault"),
            [13; 32],
            &safe_fault(),
            SafeFaultConsequence::Settle {
                execution: dispatch.value.execution,
                outcome_digest: CanonicalDigest::of(b"faulted"),
            },
        )
        .await
        .unwrap();
}

async fn before_terminal_removal(
    store: &dyn LedgerStore,
    ledger: &ClusterLedger,
    fail: &impl Fn(FailPoint),
) {
    let before = ledger.state().await.unwrap().position;
    fail(FailPoint::BeforeCommit);
    assert!(
        ledger
            .terminalize(
                key("terminal-before"),
                [14; 32],
                CanonicalDigest::of(b"done"),
            )
            .await
            .is_err()
    );
    assert_eq!(ledger.state().await.unwrap().position, before);
    ledger
        .terminalize(key("terminal"), [15; 32], CanonicalDigest::of(b"done"))
        .await
        .unwrap();

    fail(FailPoint::BeforeCommit);
    assert!(ledger.remove_terminal().await.is_err());
    assert!(store.open(ledger.resource()).await.is_ok());
}

async fn after_commit_matrix(store: Arc<dyn LedgerStore>, fail: impl Fn(FailPoint), label: &str) {
    let ledger = ClusterLedger::create(
        Arc::clone(&store),
        resource(label),
        owner("after-owner"),
        10_000,
    )
    .await
    .unwrap();
    after_admission_dispatch_settlement(&ledger, &fail).await;
    after_effect_reconciliation(&ledger, &fail).await;
    after_safe_fault(&ledger, &fail).await;
    after_terminal_cleanup(&ledger, &fail).await;
    fail(FailPoint::AfterCommitBeforeResponse);
    assert!(ledger.remove_terminal().await.is_err());
    assert!(store.open(ledger.resource()).await.is_err());
}

async fn after_admission_dispatch_settlement(ledger: &ClusterLedger, fail: &impl Fn(FailPoint)) {
    fail(FailPoint::AfterCommitBeforeResponse);
    assert!(
        ledger
            .admit(key("admit"), [1; 32], admission())
            .await
            .unwrap()
            .replayed
    );
    fail(FailPoint::AfterCommitBeforeResponse);
    let dispatch = ledger.dispatch(key("dispatch"), [2; 32]).await.unwrap();
    assert!(dispatch.replayed);
    fail(FailPoint::AfterCommitBeforeResponse);
    assert!(
        ledger
            .settle(
                key("settle"),
                [3; 32],
                dispatch.value.execution,
                CanonicalDigest::of(b"settled"),
                None,
            )
            .await
            .unwrap()
            .replayed
    );
}

async fn after_effect_reconciliation(ledger: &ClusterLedger, fail: &impl Fn(FailPoint)) {
    fail(FailPoint::AfterCommitBeforeResponse);
    let effect = ledger
        .record_effect_intent(
            key("effect-intent"),
            [4; 32],
            CanonicalDigest::of(b"request"),
        )
        .await
        .unwrap();
    assert!(effect.replayed);
    fail(FailPoint::AfterCommitBeforeResponse);
    assert!(
        ledger
            .reconcile_effect(
                key("effect-receipt"),
                [5; 32],
                effect.value.effect,
                CanonicalDigest::of(b"receipt"),
            )
            .await
            .unwrap()
            .replayed
    );
}

async fn after_safe_fault(ledger: &ClusterLedger, fail: &impl Fn(FailPoint)) {
    let dispatch = ledger
        .dispatch(key("fault-dispatch"), [6; 32])
        .await
        .unwrap();
    fail(FailPoint::AfterCommitBeforeResponse);
    assert!(
        ledger
            .record_safe_fault(
                key("fault"),
                [7; 32],
                &safe_fault(),
                SafeFaultConsequence::Settle {
                    execution: dispatch.value.execution,
                    outcome_digest: CanonicalDigest::of(b"faulted"),
                },
            )
            .await
            .unwrap()
            .replayed
    );
}

async fn after_terminal_cleanup(ledger: &ClusterLedger, fail: &impl Fn(FailPoint)) {
    fail(FailPoint::AfterCommitBeforeResponse);
    assert!(
        ledger
            .terminalize(key("terminal"), [8; 32], CanonicalDigest::of(b"done"))
            .await
            .unwrap()
            .replayed
    );
    fail(FailPoint::AfterCommitBeforeResponse);
    assert!(
        ledger
            .record_cleanup_receipt(key("cleanup"), [9; 32], CanonicalDigest::of(b"clean"),)
            .await
            .unwrap()
            .replayed
    );
}

async fn after_commit_failpoint_skips_idempotent_replay(
    store: Arc<dyn LedgerStore>,
    fail: impl Fn(FailPoint),
    label: &str,
) {
    let ledger = ClusterLedger::create(store, resource(label), owner("replay-owner"), 10_000)
        .await
        .unwrap();
    let original = ledger
        .admit(key("replay-admit"), [1; 32], admission())
        .await
        .unwrap();
    fail(FailPoint::AfterCommitBeforeResponse);
    let replayed = ledger
        .admit(key("replay-admit"), [1; 32], admission())
        .await
        .unwrap();
    assert!(replayed.replayed);
    assert_eq!(replayed.value, original.value);

    let recovered = ledger
        .dispatch(key("distinct-dispatch"), [2; 32])
        .await
        .unwrap();
    assert!(recovered.replayed);
    let state = ledger.state().await.unwrap();
    assert_eq!(state.active_dispatches.len(), 1);
    assert_eq!(state.position.get(), original.position.get() + 2);
}

fn receiptless_batch(resource: &ResourceId, sequence: u64, previous_hash: [u8; 32]) -> AppendBatch {
    let payload = RecordPayload::CleanupReceipt {
        cleanup_digest: CanonicalDigest::of(&sequence.to_le_bytes()),
    };
    let record = StoredRecord::build(
        resource.clone(),
        Position::new(sequence).unwrap(),
        &payload,
        previous_hash,
    )
    .unwrap();
    AppendBatch::new(vec![record], None).unwrap()
}

async fn receiptless_after_commit_failure(
    store: Arc<dyn LedgerStore>,
    fail: impl Fn(FailPoint),
    label: &str,
) {
    let resource = resource(label);
    store.create(&resource).await.unwrap();
    let fence = store
        .acquire_fence(&resource, &owner("receiptless-owner"), 10_000)
        .await
        .unwrap();
    fail(FailPoint::AfterCommitBeforeResponse);
    let error = store
        .compare_and_append(
            &resource,
            &fence,
            Position::ZERO,
            receiptless_batch(&resource, 1, [0; 32]),
        )
        .await
        .unwrap_err();
    assert!(matches!(
        error,
        StoreError::FailureInjected(FailPoint::AfterCommitBeforeResponse)
    ));

    let snapshot = store.read_prefix(&resource, None).await.unwrap();
    assert_eq!(snapshot.position.get(), 1);
    assert_eq!(snapshot.records.len(), 1);
    assert!(snapshot.receipts.is_empty());
    let second = store
        .compare_and_append(
            &resource,
            &fence,
            snapshot.position,
            receiptless_batch(&resource, 2, snapshot.records[0].record_hash),
        )
        .await
        .unwrap();
    assert_eq!(
        second,
        AppendOutcome::CommittedWithoutReceipt(Position::new(2).unwrap())
    );
}

#[tokio::test]
async fn fake_store_crash_matrix_preserves_atomic_authority() {
    let store = Arc::new(FakeLedgerStore::new(ManualLedgerClock::new(100)));
    before_commit_matrix(store.clone(), |point| store.fail_next(point), "fake-before").await;
    after_commit_matrix(store.clone(), |point| store.fail_next(point), "fake-after").await;
    after_commit_failpoint_skips_idempotent_replay(
        store.clone(),
        |point| store.fail_next(point),
        "fake-replay",
    )
    .await;
    receiptless_after_commit_failure(
        store.clone(),
        |point| store.fail_next(point),
        "fake-receiptless",
    )
    .await;
}

#[tokio::test]
async fn sqlite_store_crash_matrix_preserves_atomic_authority() {
    let root = temp_root("crash-sqlite");
    let store =
        Arc::new(SqliteLedgerStore::with_clock(&root, ManualLedgerClock::new(100)).unwrap());
    before_commit_matrix(
        store.clone(),
        |point| store.fail_next(point),
        "sqlite-before",
    )
    .await;
    after_commit_matrix(
        store.clone(),
        |point| store.fail_next(point),
        "sqlite-after",
    )
    .await;
    after_commit_failpoint_skips_idempotent_replay(
        store.clone(),
        |point| store.fail_next(point),
        "sqlite-replay",
    )
    .await;
    receiptless_after_commit_failure(
        store.clone(),
        |point| store.fail_next(point),
        "sqlite-receiptless",
    )
    .await;
    drop(store);
    std::fs::remove_dir_all(root).unwrap();
}
