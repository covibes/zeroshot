use std::collections::{BTreeMap, BTreeSet};

use openengine_cluster_protocol::PositiveInteger;
use zeroshot_engine::artifact_store::fake::FakeArtifactStore;
use zeroshot_engine::artifact_store::ArtifactStore;
use zeroshot_engine::cluster_ledger::record::{CanonicalDigest, RecordPayload, StoredRecord};
use zeroshot_engine::cluster_ledger::replay::ReplayError;
use zeroshot_engine::cluster_ledger::store::{
    IdempotencyId, MutationReceipt, Position, PrefixSnapshot, ResourceId,
};
use zeroshot_engine::required_proof::{
    AcceptProofRequest, AcceptedProofRef, ProcessOutcome, ProofAttemptIntent,
    ProofAttemptIntentRequest, ProofAttemptReceipt, ProofAttemptReceiptRequest, ProofOutput,
    ProofSelection, TrustedGate, TrustedGateRequest,
};

#[path = "../support/artifacts.rs"]
mod artifacts;

fn revision(character: char) -> String {
    std::iter::repeat_n(character, 40).collect()
}

fn gate() -> TrustedGate {
    TrustedGate::new(TrustedGateRequest {
        gate_id: "required.replay".to_owned(),
        argv: vec!["cargo".to_owned(), "test".to_owned()],
        cwd: "zeroshot-rust".to_owned(),
        inherited_env: BTreeSet::from(["PATH".to_owned()]),
        explicit_env: BTreeMap::new(),
        timeout_ms: 30_000,
        freshness_ms: 5_000,
        tool_identity: "cargo".to_owned(),
        tool_version: "1.88.0".to_owned(),
        tool_digest: CanonicalDigest::of(b"tool"),
        repository: "the-open-engine/zeroshot".to_owned(),
        base_revision: revision('a'),
        head_revision: revision('b'),
        config_digest: CanonicalDigest::of(b"config"),
    })
    .unwrap()
}

async fn receipt(store: &FakeArtifactStore, intent: &ProofAttemptIntent) -> ProofAttemptReceipt {
    let mut outputs = Vec::new();
    for bytes in [b"stdout".as_slice(), b"stderr".as_slice()] {
        let mut artifact_intent =
            artifacts::test_intent(bytes, &format!("run:{}", intent.run().get()));
        artifact_intent.lineage.attempt =
            PositiveInteger::new(u64::from(intent.attempt())).unwrap();
        let staged = store
            .stage(artifact_intent, artifacts::byte_stream(bytes.to_vec()))
            .await
            .unwrap();
        outputs.push(ProofOutput::new(store.publish(&staged).await.unwrap()).unwrap());
    }
    ProofAttemptReceipt::new(
        intent,
        ProofAttemptReceiptRequest {
            started_at_ms: 1_100,
            finished_at_ms: Some(1_200),
            outcome: ProcessOutcome::Exited { exit_code: 0 },
            stdout: Some(outputs.remove(0)),
            stderr: Some(outputs.remove(0)),
        },
    )
    .unwrap()
}

fn append_intent_mutation(
    snapshot: &mut PrefixSnapshot,
    resource: &ResourceId,
    key: IdempotencyId,
    intent: &ProofAttemptIntent,
) {
    let payload = intent.ledger_record().unwrap();
    let proof_position = snapshot.position.checked_add(1).unwrap();
    let previous_hash = snapshot
        .records
        .last()
        .map_or([0; 32], |record| record.record_hash);
    let proof_record =
        StoredRecord::build(resource.clone(), proof_position, &payload, previous_hash).unwrap();
    let receipt_position = proof_position.checked_add(1).unwrap();
    let receipt = MutationReceipt {
        idempotency_key: key,
        method: "required_proof_intent".to_owned(),
        fingerprint: intent.intent_id().as_bytes(),
        response: serde_json::to_vec(&intent.intent_id()).unwrap(),
        committed_position: receipt_position,
    };
    let receipt_record = StoredRecord::build(
        resource.clone(),
        receipt_position,
        &RecordPayload::MutationReceipt {
            receipt: receipt.clone(),
        },
        proof_record.record_hash,
    )
    .unwrap();
    snapshot.records.push(proof_record);
    snapshot.records.push(receipt_record);
    snapshot.receipts.push(receipt);
    snapshot.position = receipt_position;
}

fn assert_forged_required_proof_fingerprint_rejected(
    snapshot: &PrefixSnapshot,
    resource: &ResourceId,
    method: &str,
) {
    let mut forged = snapshot.clone();
    let forged_receipt = forged
        .receipts
        .iter_mut()
        .find(|receipt| receipt.method == method)
        .unwrap();
    forged_receipt.fingerprint = [0; 32];
    let forged_receipt = forged_receipt.clone();
    let record_index = forged
        .records
        .iter()
        .position(|record| {
            matches!(
                RecordPayload::decode(record.kind, record.version, &record.payload),
                Ok(RecordPayload::MutationReceipt { receipt })
                    if receipt.idempotency_key == forged_receipt.idempotency_key
            )
        })
        .unwrap();
    super::replace_payload(
        &mut forged,
        record_index,
        RecordPayload::MutationReceipt {
            receipt: forged_receipt,
        },
    );
    assert_eq!(
        super::replay(&forged, resource).unwrap_err(),
        ReplayError::ReceiptCorrupt
    );
}

