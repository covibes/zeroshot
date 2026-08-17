use super::*;

fn typed_routed_writer(name: &str, result_type: Value) -> Value {
    let mut branch = super::regressions::routed_writer(name);
    *branch
        .assert_at_mut("children")
        .assert_at_mut(0)
        .assert_at_mut("output")
        .assert_at_mut("fields")
        .assert_at_mut("result")
        .assert_at_mut("type") = result_type;
    branch
}

fn parallel_node(name: &str, prefix: &str, result_type: Value) -> Value {
    json!({
        "kind":"par","name":name,"state":record(),
        "branches":[
            typed_routed_writer(&format!("{prefix}Left"),result_type.clone()),
            typed_routed_writer(&format!("{prefix}Right"),result_type)
        ],
        "promotedStatePaths":[["result"]],
        "join":{"kind":"any"}
    })
}

fn sequential_parallel_graph(
    guard: Value,
    terminal_type: Value,
    initial_required: bool,
) -> GraphSpec {
    let selected = json!({
        "kind":"succeed","name":"selected",
        "output":{"kind":"record","fields":{
            "result":{"type":terminal_type,"required":true}
        }},
        "bindings":[{
            "target":["result"],
            "value":{"source":"state","path":["result"]}
        }]
    });
    let graph = graph_with_root_child(json!({
        "kind":"seq","name":"root","state":record(),
        "children":[
            parallel_node("zFirst","z",json!({"kind":"integer"})),
            parallel_node("aSecond","a",json!({"kind":"number"})),
            {
                "kind":"choice","name":"route","state":record(),
                "branches":[{"when":guard,"node":selected}],
                "otherwise":{
                    "kind":"succeed","name":"other",
                    "output":{"kind":"null"},"bindings":[]
                },
                "promotedStatePaths":[]
            }
        ],
        "promotedStatePaths":[]
    }));
    let mut graph = serde_json::to_value(graph).assert_value();
    *graph
        .assert_at_mut("initialInput")
        .assert_at_mut("fields")
        .assert_at_mut("result")
        .assert_at_mut("required") = json!(initial_required);
    serde_json::from_value(graph).assert_value()
}

fn failed(name: &str) -> Value {
    json!({
        "kind":"in",
        "value":{"name":name,"source":"group","field":"joined"},
        "labels":["quorum_unreachable"]
    })
}

fn multi_result_state() -> Value {
    json!({
        "kind":"record",
        "fields":{
            "value":{"type":{"kind":"integer"},"required":true},
            "left":{"type":{"kind":"number"},"required":false},
            "right":{"type":{"kind":"number"},"required":false}
        }
    })
}

fn routed_target_writer(name: &str, target: &str) -> Value {
    let state = multi_result_state();
    let mut writer = super::regressions::routed_writer(name);
    *writer.assert_at_mut("state") = state.clone();
    *writer
        .assert_at_mut("children")
        .assert_at_mut(0)
        .assert_at_mut("writeBindings")
        .assert_at_mut(0)
        .assert_at_mut("target") = json!([target]);
    *writer
        .assert_at_mut("children")
        .assert_at_mut(1)
        .assert_at_mut("state") = state;
    *writer.assert_at_mut("promotedStatePaths") = json!([[target]]);
    writer
}

fn number_target_writer(name: &str, target: &str) -> Value {
    let mut writer = routed_target_writer(name, target);
    *writer
        .assert_at_mut("children")
        .assert_at_mut(0)
        .assert_at_mut("output")
        .assert_at_mut("fields")
        .assert_at_mut("result")
        .assert_at_mut("type") = json!({"kind":"number"});
    writer
}

fn target_granular_dominance_graph(read_target: &str) -> GraphSpec {
    let state = multi_result_state();
    let first_left = number_target_writer("firstLeft", "left");
    let first_right = number_target_writer("firstRight", "right");
    let later_writer = number_target_writer("laterWriter", "left");
    let read = json!({
        "kind":"succeed","name":"readAfterFailure",
        "output":{
            "kind":"record",
            "fields":{
                "result":{"type":{"kind":"number"},"required":true}
            }
        },
        "bindings":[{
            "target":["result"],
            "value":{"source":"state","path":[read_target]}
        }]
    });
    graph_with_state_children(
        state.clone(),
        json!([
                {
                    "kind":"par","name":"firstParallel","state":state,
                    "branches":[first_left,first_right],
                    "promotedStatePaths":[["left"],["right"]],
                    "join":{"kind":"all"}
                },
                later_writer,
                {
                    "kind":"choice","name":"afterFailure","state":state,
                    "branches":[{
                        "when":failed("firstParallel"),
                        "node":read
                    }],
                    "otherwise":{
                        "kind":"succeed","name":"other",
                        "output":{"kind":"null"},"bindings":[]
                    },
                    "promotedStatePaths":[]
                }
        ]),
    )
}

fn dominance_read(read_target: &str) -> Value {
    json!({
        "kind":"succeed","name":"readAfterChoice",
        "output":{
            "kind":"record",
            "fields":{"result":{"type":{"kind":"number"},"required":true}}
        },
        "bindings":[{
            "target":["result"],
            "value":{"source":"state","path":[read_target]}
        }]
    })
}

