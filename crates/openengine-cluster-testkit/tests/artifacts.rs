use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use openengine_cluster_protocol::PROTOCOL_VERSION;
use openengine_cluster_server::method_registry::METHOD_REGISTRY;
use openengine_cluster_testkit::artifacts::{
    Artifact, ArtifactError, check_artifacts, generate_artifacts, write_artifacts,
};

#[path = "schema_support/mod.rs"]
mod schema_support;
use schema_support::find_schema;

fn generated_json(artifacts: &[Artifact], suffix: &str) -> serde_json::Value {
    let artifact = artifacts
        .iter()
        .find(|artifact| artifact.relative_path.ends_with(suffix))
        .assert_value_with(&format!("missing generated artifact {suffix}"));
    serde_json::from_slice(&artifact.bytes).assert_value()
}

#[tokio::test]
async fn generated_artifacts_are_complete_and_committed_without_drift() {
    let artifacts = generate_artifacts().await;
    let paths: Vec<_> = artifacts
        .iter()
        .map(|artifact| artifact.relative_path.as_str())
        .collect();
    for required in [
        "protocol/openengine-cluster/v1/schema.json",
        "protocol/openengine-cluster/v1/graph.schema.json",
        "protocol/openengine-cluster/v1/compiled-ir.schema.json",
        "protocol/openengine-cluster/v1/openrpc.json",
        "protocol/openengine-cluster/v1/worker.schema.json",
        "protocol/openengine-cluster/v1/fixtures/workers/positive/acp-v1.json",
        "protocol/openengine-cluster/v1/fixtures/workers/positive/a2a-1.0.json",
        "protocol/openengine-cluster/v1/fixtures/workers/positive/legacy-zeroshot-ship-v1.json",
        "protocol/openengine-cluster/v1/fixtures/workers/positive/artifact-receipt.json",
        "protocol/openengine-cluster/v1/fixtures/workers/negative/bearer-token.json",
        "protocol/openengine-cluster/v1/fixtures/workers/mock/a2a-auth-required.json",
        "protocol/openengine-cluster/v1/fixtures/graph/positive/full-all-nodes.json",
        "protocol/openengine-cluster/v1/fixtures/graph/positive/single-worker.json",
        "protocol/openengine-cluster/v1/fixtures/graph/canonical/base.canonical.json",
        "protocol/openengine-cluster/v1/fixtures/graph/canonical/base.sha256",
        "protocol/openengine-cluster/v1/fixtures/graph/negative/unknown-node.json",
        "protocol/openengine-cluster/v1/fixtures/verifier/positive/basic.json",
        "protocol/openengine-cluster/v1/fixtures/verifier/positive/binding-channels.json",
        "protocol/openengine-cluster/v1/fixtures/verifier/positive/guard-k-of-n.json",
        "protocol/openengine-cluster/v1/fixtures/verifier/positive/map-item-k-of-map.json",
        "protocol/openengine-cluster/v1/fixtures/verifier/positive/loop-and-group.json",
        "protocol/openengine-cluster/v1/fixtures/verifier/positive/join-first.json",
        "protocol/openengine-cluster/v1/fixtures/verifier/positive/nested-structural-folds.json",
        "protocol/openengine-cluster/v1/fixtures/verifier/negative/duplicate-node.json",
        "protocol/openengine-cluster/v1/fixtures/verifier/negative/terminal-fallthrough.json",
        "protocol/openengine-cluster/v1/fixtures/verifier/negative/illegal-control-selector.json",
        "protocol/openengine-cluster/v1/fixtures/verifier/negative/undefined-read.json",
        "protocol/openengine-cluster/v1/fixtures/verifier/negative/cyclic-read.json",
        "protocol/openengine-cluster/v1/fixtures/verifier/negative/type-mismatch.json",
        "protocol/openengine-cluster/v1/fixtures/verifier/negative/dead-choice.json",
        "protocol/openengine-cluster/v1/fixtures/verifier/negative/dead-otherwise.json",
        "protocol/openengine-cluster/v1/fixtures/verifier/negative/non-exhaustive-choice.json",
        "protocol/openengine-cluster/v1/fixtures/verifier/negative/unsatisfiable-loop.json",
        "protocol/openengine-cluster/v1/fixtures/verifier/negative/invalid-quorum.json",
        "protocol/openengine-cluster/v1/fixtures/verifier/negative/parallel-write-conflict.json",
        "protocol/openengine-cluster/v1/fixtures/verifier/negative/unsafe-promotion.json",
        "protocol/openengine-cluster/v1/fixtures/verifier/negative/impossible-map-outcomes.json",
        "protocol/openengine-cluster/v1/fixtures/verifier/negative/registry-not-found.json",
        "protocol/openengine-cluster/v1/fixtures/verifier/negative/registry-version-unavailable.json",
        "protocol/openengine-cluster/v1/fixtures/verifier/negative/registry-descriptor-contract.json",
        "protocol/openengine-cluster/v1/fixtures/verifier/negative/registry-descriptor-identity.json",
        "protocol/openengine-cluster/v1/fixtures/verifier/negative/registry-graph-profile.json",
        "protocol/openengine-cluster/v1/fixtures/verifier/negative/registry-input.json",
        "protocol/openengine-cluster/v1/fixtures/verifier/negative/registry-output.json",
        "protocol/openengine-cluster/v1/fixtures/verifier/negative/registry-verifier-contract.json",
        "protocol/openengine-cluster/v1/fixtures/verifier/negative/registry-signal-field.json",
        "protocol/openengine-cluster/v1/fixtures/verifier/negative/registry-signal-labels.json",
        "protocol/openengine-cluster/v1/fixtures/verifier/negative/registry-diagnostic.json",
        "protocol/openengine-cluster/v1/goldens/initialize.ndjson",
        "protocol/openengine-cluster/v1/goldens/get-empty.ndjson",
        "protocol/openengine-cluster/v1/goldens/admission-lifecycle.ndjson",
        "protocol/openengine-cluster/v1/goldens/admission-errors.ndjson",
        "protocol/openengine-cluster/v1/goldens/lifecycle-controls.ndjson",
        "protocol/openengine-cluster/v1/goldens/lifecycle-delete.ndjson",
        "protocol/openengine-cluster/v1/goldens/logs-session.json",
        "protocol/openengine-cluster/v1/fixtures/logs/logs-params.json",
        "protocol/openengine-cluster/v1/fixtures/logs/logs-closed.json",
        "protocol/openengine-cluster/v1/fixtures/logs/log-record.json",
    ] {
        assert!(paths.contains(&required), "missing {required}");
    }
    let unique: std::collections::BTreeSet<_> = paths.iter().copied().collect();
    assert_eq!(unique.len(), paths.len(), "artifact paths must be unique");
    for artifact in &artifacts {
        if artifact
            .relative_path
            .ends_with("/canonical/base.canonical.json")
        {
            assert!(
                !artifact.bytes.ends_with(b"\n"),
                "canonical-byte golden must contain exactly the hashed bytes"
            );
        } else {
            assert!(
                artifact.bytes.ends_with(b"\n"),
                "{} must be newline terminated",
                artifact.relative_path
            );
        }
    }

    let workspace = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .assert_value()
        .parent()
        .assert_value()
        .to_path_buf();
    check_artifacts(&workspace).await.assert_value();
}

