use std::collections::{BTreeMap, BTreeSet};

use async_trait::async_trait;
use openengine_cluster_protocol::{ArtifactRef, PositiveInteger};
use zeroshot_engine::artifact_store::fake::FakeArtifactStore;
use zeroshot_engine::artifact_store::ArtifactStore;
use zeroshot_engine::cluster_ledger::record::{CanonicalDigest, RunSequence};
use zeroshot_engine::required_proof::{
    reconcile_after_uncertainty, AcceptProofRequest, AcceptedProofRef, ArtifactReverification,
    AuthoritativeAttempt, InspectProofAttempt, PerformProofAttempt, ProcessOutcome,
    ProofAttemptIntent, ProofAttemptIntentRequest, ProofAttemptReceipt, ProofAttemptReceiptRequest,
    ProofOutput, ProofSelection, ReconcileProofAttempt, RequiredProofError, TrustedGate,
    TrustedGateRequest, MAX_ARGUMENT_BYTES,
};

#[path = "support/artifacts.rs"]
mod artifacts;

fn digest(label: &[u8]) -> CanonicalDigest {
    CanonicalDigest::of(label)
}

fn revision(character: char) -> String {
    std::iter::repeat_n(character, 40).collect()
}

fn gate_with(
    config_digest: CanonicalDigest,
    tool_digest: CanonicalDigest,
    base_revision: String,
    head_revision: String,
) -> TrustedGate {
    TrustedGate::new(TrustedGateRequest {
        gate_id: "required.unit".to_owned(),
        argv: vec!["cargo".to_owned(), "test".to_owned(), "--locked".to_owned()],
        cwd: "zeroshot-rust".to_owned(),
        inherited_env: BTreeSet::from(["PATH".to_owned()]),
        explicit_env: BTreeMap::from([("CARGO_TERM_COLOR".to_owned(), "never".to_owned())]),
        timeout_ms: 60_000,
        freshness_ms: 5_000,
        tool_identity: "cargo".to_owned(),
        tool_version: "1.88.0".to_owned(),
        tool_digest,
        repository: "the-open-engine/zeroshot".to_owned(),
        base_revision,
        head_revision,
        config_digest,
    })
    .unwrap()
}

fn gate() -> TrustedGate {
    gate_with(
        digest(b"config"),
        digest(b"tool"),
        revision('a'),
        revision('b'),
    )
}

fn intent_for(gate: &TrustedGate, attempt: u32) -> ProofAttemptIntent {
    ProofAttemptIntent::new(
        gate,
        ProofAttemptIntentRequest {
            run: RunSequence::new(7).unwrap(),
            attempt,
            requested_at_ms: 10_000,
            selection: ProofSelection::admitted(gate),
        },
    )
    .unwrap()
}

async fn artifact_with_lineage(
    store: &FakeArtifactStore,
    bytes: &[u8],
    run_id: &str,
    attempt: u64,
) -> ArtifactRef {
    let mut artifact_intent = artifacts::test_intent(bytes, run_id);
    artifact_intent.lineage.attempt = PositiveInteger::new(attempt).unwrap();
    let staged = store
        .stage(artifact_intent, artifacts::byte_stream(bytes.to_vec()))
        .await
        .unwrap();
    store.publish(&staged).await.unwrap()
}

async fn artifact(
    store: &FakeArtifactStore,
    bytes: &[u8],
    intent: &ProofAttemptIntent,
) -> ArtifactRef {
    artifact_with_lineage(
        store,
        bytes,
        &format!("run:{}", intent.run().get()),
        u64::from(intent.attempt()),
    )
    .await
}

async fn passing_receipt(
    store: &FakeArtifactStore,
    intent: &ProofAttemptIntent,
) -> ProofAttemptReceipt {
    let stdout = artifact(store, b"stdout", intent).await;
    let stderr = artifact(store, b"stderr", intent).await;
    ProofAttemptReceipt::new(
        intent,
        ProofAttemptReceiptRequest {
            started_at_ms: 10_100,
            finished_at_ms: Some(10_500),
            outcome: ProcessOutcome::Exited { exit_code: 0 },
            stdout: Some(ProofOutput::new(stdout).unwrap()),
            stderr: Some(ProofOutput::new(stderr).unwrap()),
        },
    )
    .unwrap()
}

