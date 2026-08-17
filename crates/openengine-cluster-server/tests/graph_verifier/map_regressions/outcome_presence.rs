use super::*;

fn outcome_state() -> Value {
    json!({
        "kind":"record",
        "fields":{
            "items":{
                "type":{"kind":"array","items":{"kind":"null"}},
                "required":true
            }
        }
    })
}

fn mapped_signal(name: &str, labels: Value) -> Value {
    json!({
        "kind":"k_of_map","count":1,
        "value":{"name":name,"source":"signal","field":"verdict"},
        "labels":labels
    })
}

fn mapped_error(name: &str) -> Value {
    json!({
        "kind":"k_of_map","count":1,
        "value":{"name":name,"source":"error","field":null},
        "labels":["timeout","crash","malformed","refusal"]
    })
}

fn mapped_successor_body(state: &Value, conditional: bool) -> Value {
    if conditional {
        json!({
            "kind":"seq","name":"mappedSequence","state":state,
            "children":[
                map_verifier("firstVerify"),
                {
                    "kind":"choice","name":"mappedRoute","state":state.clone(),
                    "branches":[{
                        "when":{
                            "kind":"in",
                            "value":{
                                "name":"firstVerify",
                                "source":"signal",
                                "field":"verdict"
                            },
                            "labels":["accepted"]
                        },
                        "node":map_verifier("secondVerify")
                    }],
                    "otherwise":{
                        "kind":"fail","name":"firstRejected","reason":"first_rejected"
                    },
                    "promotedStatePaths":[]
                }
            ],
            "promotedStatePaths":[]
        })
    } else {
        json!({
            "kind":"seq","name":"mappedSequence","state":state,
            "children":[map_verifier("firstVerify"),map_verifier("secondVerify")],
            "promotedStatePaths":[]
        })
    }
}

fn mapped_missing_successor_outcome_graph(conditional: bool) -> GraphSpec {
    let state = outcome_state();
    let body = mapped_successor_body(&state, conditional);
    graph_with_state_children(
        state.clone(),
        json!([
            {
                "kind":"map","name":"map","state":state.clone(),
                "over":{"source":"state","path":["items"]},"maxItems":1,
                "body":body,
                "promotedStatePaths":[]
            },
            {
                "kind":"choice","name":"afterMap","state":state,
                "branches":[{
                    "when":{
                        "kind":"all",
                        "guards":[
                            mapped_signal("firstVerify", json!(["accepted"])),
                            {
                                "kind":"not",
                                "guard":{
                                    "kind":"any",
                                    "guards":[
                                        mapped_signal(
                                            "secondVerify",
                                            json!(["accepted","rejected"])
                                        ),
                                        mapped_error("secondVerify")
                                    ]
                                }
                            }
                        ]
                    },
                    "node":{
                        "kind":"succeed","name":"impossible",
                        "output":{"kind":"null"},"bindings":[]
                    }
                }],
                "otherwise":{
                    "kind":"succeed","name":"possible",
                    "output":{"kind":"null"},"bindings":[]
                },
                "promotedStatePaths":[]
            }
        ]),
    )
}

fn mapped_missing_group_descendant_outcome_graph(loop_group: bool) -> GraphSpec {
    let mut value =
        serde_json::to_value(mapped_missing_successor_outcome_graph(true)).assert_value();
    let selected = value
        .assert_at("root")
        .assert_at("children")
        .assert_at(0)
        .assert_at("body")
        .assert_at("children")
        .assert_at(1)
        .assert_at("branches")
        .assert_at(0)
        .assert_at("node")
        .clone();
    let state = value
        .assert_at("root")
        .assert_at("children")
        .assert_at(0)
        .assert_at("body")
        .assert_at("state")
        .clone();
    *value
        .assert_at_mut("root")
        .assert_at_mut("children")
        .assert_at_mut(0)
        .assert_at_mut("body")
        .assert_at_mut("children")
        .assert_at_mut(1)
        .assert_at_mut("branches")
        .assert_at_mut(0)
        .assert_at_mut("node") = if loop_group {
        json!({
            "kind":"loop","name":"secondLoop","state":state,
            "body":selected,"maxIterations":1,
            "until":{
                "kind":"in",
                "value":{
                    "name":"secondVerify",
                    "source":"signal",
                    "field":"verdict"
                },
                "labels":["accepted"]
            },
            "promotedStatePaths":[]
        })
    } else {
        json!({
            "kind":"par","name":"secondParallel","state":state,
            "branches":[selected],"join":{"kind":"all"},
            "promotedStatePaths":[]
        })
    };
    serde_json::from_value(value).assert_value()
}