fn choice_dominance_graph(read_target: &str) -> GraphSpec {
    let state = multi_result_state();
    let first_left = number_target_writer("firstLeft", "left");
    let first_right = number_target_writer("firstRight", "right");
    let accepted = routed_target_writer("acceptedWriter", "left");
    let rejected = routed_target_writer("rejectedWriter", "left");
    let read = dominance_read(read_target);
    graph_with_state_children(
        state.clone(),
        json!([
                {
                    "kind":"par","name":"firstParallel","state":state,
                    "branches":[first_left,first_right],
                    "promotedStatePaths":[["left"],["right"]],
                    "join":{"kind":"all"}
                },
                {
                    "kind":"verifier","name":"routeVerifier","worker":"worker.verify@1",
                    "input":{"kind":"null"},
                    "output":{"kind":"record","fields":{}},
                    "inputBindings":[],"writeBindings":[],
                    "timeoutMs":1,"attempts":1,
                    "signals":{"verdict":["accepted","rejected"]},
                    "diagnostic":{"kind":"record","fields":{}}
                },
                {
                    "kind":"choice","name":"choiceWriters","state":state,
                    "branches":[{
                        "when":{
                            "kind":"in",
                            "value":{
                                "name":"routeVerifier",
                                "source":"signal",
                                "field":"verdict"
                            },
                            "labels":["accepted"]
                        },
                        "node":accepted
                    }],
                    "otherwise":rejected,
                    "promotedStatePaths":[["left"]]
                },
                {
                    "kind":"choice","name":"afterFailure","state":state,
                    "branches":[{
                        "when":failed("firstParallel"),
                        "node":read
                    }],
                    "otherwise":{
                        "kind":"succeed","name":"other",
                        "output":{"kind":"null"},"bindings":[]
                    },
                    "promotedStatePaths":[]
                }
        ]),
    )
}

fn nested_parallel_graph(read_on_inner_failure: bool) -> GraphSpec {
    let state = record();
    let inner = json!({
        "kind":"par","name":"innerParallel","state":state,
        "branches":[
            super::regressions::routed_writer("innerLeft"),
            super::regressions::routed_writer("innerRight")
        ],
        "promotedStatePaths":[["result"]],
        "join":{"kind":"any"}
    });
    let inner_label = if read_on_inner_failure {
        "quorum_unreachable"
    } else {
        "reached"
    };
    let read = json!({
        "kind":"succeed","name":"readNestedResult",
        "output":{
            "kind":"record",
            "fields":{"result":{"type":{"kind":"number"},"required":true}}
        },
        "bindings":[{
            "target":["result"],
            "value":{"source":"state","path":["result"]}
        }]
    });
    graph_with_root_child(json!({
        "kind":"seq","name":"root","state":state,
        "children":[
            {
                "kind":"par","name":"outerParallel","state":state,
                "branches":[inner],
                "promotedStatePaths":[["result"]],
                "join":{"kind":"all"}
            },
            {
                "kind":"choice","name":"nestedRoute","state":state,
                "branches":[{
                    "when":{
                        "kind":"all",
                        "guards":[
                            {
                                "kind":"in",
                                "value":{
                                    "name":"innerParallel",
                                    "source":"group",
                                    "field":"joined"
                                },
                                "labels":[inner_label]
                            },
                            {
                                "kind":"in",
                                "value":{
                                    "name":"outerParallel",
                                    "source":"group",
                                    "field":"joined"
                                },
                                "labels":["reached"]
                            }
                        ]
                    },
                    "node":read
                }],
                "otherwise":{
                    "kind":"succeed","name":"nestedOther",
                    "output":{"kind":"null"},"bindings":[]
                },
                "promotedStatePaths":[]
            }
        ],
        "promotedStatePaths":[]
    }))
}

#[tokio::test]
async fn sequential_parallel_restoration_uses_authored_order_not_node_name_order() {
    let graph = sequential_parallel_graph(
        json!({
            "kind":"all",
            "guards":[
                failed("zFirst"),
                {
                    "kind":"in",
                    "value":{"name":"aSecond","source":"group","field":"joined"},
                    "labels":["reached"]
                }
            ]
        }),
        json!({"kind":"number"}),
        false,
    );
    assert_graph_accepted(&graph).await;
}

#[tokio::test]
async fn multiple_parallel_failures_restore_the_original_definition() {
    let graph = sequential_parallel_graph(
        json!({"kind":"all","guards":[failed("zFirst"),failed("aSecond")]}),
        json!({"kind":"integer"}),
        true,
    );
    let error = assert_graph_rejected(&graph).await;
    assert!(rejection_codes(error).contains(&GraphDiagnosticCode::SchemaSafety));
}

#[tokio::test]
async fn later_writer_dominates_only_its_target_from_a_conditional_parallel_write() {
    ProductionGraphVerifier::new(registry())
        .verify(&target_granular_dominance_graph("left"))
        .await
        .assert_value();

    let error = ProductionGraphVerifier::new(registry())
        .verify(&target_granular_dominance_graph("right"))
        .await
        .assert_error();
    assert!(rejection_codes(error).contains(&GraphDiagnosticCode::UndefinedRead));
}

#[tokio::test]
async fn choice_merged_writers_dominate_only_their_common_target() {
    ProductionGraphVerifier::new(registry())
        .verify(&choice_dominance_graph("left"))
        .await
        .assert_value();

    let error = ProductionGraphVerifier::new(registry())
        .verify(&choice_dominance_graph("right"))
        .await
        .assert_error();
    assert!(rejection_codes(error).contains(&GraphDiagnosticCode::UndefinedRead));
}

#[tokio::test]
async fn nested_parallel_merges_preserve_inner_conditional_ownership() {
    ProductionGraphVerifier::new(registry())
        .verify(&nested_parallel_graph(false))
        .await
        .assert_value();

    let error = ProductionGraphVerifier::new(registry())
        .verify(&nested_parallel_graph(true))
        .await
        .assert_error();
    assert!(rejection_codes(error).contains(&GraphDiagnosticCode::ChoiceExhaustiveness));
}
