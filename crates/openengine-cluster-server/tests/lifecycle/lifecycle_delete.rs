use super::*;

#[tokio::test]
async fn delete_dispatches_to_cluster_backend_and_maps_domain_errors() {
    let success = dispatch_mutation(
        1,
        "delete",
        json!({"ifGeneration":1,"ifRunId":"run-1","idempotencyKey":"delete-1"}),
    )
    .await;
    assert_eq!(success.assert_at("result").assert_at("deleted"), true);
    assert_eq!(success.assert_at("result").assert_at("phase"), "empty");

    assert_common_domain_errors("delete").await;

    let not_terminal = dispatch_mutation(
        4,
        "delete",
        json!({"ifGeneration":1,"idempotencyKey":"not-terminal"}),
    )
    .await;
    assert_eq!(error_code(&not_terminal), INVALID_PHASE);

    let mut invalid = common_invalid_mutation_params();
    invalid.push(json!({"ifGeneration":1}));
    assert_invalid_mutations("delete", invalid).await;
}

#[tokio::test]
async fn default_backend_rejects_delete_with_invalid_phase() {
    let response = dispatch_default(
        "delete",
        json!({"ifGeneration":1,"ifRunId":"run-1","idempotencyKey":"default"}),
    )
    .await;
    assert_eq!(error_code(&response), INVALID_PHASE);
}
