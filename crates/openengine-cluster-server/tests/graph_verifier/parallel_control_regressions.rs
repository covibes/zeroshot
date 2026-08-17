use super::*;

#[tokio::test]
async fn first_join_rejects_a_dead_satisfied_control_for_an_unsatisfiable_predicate() {
    let verify = valid_graph()
        .assert_at("root")
        .assert_at("children")
        .assert_at(1)
        .clone();
    let work = valid_graph()
        .assert_at("root")
        .assert_at("children")
        .assert_at(0)
        .clone();
    let graph = graph_with_root_child(json!({
        "kind":"seq","name":"root","state":record(),
        "children":[
            {
                "kind":"par","name":"parallel","state":record(),
                "branches":[verify,work],
                "promotedStatePaths":[],
                "join":{
                    "kind":"first",
                    "when":{
                        "kind":"all",
                        "guards":[
                            {
                                "kind":"in",
                                "value":{
                                    "name":"verify",
                                    "source":"signal",
                                    "field":"verdict"
                                },
                                "labels":["accepted"]
                            },
                            {
                                "kind":"in",
                                "value":{
                                    "name":"verify",
                                    "source":"signal",
                                    "field":"verdict"
                                },
                                "labels":["rejected"]
                            }
                        ]
                    }
                }
            },
            {
                "kind":"choice","name":"route","state":record(),
                "branches":[{
                    "when":{
                        "kind":"in",
                        "value":{
                            "name":"parallel",
                            "source":"group",
                            "field":"raced"
                        },
                        "labels":["satisfied"]
                    },
                    "node":{
                        "kind":"succeed","name":"impossible",
                        "output":{"kind":"null"},"bindings":[]
                    }
                }],
                "otherwise":{
                    "kind":"succeed","name":"noSatisfier",
                    "output":{"kind":"null"},"bindings":[]
                },
                "promotedStatePaths":[]
            }
        ],
        "promotedStatePaths":[]
    }));

    let error = assert_graph_rejected(&graph).await;
    assert!(rejection_codes(error).contains(&GraphDiagnosticCode::ChoiceExhaustiveness));
}

fn renamed_verifier(name: &str) -> Value {
    let mut verifier = valid_graph()
        .assert_at("root")
        .assert_at("children")
        .assert_at(1)
        .clone();
    *verifier.assert_at_mut("name") = json!(name);
    verifier
}

fn right_completion_branch() -> Value {
    let mut right_work = valid_graph()
        .assert_at("root")
        .assert_at("children")
        .assert_at(0)
        .clone();
    *right_work.assert_at_mut("name") = json!("rightWork");
    *right_work.assert_at_mut("writeBindings") = json!([]);
    json!({
        "kind":"choice","name":"rightCompletion","state":record(),
        "branches":[{
            "when":{
                "kind":"in",
                "value":{
                    "name":"routeVerify",
                    "source":"signal",
                    "field":"verdict"
                },
                "labels":["accepted"]
            },
            "node":right_work
        }],
        "otherwise":{
            "kind":"fail","name":"rightIncomplete",
            "reason":"not_completed"
        },
        "promotedStatePaths":[]
    })
}

fn no_satisfier_route() -> Value {
    json!({
        "kind":"choice","name":"route","state":record(),
        "branches":[{
            "when":{
                "kind":"all",
                "guards":[
                    {
                        "kind":"in",
                        "value":{
                            "name":"parallel",
                            "source":"group",
                            "field":"raced"
                        },
                        "labels":["no_satisfier"]
                    },
                    {
                        "kind":"in",
                        "value":{
                            "name":"routeVerify",
                            "source":"signal",
                            "field":"verdict"
                        },
                        "labels":["rejected"]
                    }
                ]
            },
            "node":{
                "kind":"succeed","name":"impossible",
                "output":{"kind":"null"},"bindings":[]
            }
        }],
        "otherwise":{
            "kind":"succeed","name":"settled",
            "output":{"kind":"null"},"bindings":[]
        },
        "promotedStatePaths":[]
    })
}

fn first_no_satisfier_graph() -> GraphSpec {
    let verify = valid_graph()
        .assert_at("root")
        .assert_at("children")
        .assert_at(1)
        .clone();
    json_graph(json!({
        "kind":"seq","name":"root","state":record(),
        "children":[
            renamed_verifier("routeVerify"),
            {
                "kind":"par","name":"parallel","state":record(),
                "branches":[verify,right_completion_branch()],
                "promotedStatePaths":[],
                "join":{
                    "kind":"first",
                    "when":{
                        "kind":"in",
                        "value":{
                            "name":"verify",
                            "source":"signal",
                            "field":"verdict"
                        },
                        "labels":["accepted"]
                    }
                }
            },
            no_satisfier_route()
        ],
        "promotedStatePaths":[]
    }))
}

