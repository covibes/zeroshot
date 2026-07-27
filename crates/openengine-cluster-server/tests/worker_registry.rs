use std::collections::BTreeMap;

use async_trait::async_trait;
use openengine_cluster_protocol::{
    ControlSource, GraphSpec, WorkerDescriptor, WorkerErrorCode, WorkerRef,
};
use openengine_cluster_server::worker_registry::{
    check_graph_workers, WorkerCompatibilityCode, WorkerRegistry, WorkerRegistryError,
};
use serde_json::json;

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
            WorkerRef::new("mock.worker@1").unwrap(),
            serde_json::from_value(descriptor("mock.worker@1", false)).unwrap(),
        ),
        (
            WorkerRef::new("mock.verifier@1").unwrap(),
            serde_json::from_value(descriptor("mock.verifier@1", true)).unwrap(),
        ),
    ]))
}

#[tokio::test]
async fn resolves_nested_workers_and_applies_all_covariant_rules() {
    let graph: GraphSpec = serde_json::from_value(graph()).unwrap();
    check_graph_workers(&graph, &registry()).await.unwrap();
}

#[tokio::test]
async fn diagnostics_are_depth_first_and_cover_each_compatibility_axis() {
    let mut registry = registry();
    let worker = WorkerRef::new("mock.worker@1").unwrap();
    let broken: WorkerDescriptor = serde_json::from_value({
        let mut value = descriptor("returned.other@1", false);
        value["graphProfiles"] = json!(["openengine.graph.single-worker/v1"]);
        value["contract"]["input"] = json!({ "kind": "string" });
        value["contract"]["output"] = json!({ "kind": "string" });
        value
    })
    .unwrap();
    registry.0.insert(worker, broken);

    let verifier = WorkerRef::new("mock.verifier@1").unwrap();
    let broken_verifier: WorkerDescriptor = serde_json::from_value({
        let mut value = descriptor("mock.verifier@1", true);
        value["contract"]["verifier"]["signals"] =
            json!({ "missing": ["x"], "verdict": ["undeclared"] });
        value["contract"]["verifier"]["diagnostic"] = json!({ "kind": "string" });
        value
    })
    .unwrap();
    registry.0.insert(verifier, broken_verifier);

    let graph: GraphSpec = serde_json::from_value(graph()).unwrap();
    let diagnostics = check_graph_workers(&graph, &registry).await.unwrap_err();
    let codes: Vec<_> = diagnostics
        .iter()
        .map(|diagnostic| diagnostic.code)
        .collect();
    assert_eq!(
        &codes[..4],
        &[
            WorkerCompatibilityCode::DescriptorIdentity,
            WorkerCompatibilityCode::GraphProfile,
            WorkerCompatibilityCode::Input,
            WorkerCompatibilityCode::Output,
        ]
    );
    assert_eq!(diagnostics[0].path, ["root", "work"]);
    assert_eq!(diagnostics[4].path, ["root", "verify"]);
    assert!(codes.contains(&WorkerCompatibilityCode::SignalField));
    assert!(codes.contains(&WorkerCompatibilityCode::SignalLabels));
    assert!(codes.contains(&WorkerCompatibilityCode::Diagnostic));
}

#[tokio::test]
async fn resolves_builtin_worker_via_default_compatibility_rules() {
    let mut registry = registry();
    let worker = WorkerRef::new("mock.worker@1").unwrap();
    let mut value = descriptor("mock.worker@1", false);
    value["binding"] =
        serde_json::to_value(openengine_cluster_protocol::WorkerProtocolBinding::builtin_v1())
            .unwrap();
    value["credentialRequirements"] = json!([]);
    registry
        .0
        .insert(worker, serde_json::from_value(value).unwrap());

    let graph: GraphSpec = serde_json::from_value(graph()).unwrap();
    check_graph_workers(&graph, &registry).await.unwrap();
}

#[tokio::test]
async fn missing_exact_version_is_a_stable_registry_diagnostic() {
    let mut value = graph();
    value["root"]["children"][0]["worker"] = json!("mock.worker@2");
    let graph: GraphSpec = serde_json::from_value(value).unwrap();
    let diagnostics = check_graph_workers(&graph, &registry()).await.unwrap_err();
    assert_eq!(diagnostics[0].code, WorkerCompatibilityCode::Registry);
    assert!(diagnostics[0].message.contains("mock.worker@2"));
}

#[tokio::test]
async fn step_rejects_verifier_only_descriptor() {
    let mut registry = registry();
    let worker = WorkerRef::new("mock.worker@1").unwrap();
    registry.0.insert(
        worker,
        serde_json::from_value(descriptor("mock.worker@1", true)).unwrap(),
    );
    let graph: GraphSpec = serde_json::from_value(graph()).unwrap();
    let diagnostics = check_graph_workers(&graph, &registry).await.unwrap_err();
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
    value["root"] = json!({
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
    let graph: GraphSpec = serde_json::from_value(value).unwrap();
    let GraphNode::Choice(choice) = graph.root else {
        panic!("fixture must be a choice")
    };
    let Guard::In { value, labels } = &choice.branches.as_slice()[0].when else {
        panic!("refusal branch must use an in guard")
    };
    let outcome = WorkerOutcome::policy_refusal();
    assert_eq!(value.source, ControlSource::Error);
    assert_eq!(outcome.error_code(), Some(WorkerErrorCode::Refusal));
    assert!(
        labels
            .values()
            .contains(&EnumLabel::new(outcome.error_code().unwrap().as_str()).unwrap())
    );
}
