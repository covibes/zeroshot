use super::*;

pub(super) fn runtime() -> RuntimePlan {
    RuntimePlan::Codex {
        provider: CodexProvider::OpenAi,
        nodes: BTreeMap::from([(
            NodeName::new("worker").assert_value_with("node"),
            NodeRuntimeBinding::Agent {
                model: crate::worker_catalog::ModelId::new("gpt-5.6").assert_value_with("model"),
                effort: Some(ReasoningEffort::Max),
                session_scope: SessionScope::Execution,
                env: BTreeSet::from([EnvironmentVariableName::new("NODE_TOKEN")
                    .assert_value_with("environment name")]),
            },
        )]),
    }
}

pub(super) fn request(input: Value) -> CloudRunSubmission {
    request_with_key(input, "cloud-test")
}

pub(super) fn request_with_key(input: Value, submission_key: &str) -> CloudRunSubmission {
    CloudRunSubmission {
        graph: graph(),
        initial_input: input,
        ship: false,
        submission_key: IdempotencyKey::new(submission_key).assert_value_with("submission key"),
    }
}

pub(super) fn graph() -> GraphSpec {
    serde_json::from_value(json!({
        "profile": "openengine.graph.full/v1",
        "initialInput": {"kind": "null"},
        "policy": {"policy": "policy.native-v2@1", "default": "deny"},
        "root": {
            "kind": "seq",
            "name": "root",
            "state": {"kind": "null"},
            "children": [
                {
                    "kind": "step",
                    "name": "worker",
                    "worker": "agent.worker@1",
                    "input": {"kind": "null"},
                    "output": {"kind": "null"},
                    "inputBindings": [],
                    "writeBindings": [],
                    "timeoutMs": 10000,
                    "attempts": 1
                },
                {
                    "kind": "succeed",
                    "name": "done",
                    "output": {"kind": "null"},
                    "bindings": []
                }
            ],
            "promotedStatePaths": []
        }
    }))
    .assert_value_with("graph")
}

pub(super) fn complex_runtime() -> RuntimePlan {
    let binding = |session_scope| NodeRuntimeBinding::Agent {
        model: crate::worker_catalog::ModelId::new("gpt-5.6").assert_value_with("model"),
        effort: Some(ReasoningEffort::Max),
        session_scope,
        env: BTreeSet::new(),
    };
    RuntimePlan::Codex {
        provider: CodexProvider::OpenAi,
        nodes: BTreeMap::from([
            (
                NodeName::new("worker").assert_value_with("node"),
                binding(SessionScope::Execution),
            ),
            (
                NodeName::new("left").assert_value_with("node"),
                binding(SessionScope::Execution),
            ),
            (
                NodeName::new("right").assert_value_with("node"),
                binding(SessionScope::Execution),
            ),
            (
                NodeName::new("loop_fresh").assert_value_with("node"),
                binding(SessionScope::Execution),
            ),
            (
                NodeName::new("loop_check").assert_value_with("node"),
                binding(SessionScope::NodeInstance),
            ),
        ]),
    }
}

pub(super) fn complex_request() -> CloudRunSubmission {
    let verifier = |name: &str| {
        json!({
            "kind": "verifier",
            "name": name,
            "worker": format!("agent.{name}@1"),
            "input": {"kind": "null"},
            "output": {"kind": "null"},
            "inputBindings": [],
            "writeBindings": [],
            "timeoutMs": 10000,
            "attempts": 1,
            "signals": {"verdict": ["accepted", "rejected"]},
            "diagnostic": {"kind": "null"}
        })
    };
    let graph = serde_json::from_value(json!({
        "profile": "openengine.graph.full/v1",
        "initialInput": {"kind": "null"},
        "policy": {"policy": "policy.native-v2@1", "default": "deny"},
        "root": {
            "kind": "seq",
            "name": "root",
            "state": {"kind": "null"},
            "children": [
                {
                    "kind": "step",
                    "name": "worker",
                    "worker": "agent.worker@1",
                    "input": {"kind": "null"},
                    "output": {"kind": "null"},
                    "inputBindings": [],
                    "writeBindings": [],
                    "timeoutMs": 10000,
                    "attempts": 1
                },
                {
                    "kind": "par",
                    "name": "parallel_verifiers",
                    "state": {"kind": "null"},
                    "branches": [verifier("left"), verifier("right")],
                    "join": {"kind": "all"},
                    "promotedStatePaths": []
                },
                {
                    "kind": "loop",
                    "name": "review_loop",
                    "state": {"kind": "null"},
                    "body": {
                        "kind": "seq",
                        "name": "loop_body",
                        "state": {"kind": "null"},
                        "children": [verifier("loop_fresh"), verifier("loop_check")],
                        "promotedStatePaths": []
                    },
                    "until": {
                        "kind": "in",
                        "value": {"name": "loop_check", "source": "signal", "field": "verdict"},
                        "labels": ["accepted"]
                    },
                    "maxIterations": 3,
                    "promotedStatePaths": []
                },
                {"kind": "succeed", "name": "done", "output": {"kind": "null"}, "bindings": []}
            ],
            "promotedStatePaths": []
        }
    }))
    .assert_value_with("complex graph");
    CloudRunSubmission {
        graph,
        initial_input: Value::Null,
        ship: false,
        submission_key: IdempotencyKey::new("cloud-complex").assert_value_with("submission key"),
    }
}

use openengine_cluster_testkit::assertions::{AssertValue};
