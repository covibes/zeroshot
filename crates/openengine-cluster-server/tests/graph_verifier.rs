use std::collections::BTreeMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use async_trait::async_trait;
use openengine_cluster_protocol::{
    GraphDiagnostic, GraphDiagnosticCode, GraphProfile, GraphSpec, TerminationWitness,
    WorkerDescriptor, WorkerRef,
};
use openengine_cluster_server::admission::{GraphVerifier, VerificationError};
use openengine_cluster_server::graph_verifier::ProductionGraphVerifier;
use openengine_cluster_server::worker_registry::{WorkerRegistry, WorkerRegistryError};
use serde_json::{json, Value};

#[path = "support/assert_value.rs"]
mod assert_value;
use assert_value::AssertValue;
#[path = "support/assert_error.rs"]
mod assert_error;
use assert_error::AssertError;
#[path = "support/assert_at.rs"]
mod assert_at;
use assert_at::AssertAt;
#[path = "support/assert_at_mut.rs"]
mod assert_at_mut;
use assert_at_mut::AssertAtMut;
#[path = "graph_verifier/test_support.rs"]
mod test_support;
use test_support::{
    assert_graph_accepted, assert_graph_rejected, assert_graph_rejected_with,
    assert_undefined_read_without_schema_error, graph_with_valid_tail_nodes, set_root_children,
    work_node,
};

#[derive(Clone)]
struct MemoryRegistry {
    descriptors: Arc<BTreeMap<WorkerRef, WorkerDescriptor>>,
    resolutions: Arc<AtomicUsize>,
}

struct VersionUnavailableRegistry;

#[async_trait]
impl WorkerRegistry for VersionUnavailableRegistry {
    async fn resolve(&self, worker: &WorkerRef) -> Result<WorkerDescriptor, WorkerRegistryError> {
        Err(WorkerRegistryError::VersionUnavailable {
            worker: worker.clone(),
        })
    }
}

#[async_trait]
impl WorkerRegistry for MemoryRegistry {
    async fn resolve(&self, worker: &WorkerRef) -> Result<WorkerDescriptor, WorkerRegistryError> {
        self.resolutions.fetch_add(1, Ordering::Relaxed);
        self.descriptors
            .get(worker)
            .cloned()
            .ok_or_else(|| WorkerRegistryError::NotFound {
                worker: worker.clone(),
            })
    }
}

fn record() -> Value {
    json!({
        "kind": "record",
        "fields": {
            "value": { "type": { "kind": "integer" }, "required": true },
            "result": { "type": { "kind": "number" }, "required": false },
            "verdict": { "type": { "kind": "enum", "values": ["accepted", "rejected"] }, "required": false },
            "diagnostic": { "type": { "kind": "number" }, "required": false }
        }
    })
}

fn rejection_diagnostics(error: VerificationError) -> Vec<GraphDiagnostic> {
    match error {
        VerificationError::Rejected { diagnostics } => Some(diagnostics),
        _ => None,
    }
    .assert_value()
}

fn descriptor(worker: &str, verifier: bool) -> WorkerDescriptor {
    serde_json::from_value(json!({
        "worker": worker,
        "graphProfiles": ["openengine.graph.full/v1"],
        "binding": { "protocol": "acp", "version": "1", "profile": "openengine.worker.acp/v1" },
        "contract": {
            "input": if verifier { json!({"kind":"null"}) } else { record() },
            "output": {"kind":"record","fields":{"result":{"type":{"kind":"integer"},"required":true}}},
            "verifier": if verifier { json!({
                "signals": { "verdict": ["accepted", "rejected"] },
                "diagnostic": { "kind": "record", "fields": {
                    "code": {"type":{"kind":"integer"},"required":true}
                } }
            }) } else { Value::Null },
            "errors": ["timeout", "crash", "malformed", "refusal"]
        },
        "capabilityPolicy": { "autonomy": "strict", "permissionPolicy": "policy.strict@1" },
        "artifactProfile": {
            "allowedTypeIds": ["openengine.result@1"],
            "allowedMediaTypes": ["application/json"],
            "minimumRedaction": "internal"
        },
        "credentialRequirements": []
    }))
    .assert_value()
}

