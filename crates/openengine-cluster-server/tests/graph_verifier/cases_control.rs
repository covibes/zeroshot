async fn assert_unbounded_map_scope(graph: &GraphSpec) {
    let diagnostics = rejection_diagnostics(assert_graph_rejected(graph).await);
    assert!(diagnostics.iter().any(|diagnostic| {
        diagnostic.code == GraphDiagnosticCode::ChoiceExhaustiveness
            && diagnostic.message == "k_of_map selector has no bounded enclosing map scope"
    }));
}

fn worker_error_branch(name: &str) -> Value {
    json!({
        "when":{"kind":"in","value":{"name":"verify","source":"error","field":null},
            "labels":["timeout","crash","malformed","refusal"]},
        "node":{"kind":"fail","name":name,"reason":"worker_error"}
    })
}

fn exhaustive_terminal_choice(otherwise: Value) -> Value {
    decision_choice(
        json!([
            all_verdicts_completed_branch(),
            worker_error_branch("workerFailed")
        ]),
        otherwise,
    )
}

fn all_verdicts_completed_branch() -> Value {
    json!({
        "when":{"kind":"in","value":{"name":"verify","source":"signal","field":"verdict"},
            "labels":["accepted","rejected"]},
        "node":{"kind":"succeed","name":"completed","output":{"kind":"null"},"bindings":[]}
    })
}

fn decision_choice(branches: Value, otherwise: Value) -> Value {
    json!({
        "kind":"choice", "name":"decision", "state":record(),
        "branches":branches,
        "otherwise":otherwise,
        "promotedStatePaths":[]
    })
}

fn sole_diagnostic(error: VerificationError) -> GraphDiagnostic {
    let mut diagnostics = rejection_diagnostics(error);
    assert_eq!(diagnostics.len(), 1);
    diagnostics.swap_remove(0)
}

fn set_verifier_number_output(value: &mut Value) {
    *value
        .assert_at_mut("root")
        .assert_at_mut("children")
        .assert_at_mut(1)
        .assert_at_mut("output") =
        json!({"kind":"record","fields":{"result":{"type":{"kind":"number"},"required":true}}});
}

fn graph_with_valid_tail(tail: Value) -> GraphSpec {
    let mut value = valid_graph();
    *value
        .assert_at_mut("root")
        .assert_at_mut("children")
        .assert_at_mut(2) = tail;
    serde_json::from_value(value).assert_value()
}

#[tokio::test]
async fn every_guard_form_and_map_aggregate_is_admitted_when_satisfiable() {
    for guard in [
        json!({"kind":"any","guards":[
            {"kind":"in","value":{"name":"verify","source":"signal","field":"verdict"},"labels":["accepted"]},
            {"kind":"in","value":{"name":"verify","source":"signal","field":"verdict"},"labels":["rejected"]}
        ]}),
        json!({"kind":"not","guard":
            {"kind":"in","value":{"name":"verify","source":"error","field":null},"labels":["timeout"]}
        }),
        json!({"kind":"k_of_n","count":1,"values":[
            {"name":"verify","source":"signal","field":"verdict"},
            {"name":"verify","source":"error","field":null}
        ],"labels":["accepted","timeout"]}),
    ] {
        let mut value = valid_graph();
        *value
            .assert_at_mut("root")
            .assert_at_mut("children")
            .assert_at_mut(2)
            .assert_at_mut("branches")
            .assert_at_mut(0)
            .assert_at_mut("when") = guard;
        let graph: GraphSpec = serde_json::from_value(value).assert_value();
        assert_graph_accepted(&graph).await;
    }

    let map_graph = map_control_graph(
        2,
        json!([
            {
                "when":{
                    "kind":"k_of_map","count":2,
                    "value":{"name":"mapVerify","source":"signal","field":"verdict"},
                    "labels":["accepted"]
                },
                "node":{
                    "kind":"succeed","name":"selectedTwice",
                    "output":{"kind":"null"},"bindings":[]
                }
            },
            {
                "when":{
                    "kind":"k_of_map","count":1,
                    "value":{"name":"mapVerify","source":"signal","field":"verdict"},
                    "labels":["accepted"]
                },
                "node":{
                    "kind":"succeed","name":"selectedOnce",
                    "output":{"kind":"null"},"bindings":[]
                }
            }
        ]),
        json!({"kind":"fail","name":"failed","reason":"failed"}),
    );
    assert_graph_accepted(&map_graph).await;
}

