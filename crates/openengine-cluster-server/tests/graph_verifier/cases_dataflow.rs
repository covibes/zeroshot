fn routed_work_graph(mut value: Value) -> GraphSpec {
    set_root_children(&mut value, |value| {
        json!([
            value.assert_at("root").assert_at("children").assert_at(0).clone(),
            {
                "kind":"choice", "name":"routeWork", "state":record(),
                "branches":[{
                    "when":{"kind":"in",
                        "value":{"name":"work","source":"error","field":null},
                        "labels":["timeout","crash","malformed","refusal"]},
                    "node":{"kind":"fail","name":"workFailed","reason":"worker_error"}
                }],
                "otherwise":{
                    "kind":"succeed", "name":"done",
                    "output":{"kind":"record","fields":{
                        "result":{"type":{"kind":"number"},"required":true}
                    }},
                    "bindings":[{"target":["result"],
                        "value":{"source":"state","path":["result"]}}]
                },
                "promotedStatePaths":[]
            }
        ])
    });
    serde_json::from_value(value).assert_value()
}

#[tokio::test]
async fn success_routing_makes_output_backed_writes_definite() {
    let graph = routed_work_graph(valid_graph());

    assert_graph_accepted(&graph).await;
}

#[tokio::test]
async fn required_initial_paths_survive_optional_group_state_widening() {
    let mut value = valid_graph();
    *value
        .assert_at_mut("root")
        .assert_at_mut("state")
        .assert_at_mut("fields")
        .assert_at_mut("value")
        .assert_at_mut("required") = json!(false);
    *value
        .assert_at_mut("root")
        .assert_at_mut("state")
        .assert_at_mut("fields")
        .assert_at_mut("value")
        .assert_at_mut("type") = json!({"kind":"number"});
    let graph: GraphSpec = serde_json::from_value(value).assert_value();

    assert_graph_accepted(&graph).await;
}

#[tokio::test]
async fn success_routing_does_not_define_an_optional_output_path() {
    let mut value = valid_graph();
    *value
        .assert_at_mut("root")
        .assert_at_mut("children")
        .assert_at_mut(0)
        .assert_at_mut("output")
        .assert_at_mut("fields")
        .assert_at_mut("result")
        .assert_at_mut("required") = json!(false);
    let graph = routed_work_graph(value);

    assert_graph_rejected_with(&graph, GraphDiagnosticCode::UndefinedRead).await;
}

#[tokio::test]
async fn writing_a_required_record_does_not_define_its_optional_descendant() {
    let mut value = valid_graph();
    let state = json!({
        "kind":"record","fields":{
            "value":{"type":{"kind":"integer"},"required":true},
            "stored":{"type":{"kind":"record","fields":{
                "maybe":{"type":{"kind":"number"},"required":false}
            }},"required":false}
        }
    });
    let output = json!({
        "kind":"record","fields":{
            "payload":{"type":{"kind":"record","fields":{
                "maybe":{"type":{"kind":"number"},"required":false}
            }},"required":true}
        }
    });
    *value.assert_at_mut("root").assert_at_mut("state") = state.clone();
    *value
        .assert_at_mut("root")
        .assert_at_mut("children")
        .assert_at_mut(0)
        .assert_at_mut("output") = output.clone();
    *value
        .assert_at_mut("root")
        .assert_at_mut("children")
        .assert_at_mut(0)
        .assert_at_mut("writeBindings") = json!([{
        "value":{"node":"work","channel":"out","path":["payload"]},
        "target":["stored"]
    }]);
    set_root_children(&mut value, |value| {
        json!([
            value.assert_at("root").assert_at("children").assert_at(0).clone(),
            {
                "kind":"choice", "name":"routeWork", "state":state,
                "branches":[{
                    "when":{"kind":"in",
                        "value":{"name":"work","source":"error","field":null},
                        "labels":["timeout","crash","malformed","refusal"]},
                    "node":{"kind":"fail","name":"workFailed","reason":"worker_error"}
                }],
                "otherwise":{
                    "kind":"succeed", "name":"done",
                    "output":{"kind":"record","fields":{
                        "maybe":{"type":{"kind":"number"},"required":true}
                    }},
                    "bindings":[{"target":["maybe"],
                        "value":{"source":"state","path":["stored","maybe"]}}]
                },
                "promotedStatePaths":[]
            }
        ])
    });
    let graph: GraphSpec = serde_json::from_value(value).assert_value();

    let mut worker = serde_json::to_value(descriptor("worker.main@1", false)).assert_value();
    *worker.assert_at_mut("contract").assert_at_mut("output") = output;
    let registry = MemoryRegistry {
        descriptors: Arc::new(BTreeMap::from([(
            WorkerRef::new("worker.main@1").assert_value(),
            serde_json::from_value(worker).assert_value(),
        )])),
        resolutions: Arc::new(AtomicUsize::new(0)),
    };
    let error = ProductionGraphVerifier::new(registry)
        .verify(&graph)
        .await
        .assert_error();

    assert!(rejection_codes(error).contains(&GraphDiagnosticCode::UndefinedRead));
}

