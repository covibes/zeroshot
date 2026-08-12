use std::io::Cursor;
use std::path::{Path, PathBuf};

use openengine_cluster_protocol::{
    canonical_value_bytes, ArtifactLineage, ArtifactProducer, ArtifactRef, ByteLength, Generation,
    MediaType, NodeName, PositiveInteger, RedactionClass, RunId, Sha256Digest, TypeId,
    WorkerOutcome, WorkerRef,
};
use serde_json::json;
use sha2::{Digest, Sha256};
use zeroshot_engine::artifact_store::local_cas::LocalCasArtifactStore;
use zeroshot_engine::artifact_store::{ArtifactIntent, ArtifactStore};
use zeroshot_engine::cluster_ledger::record::CanonicalDigest;
use zeroshot_engine::cluster_ledger::store::IdempotencyId;
use zeroshot_engine::full_v1_reducer::Decision;

use super::native_process::TempState;
use super::native_recovery::{codex_descriptor, descriptor, reduce_with, seed_admission, SeedAdmission};

pub async fn seed_codex_terminal(state: &TempState, cluster: &str) -> (ArtifactRef, PathBuf) {
    let graph = zeroshot_engine::native_foreground_graph();
    let descriptors = vec![codex_descriptor(), descriptor()];
    let ledger = seed_admission(
        state,
        cluster,
        SeedAdmission {
            graph: graph.clone(),
            input: json!({
                "prompt": "Seed the completed Codex predecessor.",
                "expectedGreeting": "predecessor\n"
            }),
            descriptors: descriptors.clone(),
            corrupt_compiled_ir: false,
        },
    )
    .await;
    let reduction = reduce_with(&ledger, &graph, descriptors.clone()).await;
    let execution = reduction
        .decisions
        .iter()
        .find_map(|decision| match decision {
            Decision::Dispatch { execution, .. } => Some(*execution),
            _ => None,
        })
        .unwrap();
    let allocation = ledger
        .dispatch_reduction(
            IdempotencyId::new("seed-codex-dispatch").unwrap(),
            reduction.dispatch_authorization(execution).unwrap(),
        )
        .await
        .unwrap()
        .value;
    let (artifact, root) = publish_validation_artifact(state.path(), cluster).await;
    let outcome = WorkerOutcome::Verified {
        output: json!({
            "summary": "seeded predecessor",
            "validationArtifact": artifact.clone()
        }),
        artifacts: vec![artifact.clone()],
    };
    let bytes = canonical_value_bytes(&serde_json::to_value(outcome).unwrap()).unwrap();
    let digest = CanonicalDigest::of(&bytes);
    ledger
        .settle(
            IdempotencyId::new("seed-codex-settlement").unwrap(),
            digest.as_bytes(),
            allocation.execution,
            digest,
            Some(bytes),
        )
        .await
        .unwrap();
    let terminal = reduce_with(&ledger, &graph, descriptors).await;
    ledger
        .terminalize_reduction(
            IdempotencyId::new("seed-codex-terminal").unwrap(),
            terminal.terminal_authorization().unwrap(),
        )
        .await
        .unwrap();
    ledger.release_fence().await.unwrap();
    (artifact, root)
}

async fn publish_validation_artifact(state_dir: &Path, cluster: &str) -> (ArtifactRef, PathBuf) {
    let validation = canonical_value_bytes(&json!({
        "path": "greeting.txt",
        "sha256": "0000000000000000000000000000000000000000000000000000000000000000",
        "status": "passed"
    }))
    .unwrap();
    let resource = zeroshot_engine::cluster_ledger::ResourceId::new(cluster).unwrap();
    let root = codex_artifact_root(state_dir, &resource);
    let store = LocalCasArtifactStore::new(&root).unwrap();
    let staged = store
        .stage(
            ArtifactIntent {
                expected_sha256: Sha256Digest::new(format!("{:x}", Sha256::digest(&validation)))
                    .unwrap(),
                expected_byte_length: ByteLength::new(validation.len() as u64).unwrap(),
                media_type: MediaType::new("application/json").unwrap(),
                type_id: TypeId::new("native.agent.validation@1").unwrap(),
                producer: ArtifactProducer {
                    node: NodeName::new("codex").unwrap(),
                    worker: WorkerRef::new("native.agent.codex@1").unwrap(),
                },
                lineage: ArtifactLineage {
                    generation: Generation::new(1).unwrap(),
                    run_id: RunId::new("run:1"),
                    attempt: PositiveInteger::new(1).unwrap(),
                },
                redaction: RedactionClass::Internal,
            },
            Box::new(Cursor::new(validation)),
        )
        .await
        .unwrap();
    let artifact = store.publish(&staged).await.unwrap();
    (artifact, root)
}

fn codex_artifact_root(
    state_dir: &Path,
    resource: &zeroshot_engine::cluster_ledger::ResourceId,
) -> PathBuf {
    let mut digest = Sha256::new();
    digest.update(b"zeroshot.native-agent-artifacts/v1\0");
    digest.update(resource.as_str().as_bytes());
    state_dir.join(format!("artifacts-{:x}", digest.finalize()))
}
