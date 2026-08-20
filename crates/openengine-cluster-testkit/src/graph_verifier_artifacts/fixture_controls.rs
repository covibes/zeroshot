pub(super) fn guarded_graph(guard: Value) -> Value {
    graph(
        data_state_type(),
        data_state_type(),
        vec![
            verifier_node("verify"),
            choice("decision", data_state_type(), guard, succeed("selected")),
        ],
    )
}

pub(super) fn map_item_graph() -> Value {
    let body = json!({
        "kind":"step","name":"mapWork","worker":"fixture.data@1",
        "input":data_input_type(),"output":result_number_type(),
        "inputBindings":[{"target":["value"],"value":{"source":"item","path":["value"]}}],
        "writeBindings":[],"timeoutMs":1,"attempts":1
    });
    let map = json!({
        "kind":"map","name":"map","state":data_state_type(),"body":body,
        "over":{"source":"state","path":["items"]},"maxItems":2,"promotedStatePaths":[]
    });
    let guard = json!({
        "kind":"k_of_map","count":1,
        "value":{"name":"mapWork","source":"error","field":null},"labels":["timeout"]
    });
    graph(
        data_state_type(),
        data_state_type(),
        vec![
            map,
            choice("afterMap", data_state_type(), guard, succeed("selected")),
        ],
    )
}

pub(super) fn map_signal_graph() -> Value {
    let map = json!({
        "kind":"map","name":"map","state":data_state_type(),"body":verifier_node("mapVerify"),
        "over":{"source":"state","path":["items"]},"maxItems":2,"promotedStatePaths":[]
    });
    let aggregate = json!({
        "kind":"k_of_map","count":1,
        "value":{"name":"mapVerify","source":"signal","field":"verdict"},"labels":["accepted"]
    });
    let overflow = json!({
        "kind":"in","value":{"name":"map","source":"group","field":"overflow"},
        "labels":["overflow"]
    });
    let guard = json!({"kind":"any","guards":[aggregate,overflow]});
    let after_group = choice("mapControl", data_state_type(), guard, succeed("done"));
    graph(data_state_type(), data_state_type(), vec![map, after_group])
}

pub(super) fn loop_graph() -> Value {
    let loop_node = json!({
        "kind":"loop","name":"repeat","state":data_state_type(),"body":verifier_node("verify"),
        "until":in_guard(),"maxIterations":3,"promotedStatePaths":[]
    });
    let terminated = json!({
        "kind":"in","value":{"name":"repeat","source":"group","field":"terminated"},
        "labels":["converged"]
    });
    graph(
        data_state_type(),
        data_state_type(),
        vec![
            loop_node,
            choice(
                "loopControl",
                data_state_type(),
                terminated,
                succeed("done"),
            ),
        ],
    )
}

pub(super) fn parallel_graph(join_kind: &str) -> Value {
    assert!(
        matches!(join_kind, "all" | "any" | "quorum" | "first"),
        "join domain is closed"
    );
    let (branches, join, field) = match join_kind {
        "all" => (
            vec![
                null_step("left", "fixture.worker@1"),
                null_step("right", "fixture.worker@1"),
            ],
            json!({"kind":"all"}),
            "joined",
        ),
        "any" => (
            vec![
                null_step("left", "fixture.worker@1"),
                null_step("right", "fixture.worker@1"),
            ],
            json!({"kind":"any"}),
            "joined",
        ),
        "quorum" => (
            vec![
                null_step("left", "fixture.worker@1"),
                null_step("right", "fixture.worker@1"),
            ],
            json!({"kind":"quorum","count":1}),
            "joined",
        ),
        "first" => (
            vec![
                verifier_node("raceVerify"),
                null_step("right", "fixture.worker@1"),
            ],
            json!({"kind":"first","when":{"kind":"in",
                "value":{"name":"raceVerify","source":"signal","field":"verdict"},"labels":["accepted"]}}),
            "raced",
        ),
        _ => (Vec::new(), Value::Null, "invalid"),
    };
    let par = json!({
        "kind":"par","name":"parallel","state":data_state_type(),
        "branches":branches,"promotedStatePaths":[],"join":join
    });
    let labels = if join_kind == "first" {
        json!(["satisfied"])
    } else {
        json!(["reached"])
    };
    let control = json!({
        "kind":"in","value":{"name":"parallel","source":"group","field":field},"labels":labels
    });
    let after_join = if join_kind == "first" {
        choice("joinControl", data_state_type(), control, succeed("done"))
    } else {
        json!({
            "kind":"choice","name":"joinControl","state":data_state_type(),
            "branches":[{"when":control,"node":succeed("done")}],
            "otherwise":null,"promotedStatePaths":[]
        })
    };
    graph(data_state_type(), data_state_type(), vec![par, after_join])
}

pub(super) fn nested_fold_graph() -> Value {
    let loop_node = json!({
        "kind":"loop","name":"innerLoop","state":data_state_type(),"body":verifier_node("verify"),
        "until":in_guard(),"maxIterations":2,"promotedStatePaths":[]
    });
    let map = json!({
        "kind":"map","name":"outerMap","state":data_state_type(),"body":loop_node,
        "over":{"source":"state","path":["items"]},"maxItems":3,"promotedStatePaths":[]
    });
    let par = json!({
        "kind":"par","name":"parallel","state":data_state_type(),
        "branches":[map, null_step("peer", "fixture.worker@1")],
        "promotedStatePaths":[],"join":{"kind":"all"}
    });
    graph(
        data_state_type(),
        data_state_type(),
        vec![par, succeed("done")],
    )
}

pub(super) fn exhaustive_terminal_choice_graph() -> Value {
    let decision = json!({
        "kind":"choice","name":"decision","state":data_state_type(),
        "branches":[
            {"when":{"kind":"in","value":{"name":"verify","source":"signal","field":"verdict"},
                "labels":["accepted","rejected"]},"node":succeed("done")},
            {"when":{"kind":"in","value":{"name":"verify","source":"error","field":null},
                "labels":["timeout","crash","malformed","refusal"]},"node":fail("failed")}
        ],
        "otherwise":null,"promotedStatePaths":[]
    });
    graph(
        data_state_type(),
        data_state_type(),
        vec![verifier_node("verify"), decision],
    )
}
use super::fixture_builders::*;
use super::*;