#[test]
fn trusted_gate_rejects_unknown_oversized_and_non_normal_values() {
    let value = gate();
    let bytes = value.canonical_bytes().unwrap();
    let mut json: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    json.as_object_mut()
        .unwrap()
        .insert("unknown".to_owned(), serde_json::json!(true));
    assert_eq!(
        TrustedGate::decode(&serde_json::to_vec(&json).unwrap()).unwrap_err(),
        RequiredProofError::Decode
    );

    let mut request = TrustedGateRequest {
        gate_id: "required.unit".to_owned(),
        argv: vec!["x".repeat(MAX_ARGUMENT_BYTES + 1)],
        cwd: ".".to_owned(),
        inherited_env: BTreeSet::new(),
        explicit_env: BTreeMap::new(),
        timeout_ms: 1,
        freshness_ms: 1,
        tool_identity: "tool".to_owned(),
        tool_version: "1".to_owned(),
        tool_digest: digest(b"tool"),
        repository: "repository".to_owned(),
        base_revision: revision('a'),
        head_revision: revision('b'),
        config_digest: digest(b"config"),
    };
    assert_eq!(
        TrustedGate::new(request.clone()).unwrap_err(),
        RequiredProofError::Oversized("argument")
    );
    for cwd in ["/absolute", "a/../b", "a//b", "./a", "a/./b", "a\\b"] {
        request.argv = vec!["tool".to_owned()];
        request.cwd = cwd.to_owned();
        assert_eq!(
            TrustedGate::new(request.clone()).unwrap_err(),
            RequiredProofError::Invalid("cwd")
        );
    }
}

#[test]
fn explicit_environment_is_bounded_valid_and_credential_free() {
    let base = gate();
    let mut request = TrustedGateRequest {
        gate_id: base.gate_id().to_owned(),
        argv: base.argv().to_vec(),
        cwd: base.cwd().to_owned(),
        inherited_env: BTreeSet::new(),
        explicit_env: BTreeMap::new(),
        timeout_ms: base.timeout_ms(),
        freshness_ms: base.freshness_ms(),
        tool_identity: base.tool_identity().to_owned(),
        tool_version: base.tool_version().to_owned(),
        tool_digest: base.tool_digest(),
        repository: base.repository().to_owned(),
        base_revision: base.base_revision().to_owned(),
        head_revision: base.head_revision().to_owned(),
        config_digest: base.config_digest(),
    };
    for credential_name in [
        "API_KEY",
        "GITHUB_PAT",
        "GITHUB_TOKEN",
        "CI_JOB_JWT",
        "NPM_AUTH",
    ] {
        request.explicit_env =
            BTreeMap::from([(credential_name.to_owned(), "credential".to_owned())]);
        assert_eq!(
            TrustedGate::new(request.clone()).unwrap_err(),
            RequiredProofError::Invalid("explicit environment")
        );
    }
    request.explicit_env = BTreeMap::from([("BAD=NAME".to_owned(), "value".to_owned())]);
    assert_eq!(
        TrustedGate::new(request.clone()).unwrap_err(),
        RequiredProofError::Invalid("environment name")
    );
    request.explicit_env = BTreeMap::from([("SAFE_NAME".to_owned(), "line\nvalue".to_owned())]);
    assert_eq!(
        TrustedGate::new(request.clone()).unwrap_err(),
        RequiredProofError::Invalid("environment value")
    );
    request.explicit_env =
        BTreeMap::from([("CARGO_TERM_COLOR".to_owned(), "credential".to_owned())]);
    assert_eq!(
        TrustedGate::new(request).unwrap_err(),
        RequiredProofError::Invalid("explicit environment value")
    );
}

#[tokio::test]
async fn receipt_rejects_cross_run_and_cross_attempt_artifact_lineage() {
    let trusted = gate();
    let intent = intent_for(&trusted, 1);
    let store = FakeArtifactStore::new();
    let stderr = artifact(&store, b"correct-stderr", &intent).await;
    let wrong_run = artifact_with_lineage(&store, b"wrong-run", "run:99", 1).await;
    let wrong_attempt = artifact_with_lineage(&store, b"wrong-attempt", "run:7", 2).await;

    for (stdout, expected) in [
        (
            wrong_run,
            RequiredProofError::BindingMismatch("artifact run"),
        ),
        (
            wrong_attempt,
            RequiredProofError::BindingMismatch("artifact attempt"),
        ),
    ] {
        assert_eq!(
            ProofAttemptReceipt::new(
                &intent,
                ProofAttemptReceiptRequest {
                    started_at_ms: 10_100,
                    finished_at_ms: Some(10_500),
                    outcome: ProcessOutcome::Exited { exit_code: 0 },
                    stdout: Some(ProofOutput::new(stdout).unwrap()),
                    stderr: Some(ProofOutput::new(stderr.clone()).unwrap()),
                },
            )
            .unwrap_err(),
            expected
        );
    }
}