#[tokio::test]
async fn success_routing_does_not_define_an_optional_diagnostic_path() {
    let mut value = valid_graph();
    *value
        .assert_at_mut("root")
        .assert_at_mut("children")
        .assert_at_mut(1)
        .assert_at_mut("diagnostic") = json!({
        "kind":"record","fields":{
            "code":{"type":{"kind":"number"},"required":false}
        }
    });
    *value
        .assert_at_mut("root")
        .assert_at_mut("children")
        .assert_at_mut(1)
        .assert_at_mut("writeBindings") = json!([{
        "value":{"node":"verify","channel":"diagnostic","path":["code"]},
        "target":["diagnostic"]
    }]);
    *value.assert_at_mut("root").assert_at_mut("children") = json!([
        value.assert_at("root").assert_at("children").assert_at(1).clone(),
        {
            "kind":"choice", "name":"routeVerify", "state":record(),
            "branches":[{
                "when":{"kind":"in",
                    "value":{"name":"verify","source":"error","field":null},
                    "labels":["timeout","crash","malformed","refusal"]},
                "node":{"kind":"fail","name":"verifyFailed","reason":"worker_error"}
            }],
            "otherwise":{
                "kind":"succeed", "name":"done",
                "output":{"kind":"record","fields":{
                    "diagnostic":{"type":{"kind":"number"},"required":true}
                }},
                "bindings":[{"target":["diagnostic"],
                    "value":{"source":"state","path":["diagnostic"]}}]
            },
            "promotedStatePaths":[]
        }
    ]);
    let graph: GraphSpec = serde_json::from_value(value).assert_value();

    let error = assert_graph_rejected(&graph).await;

    assert!(rejection_codes(error).contains(&GraphDiagnosticCode::UndefinedRead));
}

#[tokio::test]
async fn output_backed_promotions_require_success_guarantees() {
    let graph = graph_with_root_child(json!({
        "kind":"seq","name":"root","state":record(),"children":[
            {"kind":"seq","name":"promoteWork","state":record(),
             "children":[valid_graph().assert_at("root").assert_at("children").assert_at(0).clone()],
             "promotedStatePaths":[["result"]]},
            {"kind":"succeed","name":"done","output":{"kind":"null"},"bindings":[]}
        ],"promotedStatePaths":[]
    }));
    let error = assert_graph_rejected(&graph).await;

    assert!(rejection_codes(error).contains(&GraphDiagnosticCode::UndefinedRead));
}

fn number_result_registry() -> MemoryRegistry {
    let mut value = serde_json::to_value(descriptor("worker.main@1", false)).assert_value();
    *value
        .assert_at_mut("contract")
        .assert_at_mut("output")
        .assert_at_mut("fields")
        .assert_at_mut("result")
        .assert_at_mut("type") = json!({"kind":"number"});
    MemoryRegistry {
        descriptors: Arc::new(BTreeMap::from([(
            WorkerRef::new("worker.main@1").assert_value(),
            serde_json::from_value(value).assert_value(),
        )])),
        resolutions: Arc::new(AtomicUsize::new(0)),
    }
}

fn assert_incompatible_promotion(error: VerificationError) {
    let diagnostics = rejection_diagnostics(error);
    assert!(
        diagnostics.iter().any(|diagnostic| {
            diagnostic.code == GraphDiagnosticCode::SchemaSafety
                && diagnostic.message
                    == "promoted value is not a subtype of its enclosing state target"
                && serde_json::to_value(&diagnostic.path).assert_value()
                    == json!([
                        {"kind":"field","name":"root"},
                        {"kind":"node","name":"root"},
                        {"kind":"field","name":"children"},
                        {"kind":"index","index":0},
                        {"kind":"node","name":"promoteNumber"},
                        {"kind":"field","name":"promotedStatePaths"},
                        {"kind":"index","index":0}
                    ])
        }),
        "unexpected diagnostics: {diagnostics:#?}"
    );
}

