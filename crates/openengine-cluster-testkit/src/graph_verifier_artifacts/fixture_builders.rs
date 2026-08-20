pub(super) fn graph(initial_input: Value, state: Value, children: Vec<Value>) -> Value {
    json!({
        "profile":"openengine.graph.full/v1",
        "initialInput":initial_input,
        "policy":{"policy":"policy.strict@1","default":"deny"},
        "root":{
            "kind":"seq","name":"root","state":state,
            "children":children,
            "promotedStatePaths":[]
        }
    })
}

pub(super) fn null_step(name: &str, worker: &str) -> Value {
    json!({
        "kind":"step","name":name,"worker":worker,
        "input":null_type(),"output":null_type(),
        "inputBindings":[],"writeBindings":[],"timeoutMs":1,"attempts":1
    })
}

pub(super) fn data_step(name: &str) -> Value {
    json!({
        "kind":"step","name":name,"worker":"fixture.data@1",
        "input":data_input_type(),"output":result_number_type(),
        "inputBindings":[{"target":["value"],"value":{"source":"state","path":["value"]}}],
        "writeBindings":[{"value":{"node":name,"channel":"out","path":["result"]},"target":["result"]}],
        "timeoutMs":1,"attempts":2
    })
}

pub(super) fn verifier_node(name: &str) -> Value {
    json!({
        "kind":"verifier","name":name,"worker":"fixture.verifier@1",
        "input":null_type(),"output":result_number_type(),
        "inputBindings":[],"writeBindings":[],"timeoutMs":1,"attempts":1,
        "signals":{"verdict":["accepted","rejected"]},
        "diagnostic":diagnostic_number_type()
    })
}

pub(super) fn succeed(name: &str) -> Value {
    json!({"kind":"succeed","name":name,"output":null_type(),"bindings":[]})
}

pub(super) fn fail(name: &str) -> Value {
    json!({"kind":"fail","name":name,"reason":"rejected"})
}

pub(super) fn choice(name: &str, state: Value, guard: Value, selected: Value) -> Value {
    json!({
        "kind":"choice","name":name,"state":state,
        "branches":[{"when":guard,"node":selected}],
        "otherwise":fail(&format!("{name}Otherwise")),
        "promotedStatePaths":[]
    })
}

pub(super) fn in_guard() -> Value {
    json!({
        "kind":"in",
        "value":{"name":"verify","source":"signal","field":"verdict"},
        "labels":["accepted"]
    })
}

pub(super) fn error_guard() -> Value {
    json!({
        "kind":"in",
        "value":{"name":"verify","source":"error","field":null},
        "labels":["timeout"]
    })
}

pub(super) fn k_of_n_guard() -> Value {
    json!({
        "kind":"k_of_n","count":1,
        "values":[
            {"name":"verify","source":"signal","field":"verdict"},
            {"name":"verify","source":"error","field":null}
        ],
        "labels":["accepted","timeout"]
    })
}

pub(super) fn basic_graph() -> Value {
    graph(
        null_type(),
        null_type(),
        vec![null_step("work", "fixture.worker@1"), succeed("done")],
    )
}

pub(super) fn binding_channels_graph() -> Value {
    let mut verifier = verifier_node("verify");
    *verifier.assert_key_mut("writeBindings") = json!([
        {"value":{"node":"verify","channel":"out","path":["result"]},"target":["result"]},
        {"value":{"node":"verify","channel":"signal","path":["verdict"]},"target":["verdict"]},
        {"value":{"node":"verify","channel":"diagnostic","path":["code"]},"target":["diagnostic"]}
    ]);
    graph(
        data_state_type(),
        data_state_type(),
        vec![verifier, succeed("done")],
    )
}

pub(super) fn state_result_succeed(name: &str) -> Value {
    json!({
        "kind":"succeed","name":name,"output":result_number_type(),
        "bindings":[{"target":["result"],"value":{"source":"state","path":["result"]}}]
    })
}

pub(super) fn success_routed_write_graph() -> Value {
    let route = json!({
        "kind":"choice","name":"routeWork","state":data_state_type(),
        "branches":[{
            "when":{"kind":"in","value":{"name":"produce","source":"error","field":null},
                "labels":["timeout","crash","malformed","refusal"]},
            "node":fail("workFailed")
        }],
        "otherwise":state_result_succeed("done"),"promotedStatePaths":[]
    });
    graph(
        data_state_type(),
        data_state_type(),
        vec![data_step("produce"), route],
    )
}

pub(super) fn map_indexed_promotion_graph() -> Value {
    map_indexed_promotion_fixture(
        json!({"kind":"array","items":{"kind":"integer"}}),
        true,
        true,
    )
}

pub(super) fn map_indexed_promotion_element_type_graph() -> Value {
    map_indexed_promotion_fixture(
        json!({"kind":"array","items":{"kind":"string"}}),
        true,
        false,
    )
}

