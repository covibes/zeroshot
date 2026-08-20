use super::*;

pub(super) fn map_verifier(name: &str) -> Value {
    crate::test_support::verifier_node(name)
}

pub(super) fn mapped_step(name: &str) -> Value {
    crate::test_support::integer_step(name, false)
}

pub(super) fn mapped_items_state() -> Value {
    json!({
        "kind":"record",
        "fields":{
            "value":{"type":{"kind":"integer"},"required":true},
            "items":{
                "type":{"kind":"array","items":{"kind":"null"}},
                "required":true
            }
        }
    })
}

pub(super) fn map_node(state: &Value, body: Value) -> Value {
    json!({
        "kind":"map","name":"map","state":state.clone(),
        "over":{"source":"state","path":["items"]},"maxItems":2,
        "body":body,
        "promotedStatePaths":[]
    })
}

pub(super) fn map_choice(
    state: Value,
    guard: Value,
    selected_name: &str,
    otherwise_name: &str,
) -> Value {
    json!({
        "kind":"choice","name":"afterMap","state":state,
        "branches":[{
            "when":guard,
            "node":{
                "kind":"succeed","name":selected_name,
                "output":{"kind":"null"},"bindings":[]
            }
        }],
        "otherwise":{
            "kind":"succeed","name":otherwise_name,
            "output":{"kind":"null"},"bindings":[]
        },
        "promotedStatePaths":[]
    })
}

pub(super) fn mapped_control_graph(
    state: Value,
    body_children: Value,
    guard: Value,
    branch_names: (&str, &str),
) -> GraphSpec {
    let body = json!({
        "kind":"seq","name":"mappedBody","state":state.clone(),
        "children":body_children,
        "promotedStatePaths":[]
    });
    graph_with_state_children(
        state.clone(),
        json!([
            map_node(&state, body),
            map_choice(state, guard, branch_names.0, branch_names.1)
        ]),
    )
}