#[tokio::test]
async fn openrpc_exposes_only_the_implemented_protocol_methods() {
    let artifacts = generate_artifacts().await;
    let openrpc = artifacts
        .iter()
        .find(|artifact| artifact.relative_path.ends_with("/openrpc.json"))
        .assert_value();
    let openrpc: serde_json::Value = serde_json::from_slice(&openrpc.bytes).assert_value();
    let methods: Vec<_> = openrpc
        .assert_key("methods")
        .as_array()
        .assert_value()
        .iter()
        .map(|method| method.assert_key("name").as_str().assert_value())
        .collect();
    let registry_methods = METHOD_REGISTRY
        .iter()
        .map(|descriptor| descriptor.name)
        .collect::<Vec<_>>();
    assert_eq!(methods, registry_methods);
    for component in [
        "GraphSpec",
        "CompiledGraphIr",
        "GraphDiagnostic",
        "StructuralBounds",
        "ArtifactRef",
        "WorkerDescriptor",
        "WorkerOutcome",
        "LegacyShipRequest",
        "LegacyShipResult",
    ] {
        assert!(
            openrpc
                .assert_key("components")
                .assert_key("schemas")
                .get(component)
                .is_some()
        );
    }
}

#[tokio::test]
async fn openrpc_apply_controls_match_the_authoritative_apply_schema() {
    let artifacts = generate_artifacts().await;
    let openrpc = generated_json(&artifacts, "/openrpc.json");
    let schema = generated_json(&artifacts, "/schema.json");
    let apply = openrpc
        .assert_key("methods")
        .as_array()
        .assert_value()
        .iter()
        .find(|method| method.assert_key("name") == "apply")
        .assert_value();

    for property in ["dryRun", "ifGeneration", "idempotencyKey"] {
        let advertised = apply
            .assert_key("params")
            .as_array()
            .assert_value()
            .iter()
            .find(|parameter| parameter.assert_key("name") == property)
            .assert_value_with(&format!("OpenRPC apply is missing {property}"));
        assert_eq!(
            advertised.assert_key("schema"),
            schema
                .assert_key("$defs")
                .assert_key("ApplyParams")
                .assert_key("properties")
                .assert_key(property),
            "OpenRPC drifted from ApplyParams for {property}"
        );
    }

    let idempotency_schema = apply
        .assert_key("params")
        .as_array()
        .assert_value()
        .iter()
        .find(|parameter| parameter.assert_key("name") == "idempotencyKey")
        .assert_value()
        .assert_key("schema")
        .clone();
    assert!(
        !jsonschema::validator_for(&idempotency_schema)
            .assert_value()
            .is_valid(&serde_json::json!("bad\nkey")),
        "OpenRPC must reject idempotency-key control characters"
    );
}

