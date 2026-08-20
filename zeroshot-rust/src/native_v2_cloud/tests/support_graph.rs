use super::*;

pub(super) fn runtime() -> RuntimePlan {
    RuntimePlan::Codex {
        provider: CodexProvider::OpenAi,
        size: RunSize::Small,
        nodes: BTreeMap::from([
            (
                NodeName::new("worker").assert_value_with("node"),
                NodeRuntimeBinding::Agent {
                    model: crate::worker_catalog::ModelId::new("gpt-5.6")
                        .assert_value_with("model"),
                    effort: Some(ReasoningEffort::Max),
                    session_scope: SessionScope::Execution,
                    env: DeclaredEnvironment::new([EnvironmentVariableName::new("NODE_TOKEN")
                        .assert_value_with("environment name")])
                    .assert_value_with("declared environment"),
                },
            ),
            (
                NodeName::new("deliver").assert_value_with("node"),
                NodeRuntimeBinding::GitDelivery {
                    env: DeclaredEnvironment::empty(),
                },
            ),
        ]),
    }
}

pub(super) fn request(input: Value) -> RunSubmitParams {
    request_with_key(input, "cloud-test")
}

pub(super) fn request_with_key(input: Value, submission_key: &str) -> RunSubmitParams {
    RunSubmitParams {
        run_id: RunId::new(format!("run-{submission_key}")),
        submission: RunSubmission {
            title: RunTitle::new("Cloud test run").assert_value_with("title"),
            graph: graph(),
            initial_input: valid_input_or(input),
            runtime: runtime(),
            source: source(),
            submission_key: IdempotencyKey::new(submission_key).assert_value_with("submission key"),
        },
    }
}

pub(super) fn source() -> ResolvedSource {
    ResolvedSource {
        repository: SourceRepositoryId::new("owner/repo").assert_value_with("repository"),
        branch: SourceBranchId::new("main").assert_value_with("branch"),
        revision: SourceRevisionId::new("1111111111111111111111111111111111111111")
            .assert_value_with("revision"),
    }
}

fn delivery_node() -> Value {
    let output = serde_json::to_value(
        crate::native_v2_delivery::delivery_result_schema(
            crate::native_v2_delivery::DeliveryMode::PullRequest,
        )
        .assert_value_with("delivery result schema"),
    )
    .assert_value_with("delivery output schema");
    let labels = serde_json::to_value(
        crate::native_v2_delivery::delivery_signal_labels(
            crate::native_v2_delivery::DeliveryMode::PullRequest,
        )
        .assert_value_with("delivery signal labels"),
    )
    .assert_value_with("delivery labels");
    json!({
        "kind": "verifier",
        "name": "deliver",
        "worker": GIT_DELIVERY_PR_WORKER_REF,
        "input": {"kind": "null"},
        "output": output,
        "inputBindings": [],
        "writeBindings": delivery_write_bindings(),
        "timeoutMs": 10000,
        "attempts": 1,
        "signals": {"delivery": labels},
        "diagnostic": {
            "kind":"record","fields":{
                "message":{"type":{"kind":"string"},"required":true}
            }
        }
    })
}

fn delivery_fields() -> [&'static str; 7] {
    [
        "version",
        "mode",
        "outcome",
        "repository",
        "targetBranch",
        "headRevision",
        "pullRequestId",
    ]
}

fn delivery_write_bindings() -> Vec<Value> {
    delivery_fields()
        .into_iter()
        .map(|field| {
            json!({
                "value": {"node": "deliver", "channel": "out", "path": [field]},
                "target": [field]
            })
        })
        .collect()
}

fn delivery_terminal_bindings() -> Vec<Value> {
    delivery_fields()
        .into_iter()
        .map(|field| json!({"target": [field], "value": {"source": "state", "path": [field]}}))
        .collect()
}

fn delivery_state_schema() -> Value {
    serde_json::to_value(
        crate::native_v2_delivery::delivery_result_schema(
            crate::native_v2_delivery::DeliveryMode::PullRequest,
        )
        .assert_value_with("delivery result schema"),
    )
    .assert_value_with("delivery state schema")
}

