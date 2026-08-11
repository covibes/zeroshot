use std::io::Cursor;
use std::path::Path;
use std::sync::Arc;

use openengine_cluster_protocol::{
    ArtifactLineage, ArtifactProducer, ArtifactRef, ByteLength, Generation, MediaType, NodeName,
    PositiveInteger, RedactionClass, RunId, Sha256Digest, TypeId, WorkerOutcome, WorkerRef,
};
use sha2::{Digest, Sha256};
use tokio::io::AsyncReadExt;

use crate::artifact_store::local_cas::LocalCasArtifactStore;
use crate::artifact_store::{ArtifactIntent, ArtifactStore};
use crate::cluster_ledger::ResourceId;
use crate::execution::driver::DriverRequest;

use super::super::program::AGENT_WORKER_REF;
use super::protocol::{
    validate_validation_output, AgentDispatchInput, AgentTerminalOutput, VALIDATION_TYPE_ID,
};

#[derive(Clone)]
pub(super) struct AgentArtifactStore {
    store: Arc<LocalCasArtifactStore>,
}

pub(super) struct ValidatedAgentOutput {
    pub(super) summary: String,
    pub(super) validation: Vec<u8>,
}

impl AgentArtifactStore {
    pub(super) fn open(state_dir: &Path, resource: &ResourceId) -> Result<Self, ()> {
        let store = LocalCasArtifactStore::new(
            state_dir.join(format!("artifacts-{}", resource_storage_id(resource))),
        )
        .map_err(|_| ())?;
        Ok(Self {
            store: Arc::new(store),
        })
    }

    pub(super) async fn publish(
        &self,
        request: &DriverRequest,
        input: &AgentDispatchInput,
        output: ValidatedAgentOutput,
    ) -> Result<WorkerOutcome, ()> {
        let intent = artifact_intent(request, input.generation, &output.validation)?;
        let staged = self
            .store
            .stage(intent, Box::new(Cursor::new(output.validation)))
            .await
            .map_err(|_| ())?;
        let artifact = match self.store.publish(&staged).await {
            Ok(artifact) => artifact,
            Err(_) => {
                let _ = self.store.discard(&staged).await;
                return Err(());
            }
        };
        let output = AgentTerminalOutput {
            summary: output.summary,
            validation_artifact: artifact.clone(),
        };
        output.validate()?;
        let output = serde_json::to_value(output).map_err(|_| ())?;
        Ok(WorkerOutcome::Verified {
            output,
            artifacts: vec![artifact],
        })
    }

    pub(super) async fn reverify(&self, expected: &ArtifactRef) -> Result<(), ()> {
        let inspected = self
            .store
            .inspect(&expected.artifact_id)
            .await
            .map_err(|_| ())?
            .ok_or(())?;
        if inspected != *expected {
            return Err(());
        }
        let mut stream = self
            .store
            .open(&expected.artifact_id)
            .await
            .map_err(|_| ())?;
        let mut bytes = Vec::new();
        stream.read_to_end(&mut bytes).await.map_err(|_| ())?;
        validate_validation_output(&bytes)
    }
}

fn artifact_intent(
    request: &DriverRequest,
    generation: u64,
    bytes: &[u8],
) -> Result<ArtifactIntent, ()> {
    Ok(ArtifactIntent {
        expected_sha256: Sha256Digest::new(format!("{:x}", Sha256::digest(bytes)))
            .map_err(|_| ())?,
        expected_byte_length: ByteLength::new(bytes.len() as u64).map_err(|_| ())?,
        media_type: MediaType::new("application/json").map_err(|_| ())?,
        type_id: TypeId::new(VALIDATION_TYPE_ID).map_err(|_| ())?,
        producer: ArtifactProducer {
            node: NodeName::new("codex").map_err(|_| ())?,
            worker: WorkerRef::new(AGENT_WORKER_REF).map_err(|_| ())?,
        },
        lineage: ArtifactLineage {
            generation: Generation::new(generation).map_err(|_| ())?,
            run_id: RunId::new(format!("run:{}", request.control.run().get())),
            attempt: PositiveInteger::new(1).map_err(|_| ())?,
        },
        redaction: RedactionClass::Internal,
    })
}

fn resource_storage_id(resource: &ResourceId) -> String {
    let mut digest = Sha256::new();
    digest.update(b"zeroshot.native-agent-artifacts/v1\0");
    digest.update(resource.as_str().as_bytes());
    format!("{:x}", digest.finalize())
}