#[tokio::test]
async fn k_of_map_rejects_selector_without_bounded_map_scope() {
    let mut value = valid_graph();
    *value
        .assert_at_mut("root")
        .assert_at_mut("children")
        .assert_at_mut(2)
        .assert_at_mut("branches")
        .assert_at_mut(0)
        .assert_at_mut("when") = json!({
        "kind":"k_of_map","count":1,
        "value":{"name":"verify","source":"signal","field":"verdict"},
        "labels":["accepted"]
    });
    let graph: GraphSpec = serde_json::from_value(value).assert_value();
    assert_unbounded_map_scope(&graph).await;
}

#[tokio::test]
async fn k_of_map_rejects_selected_map_group_control_without_enclosing_map_scope() {
    let graph = map_control_graph(
        2,
        json!([{
            "when":{
                "kind":"k_of_map","count":1,
                "value":{"name":"map","source":"group","field":"overflow"},
                "labels":["overflow"]
            },
            "node":{
                "kind":"succeed","name":"selected",
                "output":{"kind":"null"},"bindings":[]
            }
        }]),
        json!({"kind":"fail","name":"failed","reason":"failed"}),
    );

    assert_unbounded_map_scope(&graph).await;
}

#[tokio::test]
async fn exhaustive_terminal_choice_without_otherwise_is_admitted() {
    let graph = graph_with_valid_tail(exhaustive_terminal_choice(Value::Null));
    assert_graph_accepted(&graph).await;
}

#[tokio::test]
async fn exhaustive_terminal_choice_rejects_dead_otherwise() {
    let graph = graph_with_valid_tail(decision_choice(
        json!([
            {
                "when":{"kind":"in","value":{"name":"verify","source":"signal","field":"verdict"},
                    "labels":["accepted"]},
                "node":{"kind":"succeed","name":"accepted","output":{"kind":"null"},"bindings":[]}
            },
            {
                "when":{"kind":"in","value":{"name":"verify","source":"signal","field":"verdict"},
                    "labels":["rejected"]},
                "node":{"kind":"fail","name":"rejected","reason":"rejected"}
            },
            worker_error_branch("workerFailed")
        ]),
        json!({
            "kind":"succeed","name":"deadOtherwise","output":record(),
            "bindings":[{"target":["value"],"value":{"source":"state","path":["missing"]}}]
        }),
    ));
    assert_dead_otherwise(&graph).await;
}

#[tokio::test]
async fn dead_nonterminal_otherwise_does_not_cause_terminal_fallthrough() {
    let graph = graph_with_valid_tail(exhaustive_terminal_choice(json!({
        "kind":"step", "name":"deadOtherwise", "worker":"worker.main@1",
        "input":{"kind":"null"}, "output":{"kind":"null"},
        "inputBindings":[], "writeBindings":[], "timeoutMs":1, "attempts":1
    })));
    assert_dead_otherwise(&graph).await;
}

#[tokio::test]
async fn dead_nonterminal_guarded_branch_does_not_cause_terminal_fallthrough() {
    let graph = graph_with_valid_tail(decision_choice(
        json!([
            all_verdicts_completed_branch(),
            {
                "when":{"kind":"in","value":{"name":"verify","source":"signal","field":"verdict"},
                    "labels":["accepted"]},
                "node":{
                    "kind":"step", "name":"deadBranch", "worker":"worker.main@1",
                    "input":record(), "output":{"kind":"null"},
                    "inputBindings":[{"target":["value"],"value":{"source":"state","path":["missing"]}}],
                    "writeBindings":[], "timeoutMs":1, "attempts":1
                }
            },
            worker_error_branch("workerFailed")
        ]),
        Value::Null,
    ));
    let error = assert_graph_rejected(&graph).await;
    let diagnostic = sole_diagnostic(error);
    assert_eq!(diagnostic.code, GraphDiagnosticCode::ChoiceExhaustiveness);
    assert_eq!(
        diagnostic.message,
        "choice branch is unreachable after excluding earlier branches"
    );
}

