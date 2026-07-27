use super::races::assert_protocol_store_adapters;
use super::snapshot_race_store::race_ledger;
use super::*;

#[tokio::test]
async fn protocol_adapters_fold_control_and_lifecycle_from_one_empty_prefix() {
    assert_protocol_store_adapters::<ClusterLedgerAdapters>();
    let (_, ledger) = ledger("adapter-prefix").await;
    let adapters = ClusterLedgerAdapters::new(ledger);
    let (admission, lifecycle) = adapters.read_aggregate().await.unwrap();
    assert_eq!(
        admission.control.phase,
        openengine_cluster_protocol::Phase::Empty
    );
    assert_eq!(admission.control.cursor, None);
    assert_eq!(lifecycle.latest_cursor, None);
}

#[tokio::test]
async fn protocol_admission_adapter_commits_control_seed_and_receipt_atomically() {
    let (store, ledger) = race_ledger("adapter-admission").await;
    let adapters = ClusterLedgerAdapters::new(ledger);
    let proposal = admission_proposal();
    let (changed, generation) = exercise_initial_commits(&adapters, proposal).await;
    assert_running_aggregate(&adapters).await;
    exercise_changed_commit(&store, &adapters, changed, generation).await;
}

fn fixture<T: serde::de::DeserializeOwned>(relative: &str) -> T {
    let repository = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap();
    serde_json::from_slice(
        &std::fs::read(
            repository
                .join("protocol/openengine-cluster/v1/fixtures")
                .join(relative),
        )
        .unwrap(),
    )
    .unwrap()
}

fn admission_proposal() -> CommitProposal {
    let fingerprint = openengine_cluster_protocol::admission_fingerprint(
        "apply",
        &serde_json::json!({"fixture": "adapter"}),
    )
    .unwrap();
    CommitProposal {
        graph: fixture("graph/positive/full-all-nodes.json"),
        compiled_ir: fixture("graph/positive/compiled-ir.json"),
        input: Some(serde_json::json!({})),
        if_generation: Some(openengine_cluster_protocol::Generation::new(0).unwrap()),
        idempotency_key: openengine_cluster_protocol::IdempotencyKey::new("adapter-apply").unwrap(),
        fingerprint,
    }
}

async fn exercise_initial_commits(
    adapters: &ClusterLedgerAdapters,
    proposal: CommitProposal,
) -> (
    CommitProposal,
    Option<openengine_cluster_protocol::Generation>,
) {
    let changed = proposal.clone();
    let mut unchanged = proposal.clone();
    unchanged.input = None;
    unchanged.idempotency_key =
        openengine_cluster_protocol::IdempotencyKey::new("adapter-unchanged").unwrap();
    unchanged.fingerprint = openengine_cluster_protocol::admission_fingerprint(
        "apply",
        &serde_json::json!({"fixture": "unchanged"}),
    )
    .unwrap();
    let first = adapters
        .commit(proposal.clone(), &CancellationSignal::default())
        .await
        .unwrap();
    assert!(!first.deduped);
    unchanged.if_generation = first.generation;
    let unchanged_result = adapters
        .commit(unchanged, &CancellationSignal::default())
        .await
        .unwrap();
    assert!(!unchanged_result.deduped);
    assert_eq!(unchanged_result.generation, first.generation);
    assert_eq!(unchanged_result.run_id, first.run_id);
    let cancelled = CancellationSignal::default();
    cancelled.cancel();
    let replayed = adapters.commit(proposal, &cancelled).await.unwrap();
    assert!(replayed.deduped);
    assert_eq!(first.generation, replayed.generation);
    assert_eq!(first.run_id, replayed.run_id);
    let mut conflict = changed.clone();
    conflict.fingerprint = openengine_cluster_protocol::admission_fingerprint(
        "apply",
        &serde_json::json!({"fixture": "conflict"}),
    )
    .unwrap();
    assert!(matches!(
        adapters
            .commit(conflict, &CancellationSignal::default())
            .await,
        Err(openengine_cluster_server::admission::StoreError::IdempotencyReuse)
    ));
    (changed, first.generation)
}

async fn assert_running_aggregate(adapters: &ClusterLedgerAdapters) {
    let (admission, lifecycle) = adapters.read_aggregate().await.unwrap();
    assert_eq!(
        admission.control.phase,
        openengine_cluster_protocol::Phase::Running
    );
    assert!(admission.control.spec.is_some());
    assert!(admission.control.compiled_ir.is_some());
    assert_eq!(admission.seed.as_ref().unwrap().cursor.as_str(), "ledger:2");
    assert_eq!(
        admission.control.cursor.as_ref().unwrap().as_str(),
        "ledger:4"
    );
    assert_eq!(
        lifecycle.latest_cursor.as_ref().unwrap().as_str(),
        "ledger:4"
    );
}

