use std::collections::BTreeMap;

use async_trait::async_trait;
use openengine_cluster_protocol::{
    ControlSource, GraphSpec, WorkerDescriptor, WorkerErrorCode, WorkerRef,
};
use openengine_cluster_server::worker_registry::{
    check_graph_workers, WorkerCompatibilityCode, WorkerRegistry, WorkerRegistryError,
};
use serde_json::json;

#[path = "support/assert_at.rs"]
mod assert_at;
#[path = "support/assert_at_mut.rs"]
mod assert_at_mut;
#[path = "support/assert_error.rs"]
mod assert_error;
#[path = "support/assert_value.rs"]
mod assert_value;

use assert_at::AssertAt;
use assert_at_mut::AssertAtMut;
use assert_error::AssertError;
use assert_value::AssertValue;

struct MemoryRegistry(BTreeMap<WorkerRef, WorkerDescriptor>);

#[async_trait]
impl WorkerRegistry for MemoryRegistry {
    async fn resolve(&self, worker: &WorkerRef) -> Result<WorkerDescriptor, WorkerRegistryError> {
        self.0
            .get(worker)
            .cloned()
            .ok_or_else(|| WorkerRegistryError::NotFound {
                worker: worker.clone(),
            })
    }
}

fn descriptor(worker: &str, verifier: bool) -> serde_json::Value {
    json!({
        "worker": worker,
        "graphProfiles": ["openengine.graph.full/v1"],
        "binding": {
            "protocol": "acp", "version": "1", "profile": "openengine.worker.acp/v1"
        },
        "contract": {
            "input": { "kind": "number" },
            "output": { "kind": "integer" },
            "verifier": if verifier { json!({
                "signals": { "verdict": ["accepted"] },
                "diagnostic": { "kind": "integer" }
            }) } else { serde_json::Value::Null },
            "errors": ["timeout", "crash", "malformed", "refusal"]
        },
        "capabilityPolicy": {
            "autonomy": "strict", "permissionPolicy": "policy.strict@1"
        },
        "artifactProfile": {
            "allowedTypeIds": ["openengine.result@1"],
            "allowedMediaTypes": ["application/json"],
            "minimumRedaction": "internal"
        },
        "credentialRequirements": []
    })
}

fn graph() -> serde_json::Value {
    json!({
        "profile": "openengine.graph.full/v1",
        "initialInput": { "kind": "null" },
        "policy": { "policy": "policy.strict@1", "default": "deny" },
        "root": {
            "kind": "seq", "name": "root", "state": { "kind": "null" },
            "children": [
                {
                    "kind": "step", "name": "work", "worker": "mock.worker@1",
                    "input": { "kind": "integer" }, "output": { "kind": "number" },
                    "inputBindings": [], "writeBindings": [], "timeoutMs": 10, "attempts": 1
                },
                {
                    "kind": "verifier", "name": "verify", "worker": "mock.verifier@1",
                    "input": { "kind": "integer" }, "output": { "kind": "number" },
                    "inputBindings": [], "writeBindings": [], "timeoutMs": 10, "attempts": 1,
                    "signals": { "verdict": ["accepted", "rejected"] },
                    "diagnostic": { "kind": "number" }
                }
            ],
            "promotedStatePaths": []
        }
    })
}

fn registry() -> MemoryRegistry {
    MemoryRegistry(BTreeMap::from([
        (
            WorkerRef::new("mock.worker@1").assert_value(),
            serde_json::from_value(descriptor("mock.worker@1", false)).assert_value(),
        ),
        (
            WorkerRef::new("mock.verifier@1").assert_value(),
            serde_json::from_value(descriptor("mock.verifier@1", true)).assert_value(),
        ),
    ]))
}

#[tokio::test]
async fn resolves_nested_workers_and_applies_all_covariant_rules() {
    let graph: GraphSpec = serde_json::from_value(graph()).assert_value();
    check_graph_workers(&graph, &registry())
        .await
        .assert_value();
}