fn dead_otherwise_diagnostic_path() -> Value {
    json!([
        {"kind":"field","name":"root"},
        {"kind":"node","name":"root"},
        {"kind":"field","name":"children"},
        {"kind":"index","index":2},
        {"kind":"node","name":"decision"},
        {"kind":"field","name":"otherwise"},
        {"kind":"node","name":"deadOtherwise"}
    ])
}

async fn assert_dead_otherwise(graph: &GraphSpec) {
    let diagnostic = sole_diagnostic(assert_graph_rejected(graph).await);
    assert_eq!(diagnostic.code, GraphDiagnosticCode::ChoiceExhaustiveness);
    assert_eq!(
        serde_json::to_value(&diagnostic.path).assert_value(),
        dead_otherwise_diagnostic_path()
    );
}

#[tokio::test]
async fn choice_residual_outcomes_protect_unavailable_verifier_outputs() {
    let mut value = valid_graph();
    set_verifier_number_output(&mut value);
    *value
        .assert_at_mut("root")
        .assert_at_mut("children")
        .assert_at_mut(2) = json!({
        "kind":"choice", "name":"decision", "state":record(),
        "branches":[{
            "when":{"kind":"not","guard":{"kind":"in",
                "value":{"name":"verify","source":"signal","field":"verdict"},"labels":["accepted"]}},
            "node":{
                "kind":"step", "name":"recover", "worker":"worker.main@1",
                "input":{"kind":"null"}, "output":{"kind":"record","fields":{"result":{"type":{"kind":"number"},"required":true}}},
                "inputBindings":[],
                "writeBindings":[{"value":{"node":"verify","channel":"out","path":["result"]},"target":["result"]}],
                "timeoutMs":1, "attempts":1
            }
        }],
        "otherwise":{"kind":"succeed","name":"done","output":{"kind":"null"},"bindings":[]},
        "promotedStatePaths":[]
    });
    let graph: GraphSpec = serde_json::from_value(value).assert_value();
    assert_graph_rejected_with(&graph, GraphDiagnosticCode::UndefinedRead).await;
}
#[tokio::test]
async fn terminal_error_paths_do_not_poison_success_only_continuations() {
    let mut value = valid_graph();
    set_verifier_number_output(&mut value);
    *value
        .assert_at_mut("root")
        .assert_at_mut("children")
        .assert_at_mut(2) = json!({
        "kind":"choice", "name":"routeError", "state":record(),
        "branches":[{
            "when":{"kind":"in","value":{"name":"verify","source":"error","field":null},
                "labels":["timeout","crash","malformed","refusal"]},
            "node":{"kind":"fail","name":"workerFailed","reason":"worker_error"}
        }],
        "otherwise":{
            "kind":"step", "name":"consume", "worker":"worker.main@1",
            "input":record(), "output":{"kind":"record","fields":{"result":{"type":{"kind":"number"},"required":true}}},
            "inputBindings":[{"target":["value"],"value":{"source":"state","path":["value"]}}],
            "writeBindings":[{"value":{"node":"verify","channel":"out","path":["result"]},"target":["result"]}],
            "timeoutMs":1, "attempts":1
        },
        "promotedStatePaths":[]
    });
    value
        .assert_at_mut("root")
        .assert_at_mut("children")
        .as_array_mut()
        .assert_value()
        .push(json!({
            "kind":"succeed","name":"done","output":{"kind":"null"},"bindings":[]
        }));
    let graph: GraphSpec = serde_json::from_value(value).assert_value();
    assert_graph_accepted(&graph).await;
}

#[tokio::test]
async fn output_backed_writes_are_undefined_until_success_is_guaranteed() {
    let mut value = valid_graph();
    set_root_children(&mut value, |value| {
        json!([
            value.assert_at("root").assert_at("children").assert_at(0).clone(),
            {
                "kind":"succeed", "name":"done",
                "output":{"kind":"record","fields":{
                    "result":{"type":{"kind":"number"},"required":true}
                }},
                "bindings":[{
                    "target":["result"],
                    "value":{"source":"state","path":["result"]}
                }]
            }
        ])
    });
    let graph: GraphSpec = serde_json::from_value(value).assert_value();
    assert_graph_rejected_with(&graph, GraphDiagnosticCode::UndefinedRead).await;
}
use super::*;
