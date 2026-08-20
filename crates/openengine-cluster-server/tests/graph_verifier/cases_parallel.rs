use super::*;

#[tokio::test]
async fn every_parallel_join_and_group_control_domain_is_admitted() {
    for (join, field, label, verifier_branch) in [
        (json!({"kind":"any"}), "joined", "reached", false),
        (
            json!({"kind":"quorum","count":1}),
            "joined",
            "reached",
            false,
        ),
        (
            json!({
                "kind":"first",
                "when":{"kind":"in","value":{"name":"raceVerify","source":"signal","field":"verdict"},"labels":["accepted"]}
            }),
            "raced",
            "satisfied",
            true,
        ),
    ] {
        let left = work_node("left", "left");
        let mut right = work_node("right", "right");
        if verifier_branch {
            right = valid_graph()
                .assert_at("root")
                .assert_at("children")
                .assert_at(1)
                .clone();
            *right.assert_at_mut("name") = json!("raceVerify");
        }
        let otherwise =
            (field == "raced").then(|| json!({"kind":"fail","name":"failed","reason":"failed"}));
        let graph = graph_with_root_child(json!({
            "kind":"seq","name":"root","state":record(),"children":[
                {"kind":"par","name":"parallel","state":record(),"branches":[left,right],
                 "promotedStatePaths":[],"join":join},
                {"kind":"choice","name":"afterJoin","state":record(),"branches":[{
                    "when":{"kind":"in","value":{"name":"parallel","source":"group","field":field},"labels":[label]},
                    "node":{"kind":"succeed","name":"done","output":{"kind":"null"},"bindings":[]}
                 }],"otherwise":otherwise,
                 "promotedStatePaths":[]}
            ],"promotedStatePaths":[]
        }));
        assert_graph_accepted(&graph).await;
    }
}

fn quorum_flow_branch(name: &str, target: &str, state: &Value) -> Value {
    let writer = format!("{name}Writer");
    json!({
        "kind":"seq","name":name,"state":state.clone(),
        "children":[
            {
                "kind":"step","name":writer,"worker":"worker.main@1",
                "input":record(),
                "output":{"kind":"record","fields":{
                    "result":{"type":{"kind":"integer"},"required":true}
                }},
                "inputBindings":[
                    {"target":["value"],"value":{"source":"state","path":["value"]}}
                ],
                "writeBindings":[{
                    "value":{"node":writer,"channel":"out","path":["result"]},
                    "target":[target]
                }],
                "timeoutMs":1,"attempts":1
            },
            {
                "kind":"choice","name":format!("{name}Routed"),"state":state.clone(),
                "branches":[{
                    "when":{
                        "kind":"in",
                        "value":{"name":writer,"source":"error","field":null},
                        "labels":["timeout","crash","malformed","refusal"]
                    },
                    "node":{
                        "kind":"fail","name":format!("{name}Failed"),
                        "reason":"worker_failed"
                    }
                }],
                "otherwise":{
                    "kind":"step","name":format!("{name}Continuation"),
                    "worker":"worker.main@1","input":record(),
                    "output":{"kind":"record","fields":{
                        "result":{"type":{"kind":"integer"},"required":true}
                    }},
                    "inputBindings":[
                        {"target":["value"],"value":{"source":"state","path":["value"]}}
                    ],
                    "writeBindings":[],"timeoutMs":1,"attempts":1
                },
                "promotedStatePaths":[]
            }
        ],
        "promotedStatePaths":[[target]]
    })
}

fn quorum_flow_graph(count: u64) -> GraphSpec {
    let state = json!({
        "kind":"record",
        "fields":{
            "value":{"type":{"kind":"integer"},"required":true},
            "leftResult":{"type":{"kind":"integer"},"required":false},
            "rightResult":{"type":{"kind":"integer"},"required":false}
        }
    });
    graph_with_state_children(
        state.clone(),
        json!([
                {
                    "kind":"par","name":"parallel","state":state.clone(),
                    "branches":[
                        quorum_flow_branch("left","leftResult",&state),
                        quorum_flow_branch("right","rightResult",&state)
                    ],
                    "promotedStatePaths": [["leftResult"], ["rightResult"]],
                    "join": {"kind":"quorum","count":count}
                },
                {
                    "kind":"choice","name":"afterParallel","state":state,
                    "branches":[{
                        "when":{
                            "kind":"in",
                            "value":{"name":"parallel","source":"group","field":"joined"},
                            "labels":["reached"]
                        },
                        "node":{
                            "kind": "succeed", "name": "done",
                            "output": {
                                "kind": "record",
                                "fields": {
                                    "leftResult": { "type": { "kind": "integer" }, "required": true },
                                    "rightResult": { "type": { "kind": "integer" }, "required": true }
                                }
                            },
                            "bindings": [
                                {"target":["leftResult"],"value":{"source":"state","path":["leftResult"]}},
                                {"target":["rightResult"],"value":{"source":"state","path":["rightResult"]}}
                            ]
                        }
                    }],
                    "otherwise":{
                        "kind":"succeed","name":"parallelFailed",
                        "output":{"kind":"null"},"bindings":[]
                    },
                    "promotedStatePaths":[]
                }
        ]),
    )
}

#[tokio::test]
async fn quorum_promotion_and_flow_use_the_authored_completion_count() {
    let quorum_one = ProductionGraphVerifier::new(registry())
        .verify(&quorum_flow_graph(1))
        .await
        .assert_error();
    assert!(rejection_codes(quorum_one).contains(&GraphDiagnosticCode::UndefinedRead));

    ProductionGraphVerifier::new(registry())
        .verify(&quorum_flow_graph(2))
        .await
        .assert_value();
}

