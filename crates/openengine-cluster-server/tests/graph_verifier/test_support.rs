use super::*;

pub(crate) fn verifier_node(name: &str) -> Value {
    json!({
        "kind":"verifier","name":name,"worker":"worker.verify@1",
        "input":{"kind":"null"},"output":{"kind":"record","fields":{}},
        "inputBindings":[],"writeBindings":[],"timeoutMs":1,"attempts":1,
        "signals":{"verdict":["accepted","rejected"]},
        "diagnostic":{"kind":"record","fields":{}}
    })
}

pub(crate) fn integer_step(name: &str, writes_result: bool) -> Value {
    let write_bindings = if writes_result {
        json!([{
            "value":{"node":name,"channel":"out","path":["result"]},
            "target":["result"]
        }])
    } else {
        json!([])
    };
    json!({
        "kind":"step","name":name,"worker":"worker.main@1",
        "input":record(),
        "output":{"kind":"record","fields":{
            "result":{"type":{"kind":"integer"},"required":true}
        }},
        "inputBindings":[{
            "target":["value"],
            "value":{"source":"state","path":["value"]}
        }],
        "writeBindings":write_bindings,"timeoutMs":1,"attempts":1
    })
}

pub(super) fn work_node(name: &str, output_node: &str) -> Value {
    let mut work = valid_graph()
        .assert_at("root")
        .assert_at("children")
        .assert_at(0)
        .clone();
    *work.assert_at_mut("name") = json!(name);
    *work
        .assert_at_mut("writeBindings")
        .assert_at_mut(0)
        .assert_at_mut("value")
        .assert_at_mut("node") = json!(output_node);
    work
}

pub(super) fn set_root_children(value: &mut Value, build: impl FnOnce(&Value) -> Value) {
    let children = build(value);
    *value.assert_at_mut("root").assert_at_mut("children") = children;
}

pub(super) fn graph_with_valid_tail_nodes(mut tail: Value) -> GraphSpec {
    let mut value = valid_graph();
    let children = value
        .assert_at_mut("root")
        .assert_at_mut("children")
        .as_array_mut()
        .assert_value();
    children.truncate(2);
    children.append(tail.as_array_mut().assert_value());
    serde_json::from_value(value).assert_value()
}

pub(super) async fn assert_graph_accepted(graph: &GraphSpec) {
    ProductionGraphVerifier::new(registry())
        .verify(graph)
        .await
        .assert_value();
}

pub(super) async fn assert_graph_rejected(graph: &GraphSpec) -> VerificationError {
    ProductionGraphVerifier::new(registry())
        .verify(graph)
        .await
        .assert_error()
}

pub(super) async fn assert_graph_rejected_with(graph: &GraphSpec, code: GraphDiagnosticCode) {
    let error = assert_graph_rejected(graph).await;
    assert!(rejection_codes(error).contains(&code));
}

pub(super) async fn assert_undefined_read_without_schema_error(graph: &GraphSpec) {
    let codes = rejection_codes(assert_graph_rejected(graph).await);
    assert!(codes.contains(&GraphDiagnosticCode::UndefinedRead));
    assert!(!codes.contains(&GraphDiagnosticCode::SchemaSafety));
}
