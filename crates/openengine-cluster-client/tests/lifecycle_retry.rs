use openengine_cluster_client::ClusterClient;
use openengine_cluster_protocol::{Generation, IdempotencyKey, RetryParams};
use serde_json::json;

#[path = "scripted_transport_support/mod.rs"]
mod scripted_transport_support;
use scripted_transport_support::ScriptedTransport;

#[tokio::test]
async fn retry_call_uses_the_typed_contract_and_decodes_the_result() {
    let transport = ScriptedTransport::new([json!({
        "generation":1,"runId":"run-1","phase":"running",
        "retriedTurnId":"turn-1","retryTurnId":"turn-2",
        "operational":{"labels":{},"logLevel":"info","dispatchState":"active","inFlight":0},
        "atCursor":"cursor-2","deduped":false
    })]);
    let client = ClusterClient::new(transport.clone());

    let retry = client
        .retry(RetryParams {
            if_generation: Generation::new(1).unwrap(),
            idempotency_key: IdempotencyKey::new("retry-1").unwrap(),
        })
        .await
        .unwrap();

    assert_eq!(retry.retried_turn_id, "turn-1");
    assert_eq!(retry.retry_turn_id, "turn-2");
    assert_eq!(retry.at_cursor.as_str(), "cursor-2");

    let requests = transport.requests.lock().await;
    assert_eq!(requests[0]["method"], "retry");
    assert_eq!(requests[0]["params"]["ifGeneration"], 1);
    assert_eq!(requests[0]["params"]["idempotencyKey"], "retry-1");
    assert!(requests[0]["params"].get("mode").is_none());
    assert!(requests[0]["params"].get("turnId").is_none());
}
