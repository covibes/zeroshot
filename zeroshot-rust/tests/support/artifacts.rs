use std::io::Cursor;

use openengine_cluster_protocol::{
    ArtifactLineage, ArtifactProducer, ByteLength, Generation, MediaType, NodeName,
    PositiveInteger, RedactionClass, RunId, Sha256Digest, TypeId, WorkerRef,
};
use zeroshot_engine::artifact_store::{ArtifactByteStream, ArtifactIntent};

pub fn digest(bytes: &[u8]) -> Sha256Digest {
    use sha2::{Digest, Sha256};
    let value = Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    Sha256Digest::new(value).expect("test digest is valid")
}

pub fn test_intent(bytes: &[u8], run_id: &str) -> ArtifactIntent {
    ArtifactIntent {
        expected_sha256: digest(bytes),
        expected_byte_length: ByteLength::new(bytes.len() as u64).expect("test length is valid"),
        media_type: MediaType::new("application/test").expect("test media type is valid"),
        type_id: TypeId::new("test.artifact@1").expect("test type is valid"),
        producer: ArtifactProducer {
            node: NodeName::new("produce").expect("test node is valid"),
            worker: WorkerRef::new("test.worker@1").expect("test worker is valid"),
        },
        lineage: ArtifactLineage {
            generation: Generation::new(7).expect("test generation is valid"),
            run_id: RunId::new(run_id),
            attempt: PositiveInteger::new(2).expect("test attempt is valid"),
        },
        redaction: RedactionClass::Internal,
    }
}

pub fn byte_stream(bytes: Vec<u8>) -> ArtifactByteStream {
    Box::new(Cursor::new(bytes))
}