#[tokio::test]
async fn openrpc_exposes_closed_lifecycle_controls() {
    let artifacts = generate_artifacts().await;
    let openrpc = generated_json(&artifacts, "/openrpc.json");
    let schema = generated_json(&artifacts, "/schema.json");
    for (method_name, required) in [
        ("update", vec!["ifGeneration", "idempotencyKey"]),
        ("stop", vec!["mode", "ifGeneration", "idempotencyKey"]),
    ] {
        let method = openrpc
            .assert_key("methods")
            .as_array()
            .assert_value()
            .iter()
            .find(|method| method.assert_key("name") == method_name)
            .assert_value();
        for name in required {
            assert_eq!(
                method
                    .assert_key("params")
                    .as_array()
                    .assert_value()
                    .iter()
                    .find(|parameter| parameter.assert_key("name") == name)
                    .assert_value()
                    .assert_key("required"),
                true
            );
        }
    }
    let mut update_schema = schema
        .assert_key("$defs")
        .assert_key("UpdateParams")
        .clone();
    update_schema
        .as_object_mut()
        .assert_value()
        .insert("$defs".to_owned(), schema.assert_key("$defs").clone());
    let update_validator = jsonschema::validator_for(&update_schema).assert_value();
    let update_method = openrpc
        .assert_key("methods")
        .as_array()
        .assert_value()
        .iter()
        .find(|method| method.assert_key("name") == "update")
        .assert_value();
    let advertised_update_validator =
        jsonschema::validator_for(update_method.assert_key("x-params-schema")).assert_value();
    let empty_operational_update = serde_json::json!({
        "ifGeneration":1,"idempotencyKey":"empty"
    });
    assert!(!update_validator.is_valid(&empty_operational_update));
    assert!(!advertised_update_validator.is_valid(&empty_operational_update));
    assert!(advertised_update_validator.is_valid(&serde_json::json!({
        "suspended":true,"ifGeneration":1,"idempotencyKey":"suspend"
    })));
    assert!(!update_validator.is_valid(&serde_json::json!({
        "labels":null,"ifGeneration":1,"idempotencyKey":"null"
    })));
    assert!(!update_validator.is_valid(&serde_json::json!({
        "graph":{},"ifGeneration":1,"idempotencyKey":"graph"
    })));
}

#[tokio::test]
async fn schema_is_derived_from_canonical_envelopes_with_required_success_ids() {
    let artifacts = generate_artifacts().await;
    let schema = find_schema(&artifacts);
    let definitions = schema.assert_key("$defs").as_object().assert_value();

    assert!(
        definitions
            .keys()
            .any(|name| name.starts_with("JsonRpcRequest"))
    );
    assert!(
        definitions
            .keys()
            .any(|name| name.starts_with("JsonRpcSuccess"))
    );
    assert!(
        definitions
            .keys()
            .any(|name| name.starts_with("JsonRpcResponse"))
    );
    assert!(
        !definitions
            .keys()
            .any(|name| name.contains("EnvelopeSchema"))
    );

    for definition in definitions
        .iter()
        .filter(|(name, _)| name.starts_with("JsonRpcSuccess"))
        .map(|(_, definition)| definition)
    {
        assert!(
            definition
                .assert_key("required")
                .as_array()
                .assert_value()
                .contains(&serde_json::json!("id"))
        );
        assert_eq!(
            definition
                .assert_key("properties")
                .assert_key("id")
                .assert_key("$ref"),
            "#/$defs/RequestId"
        );
    }

    assert_eq!(
        definitions
            .get("InitializeParams")
            .assert_value()
            .assert_key("properties")
            .assert_key("protocolVersion")
            .assert_key("const"),
        PROTOCOL_VERSION
    );
}

#[tokio::test]
async fn artifact_check_fails_on_byte_drift_and_missing_files() {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .assert_value()
        .as_nanos();
    let workspace = std::env::temp_dir().join(format!(
        "openengine-cluster-artifact-test-{}-{unique}",
        std::process::id()
    ));
    write_artifacts(&workspace).await.assert_value();

    let schema = workspace.join("protocol/openengine-cluster/v1/schema.json");
    fs::write(&schema, b"drift\n").assert_value();
    assert!(matches!(
        check_artifacts(&workspace).await,
        Err(ArtifactError::Drift(path)) if path == schema
    ));

    fs::remove_file(&schema).assert_value();
    assert!(matches!(
        check_artifacts(&workspace).await,
        Err(ArtifactError::Missing(path)) if path == schema
    ));
    fs::remove_dir_all(workspace).assert_value();
}

use openengine_cluster_testkit::assertions::{AssertValue, JsonAt};
