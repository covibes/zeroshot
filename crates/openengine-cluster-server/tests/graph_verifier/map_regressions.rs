use super::*;

#[path = "map_regressions/fixtures.rs"]
mod fixtures;
use fixtures::{
    map_choice, map_node, map_verifier, mapped_control_graph, mapped_items_state, mapped_step,
};

fn mapped_error_read_graph() -> GraphSpec {
    let item = json!({
        "kind":"record",
        "fields":{"value":{"type":{"kind":"integer"},"required":true}}
    });
    let state = json!({
        "kind":"record",
        "fields":{
            "items":{"type":{"kind":"array","items":item},"required":true},
            "results":{
                "type":{"kind":"array","items":{"kind":"integer"}},"required":false
            }
        }
    });
    graph_with_state_children(
        state.clone(),
        json!([
                {
                    "kind":"map","name":"map","state":state,
                    "body":{
                        "kind":"step","name":"mapWork","worker":"worker.main@1",
                        "input":record(),
                        "output":{"kind":"record","fields":{
                            "result":{"type":{"kind":"integer"},"required":true}
                        }},
                        "inputBindings":[{
                            "target":["value"],
                            "value":{"source":"item","path":["value"]}
                        }],
                        "writeBindings":[{
                            "value":{"node":"mapWork","channel":"out","path":["result"]},
                            "target":["results"]
                        }],
                        "timeoutMs":1,"attempts":1
                    },
                    "over":{"source":"state","path":["items"]},
                    "maxItems":2,
                    "promotedStatePaths":[["results"]]
                },
                {
                    "kind":"choice","name":"afterMap","state":state,
                    "branches":[{
                        "when":{
                            "kind":"k_of_map","count":1,
                            "value":{"name":"mapWork","source":"error","field":null},
                            "labels":["timeout"]
                        },
                        "node":{
                            "kind":"succeed","name":"badRead",
                            "output":{"kind":"record","fields":{
                                "results":{
                                    "type":{"kind":"array","items":{"kind":"integer"}},
                                    "required":true
                                }
                            }},
                            "bindings":[{
                                "target":["results"],
                                "value":{"source":"state","path":["results"]}
                            }]
                        }
                    }],
                    "otherwise":{
                        "kind":"succeed","name":"done",
                        "output":{"kind":"null"},"bindings":[]
                    },
                    "promotedStatePaths":[]
                }
        ]),
    )
}

fn nested_map_state() -> Value {
    let item = json!({
        "kind":"record",
        "fields":{"value":{"type":{"kind":"integer"},"required":true}}
    });
    json!({
        "kind":"record",
        "fields":{
            "outerItems":{"type":{"kind":"array","items":item.clone()},"required":true},
            "innerItems":{"type":{"kind":"array","items":item},"required":true},
            "outerResults":{
                "type":{"kind":"array","items":{"kind":"integer"}},"required":true
            },
            "innerResults":{
                "type":{"kind":"array","items":{"kind":"integer"}},"required":false
            }
        }
    })
}

fn nested_map_body(state: &Value) -> Value {
    let inner_work = json!({
        "kind":"step","name":"innerWork","worker":"worker.main@1",
        "input":{"kind":"record","fields":{
            "value":{"type":{"kind":"integer"},"required":true},
            "outer":{"type":{"kind":"integer"},"required":true}
        }},
        "output":{"kind":"record","fields":{
            "result":{"type":{"kind":"integer"},"required":true}
        }},
        "inputBindings":[
            {"target":["value"],"value":{"source":"item","path":["value"]}},
            {"target":["outer"],"value":{"source":"state","path":["outerResults"]}}
        ],
        "writeBindings":[{
            "value":{"node":"innerWork","channel":"out","path":["result"]},
            "target":["innerResults"]
        }],
        "timeoutMs":1,"attempts":1
    });
    let inner_map = json!({
        "kind":"map","name":"innerMap","state":state.clone(),
        "over":{"source":"state","path":["innerItems"]},"maxItems":2,
        "body":inner_work,"promotedStatePaths":[["innerResults"]]
    });
    let outer_work = json!({
        "kind":"step","name":"outerWork","worker":"worker.main@1",
        "input":record(),
        "output":{"kind":"record","fields":{
            "result":{"type":{"kind":"integer"},"required":true}
        }},
        "inputBindings":[{
            "target":["value"],"value":{"source":"item","path":["value"]}
        }],
        "writeBindings":[{
            "value":{"node":"outerWork","channel":"out","path":["result"]},
            "target":["outerResults"]
        }],
        "timeoutMs":1,"attempts":1
    });
    json!({
        "kind":"seq","name":"outerBody","state":state.clone(),
        "children":[inner_map,outer_work],
        "promotedStatePaths":[["outerResults"]]
    })
}