fn decision_descriptor() -> WorkerDescriptor {
    let mut value = serde_json::to_value(descriptor("worker.decision@1", true)).assert_value();
    *value
        .assert_at_mut("contract")
        .assert_at_mut("verifier")
        .assert_at_mut("signals") = json!({"decision": ["accepted", "rejected"]});
    serde_json::from_value(value).assert_value()
}

fn memory_registry(descriptors: [(WorkerRef, WorkerDescriptor); 3]) -> MemoryRegistry {
    MemoryRegistry {
        descriptors: Arc::new(BTreeMap::from(descriptors)),
        resolutions: Arc::new(AtomicUsize::new(0)),
    }
}

fn registry() -> MemoryRegistry {
    memory_registry([
        (
            WorkerRef::new("worker.main@1").assert_value(),
            descriptor("worker.main@1", false),
        ),
        (
            WorkerRef::new("worker.verify@1").assert_value(),
            descriptor("worker.verify@1", true),
        ),
        (
            WorkerRef::new("worker.decision@1").assert_value(),
            decision_descriptor(),
        ),
    ])
}

fn worker_object_output() -> Value {
    json!({
        "kind":"record",
        "fields":{
            "result":{
                "type":{
                    "kind":"record",
                    "fields":{
                        "value":{
                            "type":{"kind":"integer"},
                            "required":true
                        }
                    }
                },
                "required":true
            }
        }
    })
}

fn worker_number_output() -> Value {
    json!({
        "kind":"record",
        "fields":{
            "result":{
                "type":{"kind":"number"},
                "required":true
            }
        }
    })
}

fn descriptor_with_output(worker: &str, output: Value) -> WorkerDescriptor {
    let mut value = serde_json::to_value(descriptor(worker, false)).assert_value();
    *value.assert_at_mut("contract").assert_at_mut("output") = output;
    serde_json::from_value(value).assert_value()
}

fn registry_with_worker_outputs(object_output: Value, number_output: Value) -> MemoryRegistry {
    memory_registry([
        (
            WorkerRef::new("worker.main@1").assert_value(),
            descriptor("worker.main@1", false),
        ),
        (
            WorkerRef::new("worker.object@1").assert_value(),
            descriptor_with_output("worker.object@1", object_output),
        ),
        (
            WorkerRef::new("worker.number@1").assert_value(),
            descriptor_with_output("worker.number@1", number_output),
        ),
    ])
}

fn valid_graph() -> Value {
    json!({
        "profile": "openengine.graph.full/v1",
        "initialInput": record(),
        "policy": { "policy": "policy.strict@1", "default": "deny" },
        "root": {
            "kind": "seq", "name": "root", "state": record(),
            "children": [
                {
                    "kind": "step", "name": "work", "worker": "worker.main@1",
                    "input": record(),
                    "output": {"kind":"record","fields":{"result":{"type":{"kind":"number"},"required":true}}},
                    "inputBindings": [{"target":["value"],"value":{"source":"state","path":["value"]}}],
                    "writeBindings": [{
                        "value":{"node":"work","channel":"out","path":["result"]},
                        "target":["result"]
                    }],
                    "timeoutMs": 172800000, "attempts": 2
                },
                {
                    "kind": "verifier", "name": "verify", "worker": "worker.verify@1",
                    "input": {"kind":"null"}, "output": {"kind":"record","fields":{}},
                    "inputBindings": [], "writeBindings": [], "timeoutMs": 1, "attempts": 1,
                    "signals": {"verdict":["accepted","rejected"]},
                    "diagnostic": {"kind":"record","fields":{}}
                },
                {
                    "kind":"choice", "name":"decision", "state":record(),
                    "branches":[{
                        "when":{"kind":"in","value":{"name":"verify","source":"signal","field":"verdict"},"labels":["accepted"]},
                        "node":{"kind":"succeed","name":"accepted","output":record(),"bindings":[
                            {"target":["value"],"value":{"source":"state","path":["value"]}}
                        ]}
                    }],
                    "otherwise":{"kind":"fail","name":"rejected","reason":"rejected"},
                    "promotedStatePaths":[]
                }
            ],
            "promotedStatePaths":[]
        }
    })
}

