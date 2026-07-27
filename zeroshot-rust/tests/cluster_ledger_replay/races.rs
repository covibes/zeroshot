use super::snapshot_race_store::{race_ledger, SnapshotRaceStore};
use super::*;

#[tokio::test]
async fn failed_creation_never_leaves_a_durable_resource() {
    let store = Arc::new(FakeLedgerStore::new(ManualLedgerClock::new(1_000)));
    for (label, ttl) in [("zero-ttl", 0), ("overflow-ttl", u64::MAX)] {
        let resource = resource(label);
        assert!(
            ClusterLedger::create(store.clone(), resource.clone(), owner("owner"), ttl)
                .await
                .is_err()
        );
        assert!(matches!(
            store.open(&resource).await,
            Err(StoreError::ResourceNotFound)
        ));
    }
}

async fn assert_concurrent_identical_mutation_marks_one_replayed(
    inner: Arc<dyn LedgerStore>,
    resource_id: &str,
) {
    let racing_store = Arc::new(SnapshotRaceStore::new(inner));
    let store: Arc<dyn LedgerStore> = racing_store.clone();
    let ledger = ClusterLedger::create(store, resource(resource_id), owner("owner"), 10_000)
        .await
        .unwrap();
    racing_store.arm();

    let first_ledger = ledger.clone();
    let first = tokio::spawn(async move {
        first_ledger
            .admit(key("same-key"), [1; 32], admission(b"same-admission"))
            .await
            .unwrap()
    });
    let second_ledger = ledger.clone();
    let second = tokio::spawn(async move {
        second_ledger
            .admit(key("same-key"), [1; 32], admission(b"same-admission"))
            .await
            .unwrap()
    });
    let (first, second) = tokio::join!(first, second);
    let first = first.unwrap();
    let second = second.unwrap();

    assert_ne!(first.replayed, second.replayed);
    assert_eq!(first.value, second.value);
    assert_eq!(first.position, second.position);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn concurrent_identical_fake_mutation_marks_exactly_one_result_replayed() {
    let store: Arc<dyn LedgerStore> = Arc::new(FakeLedgerStore::new(ManualLedgerClock::new(1_000)));
    assert_concurrent_identical_mutation_marks_one_replayed(store, "concurrent-fake-idempotency")
        .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn concurrent_identical_sqlite_mutation_marks_exactly_one_result_replayed() {
    let root = temp_root("concurrent-sqlite-idempotency");
    let store: Arc<dyn LedgerStore> =
        Arc::new(SqliteLedgerStore::with_clock(&root, ManualLedgerClock::new(1_000)).unwrap());
    assert_concurrent_identical_mutation_marks_one_replayed(store, "concurrent-sqlite-idempotency")
        .await;
    std::fs::remove_dir_all(root).unwrap();
}

fn assert_one_cas_winner<T, E>(first: &Result<T, E>, second: &Result<T, E>) {
    assert_eq!(
        usize::from(first.is_ok()) + usize::from(second.is_ok()),
        1,
        "exactly one mutation may commit from one validated prefix"
    );
}

pub(super) fn assert_protocol_store_adapters<T>()
where
    T: AdmissionStore + ControlJournal + VerifiedIoLedger + LifecycleStore,
{
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn concurrent_admissions_cas_against_the_validated_prefix() {
    let (store, ledger) = race_ledger("race-admission").await;
    store.arm();
    let first_ledger = ledger.clone();
    let first = tokio::spawn(async move {
        first_ledger
            .admit(key("admit-a"), [1; 32], admission(b"graph-a"))
            .await
    });
    let second_ledger = ledger.clone();
    let second = tokio::spawn(async move {
        second_ledger
            .admit(key("admit-b"), [2; 32], admission(b"graph-b"))
            .await
    });
    let first = first.await.unwrap();
    let second = second.await.unwrap();

    assert_one_cas_winner(&first, &second);
    let state = ledger.state().await.unwrap();
    assert_eq!(state.identities.next_generation, 2);
    assert_eq!(state.identities.next_run, 2);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn concurrent_dispatches_cas_against_the_validated_prefix() {
    let (store, ledger) = race_ledger("race-dispatch").await;
    ledger
        .admit(key("admit"), [1; 32], admission(b"graph"))
        .await
        .unwrap();
    store.arm();
    let first_ledger = ledger.clone();
    let first =
        tokio::spawn(async move { first_ledger.dispatch(key("dispatch-a"), [2; 32]).await });
    let second_ledger = ledger.clone();
    let second =
        tokio::spawn(async move { second_ledger.dispatch(key("dispatch-b"), [3; 32]).await });
    let first = first.await.unwrap();
    let second = second.await.unwrap();

    assert_one_cas_winner(&first, &second);
    let state = ledger.state().await.unwrap();
    assert_eq!(state.active_dispatches.len(), 1);
    assert_eq!(state.identities.next_node_instance, 2);
    assert_eq!(state.identities.next_execution, 2);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn concurrent_settlements_cas_against_the_validated_prefix() {
    let (store, ledger) = race_ledger("race-settlement").await;
    let execution = admit_and_dispatch(&ledger).await;
    store.arm();
    let first_ledger = ledger.clone();
    let first = tokio::spawn(async move {
        first_ledger
            .settle(
                key("settle-a"),
                [3; 32],
                execution,
                CanonicalDigest::of(b"outcome-a"),
                None,
            )
            .await
    });
    let second_ledger = ledger.clone();
    let second = tokio::spawn(async move {
        second_ledger
            .settle(
                key("settle-b"),
                [4; 32],
                execution,
                CanonicalDigest::of(b"outcome-b"),
                None,
            )
            .await
    });
    let first = first.await.unwrap();
    let second = second.await.unwrap();

    assert_one_cas_winner(&first, &second);
    let state = ledger.state().await.unwrap();
    assert_eq!(state.settlements.len(), 1);
    assert!(state.active_dispatches.is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn concurrent_terminalizations_cas_against_the_validated_prefix() {
    let (store, ledger) = race_ledger("race-terminal").await;
    ledger
        .admit(key("admit"), [1; 32], admission(b"graph"))
        .await
        .unwrap();
    store.arm();
    let first_ledger = ledger.clone();
    let first = tokio::spawn(async move {
        first_ledger
            .terminalize(
                key("terminal-a"),
                [2; 32],
                CanonicalDigest::of(b"outcome-a"),
            )
            .await
    });
    let second_ledger = ledger.clone();
    let second = tokio::spawn(async move {
        second_ledger
            .terminalize(
                key("terminal-b"),
                [3; 32],
                CanonicalDigest::of(b"outcome-b"),
            )
            .await
    });
    let first = first.await.unwrap();
    let second = second.await.unwrap();

    assert_one_cas_winner(&first, &second);
    assert!(ledger.state().await.unwrap().terminal_outcome.is_some());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn concurrent_safe_faults_cas_against_the_validated_prefix() {
    let (store, ledger) = race_ledger("race-safe-fault").await;
    let execution = admit_and_dispatch(&ledger).await;
    let fault = FaultFactory::new(&NoopObservationSink).create(ModuleEvidence::new(
        FaultModule::Worker,
        FaultContext::Execution,
        EvidenceClass::ProcessExited,
    ));
    store.arm();
    let first_ledger = ledger.clone();
    let first_fault = fault.clone();
    let first = tokio::spawn(async move {
        first_ledger
            .record_safe_fault(
                key("safe-fault-a"),
                [3; 32],
                &first_fault,
                SafeFaultConsequence::Settle {
                    execution,
                    outcome_digest: CanonicalDigest::of(b"outcome-a"),
                },
            )
            .await
    });
    let second_ledger = ledger.clone();
    let second = tokio::spawn(async move {
        second_ledger
            .record_safe_fault(
                key("safe-fault-b"),
                [4; 32],
                &fault,
                SafeFaultConsequence::Settle {
                    execution,
                    outcome_digest: CanonicalDigest::of(b"outcome-b"),
                },
            )
            .await
    });
    let first = first.await.unwrap();
    let second = second.await.unwrap();

    assert_one_cas_winner(&first, &second);
    let state = ledger.state().await.unwrap();
    assert_eq!(state.safe_faults.len(), 1);
    assert_eq!(state.settlements.len(), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn concurrent_effect_intents_cas_against_the_validated_prefix() {
    let (store, ledger) = race_ledger("race-effect-intent").await;
    ledger
        .admit(key("admit"), [1; 32], admission(b"graph"))
        .await
        .unwrap();
    store.arm();
    let first_ledger = ledger.clone();
    let first = tokio::spawn(async move {
        first_ledger
            .record_effect_intent(
                key("effect-intent-a"),
                [2; 32],
                CanonicalDigest::of(b"request-a"),
            )
            .await
    });
    let second_ledger = ledger.clone();
    let second = tokio::spawn(async move {
        second_ledger
            .record_effect_intent(
                key("effect-intent-b"),
                [3; 32],
                CanonicalDigest::of(b"request-b"),
            )
            .await
    });
    let first = first.await.unwrap();
    let second = second.await.unwrap();

    assert_one_cas_winner(&first, &second);
    let state = ledger.state().await.unwrap();
    assert_eq!(state.effects.len(), 1);
    assert_eq!(state.identities.next_effect, 2);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn concurrent_effect_receipts_cas_against_the_validated_prefix() {
    let (store, ledger) = race_ledger("race-effect-receipt").await;
    ledger
        .admit(key("admit"), [1; 32], admission(b"graph"))
        .await
        .unwrap();
    let effect = ledger
        .record_effect_intent(
            key("effect-intent"),
            [2; 32],
            CanonicalDigest::of(b"request"),
        )
        .await
        .unwrap()
        .value
        .effect;
    store.arm();
    let first_ledger = ledger.clone();
    let first = tokio::spawn(async move {
        first_ledger
            .reconcile_effect(
                key("effect-receipt-a"),
                [3; 32],
                effect,
                CanonicalDigest::of(b"receipt-a"),
            )
            .await
    });
    let second_ledger = ledger.clone();
    let second = tokio::spawn(async move {
        second_ledger
            .reconcile_effect(
                key("effect-receipt-b"),
                [4; 32],
                effect,
                CanonicalDigest::of(b"receipt-b"),
            )
            .await
    });
    let first = first.await.unwrap();
    let second = second.await.unwrap();

    assert_one_cas_winner(&first, &second);
    assert!(
        ledger
            .state()
            .await
            .unwrap()
            .effects
            .get(&effect)
            .unwrap()
            .receipt_digest
            .is_some()
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn concurrent_cleanup_receipts_cas_against_the_validated_prefix() {
    let (store, ledger) = race_ledger("race-cleanup").await;
    ledger
        .admit(key("admit"), [1; 32], admission(b"graph"))
        .await
        .unwrap();
    ledger
        .terminalize(key("terminal"), [2; 32], CanonicalDigest::of(b"outcome"))
        .await
        .unwrap();
    store.arm();
    let first_ledger = ledger.clone();
    let first = tokio::spawn(async move {
        first_ledger
            .record_cleanup_receipt(key("cleanup-a"), [3; 32], CanonicalDigest::of(b"cleanup-a"))
            .await
    });
    let second_ledger = ledger.clone();
    let second = tokio::spawn(async move {
        second_ledger
            .record_cleanup_receipt(key("cleanup-b"), [4; 32], CanonicalDigest::of(b"cleanup-b"))
            .await
    });
    let first = first.await.unwrap();
    let second = second.await.unwrap();

    assert_one_cas_winner(&first, &second);
    assert_eq!(ledger.state().await.unwrap().cleanup_receipts.len(), 1);
}