fn valid_input_or(input: Value) -> Value {
    if !input.is_null() {
        return input;
    }
    json!({
        "version": "v1",
        "mode": "pr",
        "outcome": "opened",
        "repository": "owner/repo",
        "targetBranch": "main",
        "headRevision": "1111111111111111111111111111111111111111",
        "pullRequestId": "pending"
    })
}

pub(super) fn graph() -> GraphSpec {
    graph_with_nodes(vec![worker_node(), delivery_node()])
}

fn worker_node() -> Value {
    json!({
        "kind": "step",
        "name": "worker",
        "worker": "agent.worker@1",
        "instructions": "Implement the cloud test change.",
        "input": {"kind": "null"},
        "output": {"kind": "null"},
        "inputBindings": [],
        "writeBindings": [],
        "timeoutMs": 10000,
        "attempts": 1
    })
}

fn graph_with_nodes(mut children: Vec<Value>) -> GraphSpec {
    let state = delivery_state_schema();
    let bindings = delivery_terminal_bindings();
    children.push(json!({
        "kind": "succeed",
        "name": "done",
        "output": state,
        "bindings": bindings
    }));
    serde_json::from_value(json!({
        "profile": "openengine.graph.full/v1",
        "initialInput": state,
        "policy": {"policy": "policy.native-v2@1", "default": "deny"},
        "root": {
            "kind": "seq",
            "name": "root",
            "state": state,
            "children": children,
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
        env: DeclaredEnvironment::empty(),
    };
    RuntimePlan::Codex {
        provider: CodexProvider::OpenAi,
        size: RunSize::Small,
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
            (
                NodeName::new("deliver").assert_value_with("node"),
                NodeRuntimeBinding::GitDelivery {
                    env: DeclaredEnvironment::empty(),
                },
            ),
        ]),
    }
}

fn complex_verifier_node(name: &str) -> Value {
    json!({
        "kind": "verifier",
        "name": name,
        "worker": format!("agent.{name}@1"),
        "instructions": format!("Verify the {name} result."),
        "input": {"kind": "null"},
        "output": {"kind": "null"},
        "inputBindings": [],
        "writeBindings": [],
        "timeoutMs": 10000,
        "attempts": 1,
        "signals": {"verdict": ["accepted", "rejected"]},
        "diagnostic": {"kind": "null"}
    })
}

fn complex_graph() -> GraphSpec {
    let state = delivery_state_schema();
    graph_with_nodes(vec![
        worker_node(),
        json!({
            "kind": "par",
            "name": "parallel_verifiers",
            "state": state,
            "branches": [complex_verifier_node("left"), complex_verifier_node("right")],
            "join": {"kind": "all"},
            "promotedStatePaths": []
        }),
        json!({
            "kind": "loop",
            "name": "review_loop",
            "state": state,
            "body": {
                "kind": "seq",
                "name": "loop_body",
                "state": state,
                "children": [
                    complex_verifier_node("loop_fresh"),
                    complex_verifier_node("loop_check")
                ],
                "promotedStatePaths": []
            },
            "until": {
                "kind": "in",
                "value": {"name": "loop_check", "source": "signal", "field": "verdict"},
                "labels": ["accepted"]
            },
            "maxIterations": 3,
            "promotedStatePaths": []
        }),
        delivery_node(),
    ])
}

pub(super) fn complex_request() -> RunSubmitParams {
    RunSubmitParams {
        run_id: RunId::new("run-cloud-complex"),
        submission: RunSubmission {
            title: RunTitle::new("Complex cloud test").assert_value_with("title"),
            graph: complex_graph(),
            initial_input: valid_input_or(Value::Null),
            runtime: complex_runtime(),
            source: source(),
            submission_key: IdempotencyKey::new("cloud-complex")
                .assert_value_with("submission key"),
        },
    }
}

use openengine_cluster_testkit::assertions::AssertValue;