#[tokio::test]
async fn verifies_full_graph_and_returns_byte_stable_authoritative_ir() {
    let graph: GraphSpec = serde_json::from_value(valid_graph()).assert_value();
    let verifier = ProductionGraphVerifier::new(registry());
    let first = verifier.verify(&graph).await.assert_value();
    let second = verifier.verify(&graph).await.assert_value();

    assert_eq!(first, second);
    assert_eq!(first.compiled_ir.profile, graph.profile);
    assert_eq!(first.compiled_ir.initial_input, graph.initial_input);
    assert_eq!(first.compiled_ir.policy, graph.policy);
    assert_eq!(first.compiled_ir.root, graph.root);
    assert_eq!(first.compiled_ir.bounds.max_node_executions.get(), 2);
    assert_eq!(first.compiled_ir.bounds.peak_concurrency.get(), 1);
    assert!(matches!(
        first.compiled_ir.bounds.termination,
        TerminationWitness::Acyclic { .. }
    ));
    assert_eq!(
        first.compiled_ir.canonical_bytes().assert_value(),
        second.compiled_ir.canonical_bytes().assert_value()
    );
}

#[tokio::test]
async fn structural_rejection_precedes_registry_resolution_and_is_stably_sorted() {
    let mut value = valid_graph();
    *value
        .assert_at_mut("root")
        .assert_at_mut("children")
        .assert_at_mut(2) = json!({
        "kind":"step", "name":"work", "worker":"missing.worker@1",
        "input":{"kind":"null"}, "output":{"kind":"null"},
        "inputBindings":[], "writeBindings":[], "timeoutMs":1, "attempts":1
    });
    let graph: GraphSpec = serde_json::from_value(value).assert_value();
    let registry = registry();
    let resolutions = Arc::clone(&registry.resolutions);
    let verifier = ProductionGraphVerifier::new(registry);

    let first = verifier.verify(&graph).await.assert_error();
    let second = verifier.verify(&graph).await.assert_error();
    assert_eq!(first, second);
    assert_eq!(resolutions.load(Ordering::Relaxed), 0);
    let diagnostics = rejection_diagnostics(first);
    assert!(
        diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == GraphDiagnosticCode::InvalidGraphShape)
    );
}

#[tokio::test]
async fn terminal_only_full_graph_is_bounded_without_registry_resolution() {
    let graph: GraphSpec = serde_json::from_value(json!({
        "profile": "openengine.graph.full/v1",
        "initialInput": {"kind": "null"},
        "policy": {"policy": "policy.default@1", "default": "deny"},
        "root": {
            "kind": "succeed",
            "name": "done",
            "output": {"kind": "null"},
            "bindings": []
        }
    }))
    .assert_value();
    let registry = registry();
    let resolutions = Arc::clone(&registry.resolutions);
    let verified = ProductionGraphVerifier::new(registry)
        .verify(&graph)
        .await
        .assert_value();

    assert_eq!(resolutions.load(Ordering::Relaxed), 0);
    assert_eq!(verified.compiled_ir.bounds.max_node_executions.get(), 1);
    assert_eq!(verified.compiled_ir.bounds.peak_concurrency.get(), 1);
    assert!(verified.compiled_ir.bounds.attempts_per_node.is_empty());
}

#[tokio::test]
async fn single_worker_profile_and_missing_worker_are_rejections() {
    let mut single = valid_graph();
    *single.assert_at_mut("profile") = json!("openengine.graph.single-worker/v1");
    let single: GraphSpec = serde_json::from_value(single).assert_value();
    assert_eq!(single.profile, GraphProfile::SingleWorker);
    assert!(matches!(
        ProductionGraphVerifier::new(registry())
            .verify(&single)
            .await,
        Err(VerificationError::Rejected { .. })
    ));

    let mut missing = valid_graph();
    *missing
        .assert_at_mut("root")
        .assert_at_mut("children")
        .assert_at_mut(0)
        .assert_at_mut("worker") = json!("worker.missing@2");
    let missing: GraphSpec = serde_json::from_value(missing).assert_value();
    let error = ProductionGraphVerifier::new(registry())
        .verify(&missing)
        .await
        .assert_error();
    assert!(matches!(error, VerificationError::Rejected { .. }));

    let graph: GraphSpec = serde_json::from_value(valid_graph()).assert_value();
    let version_error = ProductionGraphVerifier::new(VersionUnavailableRegistry)
        .verify(&graph)
        .await
        .assert_error();
    assert!(matches!(version_error, VerificationError::Rejected { .. }));
}

