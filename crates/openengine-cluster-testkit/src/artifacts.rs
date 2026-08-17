use std::fs;
use std::path::{Path, PathBuf};

use openengine_cluster_protocol::{
    AgentAttachClosedNotification, AgentAttachEventNotification, AgentAttachParams,
    AgentAttachResult, ApplyParams, ApplyResult, ArtifactRef, CancelRequestParams, CompiledGraphIr,
    DeleteParams, DeleteResult, EventNotification, GetParams, GetResult, GraphDiagnostic,
    GraphSpec, InitializeParams, InitializeResult, JsonRpcNotification, JsonRpcRequest,
    JsonRpcResponse, LogEventNotification, LogsClosedNotification, LogsParams, LogsResult,
    PlanParams, PlanResult, ResubmitParams, ResubmitResult, RetryParams, RetryResult, StopParams,
    StopResult, StructuralBounds, SubscriptionCancelParams, SubscriptionClosedNotification,
    UpdateParams, UpdateResult, WatchParams, WatchResult,
};
use openengine_cluster_server::{ConnectionContext, Dispatcher};
use schemars::{schema_for, JsonSchema};
use serde_json::{json, Value};
use thiserror::Error;

use crate::EmptyBackend;
use crate::negative_graph_fixtures::{diagnostic_fixture, negative_graph_fixtures};
use crate::schema_helpers::merge_schema;
use crate::worker_artifacts::{with_worker_components, worker_fixture_artifacts, worker_schema};

mod openrpc;

const ROOT: &str = "protocol/openengine-cluster/v1";

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Artifact {
    pub relative_path: String,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Error)]
pub enum ArtifactError {
    #[error("generated artifact is missing: {0}")]
    Missing(PathBuf),
    #[error("generated artifact has byte drift: {0}")]
    Drift(PathBuf),
    #[error("generated artifact I/O failed for {path}: {source}")]
    Io {
        path: PathBuf,
        source: std::io::Error,
    },
}

#[derive(JsonSchema)]
pub struct ImplementedProtocolSchema {
    pub initialize_request: JsonRpcRequest<InitializeParams>,
    pub initialize_response: JsonRpcResponse<InitializeResult>,
    pub plan_request: JsonRpcRequest<PlanParams>,
    pub plan_response: JsonRpcResponse<PlanResult>,
    pub apply_request: JsonRpcRequest<ApplyParams>,
    pub apply_response: JsonRpcResponse<ApplyResult>,
    pub get_request: JsonRpcRequest<GetParams>,
    pub get_response: JsonRpcResponse<GetResult>,
    pub update_request: JsonRpcRequest<UpdateParams>,
    pub update_response: JsonRpcResponse<UpdateResult>,
    pub stop_request: JsonRpcRequest<StopParams>,
    pub stop_response: JsonRpcResponse<StopResult>,
    pub retry_request: JsonRpcRequest<RetryParams>,
    pub retry_response: JsonRpcResponse<RetryResult>,
    pub resubmit_request: JsonRpcRequest<ResubmitParams>,
    pub resubmit_response: JsonRpcResponse<ResubmitResult>,
    pub delete_request: JsonRpcRequest<DeleteParams>,
    pub delete_response: JsonRpcResponse<DeleteResult>,
    pub watch_request: JsonRpcRequest<WatchParams>,
    pub watch_response: JsonRpcResponse<WatchResult>,
    pub event_notification: JsonRpcNotification<EventNotification>,
    pub subscription_cancel_notification: JsonRpcNotification<SubscriptionCancelParams>,
    pub subscription_closed_notification: JsonRpcNotification<SubscriptionClosedNotification>,
    pub cancel_request_notification: JsonRpcNotification<CancelRequestParams>,
    pub logs_request: JsonRpcRequest<LogsParams>,
    pub logs_response: JsonRpcResponse<LogsResult>,
    pub log_event_notification: JsonRpcNotification<LogEventNotification>,
    pub logs_closed_notification: JsonRpcNotification<LogsClosedNotification>,
    pub agent_attach_request: JsonRpcRequest<AgentAttachParams>,
    pub agent_attach_response: JsonRpcResponse<AgentAttachResult>,
    pub agent_attach_event_notification: JsonRpcNotification<AgentAttachEventNotification>,
    pub agent_attach_closed_notification: JsonRpcNotification<AgentAttachClosedNotification>,
}

