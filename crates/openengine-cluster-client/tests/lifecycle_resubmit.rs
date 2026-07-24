use openengine_cluster_client::ClusterClient;
use openengine_cluster_protocol::{Generation, IdempotencyKey, ResubmitParams, RunId};
use serde_json::json;

#[path = "scripted_transport_support/mod.rs"]
mod scripted_transport_support;
use scripted_transport_support::ScriptedTransport;

#[tokio::test]
async fn resubmit_call_uses_the_typed_contract_and_decodes_the_result() {
    let transport = ScriptedTransport::new([json!({
        "generation":1,"priorRunId":"run-1","runId":"run-2","phase":"running",
        "operational":{"labels":{},"logLevel":"info","dispatchState":"active","inFlight":0},
        "atCursor":"cursor-3","deduped":false
    })]);
    let client = ClusterClient::new(transport.clone());

    let resubmit = client
        .resubmit(ResubmitParams {
            if_generation: Generation::new(1).unwrap(),
            if_run_id: RunId::new("run-1"),
            idempotency_key: IdempotencyKey::new("resubmit-1").unwrap(),
            replacement_input: None,
        })
        .await
        .unwrap();

    assert_eq!(resubmit.prior_run_id.as_str(), "run-1");
    assert_eq!(resubmit.run_id.as_str(), "run-2");
    assert_eq!(resubmit.at_cursor.as_str(), "cursor-3");

    let requests = transport.requests.lock().await;
    assert_eq!(requests[0]["method"], "resubmit");
    assert_eq!(requests[0]["params"]["ifGeneration"], 1);
    assert_eq!(requests[0]["params"]["ifRunId"], "run-1");
    assert_eq!(requests[0]["params"]["idempotencyKey"], "resubmit-1");
    assert!(requests[0]["params"].get("replacementInput").is_none());
    assert!(requests[0]["params"].get("mode").is_none());
}