fn nested_map_graph() -> GraphSpec {
    let state = nested_map_state();
    let outer_map = json!({
        "kind":"map","name":"outerMap","state":state.clone(),
        "over":{"source":"state","path":["outerItems"]},"maxItems":2,
        "body":nested_map_body(&state),"promotedStatePaths":[["outerResults"]]
    });
    serde_json::from_value(json!({
        "profile":"openengine.graph.full/v1",
        "initialInput":state,"policy":{"policy":"policy.strict@1","default":"deny"},
        "root":{
            "kind":"seq","name":"root","state":state,
            "children":[
                outer_map,
                {"kind":"succeed","name":"done","output":{"kind":"null"},"bindings":[]}
            ],
            "promotedStatePaths":[]
        }
    }))
    .assert_value()
}

fn nested_map_group_aggregate_graph() -> GraphSpec {
    let state = json!({
        "kind":"record",
        "fields":{
            "outerItems":{
                "type":{"kind":"array","items":{"kind":"null"}},
                "required":true
            },
            "innerItems":{
                "type":{"kind":"array","items":{"kind":"null"}},
                "required":true
            }
        }
    });
    graph_with_state_children(
        state.clone(),
        json!([
            {
                "kind":"map","name":"outerMap","state":state.clone(),
                "over":{"source":"state","path":["outerItems"]},"maxItems":2,
                "body":{
                    "kind":"map","name":"innerMap","state":state.clone(),
                    "over":{"source":"state","path":["innerItems"]},"maxItems":1,
                    "body":{
                        "kind":"verifier","name":"innerVerify","worker":"worker.verify@1",
                        "input":{"kind":"null"},"output":{"kind":"record","fields":{}},
                        "inputBindings":[],"writeBindings":[],"timeoutMs":1,"attempts":1,
                        "signals":{"verdict":["accepted","rejected"]},
                        "diagnostic":{"kind":"record","fields":{}}
                    },
                    "promotedStatePaths":[]
                },
                "promotedStatePaths":[]
            },
            {
                "kind":"choice","name":"afterOuterMap","state":state,
                "branches":[{
                    "when":{
                        "kind":"k_of_map","count":2,
                        "value":{"name":"innerMap","source":"group","field":"overflow"},
                        "labels":["overflow"]
                    },
                    "node":{
                        "kind":"succeed","name":"twoInnerOverflows",
                        "output":{"kind":"null"},"bindings":[]
                    }
                }],
                "otherwise":{
                    "kind":"succeed","name":"fewerInnerOverflows",
                    "output":{"kind":"null"},"bindings":[]
                },
                "promotedStatePaths":[]
            }
        ]),
    )
}

