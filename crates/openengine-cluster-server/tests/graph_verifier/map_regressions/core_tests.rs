use super::*;

#[tokio::test]
async fn mapped_error_outcome_does_not_expose_success_only_results() {
    let graph = mapped_error_read_graph();
    let error = assert_graph_rejected(&graph).await;
    assert!(rejection_codes(error).contains(&GraphDiagnosticCode::UndefinedRead));
}
#[tokio::test]
async fn nested_maps_preserve_outer_index_definition_isolation() {
    let graph = nested_map_graph();
    assert_undefined_read_without_schema_error(&graph).await;
}

#[tokio::test]
async fn k_of_map_counts_group_controls_across_the_enclosing_map() {
    let graph = nested_map_group_aggregate_graph();
    assert_graph_accepted(&graph).await;
}

#[tokio::test]
async fn mapped_parallel_controls_preserve_per_item_branch_correlation() {
    let error = ProductionGraphVerifier::new(registry())
        .verify(&mapped_parallel_control_correlation_graph(2, 1))
        .await
        .assert_error();
    let codes = rejection_codes(error);
    assert!(
        codes.contains(&GraphDiagnosticCode::ChoiceExhaustiveness),
        "unexpected rejection codes: {codes:?}"
    );
}
#[tokio::test]
async fn mapped_parallel_controls_allow_jointly_possible_item_counts() {
    ProductionGraphVerifier::new(registry())
        .verify(&mapped_parallel_control_correlation_graph(1, 1))
        .await
        .assert_value();
}

#[tokio::test]
async fn mapped_parallel_controls_correlate_dependencies_omitted_from_outer_guard() {
    let error = ProductionGraphVerifier::new(registry())
        .verify(&mapped_parallel_multicontrol_correlation_graph())
        .await
        .assert_error();
    let codes = rejection_codes(error);
    assert!(
        codes.contains(&GraphDiagnosticCode::ChoiceExhaustiveness),
        "unexpected rejection codes: {codes:?}"
    );
}