pub async fn generate_artifacts() -> Vec<Artifact> {
    let schema = serde_json::to_value(schema_for!(ImplementedProtocolSchema))
        .expect("JSON Schema serialization must succeed");
    let worker_schema = worker_schema();
    let graph_schema = graph_schema();
    let compiled_ir_schema = serde_json::to_value(schema_for!(CompiledGraphIr))
        .expect("compiled IR JSON Schema serialization must succeed");
    let openrpc = openrpc::document();
    let dispatcher = Dispatcher::new(EmptyBackend, ConnectionContext::default());

    let cases = [
        (
            "initialize.ndjson",
            r#"{"jsonrpc":"2.0","id":"init-1","method":"initialize","params":{"protocolVersion":"openengine.cluster/v1"}}"#,
        ),
        (
            "get-empty.ndjson",
            r#"{"jsonrpc":"2.0","id":2,"method":"get","params":{}}"#,
        ),
        (
            "incompatible-version.ndjson",
            r#"{"jsonrpc":"2.0","id":3,"method":"initialize","params":{"protocolVersion":"openengine.cluster/v0"}}"#,
        ),
        (
            "invalid-params.ndjson",
            r#"{"jsonrpc":"2.0","id":4,"method":"get","params":[]}"#,
        ),
        (
            "unknown-method.ndjson",
            r#"{"jsonrpc":"2.0","id":5,"method":"cluster.missing","params":{}}"#,
        ),
        (
            "malformed-request.ndjson",
            r#"{"jsonrpc":"1.0","id":6,"method":"get","params":{}}"#,
        ),
        ("rejected-batch.ndjson", r#"[]"#),
    ];

    let mut artifacts = vec![
        json_artifact(format!("{ROOT}/schema.json"), schema),
        json_artifact(format!("{ROOT}/graph.schema.json"), graph_schema),
        json_artifact(
            format!("{ROOT}/compiled-ir.schema.json"),
            compiled_ir_schema,
        ),
        json_artifact(
            format!("{ROOT}/openrpc.json"),
            with_worker_components(openrpc),
        ),
        json_artifact(format!("{ROOT}/worker.schema.json"), worker_schema),
    ];
    artifacts.extend(worker_fixture_artifacts());
    artifacts.extend(graph_fixture_artifacts());
    artifacts.extend(crate::graph_verifier_artifacts::graph_verifier_fixture_artifacts().await);
    artifacts.extend(crate::admission_artifacts::generate_admission_goldens().await);
    artifacts.extend(crate::lifecycle_artifacts::generate_lifecycle_goldens().await);
    artifacts.extend(crate::lifecycle_artifacts::generate_resubmit_goldens().await);
    artifacts.extend(crate::lifecycle_artifacts::generate_delete_goldens().await);
    artifacts.extend(crate::watch_artifacts::generate_watch_goldens().await);
    artifacts.extend(crate::logs_artifacts::generate_logs_goldens().await);
    artifacts.extend(crate::agent_attach_artifacts::generate_agent_attach_goldens().await);
    artifacts.extend(crate::native_v2_observation_artifacts::artifacts());
    for (name, request) in cases {
        let response = dispatcher.dispatch(request).await;
        artifacts.push(Artifact {
            relative_path: format!("{ROOT}/goldens/{name}"),
            bytes: format!("{request}\n{response}\n").into_bytes(),
        });
    }
    artifacts
}

pub async fn check_artifacts(workspace: &Path) -> Result<(), ArtifactError> {
    for artifact in generate_artifacts().await {
        let path = workspace.join(&artifact.relative_path);
        let actual = match fs::read(&path) {
            Ok(actual) => actual,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Err(ArtifactError::Missing(path));
            }
            Err(source) => return Err(ArtifactError::Io { path, source }),
        };
        if actual != artifact.bytes {
            return Err(ArtifactError::Drift(path));
        }
    }
    Ok(())
}

