use serde_json::{Value, json};

pub(super) fn artifact_ref_fixture() -> Value {
    json!({
        "artifactId": "artifact-123", "sha256": "a".repeat(64), "byteLength": 42,
        "mediaType": "application/json", "typeId": "openengine.result@1",
        "producer": { "node": "work", "worker": "legacy.zeroshot.ship@1" },
        "lineage": { "generation": 7, "runId": "run-9", "attempt": 1 },
        "redaction": "internal"
    })
}
