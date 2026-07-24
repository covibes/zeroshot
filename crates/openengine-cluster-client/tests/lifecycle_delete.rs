use openengine_cluster_client::ClusterClient;
use openengine_cluster_protocol::{DeleteParams, Generation, IdempotencyKey, RunId};
use serde_json::json;

#[path = "scripted_transport_support/mod.rs"]
mod scripted_transport_support;
use scripted_transport_support::ScriptedTransport;

#[tokio::test]
async fn delete_call_uses_the_typed_contract_and_decodes_the_result() {
    let transport = ScriptedTransport::new([json!({
        "deleted":true,"phase":"empty","deduped":false
    })]);
    let client = ClusterClient::new(transport.clone());

    let delete = client
        .delete(DeleteParams {
            if_generation: Generation::new(1).unwrap(),
            if_run_id: Some(RunId::new("run-1")),
            idempotency_key: IdempotencyKey::new("delete-1").unwrap(),
        })
        .await
        .unwrap();

    assert!(delete.deleted);
    assert_eq!(delete.phase, openengine_cluster_protocol::Phase::Empty);
    assert!(!delete.deduped);

    let requests = transport.requests.lock().await;
    assert_eq!(requests[0]["method"], "delete");
    assert_eq!(requests[0]["params"]["ifGeneration"], 1);
    assert_eq!(requests[0]["params"]["ifRunId"], "run-1");
    assert_eq!(requests[0]["params"]["idempotencyKey"], "delete-1");
    assert!(requests[0]["params"].get("mode").is_none());
}

#[tokio::test]
async fn delete_call_omits_if_run_id_when_absent() {
    let transport = ScriptedTransport::new([json!({
        "deleted":false,"phase":"empty","deduped":false
    })]);
    let client = ClusterClient::new(transport.clone());

    client
        .delete(DeleteParams {
            if_generation: Generation::new(0).unwrap(),
            if_run_id: None,
            idempotency_key: IdempotencyKey::new("delete-noop").unwrap(),
        })
        .await
        .unwrap();

    let requests = transport.requests.lock().await;
    assert!(requests[0]["params"].get("ifRunId").is_none());
}
