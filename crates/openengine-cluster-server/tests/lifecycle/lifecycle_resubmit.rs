use super::*;

#[tokio::test]
async fn resubmit_dispatches_to_cluster_backend_and_maps_domain_errors() {
    let success = dispatch_mutation(
        1,
        "resubmit",
        json!({"ifGeneration":1,"ifRunId":"run-1","idempotencyKey":"resubmit-1"}),
    )
    .await;
    assert_eq!(success.assert_at("result").assert_at("priorRunId"), "run-1");
    assert_eq!(success.assert_at("result").assert_at("runId"), "run-2");

    assert_common_domain_errors("resubmit").await;

    let bad_input = dispatch_mutation(
        4,
        "resubmit",
        json!({"ifGeneration":1,"ifRunId":"run-1","idempotencyKey":"bad-input",
            "replacementInput":{"bad":true}}),
    )
    .await;
    assert_eq!(error_code(&bad_input), SCHEMA_VIOLATION);

    let mut invalid = common_invalid_mutation_params();
    invalid.extend([
        json!({"ifGeneration":1,"idempotencyKey":"missing-run"}),
        json!({"ifGeneration":1,"ifRunId":"run-1"}),
    ]);
    assert_invalid_mutations("resubmit", invalid).await;
}

#[tokio::test]
async fn default_backend_rejects_resubmit_with_invalid_phase() {
    let response = dispatch_default(
        "resubmit",
        json!({"ifGeneration":1,"ifRunId":"run-1","idempotencyKey":"default"}),
    )
    .await;
    assert_eq!(error_code(&response), INVALID_PHASE);
}