#[tokio::test]
async fn promoted_writes_must_be_subtypes_of_the_enclosing_state() {
    let enclosing_state = json!({
        "kind":"record","fields":{
            "value":{"type":{"kind":"integer"},"required":true},
            "result":{"type":{"kind":"integer"},"required":true}
        }
    });
    let child_state = json!({
        "kind":"record","fields":{
            "value":{"type":{"kind":"integer"},"required":true},
            "result":{"type":{"kind":"number"},"required":true}
        }
    });
    let graph: GraphSpec = serde_json::from_value(json!({
        "profile":"openengine.graph.full/v1",
        "initialInput":enclosing_state,
        "policy":{"policy":"policy.strict@1","default":"deny"},
        "root":{
            "kind":"seq","name":"root","state":enclosing_state,"children":[
                {"kind":"seq","name":"promoteNumber","state":child_state,"children":[
                    {"kind":"step","name":"numberWork","worker":"worker.main@1",
                     "input":child_state,
                     "output":{"kind":"record","fields":{
                         "result":{"type":{"kind":"number"},"required":true}
                     }},
                     "inputBindings":[
                         {"target":["value"],"value":{"source":"state","path":["value"]}},
                         {"target":["result"],"value":{"source":"state","path":["result"]}}
                     ],
                     "writeBindings":[{
                         "value":{"node":"numberWork","channel":"out","path":["result"]},
                         "target":["result"]
                     }],
                     "timeoutMs":1,"attempts":1}
                ],"promotedStatePaths":[["result"]]},
                {"kind":"choice","name":"routeNumberWork","state":enclosing_state,
                 "branches":[{
                     "when":{"kind":"in",
                         "value":{"name":"numberWork","source":"error","field":null},
                         "labels":["timeout","crash","malformed","refusal"]},
                     "node":{"kind":"fail","name":"numberWorkFailed","reason":"worker_error"}
                 }],
                 "otherwise":{"kind":"succeed","name":"done",
                     "output":{"kind":"record","fields":{
                         "result":{"type":{"kind":"integer"},"required":true}
                     }},
                     "bindings":[{
                         "target":["result"],"value":{"source":"state","path":["result"]}
                     }]},
                 "promotedStatePaths":[]}
            ],"promotedStatePaths":[]
        }
    }))
    .assert_value();
    let error = ProductionGraphVerifier::new(number_result_registry())
        .verify(&graph)
        .await
        .assert_error();
    assert_incompatible_promotion(error);

    let mut safe_graph = serde_json::to_value(&graph).assert_value();
    *safe_graph
        .assert_at_mut("root")
        .assert_at_mut("children")
        .assert_at_mut(0)
        .assert_at_mut("children")
        .assert_at_mut(0)
        .assert_at_mut("output")
        .assert_at_mut("fields")
        .assert_at_mut("result")
        .assert_at_mut("type") = json!({"kind":"integer"});
    let safe_graph: GraphSpec = serde_json::from_value(safe_graph).assert_value();
    assert_graph_accepted(&safe_graph).await;
}

#[tokio::test]
async fn k_guards_reject_labels_outside_every_closed_selector_domain() {
    for guard in [
        json!({"kind":"k_of_n","count":1,"values":[
            {"name":"verify","source":"signal","field":"verdict"},
            {"name":"verify","source":"error","field":null}
        ],"labels":["accepted","timeout","bogus"]}),
        json!({"kind":"k_of_map","count":1,
            "value":{"name":"mapVerify","source":"signal","field":"verdict"},
            "labels":["accepted","bogus"]}),
    ] {
        let graph = if guard.assert_at("kind") == "k_of_n" {
            let mut value = valid_graph();
            *value
                .assert_at_mut("root")
                .assert_at_mut("children")
                .assert_at_mut(2)
                .assert_at_mut("branches")
                .assert_at_mut(0)
                .assert_at_mut("when") = guard;
            serde_json::from_value(value).assert_value()
        } else {
            map_choice_graph(1, guard)
        };
        let error = assert_graph_rejected(&graph).await;
        assert!(rejection_codes(error).contains(&GraphDiagnosticCode::ChoiceExhaustiveness));
    }
}

#[tokio::test]
async fn single_map_item_cannot_have_success_and_error_outcomes() {
    let guard = json!({"kind":"all","guards":[
        {"kind":"k_of_map","count":1,
            "value":{"name":"mapVerify","source":"signal","field":"verdict"},"labels":["accepted"]},
        {"kind":"k_of_map","count":1,
            "value":{"name":"mapVerify","source":"error","field":null},"labels":["timeout"]}
    ]});
    let graph = map_choice_graph(1, guard);
    let error = assert_graph_rejected(&graph).await;
    assert!(rejection_codes(error).contains(&GraphDiagnosticCode::ChoiceExhaustiveness));
}

fn map_choice_graph(max_items: u64, guard: Value) -> GraphSpec {
    map_control_graph(
        max_items,
        json!([{
            "when":guard,
            "node":{
                "kind":"succeed","name":"selected",
                "output":{"kind":"null"},"bindings":[]
            }
        }]),
        json!({"kind":"fail","name":"failed","reason":"failed"}),
    )
}
use super::*;
