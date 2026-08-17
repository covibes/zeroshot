#[tokio::test]
async fn map_promotes_indexed_results_and_defines_empty_results() {
    let graph = indexed_map_graph(
        json!({"kind":"integer"}),
        json!({"kind":"array","items":{"kind":"integer"}}),
        true,
    );

    assert_graph_accepted(&graph).await;
}

#[tokio::test]
async fn map_indexed_promotions_reject_invalid_element_sources_and_targets() {
    let mismatch = indexed_map_graph(
        json!({"kind":"number"}),
        json!({"kind":"array","items":{"kind":"integer"}}),
        true,
    );
    let mismatch = assert_graph_rejected(&mismatch).await;
    let mismatch_codes = rejection_codes(mismatch);
    assert!(mismatch_codes.contains(&GraphDiagnosticCode::SchemaSafety));
    assert!(!mismatch_codes.contains(&GraphDiagnosticCode::UndefinedRead));

    let scalar_target =
        indexed_map_graph(json!({"kind":"integer"}), json!({"kind":"integer"}), true);
    let mut scalar_target = serde_json::to_value(scalar_target).assert_value();
    *scalar_target
        .assert_at_mut("root")
        .assert_at_mut("children")
        .assert_at_mut(1) =
        json!({"kind":"succeed","name":"done","output":{"kind":"null"},"bindings":[]});
    let scalar_target = serde_json::from_value(scalar_target).assert_value();
    let scalar_target = assert_graph_rejected(&scalar_target).await;
    let scalar_codes = rejection_codes(scalar_target);
    assert!(scalar_codes.contains(&GraphDiagnosticCode::SchemaSafety));
    assert!(!scalar_codes.contains(&GraphDiagnosticCode::UndefinedRead));

    let missing_writer = indexed_map_graph(
        json!({"kind":"integer"}),
        json!({"kind":"array","items":{"kind":"integer"}}),
        false,
    );
    let missing_writer = assert_graph_rejected(&missing_writer).await;
    assert!(rejection_codes(missing_writer).contains(&GraphDiagnosticCode::UndefinedRead));
}

#[tokio::test]
async fn map_indexed_reads_do_not_reuse_the_outer_array_definition() {
    let mut value = serde_json::to_value(indexed_map_graph(
        json!({"kind":"integer"}),
        json!({"kind":"array","items":{"kind":"integer"}}),
        true,
    ))
    .assert_value();
    *value
        .assert_at_mut("initialInput")
        .assert_at_mut("fields")
        .assert_at_mut("results")
        .assert_at_mut("required") = json!(true);
    value
        .assert_at_mut("root")
        .assert_at_mut("children")
        .assert_at_mut(0)
        .assert_at_mut("body")
        .assert_at_mut("input")
        .assert_at_mut("fields")
        .as_object_mut()
        .assert_value()
        .insert(
            "prior".to_owned(),
            json!({"type":{"kind":"integer"},"required":true}),
        );
    value
        .assert_at_mut("root")
        .assert_at_mut("children")
        .assert_at_mut(0)
        .assert_at_mut("body")
        .assert_at_mut("inputBindings")
        .as_array_mut()
        .assert_value()
        .push(json!({
            "target":["prior"],
            "value":{"source":"state","path":["results"]}
        }));
    let graph = serde_json::from_value(value).assert_value();
    assert_undefined_read_without_schema_error(&graph).await;
}
use super::map_fixture::indexed_map_graph;
use super::*;
