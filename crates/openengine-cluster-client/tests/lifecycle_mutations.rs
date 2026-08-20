use openengine_cluster_client::ClusterClient;
use openengine_cluster_protocol::{
    DeleteParams, Generation, IdempotencyKey, ResubmitParams, RetryParams, RunId,
};
use serde_json::{json, Value};

#[path = "support/mod.rs"]
pub mod support;
use support::{AssertAt, AssertValue, JsonAt};

#[path = "scripted_transport_support/mod.rs"]
mod scripted_transport_support;
use scripted_transport_support::ScriptedTransport;

fn assert_mutation_params<'a>(
    request: &'a Value,
    method: &str,
    idempotency_key: &str,
) -> &'a Value {
    assert_eq!(request.assert_key("method"), method);
    let params = request.assert_key("params");
    assert_eq!(params.assert_key("ifGeneration"), 1);
    assert_eq!(params.assert_key("idempotencyKey"), idempotency_key);
    params
}

#[tokio::test]
async fn delete_call_uses_the_typed_contract_and_decodes_the_result() {
    let transport = ScriptedTransport::new([json!({
        "deleted":true,"phase":"empty","deduped":false
    })]);
    let client = ClusterClient::new(transport.clone());
    let delete = client
        .delete(DeleteParams {
            if_generation: Generation::new(1).assert_value(),
            if_run_id: Some(RunId::new("run-1")),
            idempotency_key: IdempotencyKey::new("delete-1").assert_value(),
        })
        .await
        .assert_value();
    assert!(delete.deleted);
    assert_eq!(delete.phase, openengine_cluster_protocol::Phase::Empty);
    assert!(!delete.deduped);

    let requests = transport.requests.lock().await;
    let request = requests.assert_at(0);
    let params = assert_mutation_params(request, "delete", "delete-1");
    assert_eq!(params.assert_key("ifRunId"), "run-1");
    assert!(params.get("mode").is_none());
}

#[tokio::test]
async fn delete_call_omits_if_run_id_when_absent() {
    let transport = ScriptedTransport::new([json!({
        "deleted":false,"phase":"empty","deduped":false
    })]);
    ClusterClient::new(transport.clone())
        .delete(DeleteParams {
            if_generation: Generation::new(0).assert_value(),
            if_run_id: None,
            idempotency_key: IdempotencyKey::new("delete-noop").assert_value(),
        })
        .await
        .assert_value();

    let requests = transport.requests.lock().await;
    assert!(
        requests
            .assert_at(0)
            .assert_key("params")
            .get("ifRunId")
            .is_none()
    );
}

#[tokio::test]
async fn resubmit_call_uses_the_typed_contract_and_decodes_the_result() {
    let transport = ScriptedTransport::new([json!({
        "generation":1,"priorRunId":"run-1","runId":"run-2","phase":"running",
        "operational":{"labels":{},"logLevel":"info","dispatchState":"active","inFlight":0},
        "atCursor":"cursor-3","deduped":false
    })]);
    let resubmit = ClusterClient::new(transport.clone())
        .resubmit(ResubmitParams {
            if_generation: Generation::new(1).assert_value(),
            if_run_id: RunId::new("run-1"),
            idempotency_key: IdempotencyKey::new("resubmit-1").assert_value(),
            replacement_input: None,
        })
        .await
        .assert_value();
    assert_eq!(resubmit.prior_run_id.as_str(), "run-1");
    assert_eq!(resubmit.run_id.as_str(), "run-2");
    assert_eq!(resubmit.at_cursor.as_str(), "cursor-3");

    let requests = transport.requests.lock().await;
    let request = requests.assert_at(0);
    let params = assert_mutation_params(request, "resubmit", "resubmit-1");
    assert_eq!(params.assert_key("ifRunId"), "run-1");
    assert!(params.get("replacementInput").is_none());
    assert!(params.get("mode").is_none());
}

#[tokio::test]
async fn retry_call_uses_the_typed_contract_and_decodes_the_result() {
    let transport = ScriptedTransport::new([json!({
        "generation":1,"runId":"run-1","phase":"running",
        "retriedTurnId":"turn-1","retryTurnId":"turn-2",
        "operational":{"labels":{},"logLevel":"info","dispatchState":"active","inFlight":0},
        "atCursor":"cursor-2","deduped":false
    })]);
    let retry = ClusterClient::new(transport.clone())
        .retry(RetryParams {
            if_generation: Generation::new(1).assert_value(),
            idempotency_key: IdempotencyKey::new("retry-1").assert_value(),
        })
        .await
        .assert_value();
    assert_eq!(retry.retried_turn_id, "turn-1");
    assert_eq!(retry.retry_turn_id, "turn-2");
    assert_eq!(retry.at_cursor.as_str(), "cursor-2");

    let requests = transport.requests.lock().await;
    let request = requests.assert_at(0);
    let params = assert_mutation_params(request, "retry", "retry-1");
    assert!(params.get("mode").is_none());
    assert!(params.get("turnId").is_none());
}
