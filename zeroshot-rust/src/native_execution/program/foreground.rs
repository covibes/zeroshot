use openengine_cluster_protocol::{GraphSpec, WorkerDescriptor};
use serde_json::{json, Value};

use super::AgentKind;

pub(super) fn graph(kind: AgentKind) -> GraphSpec {
    serde_json::from_value(json!({
        "profile": "openengine.graph.full/v1",
        "initialInput": input_type(kind),
        "policy": { "policy": "policy.default@1", "default": "deny" },
        "root": {
            "kind": "seq",
            "name": "root",
            "state": state_type(kind),
            "children": [step(kind), terminal_choice(kind)],
            "promotedStatePaths": []
        }
    }))
    .expect("fixed native foreground graph must decode")
}

pub(super) fn descriptor(kind: AgentKind) -> WorkerDescriptor {
    serde_json::from_value(json!({
        "worker": kind.worker_ref(),
        "graphProfiles": ["openengine.graph.full/v1"],
        "binding": {
            "protocol": "builtin",
            "version": "1",
            "profile": "openengine.worker.builtin/v1"
        },
        "contract": {
            "input": input_type(kind),
            "output": output_type(kind),
            "verifier": null,
            "errors": ["timeout", "crash", "malformed", "refusal"]
        },
        "capabilityPolicy": {
            "autonomy": "strict",
            "permissionPolicy": "policy.default@1"
        },
        "artifactProfile": artifact_profile(kind),
        "credentialRequirements": []
    }))
    .expect("fixed native foreground descriptor must decode")
}

fn step(kind: AgentKind) -> Value {
    json!({
        "kind": "step",
        "name": node_name(kind),
        "worker": kind.worker_ref(),
        "input": input_type(kind),
        "output": output_type(kind),
        "inputBindings": input_bindings(kind),
        "writeBindings": write_bindings(kind),
        "timeoutMs": 3_600_000,
        "attempts": 1
    })
}

fn terminal_choice(kind: AgentKind) -> Value {
    json!({
        "kind": "choice",
        "name": "finish",
        "state": state_type(kind),
        "branches": [{
            "when": {
                "kind": "in",
                "value": { "name": node_name(kind), "source": "error", "field": null },
                "labels": ["timeout", "crash", "malformed", "refusal"]
            },
            "node": { "kind": "fail", "name": "failed", "reason": "worker_failed" }
        }],
        "otherwise": {
            "kind": "succeed",
            "name": "done",
            "output": output_type(kind),
            "bindings": output_bindings(kind)
        },
        "promotedStatePaths": []
    })
}

fn node_name(kind: AgentKind) -> &'static str {
    match kind {
        AgentKind::CodexV1 => "codex",
        AgentKind::PiV1 => "pi",
    }
}

fn input_type(kind: AgentKind) -> Value {
    let mut fields = serde_json::Map::from_iter([(
        "prompt".to_owned(),
        json!({ "type": { "kind": "string" }, "required": true }),
    )]);
    if kind == AgentKind::CodexV1 {
        fields.insert(
            "expectedGreeting".to_owned(),
            json!({ "type": { "kind": "string" }, "required": true }),
        );
    }
    json!({ "kind": "record", "fields": fields })
}

fn state_type(kind: AgentKind) -> Value {
    let mut fields = input_type(kind)["fields"]
        .as_object()
        .expect("fixed input is a record")
        .clone();
    match kind {
        AgentKind::CodexV1 => {
            fields.insert(
                "summary".to_owned(),
                json!({ "type": { "kind": "string" }, "required": false }),
            );
            fields.insert(
                "validationArtifact".to_owned(),
                json!({ "type": artifact_type(), "required": false }),
            );
        }
        AgentKind::PiV1 => {
            fields.insert(
                "response".to_owned(),
                json!({ "type": { "kind": "string" }, "required": false }),
            );
        }
    }
    json!({ "kind": "record", "fields": fields })
}

fn output_type(kind: AgentKind) -> Value {
    match kind {
        AgentKind::CodexV1 => json!({
            "kind": "record",
            "fields": {
                "summary": { "type": { "kind": "string" }, "required": true },
                "validationArtifact": { "type": artifact_type(), "required": true }
            }
        }),
        AgentKind::PiV1 => json!({
            "kind": "record",
            "fields": {
                "response": { "type": { "kind": "string" }, "required": true }
            }
        }),
    }
}

fn input_bindings(kind: AgentKind) -> Vec<Value> {
    let mut bindings = vec![json!({
        "target": ["prompt"],
        "value": { "source": "state", "path": ["prompt"] }
    })];
    if kind == AgentKind::CodexV1 {
        bindings.push(json!({
            "target": ["expectedGreeting"],
            "value": { "source": "state", "path": ["expectedGreeting"] }
        }));
    }
    bindings
}

fn write_bindings(kind: AgentKind) -> Vec<Value> {
    output_fields(kind)
        .iter()
        .copied()
        .map(|field| {
            json!({
                "value": { "node": node_name(kind), "channel": "out", "path": [field] },
                "target": [field]
            })
        })
        .collect()
}

fn output_bindings(kind: AgentKind) -> Vec<Value> {
    output_fields(kind)
        .iter()
        .copied()
        .map(|field| {
            json!({
                "target": [field],
                "value": { "source": "state", "path": [field] }
            })
        })
        .collect()
}

fn output_fields(kind: AgentKind) -> &'static [&'static str] {
    match kind {
        AgentKind::CodexV1 => &["summary", "validationArtifact"],
        AgentKind::PiV1 => &["response"],
    }
}

fn artifact_profile(kind: AgentKind) -> Value {
    match kind {
        AgentKind::CodexV1 => json!({
            "allowedTypeIds": ["native.agent.validation@1"],
            "allowedMediaTypes": ["application/json"],
            "minimumRedaction": "internal"
        }),
        AgentKind::PiV1 => json!({
            "allowedTypeIds": ["native.agent.pi.response@1"],
            "allowedMediaTypes": ["application/json"],
            "minimumRedaction": "internal"
        }),
    }
}

fn artifact_type() -> Value {
    json!({
        "kind": "record",
        "fields": {
            "artifactId": { "type": { "kind": "string" }, "required": true },
            "sha256": { "type": { "kind": "string" }, "required": true },
            "byteLength": { "type": { "kind": "integer" }, "required": true },
            "mediaType": { "type": { "kind": "string" }, "required": true },
            "typeId": { "type": { "kind": "string" }, "required": true },
            "producer": {
                "type": {
                    "kind": "record",
                    "fields": {
                        "node": { "type": { "kind": "string" }, "required": true },
                        "worker": { "type": { "kind": "string" }, "required": true }
                    }
                },
                "required": true
            },
            "lineage": {
                "type": {
                    "kind": "record",
                    "fields": {
                        "generation": { "type": { "kind": "integer" }, "required": true },
                        "runId": { "type": { "kind": "string" }, "required": true },
                        "attempt": { "type": { "kind": "integer" }, "required": true }
                    }
                },
                "required": true
            },
            "redaction": {
                "type": {
                    "kind": "enum",
                    "values": ["public", "internal", "confidential", "restricted"]
                },
                "required": true
            }
        }
    })
}
