use std::io::Cursor;
use std::sync::Arc;

use async_trait::async_trait;
use openengine_cluster_protocol::{ArtifactId, ArtifactRef, ByteLength, RunId, Sha256Digest};
use tokio::io::AsyncReadExt;
use zeroshot_engine::artifact_store::fake::{FakeArtifactStore, FakeFailurePoint};
use zeroshot_engine::artifact_store::{
    ArtifactByteStream, ArtifactIntent, ArtifactStore, ArtifactStoreFailure,
    ArtifactStoreFailureKind, ArtifactStoreOperation, DiscardResult, MAX_ARTIFACT_BYTES,
    ReleaseResult, StagedArtifact, VerifiedArtifactStream, derive_artifact_id,
};
use zeroshot_engine::fault::{EvidenceClass, FaultContext, FaultModule};
use zeroshot_engine::required_proof::{ArtifactReverification, RequiredProofError};

#[path = "support/artifacts.rs"]
mod artifacts;

use artifacts::{byte_stream as stream, test_intent as intent};

#[tokio::test]
async fn store_is_object_safe_and_accepts_the_exact_limit() {
    let store: Arc<dyn ArtifactStore> = Arc::new(FakeArtifactStore::new());
    let bytes = vec![0x5a; MAX_ARTIFACT_BYTES as usize];
    let staged = store
        .stage(intent(&bytes, "exact-limit"), stream(bytes))
        .await
        .expect("the exact artifact limit must stage");
    let artifact_ref = store
        .publish(&staged)
        .await
        .expect("the exact artifact limit must publish");
    assert_eq!(artifact_ref.byte_length.get(), MAX_ARTIFACT_BYTES);
}

#[tokio::test]
async fn stage_rejects_declared_and_streamed_overflow_short_input_and_hash_mismatch() {
    let store = FakeArtifactStore::new();
    let one = vec![1];
    let mut oversized = intent(&one, "declared-overflow");
    oversized.expected_byte_length =
        ByteLength::new(MAX_ARTIFACT_BYTES + 1).expect("protocol length permits store overflow");
    assert_eq!(
        store
            .stage(oversized, stream(Vec::new()))
            .await
            .expect_err("oversized declaration must fail")
            .kind(),
        ArtifactStoreFailureKind::Oversize
    );

    let expected = vec![1, 2];
    assert_eq!(
        store
            .stage(intent(&expected, "stream-overflow"), stream(vec![1, 2, 3]))
            .await
            .expect_err("sentinel byte must detect streamed overflow")
            .kind(),
        ArtifactStoreFailureKind::Oversize
    );
    assert_eq!(
        store
            .stage(intent(&expected, "short"), stream(vec![1]))
            .await
            .expect_err("short input must fail")
            .kind(),
        ArtifactStoreFailureKind::LengthMismatch
    );
    assert_eq!(
        store
            .stage(intent(&expected, "hash"), stream(vec![2, 1]))
            .await
            .expect_err("digest mismatch must fail")
            .kind(),
        ArtifactStoreFailureKind::HashMismatch
    );
}

#[test]
fn artifact_identity_has_a_golden_domain_separated_projection() {
    let artifact_intent = intent(b"golden artifact", "run-golden");
    assert_eq!(
        derive_artifact_id(&artifact_intent).as_str(),
        "cas-v1-ffa3f25c49fda68dbd65543d55d83861ff6b28e8e8f647e57662af90b0ab653b"
    );
    let mut other_lineage = artifact_intent.clone();
    other_lineage.lineage.run_id = RunId::new("run-other");
    assert_ne!(
        derive_artifact_id(&artifact_intent),
        derive_artifact_id(&other_lineage)
    );
}

#[tokio::test]
async fn publish_is_idempotent_and_lineage_refs_share_content() {
    let store = FakeArtifactStore::new();
    let bytes = b"shared bytes".to_vec();
    let first = store
        .stage(intent(&bytes, "run-one"), stream(bytes.clone()))
        .await
        .expect("first stage succeeds");
    let first_ref = store.publish(&first).await.expect("first publish succeeds");
    assert_eq!(
        store.publish(&first).await.expect("retry is idempotent"),
        first_ref
    );

    let duplicate = store
        .stage(intent(&bytes, "run-one"), stream(bytes.clone()))
        .await
        .expect("duplicate stage succeeds");
    assert_eq!(
        store
            .publish(&duplicate)
            .await
            .expect("duplicate intent publishes"),
        first_ref
    );

    let second = store
        .stage(intent(&bytes, "run-two"), stream(bytes))
        .await
        .expect("second lineage stages");
    let second_ref = store
        .publish(&second)
        .await
        .expect("second lineage publishes");
    assert_ne!(first_ref.artifact_id, second_ref.artifact_id);
    assert_eq!(store.blob_count(), 1);
    assert_eq!(store.committed_ref_count(), 2);

    assert_eq!(
        store
            .release(&first_ref.artifact_id)
            .await
            .expect("first release succeeds"),
        ReleaseResult::Released
    );
    assert_eq!(store.blob_count(), 1);
    assert!(
        store
            .inspect(&second_ref.artifact_id)
            .await
            .expect("inspect succeeds")
            .is_some()
    );
    assert_eq!(
        store
            .release(&second_ref.artifact_id)
            .await
            .expect("last release succeeds"),
        ReleaseResult::Released
    );
    assert_eq!(store.blob_count(), 0);
    assert_eq!(
        store
            .release(&second_ref.artifact_id)
            .await
            .expect("release retry succeeds"),
        ReleaseResult::NotFound
    );
}