#[test]
fn graph_visible_selection_contains_only_gate_and_revision_bindings() {
    let trusted = gate();
    let selection = ProofSelection::admitted(&trusted);
    let json = String::from_utf8(selection.canonical_bytes().unwrap()).unwrap();
    for present in ["gate_id", "repository", "base_revision", "head_revision"] {
        assert!(json.contains(present));
    }
    for absent in ["argv", "cwd", "env", "tool", "digest", "credential", "path"] {
        assert!(!json.contains(absent), "selection leaked {absent}: {json}");
    }
}

#[test]
fn canonical_encoding_and_identity_are_stable_and_strict() {
    let trusted = gate();
    let decoded = TrustedGate::decode(&trusted.canonical_bytes().unwrap()).unwrap();
    assert_eq!(decoded, trusted);
    assert_eq!(decoded.gate_digest(), trusted.gate_digest());

    let first = intent_for(&trusted, 1);
    let second = intent_for(&trusted, 1);
    assert_eq!(first, second);
    assert_eq!(first.intent_id(), second.intent_id());
    assert_eq!(
        PerformProofAttempt::new(first.clone()).idempotency_identity(),
        first.intent_id()
    );
    let inspect = InspectProofAttempt::for_intent(&first);
    assert_eq!(inspect.run(), first.run());
    assert_eq!(inspect.attempt(), first.attempt());
    assert_eq!(inspect.idempotency_identity(), first.intent_id());
    let padded = format!(
        " {}",
        String::from_utf8(first.canonical_bytes().unwrap()).unwrap()
    );
    assert_eq!(
        ProofAttemptIntent::decode(padded.as_bytes()).unwrap_err(),
        RequiredProofError::NonCanonical
    );
}

#[tokio::test]
async fn wrong_revision_config_tool_and_gate_digest_fail_closed() {
    let trusted = gate();
    let attempt = intent_for(&trusted, 1);
    let store = FakeArtifactStore::new();
    let receipt = passing_receipt(&store, &attempt).await;

    let variants = [
        gate_with(
            digest(b"other-config"),
            digest(b"tool"),
            revision('a'),
            revision('b'),
        ),
        gate_with(
            digest(b"config"),
            digest(b"other-tool"),
            revision('a'),
            revision('b'),
        ),
        gate_with(
            digest(b"config"),
            digest(b"tool"),
            revision('c'),
            revision('b'),
        ),
    ];
    for wrong in variants {
        assert!(
            AcceptedProofRef::accept(AcceptProofRequest {
                gate: &wrong,
                intent: &attempt,
                receipt: &receipt,
                accepted_at_ms: 11_000,
                artifacts: &store,
            })
            .await
            .is_err()
        );
    }

    let mut json: serde_json::Value =
        serde_json::from_slice(&attempt.canonical_bytes().unwrap()).unwrap();
    json["body"]["gate_digest"] = serde_json::json!(vec![0; 32]);
    assert_eq!(
        ProofAttemptIntent::decode(&serde_json::to_vec(&json).unwrap()).unwrap_err(),
        RequiredProofError::DigestMismatch("intent")
    );
}

#[tokio::test]
async fn stale_failed_incomplete_and_indeterminate_attempts_are_never_accepted() {
    let trusted = gate();
    let attempt = intent_for(&trusted, 1);
    let store = FakeArtifactStore::new();
    let passing = passing_receipt(&store, &attempt).await;
    assert_eq!(
        AcceptedProofRef::accept(AcceptProofRequest {
            gate: &trusted,
            intent: &attempt,
            receipt: &passing,
            accepted_at_ms: 20_000,
            artifacts: &store,
        })
        .await
        .unwrap_err(),
        RequiredProofError::Stale
    );

    for (outcome, finished, expected) in [
        (
            ProcessOutcome::Exited { exit_code: 1 },
            Some(10_500),
            RequiredProofError::NotPassing,
        ),
        (
            ProcessOutcome::Incomplete,
            None,
            RequiredProofError::Incomplete,
        ),
        (
            ProcessOutcome::Indeterminate,
            Some(10_500),
            RequiredProofError::Indeterminate,
        ),
    ] {
        let receipt = ProofAttemptReceipt::new(
            &attempt,
            ProofAttemptReceiptRequest {
                started_at_ms: 10_100,
                finished_at_ms: finished,
                outcome,
                stdout: None,
                stderr: None,
            },
        )
        .unwrap();
        assert_eq!(
            AcceptedProofRef::accept(AcceptProofRequest {
                gate: &trusted,
                intent: &attempt,
                receipt: &receipt,
                accepted_at_ms: 11_000,
                artifacts: &store,
            })
            .await
            .unwrap_err(),
            expected
        );
    }
}