fn shared_quorum_flow_graph(count: u64) -> GraphSpec {
    let mut value = serde_json::to_value(quorum_flow_graph(2)).assert_value();
    let left = value
        .assert_at("root")
        .assert_at("children")
        .assert_at(0)
        .assert_at("branches")
        .assert_at(0)
        .clone();
    let third = quorum_flow_branch("third", "leftResult", left.assert_at("state"));
    let right = value
        .assert_at("root")
        .assert_at("children")
        .assert_at(0)
        .assert_at("branches")
        .assert_at(1)
        .clone();
    *value
        .assert_at_mut("root")
        .assert_at_mut("children")
        .assert_at_mut(0)
        .assert_at_mut("branches") = json!([left, right, third]);
    *value
        .assert_at_mut("root")
        .assert_at_mut("children")
        .assert_at_mut(0)
        .assert_at_mut("join")
        .assert_at_mut("count") = json!(count);
    *value
        .assert_at_mut("root")
        .assert_at_mut("children")
        .assert_at_mut(0)
        .assert_at_mut("promotedStatePaths") = json!([["leftResult"]]);
    *value
        .assert_at_mut("root")
        .assert_at_mut("children")
        .assert_at_mut(1)
        .assert_at_mut("branches")
        .assert_at_mut(0)
        .assert_at_mut("node")
        .assert_at_mut("output")
        .assert_at_mut("fields") = json!({
        "leftResult": { "type": { "kind": "integer" }, "required": true }
    });
    *value
        .assert_at_mut("root")
        .assert_at_mut("children")
        .assert_at_mut(1)
        .assert_at_mut("branches")
        .assert_at_mut(0)
        .assert_at_mut("node")
        .assert_at_mut("bindings") = json!([{
        "target":["leftResult"],"value":{"source":"state","path":["leftResult"]}
    }]);
    serde_json::from_value(value).assert_value()
}

#[tokio::test]
async fn quorum_effects_cover_every_size_count_completion_set() {
    let quorum_one = ProductionGraphVerifier::new(registry())
        .verify(&shared_quorum_flow_graph(1))
        .await
        .assert_error();
    assert!(rejection_codes(quorum_one).contains(&GraphDiagnosticCode::UndefinedRead));

    ProductionGraphVerifier::new(registry())
        .verify(&shared_quorum_flow_graph(2))
        .await
        .assert_value();
}

fn parallel_terminal_graph(join: Value) -> GraphSpec {
    let work = valid_graph()
        .assert_at("root")
        .assert_at("children")
        .assert_at(0)
        .clone();
    graph_with_root_child(json!({
        "kind":"seq", "name":"root", "state":record(), "children":[
            {
                "kind":"par", "name":"parallel", "state":record(),
                "branches":[
                    work,
                    {"kind":"succeed","name":"leftDone","output":{"kind":"null"},"bindings":[]},
                    {"kind":"succeed","name":"rightDone","output":{"kind":"null"},"bindings":[]}
                ],
                "promotedStatePaths":[], "join":join
            },
            {"kind":"succeed","name":"afterParallel","output":{"kind":"null"},"bindings":[]}
        ],
        "promotedStatePaths":[]
    }))
}

#[tokio::test]
async fn parallel_terminal_reachability_uses_the_join_completion_count() {
    ProductionGraphVerifier::new(registry())
        .verify(&parallel_terminal_graph(json!({"kind":"quorum","count":1})))
        .await
        .assert_value();

    for join in [json!({"kind":"quorum","count":2}), json!({"kind":"all"})] {
        let error = ProductionGraphVerifier::new(registry())
            .verify(&parallel_terminal_graph(join))
            .await
            .assert_error();
        let diagnostics = rejection_diagnostics(error);
        assert!(diagnostics.iter().any(|diagnostic| {
            diagnostic.code == GraphDiagnosticCode::Reachability
                && diagnostic
                    .related_nodes
                    .iter()
                    .any(|name| name.as_str() == "afterParallel")
        }));
    }
}

#[tokio::test]
async fn quorum_completion_sets_preserve_shared_guard_correlations() {
    let graph = graph_with_valid_tail_nodes(json!([{
        "kind":"par", "name":"correlatedQuorum", "state":record(),
        "branches":[
            conditional_quorum_branch(
                "acceptedBranch","accepted","acceptedWork","rejectedDone"
            ),
            conditional_quorum_branch(
                "rejectedBranch","rejected","rejectedWork","acceptedDone"
            )
        ],
        "promotedStatePaths":[],
        "join":{"kind":"quorum","count":2}
    }]));

    assert_graph_accepted(&graph).await;
}

fn conditional_quorum_branch(name: &str, label: &str, worker: &str, terminal: &str) -> Value {
    json!({
        "kind":"choice","name":name,"state":record(),
        "branches":[{
            "when":{
                "kind":"in",
                "value":{"name":"verify","source":"signal","field":"verdict"},
                "labels":[label]
            },
            "node":{
                "kind":"step","name":worker,"worker":"worker.main@1",
                "input":record(),
                "output":{"kind":"record","fields":{
                    "result":{"type":{"kind":"number"},"required":true}
                }},
                "inputBindings":[
                    {"target":["value"],"value":{"source":"state","path":["value"]}}
                ],
                "writeBindings":[],"timeoutMs":1,"attempts":1
            }
        }],
        "otherwise":{
            "kind":"succeed","name":terminal,"output":{"kind":"null"},"bindings":[]
        },
        "promotedStatePaths":[]
    })
}

#[path = "cases_parallel/correlated_flow.rs"]
mod correlated_flow;