#[test]
fn timeout_wire_range_has_no_product_ceiling() {
    let graph: GraphSpec = serde_json::from_value(valid_graph()).assert_value();
    let timeout = match serde_json::to_value(graph)
        .assert_value()
        .assert_at("root")
        .assert_at("children")
        .assert_at(0)
        .assert_at("timeoutMs")
        .clone()
    {
        Value::Number(timeout) => Some(timeout),
        _ => None,
    }
    .assert_value();
    assert_eq!(timeout.as_u64(), Some(172_800_000));

    for invalid in [0_u64, openengine_cluster_protocol::MAX_SAFE_GENERATION + 1] {
        let mut value = valid_graph();
        *value
            .assert_at_mut("root")
            .assert_at_mut("children")
            .assert_at_mut(0)
            .assert_at_mut("timeoutMs") = json!(invalid);
        assert!(serde_json::from_value::<GraphSpec>(value).is_err());
    }
}

fn rejection_codes(error: VerificationError) -> Vec<GraphDiagnosticCode> {
    rejection_diagnostics(error)
        .into_iter()
        .map(|diagnostic| diagnostic.code)
        .collect()
}

fn required_empty_record_payload() -> Value {
    json!({
        "kind": "record",
        "fields": {
            "object": {
                "type": { "kind": "record", "fields": {} },
                "required": true
            }
        }
    })
}

fn graph_with_state_children(state: Value, children: Value) -> GraphSpec {
    serde_json::from_value(json!({
        "profile":"openengine.graph.full/v1",
        "initialInput":state.clone(),
        "policy":{"policy":"policy.strict@1","default":"deny"},
        "root":{
            "kind":"seq","name":"root","state":state,
            "children":children,"promotedStatePaths":[]
        }
    }))
    .assert_value()
}

fn graph_with_root_child(child: Value) -> GraphSpec {
    serde_json::from_value(json!({
        "profile":"openengine.graph.full/v1","initialInput":record(),
        "policy":{"policy":"policy.strict@1","default":"deny"},"root":child
    }))
    .assert_value()
}

fn map_control_graph(max_items: u64, branches: Value, otherwise: Value) -> GraphSpec {
    let state = json!({
        "kind":"record",
        "fields":{
            "items":{
                "type":{"kind":"array","items":{"kind":"null"}},
                "required":true
            }
        }
    });
    graph_with_state_children(
        state.clone(),
        json!([
            {
                "kind":"map","name":"map","state":state.clone(),
                "body":{
                    "kind":"verifier","name":"mapVerify","worker":"worker.verify@1",
                    "input":{"kind":"null"},"output":{"kind":"record","fields":{}},
                    "inputBindings":[],"writeBindings":[],"timeoutMs":1,"attempts":1,
                    "signals":{"verdict":["accepted","rejected"]},
                    "diagnostic":{"kind":"record","fields":{}}
                },
                "over":{"source":"state","path":["items"]},
                "maxItems":max_items,"promotedStatePaths":[]
            },
            {
                "kind":"choice","name":"choice","state":state,
                "branches":branches,"otherwise":otherwise,"promotedStatePaths":[]
            }
        ]),
    )
}

#[path = "graph_verifier/cases_control.rs"]
mod cases_control;
#[path = "graph_verifier/cases_dataflow.rs"]
mod cases_dataflow;
#[path = "graph_verifier/cases_parallel.rs"]
mod cases_parallel;
#[path = "graph_verifier/cases_structure.rs"]
mod cases_structure;
#[path = "graph_verifier/map_regressions.rs"]
mod map_regressions;
#[path = "graph_verifier/parallel_control_regressions.rs"]
mod parallel_control_regressions;
#[path = "graph_verifier/parallel_definition_regressions.rs"]
mod parallel_definition_regressions;
#[path = "graph_verifier/parallel_regressions.rs"]
mod parallel_regressions;
#[path = "graph_verifier/regressions.rs"]
mod regressions;