pub async fn write_artifacts(workspace: &Path) -> Result<(), ArtifactError> {
    for artifact in generate_artifacts().await {
        let path = workspace.join(&artifact.relative_path);
        let parent = path
            .parent()
            .expect("every generated artifact must have a parent directory");
        fs::create_dir_all(parent).map_err(|source| ArtifactError::Io {
            path: parent.to_path_buf(),
            source,
        })?;
        fs::write(&path, artifact.bytes).map_err(|source| ArtifactError::Io { path, source })?;
    }
    Ok(())
}

#[must_use]
pub fn workspace_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .expect("testkit crate must be two directories below the workspace")
        .to_path_buf()
}

pub(crate) fn json_artifact(relative_path: String, value: Value) -> Artifact {
    let mut bytes = serde_json::to_vec_pretty(&value).expect("artifact serialization must succeed");
    bytes.push(b'\n');
    Artifact {
        relative_path,
        bytes,
    }
}

fn graph_schema() -> Value {
    let mut root = serde_json::to_value(schema_for!(GraphSpec))
        .expect("graph JSON Schema serialization must succeed");
    for (name, schema) in [
        (
            "GraphDiagnostic",
            serde_json::to_value(schema_for!(GraphDiagnostic))
                .expect("diagnostic schema serialization must succeed"),
        ),
        (
            "StructuralBounds",
            serde_json::to_value(schema_for!(StructuralBounds))
                .expect("bounds schema serialization must succeed"),
        ),
        (
            "ArtifactRef",
            serde_json::to_value(schema_for!(ArtifactRef))
                .expect("artifact schema serialization must succeed"),
        ),
    ] {
        merge_schema(&mut root, name, schema);
    }
    root
}

fn graph_fixture_artifacts() -> Vec<Artifact> {
    let full = full_graph_fixture();
    let single = single_worker_fixture();
    let compiled = compiled_fixture(&["right", "left"], &["first", "second"]);
    let reordered = compiled_fixture(&["left", "right"], &["first", "second"]);
    let mutated = compiled_fixture(&["left", "right"], &["second", "first"]);
    let compiled_ir: CompiledGraphIr = serde_json::from_value(compiled.clone())
        .expect("generated compiled fixture must deserialize");
    let canonical_bytes = compiled_ir
        .canonical_bytes()
        .expect("generated compiled fixture must canonicalize");
    let digest = compiled_ir
        .identity()
        .expect("generated compiled fixture must hash")
        .to_string();

    let mut artifacts = vec![
        json_artifact(
            format!("{ROOT}/fixtures/graph/positive/full-all-nodes.json"),
            full.clone(),
        ),
        json_artifact(
            format!("{ROOT}/fixtures/graph/positive/single-worker.json"),
            single,
        ),
        json_artifact(
            format!("{ROOT}/fixtures/graph/positive/compiled-ir.json"),
            compiled.clone(),
        ),
        json_artifact(
            format!("{ROOT}/fixtures/graph/positive/diagnostic.json"),
            diagnostic_fixture(),
        ),
        json_artifact(
            format!("{ROOT}/fixtures/graph/positive/artifact-ref.json"),
            artifact_ref_fixture(),
        ),
        json_artifact(
            format!("{ROOT}/fixtures/graph/canonical/base.json"),
            compiled.clone(),
        ),
        json_artifact(
            format!("{ROOT}/fixtures/graph/canonical/reordered.json"),
            reordered,
        ),
        json_artifact(
            format!("{ROOT}/fixtures/graph/canonical/sequence-mutated.json"),
            mutated,
        ),
        Artifact {
            relative_path: format!("{ROOT}/fixtures/graph/canonical/base.canonical.json"),
            bytes: canonical_bytes,
        },
        Artifact {
            relative_path: format!("{ROOT}/fixtures/graph/canonical/base.sha256"),
            bytes: format!("{digest}\n").into_bytes(),
        },
    ];

    for (name, code, schema, document) in
        negative_graph_fixtures(full, compiled, artifact_ref_fixture())
    {
        artifacts.push(json_artifact(
            format!("{ROOT}/fixtures/graph/negative/{name}.json"),
            json!({ "expectedCode": code, "schema": schema, "document": document }),
        ));
    }
    artifacts
}

