pub(crate) fn routed_writer(name: &str) -> Value {
    let route = format!("{name}Route");
    let failed = format!("{name}Failed");
    let continued = format!("{name}Continued");
    let writer = crate::test_support::integer_step(name, true);
    json!({
        "kind":"seq","name":format!("{name}Branch"),"state":record(),
        "children":[
            writer,
            {
                "kind":"choice","name":route,"state":record(),
                "branches":[{
                    "when":{
                        "kind":"in",
                        "value":{"name":name,"source":"error","field":null},
                        "labels":["timeout","crash","malformed","refusal"]
                    },
                    "node":{"kind":"fail","name":failed,"reason":"worker_failed"}
                }],
                "otherwise":{
                    "kind":"step","name":continued,"worker":"worker.main@1",
                    "input":record(),
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
        "promotedStatePaths":[["result"]]
    })
}

fn routed_non_writer(name: &str) -> Value {
    let mut branch = routed_writer(name);
    *branch
        .assert_at_mut("children")
        .assert_at_mut(0)
        .assert_at_mut("writeBindings") = json!([]);
    *branch.assert_at_mut("promotedStatePaths") = json!([]);
    branch
}

fn first_satisfier_branch() -> Value {
    json!({
        "kind":"seq","name":"firstSatisfier","state":record(),
        "children":[
            routed_writer("firstWork"),
            crate::test_support::verifier_node("leftVerify"),
            {
                "kind":"choice","name":"leftVerifyRoute","state":record(),
                "branches":[{
                    "when":{
                        "kind":"in",
                        "value":{"name":"leftVerify","source":"error","field":null},
                        "labels":["timeout","crash","malformed","refusal"]
                    },
                    "node":{
                        "kind":"fail","name":"leftVerifyFailed",
                        "reason":"verifier_failed"
                    }
                }],
                "otherwise":{
                    "kind":"step","name":"leftVerifyContinued",
                    "worker":"worker.main@1","input":record(),
                    "output":{"kind":"record","fields":{
                        "result":{"type":{"kind":"number"},"required":true}
                    }},
                    "inputBindings":[
                        {"target":["value"],"value":{"source":"state","path":["value"]}}
                    ],
                    "writeBindings":[],"timeoutMs":1,"attempts":1
                },
                "promotedStatePaths":[]
            }
        ],
        "promotedStatePaths":[["result"]]
    })
}

#[derive(Clone, Copy)]
struct JoinControl {
    field: &'static str,
    success: &'static str,
    failure: &'static str,
}

struct ParallelJoinCase {
    branches: Vec<Value>,
    join: Value,
    control: JoinControl,
}

fn parallel_join_case(join_kind: &str) -> ParallelJoinCase {
    match join_kind {
        "all" => Some(ParallelJoinCase {
            branches: vec![routed_writer("left"), routed_non_writer("right")],
            join: json!({"kind":"all"}),
            control: JoinControl {
                field: "joined",
                success: "reached",
                failure: "quorum_unreachable",
            },
        }),
        "any" => Some(ParallelJoinCase {
            branches: vec![routed_writer("left"), routed_writer("right")],
            join: json!({"kind":"any"}),
            control: JoinControl {
                field: "joined",
                success: "reached",
                failure: "quorum_unreachable",
            },
        }),
        "quorum" => Some(ParallelJoinCase {
            branches: vec![routed_writer("left"), routed_writer("right")],
            join: json!({"kind":"quorum","count":1}),
            control: JoinControl {
                field: "joined",
                success: "reached",
                failure: "quorum_unreachable",
            },
        }),
        "first" => Some(ParallelJoinCase {
            branches: vec![first_satisfier_branch(), routed_non_writer("right")],
            join: json!({
                "kind":"first",
                "when":{
                    "kind":"in",
                    "value":{"name":"leftVerify","source":"signal","field":"verdict"},
                    "labels":["accepted"]
                }
            }),
            control: JoinControl {
                field: "raced",
                success: "satisfied",
                failure: "no_satisfier",
            },
        }),
        _ => None,
    }
    .assert_value()
}

fn parallel_result_route(routed_label: Option<&str>, control: JoinControl) -> Value {
    let result = json!({
        "kind":"succeed","name":"readResult",
        "output":{"kind":"record","fields":{
            "result":{"type":{"kind":"number"},"required":true}
        }},
        "bindings":[{
            "target":["result"],
            "value":{"source":"state","path":["result"]}
        }]
    });
    routed_label.map_or_else(
        || result.clone(),
        |label| {
            let expected_label = if label == "success" {
                control.success
            } else {
                control.failure
            };
            json!({
                "kind":"choice","name":"afterParallel","state":record(),
                "branches":[{
                    "when":{
                        "kind":"in",
                        "value":{
                            "name":"parallel",
                            "source":"group",
                            "field":control.field
                        },
                        "labels":[expected_label]
                    },
                    "node":result
                }],
                "otherwise":{
                    "kind":"succeed","name":"otherOutcome",
                    "output":{"kind":"null"},"bindings":[]
                },
                "promotedStatePaths":[]
            })
        },
    )
}

fn parallel_promotion_graph(join_kind: &str, routed_label: Option<&str>) -> GraphSpec {
    let ParallelJoinCase {
        branches,
        join,
        control,
    } = parallel_join_case(join_kind);
    let successor = parallel_result_route(routed_label, control);
    graph_with_root_child(json!({
        "kind":"seq","name":"root","state":record(),
        "children":[
            {
                "kind":"par","name":"parallel","state":record(),
                "branches":branches,
                "promotedStatePaths":[["result"]],
                "join":join
            },
            successor
        ],
        "promotedStatePaths":[]
    }))
}

fn parallel_output_route(hidden: &str, routed_label: &str, control: JoinControl) -> Value {
    let expected_label = if routed_label == "success" {
        control.success
    } else {
        control.failure
    };
    json!({
        "kind":"choice","name":"afterParallelOutput","state":record(),
        "branches":[{
            "when":{
                "kind":"in",
                "value":{
                    "name":"parallelOutput",
                    "source":"group",
                    "field":control.field
                },
                "labels":[expected_label]
            },
            "node":{
                "kind":"seq","name":"consumeHiddenBranch","state":record(),
                "children":[
                    {
                        "kind":"step","name":"consumeHidden","worker":"worker.main@1",
                        "input":record(),
                        "output":{"kind":"record","fields":{
                            "result":{"type":{"kind":"integer"},"required":true}
                        }},
                        "inputBindings":[
                            {"target":["value"],"value":{"source":"state","path":["value"]}}
                        ],
                        "writeBindings":[{
                            "value":{"node":hidden,"channel":"out","path":["result"]},
                            "target":["result"]
                        }],
                        "timeoutMs":1,"attempts":1
                    },
                    {
                        "kind":"succeed","name":"consumedHidden",
                        "output":{"kind":"null"},"bindings":[]
                    }
                ],
                "promotedStatePaths":[]
            }
        }],
        "otherwise":{
            "kind":"succeed","name":"otherParallelOutput",
            "output":{"kind":"null"},"bindings":[]
        },
        "promotedStatePaths":[]
    })
}

fn parallel_output_graph(join_kind: &str, routed_label: &str) -> GraphSpec {
    let ParallelJoinCase {
        mut branches,
        join,
        control,
    } = parallel_join_case(join_kind);
    let hidden = if join_kind == "first" {
        "firstWork"
    } else {
        "left"
    };
    if matches!(join_kind, "any" | "quorum") {
        *branches.assert_at_mut(1) = json!({
            "kind":"fail","name":"nonCompletingBranch","reason":"does_not_complete"
        });
    }
    let successor = parallel_output_route(hidden, routed_label, control);
    graph_with_root_child(json!({
        "kind":"seq","name":"root","state":record(),
        "children":[
            {
                "kind":"par","name":"parallelOutput","state":record(),
                "branches":branches,
                "promotedStatePaths":[],
                "join":join
            },
            successor
        ],
        "promotedStatePaths":[]
    }))
}

#[tokio::test]
async fn every_parallel_join_refines_promotions_for_success_and_failure_controls() {
    for join in ["all", "any", "quorum", "first"] {
        ProductionGraphVerifier::new(registry())
            .verify(&parallel_promotion_graph(join, Some("success")))
            .await
            .assert_value();

        let failure = ProductionGraphVerifier::new(registry())
            .verify(&parallel_promotion_graph(join, Some("failure")))
            .await
            .assert_error();
        assert!(
            rejection_codes(failure).contains(&GraphDiagnosticCode::UndefinedRead),
            "{join} failure control exposed a success-only promotion"
        );

        let unguarded = ProductionGraphVerifier::new(registry())
            .verify(&parallel_promotion_graph(join, None))
            .await
            .assert_error();
        assert!(
            rejection_codes(unguarded).contains(&GraphDiagnosticCode::UndefinedRead),
            "{join} unguarded continuation exposed a success-only promotion"
        );
    }

    let mut prior =
        serde_json::to_value(parallel_promotion_graph("any", Some("failure"))).assert_value();
    *prior
        .assert_at_mut("initialInput")
        .assert_at_mut("fields")
        .assert_at_mut("result")
        .assert_at_mut("required") = json!(true);
    ProductionGraphVerifier::new(registry())
        .verify(&serde_json::from_value(prior).assert_value())
        .await
        .assert_value();
}

#[tokio::test]
async fn every_parallel_failure_control_hides_success_only_branch_outputs() {
    for join in ["all", "any", "quorum", "first"] {
        ProductionGraphVerifier::new(registry())
            .verify(&parallel_output_graph(join, "success"))
            .await
            .assert_value();

        let failure = ProductionGraphVerifier::new(registry())
            .verify(&parallel_output_graph(join, "failure"))
            .await
            .assert_error();
        assert!(
            rejection_codes(failure).contains(&GraphDiagnosticCode::UndefinedRead),
            "{join} failure control exposed a success-only branch output"
        );
    }
}
use super::*;
