use openengine_cluster_protocol::GraphSpec;
use serde_json::json;

use super::native_process::TempState;

pub fn deterministic_graph() -> GraphSpec {
    serde_json::from_value(json!({
        "profile": "openengine.graph.full/v1",
        "initialInput": {
            "kind": "record",
            "fields": {
                "value": { "type": { "kind": "integer" }, "required": true }
            }
        },
        "policy": { "policy": "policy.default@1", "default": "deny" },
        "root": {
            "kind": "seq",
            "name": "root",
            "state": {
                "kind": "record",
                "fields": {
                    "value": { "type": { "kind": "integer" }, "required": true }
                }
            },
            "children": [
                {
                    "kind": "step",
                    "name": "deterministic",
                    "worker": "native.deterministic@1",
                    "input": { "kind": "null" },
                    "output": {
                        "kind": "record",
                        "fields": {
                            "value": { "type": { "kind": "integer" }, "required": true }
                        }
                    },
                    "inputBindings": [],
                    "writeBindings": [{
                        "value": {
                            "node": "deterministic",
                            "channel": "out",
                            "path": ["value"]
                        },
                        "target": ["value"]
                    }],
                    "timeoutMs": 10000,
                    "attempts": 1
                },
                {
                    "kind": "succeed",
                    "name": "done",
                    "output": {
                        "kind": "record",
                        "fields": {
                            "value": { "type": { "kind": "integer" }, "required": true }
                        }
                    },
                    "bindings": [{
                        "target": ["value"],
                        "value": { "source": "state", "path": ["value"] }
                    }]
                }
            ],
            "promotedStatePaths": []
        }
    }))
    .unwrap()
}

pub fn effect_count(state: &TempState) -> usize {
    std::fs::read_dir(state.path())
        .unwrap()
        .filter_map(Result::ok)
        .filter(|entry| {
            entry
                .file_name()
                .to_str()
                .is_some_and(|name| name.starts_with("native-effect-") && name.ends_with(".marker"))
        })
        .count()
}