fn all_payload_type() -> Value {
    json!({
        "kind": "record",
        "fields": {
            "nothing": { "type": { "kind": "null" }, "required": false },
            "enabled": { "type": { "kind": "boolean" }, "required": true },
            "count": { "type": { "kind": "integer" }, "required": true },
            "ratio": { "type": { "kind": "number" }, "required": false },
            "text": { "type": { "kind": "string" }, "required": true },
            "items": { "type": { "kind": "array", "items": { "kind": "string" } }, "required": true },
            "verdict": { "type": { "kind": "enum", "values": ["accepted", "rejected"] }, "required": false }
        }
    })
}

fn control_selector(source: &str) -> Value {
    json!({
        "name": "verify",
        "source": source,
        "field": if source == "error" { Value::Null } else { json!("verdict") }
    })
}

fn guard_fixture(kind: &str) -> Value {
    match kind {
        "in" => {
            json!({ "kind": "in", "value": control_selector("signal"), "labels": ["accepted"] })
        }
        "all" => json!({ "kind": "all", "guards": [guard_fixture("in")] }),
        "any" => json!({ "kind": "any", "guards": [guard_fixture("in")] }),
        "not" => json!({ "kind": "not", "guard": guard_fixture("in") }),
        "k_of_n" => json!({
            "kind": "k_of_n", "count": 1,
            "values": [control_selector("signal"), control_selector("error")],
            "labels": ["accepted", "refusal"]
        }),
        "k_of_map" => json!({
            "kind": "k_of_map", "count": 1, "value": control_selector("group"),
            "labels": ["accepted"]
        }),
        _ => unreachable!("fixture guard kind is closed"),
    }
}

fn succeed_fixture(name: &str) -> Value {
    json!({
        "kind": "succeed", "name": name, "output": { "kind": "string" },
        "bindings": [{ "target": ["text"], "value": { "source": "state", "path": ["text"] } }]
    })
}

