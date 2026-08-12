use openengine_cluster_protocol::{GraphSpec, WorkerDescriptor};
use serde_json::json;

use super::AGENT_WORKER_REF;

pub(super) fn graph() -> GraphSpec {
    serde_json::from_value(json!({
        "profile": "openengine.graph.full/v1",
        "initialInput": input_type(),
        "policy": { "policy": "policy.default@1", "default": "deny" },
        "root": {
            "kind": "seq",
            "name": "root",
            "state": state_type(),
            "children": [agent_step(), terminal_choice()],
            "promotedStatePaths": []
        }
    }))
    .expect("fixed native foreground agent graph must decode")
}

fn agent_step() -> serde_json::Value {
    json!({
        "kind": "step",
        "name": "codex",
        "worker": AGENT_WORKER_REF,
        "input": input_type(),
        "output": output_type(),
        "inputBindings": [
            {
                "target": ["prompt"],
                "value": { "source": "state", "path": ["prompt"] }
            },
            {
                "target": ["expectedGreeting"],
                "value": { "source": "state", "path": ["expectedGreeting"] }
            }
        ],
        "writeBindings": [
            {
                "value": { "node": "codex", "channel": "out", "path": ["summary"] },
                "target": ["summary"]
            },
            {
                "value": {
                    "node": "codex",
                    "channel": "out",
                    "path": ["validationArtifact"]
                },
                "target": ["validationArtifact"]
            }
        ],
        "timeoutMs": 3_600_000,
        "attempts": 1
    })
}

fn terminal_choice() -> serde_json::Value {
    json!({
        "kind": "choice",
        "name": "finish",
        "state": state_type(),
        "branches": [{
            "when": {
                "kind": "in",
                "value": { "name": "codex", "source": "error", "field": null },
                "labels": ["timeout", "crash", "malformed", "refusal"]
            },
            "node": { "kind": "fail", "name": "failed", "reason": "worker_failed" }
        }],
        "otherwise": {
            "kind": "succeed",
            "name": "done",
            "output": output_type(),
            "bindings": [
                {
                    "target": ["summary"],
                    "value": { "source": "state", "path": ["summary"] }
                },
                {
                    "target": ["validationArtifact"],
                    "value": { "source": "state", "path": ["validationArtifact"] }
                }
            ]
        },
        "promotedStatePaths": []
    })
}

pub(super) fn descriptor() -> WorkerDescriptor {
    serde_json::from_value(json!({
        "worker": AGENT_WORKER_REF,
        "graphProfiles": ["openengine.graph.full/v1"],
        "binding": {
            "protocol": "builtin",
            "version": "1",
            "profile": "openengine.worker.builtin/v1"
        },
        "contract": {
            "input": input_type(),
            "output": output_type(),
            "verifier": null,
            "errors": ["timeout", "crash", "malformed", "refusal"]
        },
        "capabilityPolicy": {
            "autonomy": "strict",
            "permissionPolicy": "policy.default@1"
        },
        "artifactProfile": {
            "allowedTypeIds": ["native.agent.validation@1"],
            "allowedMediaTypes": ["application/json"],
            "minimumRedaction": "internal"
        },
        "credentialRequirements": []
    }))
    .expect("fixed native foreground agent descriptor must decode")
}

fn input_type() -> serde_json::Value {
    json!({
        "kind": "record",
        "fields": {
            "prompt": { "type": { "kind": "string" }, "required": true },
            "expectedGreeting": { "type": { "kind": "string" }, "required": true }
        }
    })
}

fn state_type() -> serde_json::Value {
    json!({
        "kind": "record",
        "fields": {
            "prompt": { "type": { "kind": "string" }, "required": true },
            "expectedGreeting": { "type": { "kind": "string" }, "required": true },
            "summary": { "type": { "kind": "string" }, "required": false },
            "validationArtifact": { "type": artifact_type(), "required": false }
        }
    })
}

fn output_type() -> serde_json::Value {
    json!({
        "kind": "record",
        "fields": {
            "summary": { "type": { "kind": "string" }, "required": true },
            "validationArtifact": { "type": artifact_type(), "required": true }
        }
    })
}

fn artifact_type() -> serde_json::Value {
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