#[tokio::test]
async fn acceptance_is_bound_to_one_exact_attempt_and_later_attempts_are_distinct() {
    let trusted = gate();
    let first = intent_for(&trusted, 1);
    let later = intent_for(&trusted, 2);
    let store = FakeArtifactStore::new();
    let first_receipt = passing_receipt(&store, &first).await;
    let later_receipt = passing_receipt(&store, &later).await;
    let accepted = AcceptedProofRef::accept(AcceptProofRequest {
        gate: &trusted,
        intent: &first,
        receipt: &first_receipt,
        accepted_at_ms: 11_000,
        artifacts: &store,
    })
    .await
    .unwrap();
    accepted.matches(&first, &first_receipt).unwrap();
    assert!(accepted.matches(&later, &later_receipt).is_err());
    assert_ne!(first.intent_id(), later.intent_id());
    assert_ne!(
        first_receipt.receipt_digest(),
        later_receipt.receipt_digest()
    );

    let mut forged: serde_json::Value =
        serde_json::from_slice(&accepted.canonical_bytes().unwrap()).unwrap();
    forged["attempt"] = serde_json::json!(2);
    assert_eq!(
        AcceptedProofRef::decode(&serde_json::to_vec(&forged).unwrap()).unwrap_err(),
        RequiredProofError::DigestMismatch("acceptance")
    );
}

struct RejectArtifacts;

#[async_trait]
impl ArtifactReverification for RejectArtifacts {
    async fn reverify(&self, _expected: &ArtifactRef) -> Result<(), RequiredProofError> {
        Err(RequiredProofError::ArtifactMismatch)
    }
}

#[tokio::test]
async fn acceptance_requires_artifact_digest_reverification() {
    let trusted = gate();
    let attempt = intent_for(&trusted, 1);
    let store = FakeArtifactStore::new();
    let receipt = passing_receipt(&store, &attempt).await;
    assert_eq!(
        AcceptedProofRef::accept(AcceptProofRequest {
            gate: &trusted,
            intent: &attempt,
            receipt: &receipt,
            accepted_at_ms: 11_000,
            artifacts: &RejectArtifacts,
        })
        .await
        .unwrap_err(),
        RequiredProofError::ArtifactMismatch
    );
    AcceptedProofRef::accept(AcceptProofRequest {
        gate: &trusted,
        intent: &attempt,
        receipt: &receipt,
        accepted_at_ms: 11_000,
        artifacts: &store,
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn reconciliation_after_uncertainty_uses_only_exact_authoritative_receipt() {
    let trusted = gate();
    let intent = intent_for(&trusted, 1);
    assert_eq!(
        reconcile_after_uncertainty(&intent, AuthoritativeAttempt::Missing).unwrap_err(),
        RequiredProofError::AuthorityUncertain
    );
    assert_eq!(
        reconcile_after_uncertainty(
            &intent,
            AuthoritativeAttempt::IntentOnly(Box::new(intent.clone())),
        )
        .unwrap_err(),
        RequiredProofError::AuthorityUncertain
    );
    let store = FakeArtifactStore::new();
    let receipt = passing_receipt(&store, &intent).await;
    assert_eq!(
        reconcile_after_uncertainty(
            &intent,
            AuthoritativeAttempt::Receipt {
                intent: Box::new(intent.clone()),
                receipt: Box::new(receipt.clone()),
            },
        )
        .unwrap(),
        receipt
    );
    assert_eq!(
        ReconcileProofAttempt::new(
            intent.clone(),
            AuthoritativeAttempt::Receipt {
                intent: Box::new(intent.clone()),
                receipt: Box::new(receipt.clone()),
            },
        )
        .resolve()
        .unwrap(),
        receipt
    );
    let other = intent_for(&trusted, 2);
    assert_eq!(
        reconcile_after_uncertainty(&intent, AuthoritativeAttempt::IntentOnly(Box::new(other)),)
            .unwrap_err(),
        RequiredProofError::ConflictingAttempt
    );
}