#[tokio::test]
async fn diagnostics_are_depth_first_and_cover_each_compatibility_axis() {
    let mut registry = registry();
    let worker = WorkerRef::new("mock.worker@1").assert_value();
    let broken: WorkerDescriptor = serde_json::from_value({
        let mut value = descriptor("returned.other@1", false);
        *value.assert_at_mut("graphProfiles") = json!(["openengine.graph.single-worker/v1"]);
        *value.assert_at_mut("contract").assert_at_mut("input") = json!({ "kind": "string" });
        *value.assert_at_mut("contract").assert_at_mut("output") = json!({ "kind": "string" });
        value
    })
    .assert_value();
    registry.0.insert(worker, broken);

    let verifier = WorkerRef::new("mock.verifier@1").assert_value();
    let broken_verifier: WorkerDescriptor = serde_json::from_value({
        let mut value = descriptor("mock.verifier@1", true);
        *value
            .assert_at_mut("contract")
            .assert_at_mut("verifier")
            .assert_at_mut("signals") = json!({ "missing": ["x"], "verdict": ["undeclared"] });
        *value
            .assert_at_mut("contract")
            .assert_at_mut("verifier")
            .assert_at_mut("diagnostic") = json!({ "kind": "string" });
        value
    })
    .assert_value();
    registry.0.insert(verifier, broken_verifier);

    let graph: GraphSpec = serde_json::from_value(graph()).assert_value();
    let diagnostics = check_graph_workers(&graph, &registry).await.assert_error();
    let codes: Vec<_> = diagnostics
        .iter()
        .map(|diagnostic| diagnostic.code)
        .collect();
    assert_eq!(
        codes.iter().take(4).copied().collect::<Vec<_>>(),
        &[
            WorkerCompatibilityCode::DescriptorIdentity,
            WorkerCompatibilityCode::GraphProfile,
            WorkerCompatibilityCode::Input,
            WorkerCompatibilityCode::Output,
        ]
    );
    assert_eq!(diagnostics.assert_at(0).path, ["root", "work"]);
    assert_eq!(diagnostics.assert_at(4).path, ["root", "verify"]);
    assert!(codes.contains(&WorkerCompatibilityCode::SignalField));
    assert!(codes.contains(&WorkerCompatibilityCode::SignalLabels));
    assert!(codes.contains(&WorkerCompatibilityCode::Diagnostic));
}

#[tokio::test]
async fn resolves_builtin_worker_via_default_compatibility_rules() {
    let mut registry = registry();
    let worker = WorkerRef::new("mock.worker@1").assert_value();
    let mut value = descriptor("mock.worker@1", false);
    *value.assert_at_mut("binding") =
        serde_json::to_value(openengine_cluster_protocol::WorkerProtocolBinding::builtin_v1())
            .assert_value();
    *value.assert_at_mut("credentialRequirements") = json!([]);
    registry
        .0
        .insert(worker, serde_json::from_value(value).assert_value());

    let graph: GraphSpec = serde_json::from_value(graph()).assert_value();
    check_graph_workers(&graph, &registry).await.assert_value();
}

#[tokio::test]
async fn missing_exact_version_is_a_stable_registry_diagnostic() {
    let mut value = graph();
    *value
        .assert_at_mut("root")
        .assert_at_mut("children")
        .assert_at_mut(0)
        .assert_at_mut("worker") = json!("mock.worker@2");
    let graph: GraphSpec = serde_json::from_value(value).assert_value();
    let diagnostics = check_graph_workers(&graph, &registry())
        .await
        .assert_error();
    assert_eq!(
        diagnostics.assert_at(0).code,
        WorkerCompatibilityCode::Registry
    );
    assert!(diagnostics.assert_at(0).message.contains("mock.worker@2"));
}

#[tokio::test]
async fn step_rejects_verifier_only_descriptor() {
    let mut registry = registry();
    let worker = WorkerRef::new("mock.worker@1").assert_value();
    registry.0.insert(
        worker,
        serde_json::from_value(descriptor("mock.worker@1", true)).assert_value(),
    );
    let graph: GraphSpec = serde_json::from_value(graph()).assert_value();
    let diagnostics = check_graph_workers(&graph, &registry).await.assert_error();
    assert!(diagnostics.iter().any(|diagnostic| {
        diagnostic.path == ["root", "work"]
            && diagnostic.code == WorkerCompatibilityCode::VerifierContract
            && diagnostic
                .message
                .contains("step node resolved to a verifier-only descriptor")
    }));
}

#[test]
fn policy_refusal_routes_as_error() {
    use openengine_cluster_protocol::{EnumLabel, GraphNode, Guard, WorkerOutcome};

    let mut value = graph();
    *value.assert_at_mut("root") = json!({
        "kind": "choice", "name": "route", "state": { "kind": "null" },
        "branches": [{
            "when": {
                "kind": "in",
                "value": { "name": "work", "source": "error", "field": null },
                "labels": ["refusal"]
            },
            "node": { "kind": "fail", "name": "refused", "reason": "policy_denied" }
        }],
        "otherwise": { "kind": "succeed", "name": "continued", "output": { "kind": "null" }, "bindings": [] },
        "promotedStatePaths": []
    });
    let graph: GraphSpec = serde_json::from_value(value).assert_value();
    let choice = match graph.root {
        GraphNode::Choice(choice) => Some(choice),
        _ => None,
    }
    .assert_value();
    let branch = choice.branches.as_slice().first().assert_value();
    let (value, labels) = match &branch.when {
        Guard::In { value, labels } => Some((value, labels)),
        _ => None,
    }
    .assert_value();
    let outcome = WorkerOutcome::policy_refusal();
    assert_eq!(value.source, ControlSource::Error);
    assert_eq!(outcome.error_code(), Some(WorkerErrorCode::Refusal));
    let error_code = outcome.error_code().assert_value();
    assert!(
        labels
            .values()
            .contains(&EnumLabel::new(error_code.as_str()).assert_value())
    );
}