fn json_graph(root: Value) -> GraphSpec {
    graph_with_root_child(root)
}

#[tokio::test]
async fn first_join_rejects_no_satisfier_until_every_branch_completes() {
    let error = ProductionGraphVerifier::new(registry())
        .verify(&first_no_satisfier_graph())
        .await
        .assert_error();
    assert!(rejection_codes(error).contains(&GraphDiagnosticCode::ChoiceExhaustiveness));
}

fn controlled_signal_branch() -> Value {
    let mut branch_work = valid_graph()
        .assert_at("root")
        .assert_at("children")
        .assert_at(0)
        .clone();
    *branch_work.assert_at_mut("name") = json!("branchWork");
    *branch_work.assert_at_mut("writeBindings") = json!([]);
    json!({
        "kind":"seq","name":"controlledBranch","state":record(),
        "children":[
            renamed_verifier("branchVerify"),
            {
                "kind":"choice","name":"branchRoute","state":record(),
                "branches":[{
                    "when":{
                        "kind":"in",
                        "value":{
                            "name":"branchVerify",
                            "source":"signal",
                            "field":"verdict"
                        },
                        "labels":["accepted"]
                    },
                    "node":branch_work
                }],
                "otherwise":{
                    "kind":"fail","name":"branchFailed",
                    "reason":"branch_did_not_complete"
                },
                "promotedStatePaths":[]
            }
        ],
        "promotedStatePaths":[]
    })
}

fn joined_signal_route(joined_label: &str, signal_label: &str) -> Value {
    json!({
        "kind":"choice","name":"route","state":record(),
        "branches":[{
            "when":{
                "kind":"all",
                "guards":[
                    {
                        "kind":"in",
                        "value":{
                            "name":"parallel",
                            "source":"group",
                            "field":"joined"
                        },
                        "labels":[joined_label]
                    },
                    {
                        "kind":"in",
                        "value":{
                            "name":"branchVerify",
                            "source":"signal",
                            "field":"verdict"
                        },
                        "labels":[signal_label]
                    }
                ]
            },
            "node":{
                "kind":"succeed","name":"impossible",
                "output":{"kind":"null"},"bindings":[]
            }
        }],
        "otherwise":{
            "kind":"succeed","name":"settled",
            "output":{"kind":"null"},"bindings":[]
        },
        "promotedStatePaths":[]
    })
}

fn joined_control_with_branch_signal_graph(
    join: Value,
    joined_label: &str,
    signal_label: &str,
) -> GraphSpec {
    let other_branch = if join.assert_at("kind") == "all" {
        let mut work = valid_graph()
            .assert_at("root")
            .assert_at("children")
            .assert_at(0)
            .clone();
        *work.assert_at_mut("name") = json!("alwaysWork");
        *work.assert_at_mut("writeBindings") = json!([]);
        work
    } else {
        json!({
            "kind":"fail","name":"nonCompletingBranch",
            "reason":"does_not_complete"
        })
    };
    graph_with_root_child(json!({
        "kind":"seq","name":"root","state":record(),
        "children":[
            {
                "kind":"par","name":"parallel","state":record(),
                "branches":[controlled_signal_branch(),other_branch],
                "promotedStatePaths":[],
                "join":join
            },
            joined_signal_route(joined_label,signal_label)
        ],
        "promotedStatePaths":[]
    }))
}

#[tokio::test]
async fn joined_control_is_correlated_with_all_any_and_quorum_branch_completion() {
    for (name, join) in [
        ("all", json!({"kind":"all"})),
        ("any", json!({"kind":"any"})),
        ("quorum", json!({"kind":"quorum","count":1})),
    ] {
        for (joined_label, signal_label) in
            [("quorum_unreachable", "accepted"), ("reached", "rejected")]
        {
            let error = ProductionGraphVerifier::new(registry())
                .verify(&joined_control_with_branch_signal_graph(
                    join.clone(),
                    joined_label,
                    signal_label,
                ))
                .await
                .assert_error();
            assert!(
                rejection_codes(error).contains(&GraphDiagnosticCode::ChoiceExhaustiveness),
                "{name} admitted impossible joined={joined_label} with branch signal={signal_label}"
            );
        }
    }
}