#[tokio::test]
async fn response_loss_recovers_through_inspect_and_open_yields_verified_bytes() {
    let store = FakeArtifactStore::new();
    let bytes = b"durable artifact".to_vec();
    let staged = store
        .stage(intent(&bytes, "response-loss"), stream(bytes.clone()))
        .await
        .expect("stage succeeds");
    store.script_failure(
        FakeFailurePoint::AfterPublishCommit,
        ArtifactStoreFailureKind::Io(ArtifactStoreOperation::Publish),
    );
    assert_eq!(
        store
            .publish(&staged)
            .await
            .expect_err("script loses publish response")
            .kind(),
        ArtifactStoreFailureKind::Io(ArtifactStoreOperation::Publish)
    );
    let recovered = store
        .inspect(staged.artifact_id())
        .await
        .expect("inspect succeeds")
        .expect("commit is authoritative");
    assert_eq!(&recovered.artifact_id, staged.artifact_id());
    let mut opened = store
        .open(staged.artifact_id())
        .await
        .expect("open succeeds");
    let mut actual = Vec::new();
    opened
        .read_to_end(&mut actual)
        .await
        .expect("verified stream reads");
    assert_eq!(actual, bytes);
}

#[tokio::test]
async fn fake_scripts_every_boundary_in_fifo_order() {
    let failure = ArtifactStoreFailureKind::Io(ArtifactStoreOperation::Stage);
    let stage_store = FakeArtifactStore::new();
    stage_store.script_failure(FakeFailurePoint::BeforeStageCommit, failure);
    assert_eq!(
        stage_store
            .stage(intent(b"x", "stage-fail"), stream(b"x".to_vec()))
            .await
            .expect_err("stage boundary fails")
            .kind(),
        failure
    );

    let store = FakeArtifactStore::new();
    let staged = store
        .stage(intent(b"x", "boundaries"), stream(b"x".to_vec()))
        .await
        .expect("stage succeeds");
    store.script_failure(
        FakeFailurePoint::BeforePublishCommit,
        ArtifactStoreFailureKind::Io(ArtifactStoreOperation::Publish),
    );
    assert!(store.publish(&staged).await.is_err());
    let artifact_ref = store
        .publish(&staged)
        .await
        .expect("publish retry succeeds");

    for (point, operation) in [
        (FakeFailurePoint::Inspect, ArtifactStoreOperation::Inspect),
        (FakeFailurePoint::Open, ArtifactStoreOperation::Open),
        (FakeFailurePoint::Release, ArtifactStoreOperation::Release),
    ] {
        store.script_failure(point, ArtifactStoreFailureKind::Io(operation));
        let result = match point {
            FakeFailurePoint::Inspect => store.inspect(&artifact_ref.artifact_id).await.map(|_| ()),
            FakeFailurePoint::Open => store.open(&artifact_ref.artifact_id).await.map(|_| ()),
            FakeFailurePoint::Release => store.release(&artifact_ref.artifact_id).await.map(|_| ()),
            _ => unreachable!("only direct operation boundaries are listed"),
        };
        assert_eq!(
            result.expect_err("scripted boundary fails").kind(),
            ArtifactStoreFailureKind::Io(operation)
        );
    }

    let pending = store
        .stage(intent(b"y", "discard"), stream(b"y".to_vec()))
        .await
        .expect("pending stage succeeds");
    store.script_failure(
        FakeFailurePoint::Discard,
        ArtifactStoreFailureKind::Io(ArtifactStoreOperation::Discard),
    );
    assert!(store.discard(&pending).await.is_err());
    assert_eq!(
        store
            .discard(&pending)
            .await
            .expect("discard retry succeeds"),
        DiscardResult::Discarded
    );
    assert_eq!(
        store
            .discard(&pending)
            .await
            .expect("discard is idempotent"),
        DiscardResult::AlreadyDiscarded
    );
}

#[tokio::test]
async fn restart_discards_only_uncommitted_stages() {
    let store = FakeArtifactStore::new();
    let committed = store
        .stage(
            intent(b"committed", "restart"),
            stream(b"committed".to_vec()),
        )
        .await
        .expect("committed stage succeeds");
    let committed_ref = store.publish(&committed).await.expect("publish succeeds");
    let _pending = store
        .stage(intent(b"pending", "restart"), stream(b"pending".to_vec()))
        .await
        .expect("pending stage succeeds");
    assert_eq!(store.staged_count(), 2);
    store.restart();
    assert_eq!(store.staged_count(), 0);
    assert!(
        store
            .inspect(&committed_ref.artifact_id)
            .await
            .expect("inspect succeeds after restart")
            .is_some()
    );
}