#[test]
fn replay_rejects_required_proof_intent_without_admission() {
    let resource = super::resource("proof-before-admission");
    let trusted = gate();
    let intent = ProofAttemptIntent::new(
        &trusted,
        ProofAttemptIntentRequest {
            run: zeroshot_engine::cluster_ledger::RunSequence::new(7).unwrap(),
            attempt: 1,
            requested_at_ms: 1_000,
            selection: ProofSelection::admitted(&trusted),
        },
    )
    .unwrap();
    let mut snapshot = PrefixSnapshot {
        position: Position::ZERO,
        records: Vec::new(),
        receipts: Vec::new(),
    };
    append_intent_mutation(
        &mut snapshot,
        &resource,
        super::key("proof-before-admission"),
        &intent,
    );
    assert_eq!(
        super::replay(&snapshot, &resource).unwrap_err(),
        ReplayError::InvalidOrder
    );
}

#[tokio::test]
async fn replay_rejects_required_proof_intent_for_non_current_run() {
    let (store, cluster) = super::ledger("proof-wrong-run").await;
    cluster
        .admit(
            super::key("wrong-run-admit"),
            [9; 32],
            super::admission(b"wrong-run-graph"),
        )
        .await
        .unwrap();
    let trusted = gate();
    let intent = ProofAttemptIntent::new(
        &trusted,
        ProofAttemptIntentRequest {
            run: zeroshot_engine::cluster_ledger::RunSequence::new(7).unwrap(),
            attempt: 1,
            requested_at_ms: 1_000,
            selection: ProofSelection::admitted(&trusted),
        },
    )
    .unwrap();
    let mut snapshot = store.read_prefix(cluster.resource(), None).await.unwrap();
    append_intent_mutation(
        &mut snapshot,
        cluster.resource(),
        super::key("proof-wrong-run"),
        &intent,
    );
    assert_eq!(
        super::replay(&snapshot, cluster.resource()).unwrap_err(),
        ReplayError::InvalidOrder
    );
}

#[tokio::test]
async fn required_proof_records_round_trip_and_fold_exact_immutable_attempts() {
    let (store, cluster) = super::ledger("required-proof-replay").await;
    let allocation = cluster
        .admit(
            super::key("proof-admit"),
            [7; 32],
            super::admission(b"proof-graph"),
        )
        .await
        .unwrap()
        .value;
    let trusted = gate();
    let first = ProofAttemptIntent::new(
        &trusted,
        ProofAttemptIntentRequest {
            run: allocation.run,
            attempt: 1,
            requested_at_ms: 1_000,
            selection: ProofSelection::admitted(&trusted),
        },
    )
    .unwrap();
    let first_commit = cluster
        .record_required_proof_intent(super::key("proof-intent-1"), first.clone())
        .await
        .unwrap();
    assert!(!first_commit.replayed);
    assert!(
        cluster
            .record_required_proof_intent(super::key("proof-intent-1"), first.clone())
            .await
            .unwrap()
            .replayed
    );

    let artifacts = FakeArtifactStore::new();
    let first_receipt = receipt(&artifacts, &first).await;
    cluster
        .record_required_proof_receipt(super::key("proof-receipt-1"), first_receipt.clone())
        .await
        .unwrap();
    let accepted = AcceptedProofRef::accept(AcceptProofRequest {
        gate: &trusted,
        intent: &first,
        receipt: &first_receipt,
        accepted_at_ms: 1_300,
        artifacts: &artifacts,
    })
    .await
    .unwrap();
    cluster
        .record_required_proof_acceptance(super::key("proof-acceptance-1"), accepted.clone())
        .await
        .unwrap();

    let later = ProofAttemptIntent::new(
        &trusted,
        ProofAttemptIntentRequest {
            run: allocation.run,
            attempt: 2,
            requested_at_ms: 1_400,
            selection: ProofSelection::admitted(&trusted),
        },
    )
    .unwrap();
    cluster
        .record_required_proof_intent(super::key("proof-intent-2"), later.clone())
        .await
        .unwrap();
    let later_receipt = receipt(&artifacts, &later).await;
    cluster
        .record_required_proof_receipt(super::key("proof-receipt-2"), later_receipt.clone())
        .await
        .unwrap();

    let state = cluster.state().await.unwrap();
    assert_eq!(state.required_proofs.len(), 2);
    assert_eq!(state.required_proofs[0].intent, first);
    assert_eq!(state.required_proofs[0].receipt, Some(first_receipt));
    assert_eq!(state.required_proofs[0].accepted, Some(accepted));
    assert_eq!(state.required_proofs[1].intent, later);
    assert_eq!(state.required_proofs[1].receipt, Some(later_receipt));
    assert_eq!(state.required_proofs[1].accepted, None);

    let snapshot = store.read_prefix(cluster.resource(), None).await.unwrap();
    let replayed = super::replay(&snapshot, cluster.resource()).unwrap();
    assert_eq!(replayed.required_proofs, state.required_proofs);
    assert_eq!(
        replayed.public_bytes().unwrap(),
        state.public_bytes().unwrap()
    );
    for method in [
        "required_proof_intent",
        "required_proof_receipt",
        "required_proof_acceptance",
    ] {
        assert_forged_required_proof_fingerprint_rejected(&snapshot, cluster.resource(), method);
    }
}