fn full_graph_fixture() -> Value {
    let branches = ["in", "all", "any", "not", "k_of_n", "k_of_map"]
        .into_iter()
        .enumerate()
        .map(|(index, kind)| {
            json!({
                "when": guard_fixture(kind),
                "node": succeed_fixture(&format!("choice{index}"))
            })
        })
        .collect::<Vec<_>>();
    let par = |name: &str, join: Value| {
        json!({
            "kind": "par", "name": name, "state": all_payload_type(),
            "branches": [succeed_fixture(&format!("{name}Left")), succeed_fixture(&format!("{name}Right"))],
            "promotedStatePaths": [["text"]], "join": join
        })
    };
    json!({
        "profile": "openengine.graph.full/v1",
        "initialInput": all_payload_type(),
        "policy": { "policy": "policy.default@1", "default": "deny" },
        "root": {
            "kind": "seq", "name": "root", "state": all_payload_type(),
            "children": [
                {
                    "kind": "step", "name": "work", "worker": "legacy.zeroshot.ship@1",
                    "input": all_payload_type(), "output": { "kind": "string" },
                    "inputBindings": [
                        { "target": ["text"], "value": { "source": "state", "path": ["text"] } },
                        { "target": ["text"], "value": { "source": "item", "path": ["text"] } }
                    ],
                    "writeBindings": [{
                        "value": { "node": "work", "channel": "out", "path": ["text"] },
                        "target": ["text"]
                    }],
                    "timeoutMs": 1000, "attempts": 2
                },
                {
                    "kind": "verifier", "name": "verify", "worker": "worker.validator@1",
                    "input": { "kind": "string" }, "output": { "kind": "boolean" },
                    "inputBindings": [], "writeBindings": [], "timeoutMs": 500, "attempts": 1,
                    "signals": { "verdict": ["accepted", "rejected"] },
                    "diagnostic": { "kind": "record", "fields": {} }
                },
                {
                    "kind": "choice", "name": "choose", "state": all_payload_type(),
                    "branches": branches,
                    "otherwise": { "kind": "fail", "name": "failed", "reason": "rejected" },
                    "promotedStatePaths": []
                },
                par("joinAll", json!({ "kind": "all" })),
                par("joinAny", json!({ "kind": "any" })),
                par("joinQuorum", json!({ "kind": "quorum", "count": 1 })),
                par("joinFirst", json!({ "kind": "first", "when": guard_fixture("in") })),
                {
                    "kind": "loop", "name": "repeat", "state": all_payload_type(),
                    "body": succeed_fixture("loopBody"), "until": guard_fixture("in"),
                    "maxIterations": 3, "promotedStatePaths": []
                },
                {
                    "kind": "map", "name": "each", "state": all_payload_type(),
                    "body": succeed_fixture("mapBody"),
                    "over": { "source": "state", "path": ["items"] },
                    "maxItems": 32, "promotedStatePaths": []
                }
            ],
            "promotedStatePaths": [["text"]]
        }
    })
}

fn single_worker_fixture() -> Value {
    json!({
        "profile": "openengine.graph.single-worker/v1",
        "initialInput": { "kind": "null" },
        "policy": { "policy": "policy.default@1", "default": "deny" },
        "root": {
            "kind": "step", "name": "worker", "worker": "legacy.zeroshot.ship@1",
            "input": { "kind": "null" }, "output": { "kind": "null" },
            "inputBindings": [], "writeBindings": [], "timeoutMs": 60000, "attempts": 1
        }
    })
}

fn compiled_fixture(par_order: &[&str], sequence_order: &[&str]) -> Value {
    let terminal = |name: &&str| json!({ "kind": "succeed", "name": name, "output": { "kind": "null" }, "bindings": [] });
    json!({
        "profile": "openengine.graph.full/v1",
        "initialInput": { "kind": "record", "fields": {} },
        "policy": { "policy": "policy.default@1", "default": "deny" },
        "root": {
            "kind": "seq", "name": "root", "state": { "kind": "record", "fields": {} },
            "children": [
                {
                    "kind": "par", "name": "parallel", "state": { "kind": "record", "fields": {} },
                    "branches": par_order.iter().map(terminal).collect::<Vec<_>>(),
                    "promotedStatePaths": [], "join": { "kind": "all" }
                },
                {
                    "kind": "seq", "name": "ordered", "state": { "kind": "record", "fields": {} },
                    "children": sequence_order.iter().map(terminal).collect::<Vec<_>>(),
                    "promotedStatePaths": []
                }
            ],
            "promotedStatePaths": []
        },
        "bounds": {
            "termination": { "kind": "bounded", "ranking": [["count"]], "maxIterations": 4 },
            "maxNodeExecutions": 12, "peakConcurrency": 2,
            "attemptsPerNode": { "parallel": 1, "ordered": 1 }
        }
    })
}

fn artifact_ref_fixture() -> Value {
    json!({
        "artifactId": "artifact-123", "sha256": "a".repeat(64), "byteLength": 42,
        "mediaType": "application/json", "typeId": "openengine.result@1",
        "producer": { "node": "work", "worker": "legacy.zeroshot.ship@1" },
        "lineage": { "generation": 7, "runId": "run-9", "attempt": 1 },
        "redaction": "internal"
    })
}