fn mapped_parallel_control_correlation_graph(reached_count: u64, rejected_count: u64) -> GraphSpec {
    let state = mapped_items_state();
    let item_verify = map_verifier("itemVerify");
    let accepted_work = mapped_step("acceptedWork");
    let controlled_branch = json!({
        "kind":"choice","name":"itemRoute","state":state.clone(),
        "branches":[{
            "when":{
                "kind":"in",
                "value":{"name":"itemVerify","source":"signal","field":"verdict"},
                "labels":["accepted"]
            },
            "node":accepted_work
        }],
        "otherwise":{
            "kind":"fail","name":"itemRejected","reason":"item_rejected"
        },
        "promotedStatePaths":[]
    });
    let inner_parallel = json!({
        "kind":"par","name":"innerPar","state":state.clone(),
        "branches":[
            controlled_branch,
            {"kind":"fail","name":"neverCompletes","reason":"never_completes"}
        ],
        "join":{"kind":"any"},
        "promotedStatePaths":[]
    });
    mapped_control_graph(
        state,
        json!([item_verify, inner_parallel]),
        json!({
            "kind":"all",
            "guards":[
                {
                    "kind":"k_of_map","count":reached_count,
                    "value":{"name":"innerPar","source":"group","field":"joined"},
                    "labels":["reached"]
                },
                {
                    "kind":"k_of_map","count":rejected_count,
                    "value":{"name":"itemVerify","source":"signal","field":"verdict"},
                    "labels":["rejected"]
                }
            ]
        }),
        ("impossible", "possible"),
    )
}

fn controlled_step(
    state: &Value,
    name: &str,
    selector: (&str, &str),
    outcomes: (&str, &str),
) -> Value {
    let (selector_name, signal_field) = selector;
    let (accepted_name, rejected_name) = outcomes;
    json!({
            "kind":"choice","name":name,"state":state,
            "branches":[{
                "when":{
                    "kind":"in",
                    "value":{
                        "name":selector_name,
                        "source":"signal",
                        "field":signal_field
                    },
                    "labels":["accepted"]
                },
                "node":mapped_step(accepted_name)
            }],
            "otherwise":{
                "kind":"fail","name":rejected_name,"reason":"rejected"
            },
            "promotedStatePaths":[]
    })
}

fn mapped_parallel_multicontrol_correlation_graph() -> GraphSpec {
    let state = mapped_items_state();
    let verdict = map_verifier("itemVerdict");
    let decision = json!({
        "kind":"verifier","name":"itemDecision","worker":"worker.decision@1",
        "input":{"kind":"null"},"output":{"kind":"record","fields":{}},
        "inputBindings":[],"writeBindings":[],"timeoutMs":1,"attempts":1,
        "signals":{"decision":["accepted","rejected"]},
        "diagnostic":{"kind":"record","fields":{}}
    });
    let completing_branch = json!({
        "kind":"seq","name":"requiresBoth","state":state.clone(),
        "children":[
            controlled_step(
                &state,
                "verdictRoute",
                ("itemVerdict", "verdict"),
                ("acceptedVerdict", "rejectedVerdict")
            ),
            controlled_step(
                &state,
                "decisionRoute",
                ("itemDecision", "decision"),
                ("acceptedDecision", "rejectedDecision")
            )
        ],
        "promotedStatePaths":[]
    });
    let inner_parallel = json!({
        "kind":"par","name":"innerPar","state":state.clone(),
        "branches":[
            completing_branch,
            {"kind":"fail","name":"neverCompletes","reason":"never_completes"}
        ],
        "join":{"kind":"any"},
        "promotedStatePaths":[]
    });
    mapped_control_graph(
        state,
        json!([verdict, decision, inner_parallel]),
        json!({
            "kind":"all",
            "guards":[
                {
                    "kind":"k_of_map","count":2,
                    "value":{
                        "name":"innerPar",
                        "source":"group",
                        "field":"joined"
                    },
                    "labels":["reached"]
                },
                {
                    "kind":"k_of_map","count":1,
                    "value":{
                        "name":"itemVerdict",
                        "source":"signal",
                        "field":"verdict"
                    },
                    "labels":["rejected"]
                }
            ]
        }),
        ("impossible", "possible"),
    )
}

#[path = "map_regressions/core_tests.rs"]
mod core_tests;
#[path = "map_regressions/incoming_control.rs"]
mod incoming_control;
#[path = "map_regressions/outcome_presence.rs"]
mod outcome_presence;
