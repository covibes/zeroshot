#[path = "support/assert_value.rs"]
mod assert_value;

#[path = "support/json_insert.rs"]
mod json_insert;

#[path = "support/json_mut.rs"]
mod json_mut;

use assert_value::AssertValue;
use openengine_cluster_protocol::{
    ArtifactId, ArtifactLineage, ArtifactProducer, ArtifactRef, ByteLength, Generation, MediaType,
    NodeName, PositiveInteger, RedactionClass, RunId, Sha256Digest, TypeId, WorkerRef,
};
use serde_json::json;

fn receipt() -> ArtifactRef {
    ArtifactRef {
        artifact_id: ArtifactId::new("artifact-123").assert_value(),
        sha256: Sha256Digest::new("a".repeat(64)).assert_value(),
        byte_length: ByteLength::new(42).assert_value(),
        media_type: MediaType::new("application/json").assert_value(),
        type_id: TypeId::new("openengine.result@1").assert_value(),
        producer: ArtifactProducer {
            node: NodeName::new("worker").assert_value(),
            worker: WorkerRef::new("worker.impl@1").assert_value(),
        },
        lineage: ArtifactLineage {
            generation: Generation::new(7).assert_value(),
            run_id: RunId::new("run-9"),
            attempt: PositiveInteger::new(2).assert_value(),
        },
        redaction: RedactionClass::Confidential,
    }
}

fn assert_receipt_mutation_rejected(pointer: &str, replacement: serde_json::Value) {
    let mut value = serde_json::to_value(receipt()).assert_value();
    *json_mut::json_at_mut(&mut value, pointer) = replacement;
    assert!(serde_json::from_value::<ArtifactRef>(value).is_err());
}

#[test]
fn artifact_receipt_has_the_exact_byte_free_durable_shape() {
    let value = serde_json::to_value(receipt()).assert_value();
    assert_eq!(
        value,
        json!({
            "artifactId": "artifact-123",
            "sha256": "a".repeat(64),
            "byteLength": 42,
            "mediaType": "application/json",
            "typeId": "openengine.result@1",
            "producer": { "node": "worker", "worker": "worker.impl@1" },
            "lineage": { "generation": 7, "runId": "run-9", "attempt": 2 },
            "redaction": "confidential"
        })
    );
    assert_eq!(
        serde_json::from_value::<ArtifactRef>(value).assert_value(),
        receipt()
    );
}

#[test]
fn artifact_receipts_reject_bytes_urls_tokens_paths_bad_hashes_and_unsafe_counts() {
    assert!(TypeId::new("unstable").is_err());
    assert!(TypeId::new("openengine.result@").is_err());

    let mut value = serde_json::to_value(receipt()).assert_value();
    *json_mut::json_at_mut(&mut value, "/typeId") = json!("openengine.result@");
    assert!(serde_json::from_value::<ArtifactRef>(value.clone()).is_err());
    let schema = serde_json::to_value(schemars::schema_for!(ArtifactRef)).assert_value();
    let validator = jsonschema::validator_for(&schema).assert_value();
    assert!(!validator.is_valid(&value));

    for field in ["artifactId", "mediaType"] {
        let mut value = serde_json::to_value(receipt()).assert_value();
        json_insert::json_insert(&mut value, "", field, json!("bad\nvalue"));
        assert!(
            serde_json::from_value::<ArtifactRef>(value.clone()).is_err(),
            "Rust accepted a control character in {field}"
        );
        assert!(
            !validator.is_valid(&value),
            "JSON Schema accepted a control character in {field}"
        );

        let mut maximum = serde_json::to_value(receipt()).assert_value();
        json_insert::json_insert(&mut maximum, "", field, json!("é".repeat(256)));
        assert!(
            serde_json::from_value::<ArtifactRef>(maximum.clone()).is_ok(),
            "Rust must apply the JSON Schema character-count bound to {field}"
        );
        assert!(validator.is_valid(&maximum));

        let mut overlong = serde_json::to_value(receipt()).assert_value();
        json_insert::json_insert(&mut overlong, "", field, json!("é".repeat(257)));
        assert!(serde_json::from_value::<ArtifactRef>(overlong.clone()).is_err());
        assert!(!validator.is_valid(&overlong));
    }

    for field in ["bytes", "signedUrl", "bearerToken", "path"] {
        let mut value = serde_json::to_value(receipt()).assert_value();
        json_insert::json_insert(&mut value, "", field, json!("forbidden"));
        assert!(
            serde_json::from_value::<ArtifactRef>(value).is_err(),
            "accepted {field}"
        );
    }

    assert_receipt_mutation_rejected("/sha256", json!("ABC"));
    assert_receipt_mutation_rejected("/byteLength", json!(9_007_199_254_740_992_u64));
    assert_receipt_mutation_rejected("/lineage/attempt", json!(0));

    let decimal_integral: serde_json::Value = serde_json::from_str("42.0").assert_value();
    let mut value = serde_json::to_value(receipt()).assert_value();
    *json_mut::json_at_mut(&mut value, "/byteLength") = decimal_integral;
    assert!(serde_json::from_value::<ArtifactRef>(value.clone()).is_ok());
    assert!(validator.is_valid(&value));
}