async fn exercise_changed_commit(
    store: &super::snapshot_race_store::SnapshotRaceStore,
    adapters: &ClusterLedgerAdapters,
    mut changed: CommitProposal,
    generation: Option<openengine_cluster_protocol::Generation>,
) {
    let verifier_vector: serde_json::Value = fixture("verifier/positive/basic.json");
    changed.compiled_ir =
        serde_json::from_value(verifier_vector["expected"]["compiledIr"].clone()).unwrap();
    changed.if_generation = generation;
    changed.idempotency_key =
        openengine_cluster_protocol::IdempotencyKey::new("adapter-changed").unwrap();
    changed.fingerprint = openengine_cluster_protocol::admission_fingerprint(
        "apply",
        &serde_json::json!({"fixture": "changed"}),
    )
    .unwrap();
    let cancellation_race = CancellationSignal::default();
    store.cancel_before_next_append(cancellation_race.clone());
    let position_before_cancel = adapters.ledger().state().await.unwrap().position;
    assert_eq!(
        adapters
            .commit(changed.clone(), &cancellation_race)
            .await
            .unwrap_err(),
        openengine_cluster_server::admission::StoreError::Cancelled
    );
    assert_eq!(
        adapters.ledger().state().await.unwrap().position,
        position_before_cancel
    );
    let changed_result = adapters
        .commit(changed, &CancellationSignal::default())
        .await
        .unwrap();
    assert_eq!(changed_result.generation.unwrap().get(), 2);
    assert_eq!(changed_result.run_id.as_ref().unwrap().as_str(), "run:2");
    let (changed_admission, changed_lifecycle) = adapters.read_aggregate().await.unwrap();
    assert_eq!(
        changed_admission.control.cursor.as_ref().unwrap().as_str(),
        "ledger:7"
    );
    assert_eq!(
        changed_lifecycle.latest_cursor.as_ref().unwrap().as_str(),
        "ledger:7"
    );
}

#[tokio::test]
async fn generation_cas_allocates_exact_sequential_run_identities() {
    let (_, ledger) = ledger("generation-cas").await;
    let first = ledger
        .admit(key("first"), [1; 32], admission(b"graph-one"))
        .await
        .unwrap();
    let first_dispatch = ledger
        .dispatch(key("first-dispatch"), [2; 32])
        .await
        .unwrap();
    let first_outcome = CanonicalDigest::of(b"first-outcome");
    ledger
        .settle(
            key("first-settlement"),
            [3; 32],
            first_dispatch.value.execution,
            first_outcome,
            None,
        )
        .await
        .unwrap();
    let before = ledger.state().await.unwrap().position;
    assert!(
        ledger
            .admit_next(
                key("wrong-cas"),
                [4; 32],
                zeroshot_engine::cluster_ledger::GenerationId::new(99).unwrap(),
                admission(b"graph-two"),
            )
            .await
            .is_err()
    );
    assert_eq!(ledger.state().await.unwrap().position, before);

    let second = ledger
        .admit_next(
            key("second"),
            [5; 32],
            first.value.generation,
            admission(b"graph-two"),
        )
        .await
        .unwrap();
    assert_eq!(second.value.generation.get(), 2);
    assert_eq!(second.value.run.get(), 2);
    let state = ledger.state().await.unwrap();
    assert_eq!(state.admission.unwrap().generation, second.value.generation);
    assert_eq!(state.verified_inputs.len(), 2);
    assert_eq!(state.position.get(), 10);
    let late = ledger
        .settle(
            key("late-first-settlement"),
            [6; 32],
            first_dispatch.value.execution,
            CanonicalDigest::of(b"late-outcome"),
            None,
        )
        .await
        .unwrap();
    assert!(!late.value.accepted);
    assert_eq!(late.value.authoritative_digest, first_outcome);
    assert_eq!(ledger.state().await.unwrap().position.get(), 12);
}

#[tokio::test]
async fn identical_prefix_replays_to_byte_identical_public_state() {
    let (store, ledger) = ledger("exact-replay").await;
    let admitted = ledger
        .admit(key("admit"), [1; 32], admission(b"graph"))
        .await
        .unwrap();
    assert!(!admitted.replayed);
    let duplicate = ledger
        .admit(key("admit"), [1; 32], admission(b"graph"))
        .await
        .unwrap();
    assert!(duplicate.replayed);
    assert_eq!(admitted.value, duplicate.value);

    let dispatched = ledger.dispatch(key("dispatch"), [2; 32]).await.unwrap();
    let output = br#"{"result":"ok"}"#.to_vec();
    let output_digest = CanonicalDigest::of(&output);
    let settled = ledger
        .settle(
            key("settle"),
            [3; 32],
            dispatched.value.execution,
            output_digest,
            Some(output),
        )
        .await
        .unwrap();
    assert!(settled.value.accepted);
    let late = ledger
        .settle(
            key("late"),
            [4; 32],
            dispatched.value.execution,
            CanonicalDigest::of(b"late"),
            None,
        )
        .await
        .unwrap();
    assert!(!late.value.accepted);
    assert_eq!(late.value.authoritative_digest, output_digest);

    let terminal = ledger
        .terminalize(key("terminal"), [5; 32], output_digest)
        .await
        .unwrap();
    ledger
        .record_cleanup_receipt(key("cleanup"), [6; 32], CanonicalDigest::of(b"clean"))
        .await
        .unwrap();
    assert!(
        ledger
            .dispatch(key("post-terminal"), [7; 32])
            .await
            .is_err()
    );

    let prefix = store
        .read_prefix(ledger.resource(), Some(terminal.position))
        .await
        .unwrap();
    let first = replay(&prefix, ledger.resource())
        .unwrap()
        .public_bytes()
        .unwrap();
    let second = replay(&prefix, ledger.resource())
        .unwrap()
        .public_bytes()
        .unwrap();
    assert_eq!(first, second);
}