pub(super) fn map_promotion_target_not_array_graph() -> Value {
    map_indexed_promotion_fixture(json!({"kind":"integer"}), true, false)
}

pub(super) fn map_promotion_no_body_write_graph() -> Value {
    map_indexed_promotion_fixture(
        json!({"kind":"array","items":{"kind":"integer"}}),
        false,
        false,
    )
}

pub(super) fn map_indexed_promotion_fixture(
    promoted_type: Value,
    writes_result: bool,
    reads_result: bool,
) -> Value {
    let state = json!({
        "kind":"record",
        "fields":{
            "items":{"type":{"kind":"array","items":data_input_type()},"required":true},
            "results":{"type":promoted_type,"required":false}
        }
    });
    let mut body = json!({
        "kind":"step","name":"mapWork","worker":"fixture.data@1",
        "input":data_input_type(),"output":result_integer_type(),
        "inputBindings":[{"target":["value"],"value":{"source":"item","path":["value"]}}],
        "writeBindings":[],"timeoutMs":1,"attempts":1
    });
    if writes_result {
        *body.assert_key_mut("writeBindings") = json!([{
            "value":{"node":"mapWork","channel":"out","path":["result"]},
            "target":["results"]
        }]);
    }
    let map = json!({
        "kind":"map","name":"map","state":state,"body":body,
        "over":{"source":"state","path":["items"]},"maxItems":2,
        "promotedStatePaths":[["results"]]
    });
    let terminal = if reads_result {
        let read = json!({
            "kind":"succeed","name":"done",
            "output":{"kind":"record","fields":{
                "results":{"type":{"kind":"array","items":{"kind":"integer"}},"required":true}
            }},
            "bindings":[{"target":["results"],"value":{"source":"state","path":["results"]}}]
        });
        json!({
            "kind":"choice","name":"afterMap","state":state,
            "branches":[{
                "when":{
                    "kind":"k_of_map","count":1,
                    "value":{"name":"mapWork","source":"error","field":null},
                    "labels":["timeout","crash","malformed","refusal"]
                },
                "node":fail("mapFailed")
            }],
            "otherwise":read,
            "promotedStatePaths":[]
        })
    } else {
        succeed("done")
    };
    graph(state.clone(), state, vec![map, terminal])
}

pub(super) fn parallel_success_routed_promotion_graph() -> Value {
    parallel_promotion_graph("reached", state_result_succeed("done"), fail("failed"))
}

pub(super) fn parallel_failure_promotion_graph() -> Value {
    parallel_promotion_graph(
        "quorum_unreachable",
        state_result_succeed("badRead"),
        succeed("done"),
    )
}

pub(super) fn parallel_promotion_graph(label: &str, selected: Value, otherwise: Value) -> Value {
    let state = data_state_type();
    let parallel = json!({
        "kind":"par","name":"parallel","state":state,
        "branches":[
            parallel_writer_branch("left"),
            parallel_writer_branch("right")
        ],
        "promotedStatePaths":[["result"]],"join":{"kind":"any"}
    });
    let route = json!({
        "kind":"choice","name":"afterParallel","state":state,
        "branches":[{
            "when":{"kind":"in",
                "value":{"name":"parallel","source":"group","field":"joined"},
                "labels":[label]},
            "node":selected
        }],
        "otherwise":otherwise,"promotedStatePaths":[]
    });
    graph(state.clone(), state, vec![parallel, route])
}

pub(super) fn parallel_writer_branch(prefix: &str) -> Value {
    let writer = format!("{prefix}Writer");
    let route = format!("{prefix}Route");
    let failed = format!("{prefix}Failed");
    let continued = format!("{prefix}Continued");
    json!({
        "kind":"seq","name":prefix,"state":data_state_type(),
        "children":[
            data_step(&writer),
            {
                "kind":"choice","name":route,"state":data_state_type(),
                "branches":[{
                    "when":{"kind":"in",
                        "value":{"name":writer,"source":"error","field":null},
                        "labels":["timeout","crash","malformed","refusal"]},
                    "node":fail(&failed)
                }],
                "otherwise":null_step(&continued, "fixture.worker@1"),
                "promotedStatePaths":[]
            }
        ],
        "promotedStatePaths":[["result"]]
    })
}

pub(super) fn unconstructible_worker_input_graph() -> Value {
    let step = json!({
        "kind":"step","name":"work","worker":"fixture.worker@1",
        "input":{"kind":"string"},"output":null_type(),
        "inputBindings":[],"writeBindings":[],"timeoutMs":1,"attempts":1
    });
    graph(null_type(), null_type(), vec![step, succeed("done")])
}

pub(super) fn unconstructible_terminal_output_graph() -> Value {
    let terminal = json!({
        "kind":"succeed","name":"done","output":{"kind":"string"},"bindings":[]
    });
    graph(
        null_type(),
        null_type(),
        vec![null_step("work", "fixture.worker@1"), terminal],
    )
}
use super::*;