#[tokio::test]
async fn mapped_sequence_success_cannot_omit_guaranteed_successor_outcome() {
    let error = ProductionGraphVerifier::new(registry())
        .verify(&mapped_missing_successor_outcome_graph(false))
        .await
        .assert_error();
    let codes = rejection_codes(error);
    assert!(
        codes.contains(&GraphDiagnosticCode::ChoiceExhaustiveness),
        "mapped sequence admitted a missing successor outcome: {codes:?}"
    );
}

#[tokio::test]
async fn mapped_choice_success_cannot_omit_selected_successor_outcome() {
    let error = ProductionGraphVerifier::new(registry())
        .verify(&mapped_missing_successor_outcome_graph(true))
        .await
        .assert_error();
    let codes = rejection_codes(error);
    assert!(
        codes.contains(&GraphDiagnosticCode::ChoiceExhaustiveness),
        "mapped choice admitted a missing selected outcome: {codes:?}"
    );
}

#[tokio::test]
async fn mapped_selected_par_all_cannot_omit_guaranteed_descendant_outcome() {
    let error = ProductionGraphVerifier::new(registry())
        .verify(&mapped_missing_group_descendant_outcome_graph(false))
        .await
        .assert_error();
    let codes = rejection_codes(error);
    assert!(
        codes.contains(&GraphDiagnosticCode::ChoiceExhaustiveness),
        "mapped par-all admitted a missing guaranteed descendant outcome: {codes:?}"
    );
}

#[tokio::test]
async fn mapped_selected_loop_cannot_omit_guaranteed_body_outcome() {
    let error = ProductionGraphVerifier::new(registry())
        .verify(&mapped_missing_group_descendant_outcome_graph(true))
        .await
        .assert_error();
    let codes = rejection_codes(error);
    assert!(
        codes.contains(&GraphDiagnosticCode::ChoiceExhaustiveness),
        "mapped loop admitted a missing guaranteed body outcome: {codes:?}"
    );
}

#[tokio::test]
async fn mapped_group_descendants_remain_absent_when_their_route_is_not_selected() {
    for loop_group in [false, true] {
        let mut value =
            serde_json::to_value(mapped_missing_group_descendant_outcome_graph(loop_group))
                .assert_value();
        *value
            .assert_at_mut("root")
            .assert_at_mut("children")
            .assert_at_mut(1)
            .assert_at_mut("branches")
            .assert_at_mut(0)
            .assert_at_mut("when")
            .assert_at_mut("guards")
            .assert_at_mut(0)
            .assert_at_mut("labels") = json!(["rejected"]);
        ProductionGraphVerifier::new(registry())
            .verify(&serde_json::from_value(value).assert_value())
            .await
            .assert_value();
    }
}

#[tokio::test]
async fn mapped_sequence_keeps_successor_outcomes_after_predecessor_errors() {
    let mut value =
        serde_json::to_value(mapped_missing_successor_outcome_graph(false)).assert_value();
    *value
        .assert_at_mut("root")
        .assert_at_mut("children")
        .assert_at_mut(1)
        .assert_at_mut("branches")
        .assert_at_mut(0)
        .assert_at_mut("when") = json!({
        "kind":"all",
        "guards":[
            {
                "kind":"not",
                "guard":{
                    "kind":"k_of_map","count":1,
                    "value":{
                        "name":"firstVerify",
                        "source":"signal",
                        "field":"verdict"
                    },
                    "labels":["accepted","rejected"]
                }
            },
            {
                "kind":"k_of_map","count":1,
                "value":{
                    "name":"secondVerify",
                    "source":"signal",
                    "field":"verdict"
                },
                "labels":["accepted"]
            }
        ]
    });
    ProductionGraphVerifier::new(registry())
        .verify(&serde_json::from_value(value).assert_value())
        .await
        .assert_value();
}