#[test]
fn failure_mapping_is_closed_and_contains_no_raw_text() {
    let cases = [
        (
            ArtifactStoreFailureKind::Oversize,
            FaultModule::Worker,
            FaultContext::Settlement,
            EvidenceClass::ResourceExhausted,
        ),
        (
            ArtifactStoreFailureKind::HashMismatch,
            FaultModule::Worker,
            FaultContext::Settlement,
            EvidenceClass::MalformedExternalData,
        ),
        (
            ArtifactStoreFailureKind::LockUnavailable,
            FaultModule::Storage,
            FaultContext::Configuration,
            EvidenceClass::Unavailable,
        ),
        (
            ArtifactStoreFailureKind::CorruptContent,
            FaultModule::Storage,
            FaultContext::Recovery,
            EvidenceClass::IntegrityFailure,
        ),
    ];
    for (kind, module, context, class) in cases {
        let failure = zeroshot_engine::artifact_store::ArtifactStoreFailure::new(kind);
        let evidence = failure.module_evidence();
        assert_eq!(evidence.module(), module);
        assert_eq!(evidence.context(), context);
        assert_eq!(evidence.class(), class);
        assert!(!failure.to_string().contains('/'));
        assert!(!format!("{failure:?}").contains("path"));
    }
}

struct CorruptOpenStore {
    artifact_ref: ArtifactRef,
    bytes: Vec<u8>,
}

#[async_trait]
impl ArtifactStore for CorruptOpenStore {
    async fn stage(
        &self,
        _intent: ArtifactIntent,
        _bytes: ArtifactByteStream,
    ) -> Result<StagedArtifact, ArtifactStoreFailure> {
        Err(ArtifactStoreFailure::new(
            ArtifactStoreFailureKind::InvalidStage,
        ))
    }

    async fn publish(&self, _staged: &StagedArtifact) -> Result<ArtifactRef, ArtifactStoreFailure> {
        Err(ArtifactStoreFailure::new(
            ArtifactStoreFailureKind::InvalidStage,
        ))
    }

    async fn inspect(
        &self,
        artifact_id: &ArtifactId,
    ) -> Result<Option<ArtifactRef>, ArtifactStoreFailure> {
        Ok((artifact_id == &self.artifact_ref.artifact_id).then(|| self.artifact_ref.clone()))
    }

    async fn open(
        &self,
        artifact_id: &ArtifactId,
    ) -> Result<VerifiedArtifactStream, ArtifactStoreFailure> {
        if artifact_id != &self.artifact_ref.artifact_id {
            return Err(ArtifactStoreFailure::new(
                ArtifactStoreFailureKind::MissingCommittedContent,
            ));
        }
        Ok(Box::new(Cursor::new(self.bytes.clone())))
    }

    async fn discard(
        &self,
        _staged: &StagedArtifact,
    ) -> Result<DiscardResult, ArtifactStoreFailure> {
        Err(ArtifactStoreFailure::new(
            ArtifactStoreFailureKind::InvalidStage,
        ))
    }

    async fn release(
        &self,
        _artifact_id: &ArtifactId,
    ) -> Result<ReleaseResult, ArtifactStoreFailure> {
        Err(ArtifactStoreFailure::new(
            ArtifactStoreFailureKind::InvalidStage,
        ))
    }
}

#[tokio::test]
async fn required_proof_reverification_hashes_exact_short_and_overlong_streams() {
    let source = FakeArtifactStore::new();
    let expected_bytes = b"proof output".to_vec();
    let staged = source
        .stage(
            intent(&expected_bytes, "proof-corrupt-open"),
            stream(expected_bytes.clone()),
        )
        .await
        .unwrap();
    let artifact_ref = source.publish(&staged).await.unwrap();

    for bytes in [
        vec![b'x'; expected_bytes.len()],
        expected_bytes[..expected_bytes.len() - 1].to_vec(),
        [expected_bytes.as_slice(), b"x"].concat(),
    ] {
        let store = CorruptOpenStore {
            artifact_ref: artifact_ref.clone(),
            bytes,
        };
        assert_eq!(
            ArtifactReverification::reverify(&store, &artifact_ref)
                .await
                .unwrap_err(),
            RequiredProofError::ArtifactMismatch
        );
    }
}

#[tokio::test]
async fn required_proof_reverification_checks_exact_ref_length_and_digest() {
    let store = FakeArtifactStore::new();
    let bytes = b"proof output".to_vec();
    let staged = store
        .stage(intent(&bytes, "proof-reverify"), stream(bytes))
        .await
        .unwrap();
    let artifact_ref = store.publish(&staged).await.unwrap();
    ArtifactReverification::reverify(&store, &artifact_ref)
        .await
        .unwrap();

    let mut forged = artifact_ref;
    forged.sha256 = Sha256Digest::new("0".repeat(64)).unwrap();
    assert_eq!(
        ArtifactReverification::reverify(&store, &forged)
            .await
            .unwrap_err(),
        RequiredProofError::ArtifactMismatch
    );
}
