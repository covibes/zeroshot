use super::*;
pub(super) use crate::native_v2_candidate::test_support::success_node_named as succeed;

pub(super) async fn stored_run(ledger: &FakeRunLedger) -> StoredRun {
    ledger
        .get(&RunId::new("run-supervisor-test"))
        .await
        .assert_value_with("ledger")
        .assert_value_with("run")
}

pub(super) fn executable_names(root: &GraphNode) -> BTreeSet<String> {
    fn collect(node: &GraphNode, names: &mut BTreeSet<String>) {
        match node {
            GraphNode::Step(node) => {
                names.insert(node.name.as_str().to_owned());
            }
            GraphNode::Verifier(node) => {
                names.insert(node.name.as_str().to_owned());
            }
            GraphNode::Seq(node) => node
                .children
                .as_slice()
                .iter()
                .for_each(|child| collect(child, names)),
            GraphNode::Choice(node) => {
                node.branches
                    .as_slice()
                    .iter()
                    .for_each(|branch| collect(&branch.node, names));
                if let Some(otherwise) = &node.otherwise {
                    collect(otherwise, names);
                }
            }
            GraphNode::Par(node) => node
                .branches
                .as_slice()
                .iter()
                .for_each(|branch| collect(branch, names)),
            GraphNode::Loop(node) => collect(&node.body, names),
            GraphNode::Map(node) => collect(&node.body, names),
            GraphNode::Succeed(_) | GraphNode::Fail(_) => {}
        }
    }
    let mut names = BTreeSet::new();
    collect(root, &mut names);
    names
}

pub(super) fn graph(root: Value, initial_input: Value) -> GraphSpec {
    serde_json::from_value(json!({
        "profile": "openengine.graph.full/v1",
        "initialInput": initial_input,
        "policy": {"policy": "policy.native-v2@1", "default": "deny"},
        "root": root
    }))
    .assert_value_with("valid graph syntax")
}

pub(super) fn null_type() -> Value {
    json!({"kind": "null"})
}

pub(super) fn record_type() -> Value {
    json!({
        "kind": "record",
        "fields": {
            "items": {
                "required": true,
                "type": {"kind": "array", "items": {"kind": "string"}}
            }
        }
    })
}

pub(super) fn step(name: &str, timeout_ms: u64) -> Value {
    json!({
        "kind": "step",
        "name": name,
        "worker": format!("worker.{name}@1"),
        "instructions": format!("Execute the {name} worker."),
        "input": null_type(),
        "output": null_type(),
        "inputBindings": [],
        "writeBindings": [],
        "timeoutMs": timeout_ms,
        "attempts": 1
    })
}

pub(super) fn verifier(name: &str, timeout_ms: u64) -> Value {
    json!({
        "kind": "verifier",
        "name": name,
        "worker": format!("worker.{name}@1"),
        "instructions": format!("Execute the {name} verifier."),
        "input": null_type(),
        "output": null_type(),
        "inputBindings": [],
        "writeBindings": [],
        "timeoutMs": timeout_ms,
        "attempts": 1,
        "signals": {"verdict": ["accepted", "rejected"]},
        "diagnostic": null_type()
    })
}

pub(super) fn signal_guard(node: &str, label: &str) -> Value {
    json!({
        "kind": "in",
        "value": {"name": node, "source": "signal", "field": "verdict"},
        "labels": [label]
    })
}

pub(super) fn sequence(children: Vec<Value>, state: Value) -> Value {
    json!({
        "kind": "seq",
        "name": "root",
        "state": state,
        "children": children,
        "promotedStatePaths": []
    })
}

pub(super) fn parallel(join: Value, branches: Vec<Value>) -> GraphSpec {
    graph(
        sequence(
            vec![
                json!({
                    "kind": "par",
                    "name": "parallel",
                    "state": null_type(),
                    "branches": branches,
                    "join": join,
                    "promotedStatePaths": []
                }),
                succeed("done"),
            ],
            null_type(),
        ),
        null_type(),
    )
}

pub(super) fn all_constructs_graph() -> GraphSpec {
    let state = record_type();
    let root = sequence(
        vec![
            step("worker", 1_000),
            verifier("choose_gate", 1_000),
            json!({
                "kind": "choice",
                "name": "choice",
                "state": state,
                "branches": [{
                    "when": signal_guard("choose_gate", "accepted"),
                    "node": verifier("choice_work", 1_000)
                }],
                "otherwise": verifier("choice_other", 1_000),
                "promotedStatePaths": []
            }),
            json!({
                "kind": "par",
                "name": "all",
                "state": state,
                "branches": [verifier("left", 1_000), verifier("right", 1_000)],
                "join": {"kind": "all"},
                "promotedStatePaths": []
            }),
            json!({
                "kind": "loop",
                "name": "loop",
                "state": state,
                "body": verifier("loop_check", 1_000),
                "until": signal_guard("loop_check", "accepted"),
                "maxIterations": 3,
                "promotedStatePaths": []
            }),
            json!({
                "kind": "map",
                "name": "map",
                "state": state,
                "body": verifier("map_check", 1_000),
                "over": {"source": "state", "path": ["items"]},
                "maxItems": 4,
                "promotedStatePaths": []
            }),
            succeed("done"),
        ],
        state.clone(),
    );
    graph(root, state)
}

pub(super) fn all_constructs_driver() -> FakeDriver {
    FakeDriver::scripted([
        (
            "loop_check",
            vec![
                Behavior::Complete {
                    delay: Duration::ZERO,
                    outcome: verifier_outcome("rejected"),
                },
                Behavior::Complete {
                    delay: Duration::ZERO,
                    outcome: verifier_outcome("accepted"),
                },
            ],
        ),
        (
            "left",
            vec![Behavior::Complete {
                delay: Duration::from_millis(20),
                outcome: verifier_outcome("accepted"),
            }],
        ),
        (
            "right",
            vec![Behavior::Complete {
                delay: Duration::from_millis(5),
                outcome: verifier_outcome("accepted"),
            }],
        ),
    ])
}

use openengine_cluster_testkit::assertions::{AssertValue};
