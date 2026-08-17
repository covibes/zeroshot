use super::*;

fn mapped_count(name: &str, source: &str, field: &str, label: &str) -> Value {
    json!({
        "kind":"k_of_map","count":1,
        "value":{"name":name,"source":source,"field":field},
        "labels":[label]
    })
}

fn accepted_gate_with(mut additional_guards: Vec<Value>) -> Value {
    let mut guards = vec![json!({
        "kind":"in",
        "value":{"name":"gate","source":"signal","field":"verdict"},
        "labels":["accepted"]
    })];
    guards.append(&mut additional_guards);
    json!({"kind":"all","guards":guards})
}

fn mapped_parallel_with_incoming_control_graph(first: bool) -> GraphSpec {
    let state = mapped_items_state();
    let gate = map_verifier("gate");
    let work = mapped_step("mappedWork");
    let (join, field, failure_label, branches) = if first {
        (
            json!({
                "kind":"first",
                "when":{
                    "kind":"in",
                    "value":{"name":"gate","source":"signal","field":"verdict"},
                    "labels":["accepted"]
                }
            }),
            "raced",
            "no_satisfier",
            json!([work]),
        )
    } else {
        (
            json!({"kind":"any"}),
            "joined",
            "quorum_unreachable",
            json!([
                {
                    "kind":"choice","name":"mappedRoute","state":state.clone(),
                    "branches":[{
                        "when":{
                            "kind":"in",
                            "value":{"name":"gate","source":"signal","field":"verdict"},
                            "labels":["accepted"]
                        },
                        "node":work
                    }],
                    "otherwise":{
                        "kind":"fail","name":"gateRejected","reason":"gate_rejected"
                    },
                    "promotedStatePaths":[]
                },
                {"kind":"fail","name":"neverCompletes","reason":"never_completes"}
            ]),
        )
    };
    graph_with_state_children(
        state.clone(),
        json!([
            gate,
            map_node(
                &state,
                json!({
                    "kind":"par","name":"mappedParallel","state":state.clone(),
                    "branches":branches,"join":join,"promotedStatePaths":[]
                })
            ),
            map_choice(
                state,
                accepted_gate_with(vec![json!({
                    "kind":"k_of_map","count":1,
                    "value":{
                        "name":"mappedParallel",
                        "source":"group",
                        "field":field
                    },
                    "labels":[failure_label]
                })]),
                "impossible",
                "possible"
            )
        ]),
    )
}

fn mapped_parallel_with_shared_and_item_controls_graph(first: bool) -> GraphSpec {
    let state = mapped_items_state();
    let work = mapped_step("mappedWork");
    let completion_guard = json!({
        "kind":"all",
        "guards":[
            {
                "kind":"in",
                "value":{"name":"gate","source":"signal","field":"verdict"},
                "labels":["accepted"]
            },
            {
                "kind":"in",
                "value":{"name":"itemVerify","source":"signal","field":"verdict"},
                "labels":["accepted"]
            }
        ]
    });
    let (join, field, success_label, failure_label, branches) = if first {
        (
            json!({"kind":"first","when":completion_guard}),
            "raced",
            "satisfied",
            "no_satisfier",
            json!([work]),
        )
    } else {
        (
            json!({"kind":"any"}),
            "joined",
            "reached",
            "quorum_unreachable",
            json!([
                {
                    "kind":"choice","name":"mappedRoute","state":state.clone(),
                    "branches":[{
                        "when":completion_guard,
                        "node":work
                    }],
                    "otherwise":{
                        "kind":"fail","name":"routeRejected","reason":"route_rejected"
                    },
                    "promotedStatePaths":[]
                },
                {"kind":"fail","name":"neverCompletes","reason":"never_completes"}
            ]),
        )
    };
    graph_with_state_children(
        state.clone(),
        json!([
            map_verifier("gate"),
            map_node(
                &state,
                json!({
                    "kind":"seq","name":"mappedBody","state":state.clone(),
                    "children":[
                        map_verifier("itemVerify"),
                        {
                            "kind":"par","name":"mappedParallel","state":state.clone(),
                            "branches":branches,"join":join,"promotedStatePaths":[]
                        }
                    ],
                    "promotedStatePaths":[]
                })
            ),
            map_choice(
                state,
                accepted_gate_with(vec![
                    mapped_count("mappedParallel", "group", field, success_label),
                    mapped_count("mappedParallel", "group", field, failure_label),
                    mapped_count("itemVerify", "signal", "verdict", "accepted"),
                    mapped_count("itemVerify", "signal", "verdict", "rejected")
                ]),
                "mixedOutcomes",
                "otherOutcomes"
            )
        ]),
    )
}

#[tokio::test]
async fn mapped_parallel_controls_correlate_incoming_controls_per_item() {
    for first in [false, true] {
        let error = ProductionGraphVerifier::new(registry())
            .verify(&mapped_parallel_with_incoming_control_graph(first))
            .await
            .assert_error();
        let codes = rejection_codes(error);
        assert!(
            codes.contains(&GraphDiagnosticCode::ChoiceExhaustiveness),
            "mapped {} control admitted an outcome impossible for the incoming gate: {codes:?}",
            if first { "raced" } else { "joined" }
        );
    }
}

#[tokio::test]
async fn mapped_parallel_controls_keep_item_variation_with_incoming_controls() {
    for first in [false, true] {
        ProductionGraphVerifier::new(registry())
            .verify(&mapped_parallel_with_shared_and_item_controls_graph(first))
            .await
            .assert_value();
    }
}
