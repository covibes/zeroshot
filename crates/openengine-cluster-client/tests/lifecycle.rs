use async_trait::async_trait;
use openengine_cluster_client::{ClientError, ClusterClient, JsonRpcTransport, TransportError};
use openengine_cluster_protocol::{Generation, IdempotencyKey, StopMode, StopParams, UpdateParams};
use serde_json::json;

#[path = "support/mod.rs"]
pub mod support;
use support::{AssertAt, AssertError, AssertValue, JsonAt};

#[path = "scripted_transport_support/mod.rs"]
mod scripted_transport_support;
use scripted_transport_support::ScriptedTransport;

fn generation() -> Generation {
    Generation::new(1).assert_value()
}

#[tokio::test]
async fn lifecycle_calls_use_typed_update_and_stop_contracts() {
    let transport = ScriptedTransport::new([
        json!({
            "generation":1,"runId":"run-1","phase":"running",
            "operational":{"labels":{},"logLevel":"info","dispatchState":"suspended","inFlight":0},
            "atCursor":"cursor-2","deduped":false
        }),
        json!({
            "generation":1,"runId":"run-1","phase":"finished",
            "acceptedMode":"force","effectiveMode":"force",
            "operational":{"labels":{},"logLevel":"info","dispatchState":"stopped","stopMode":"force","inFlight":0},
            "atCursor":"cursor-4","deduped":false
        }),
    ]);
    let client = ClusterClient::new(transport.clone());

    let update = client
        .update(UpdateParams {
            labels: None,
            log_level: None,
            suspended: Some(true),
            if_generation: generation(),
            idempotency_key: IdempotencyKey::new("suspend").assert_value(),
        })
        .await
        .assert_value();
    let stop = client
        .stop(StopParams {
            mode: StopMode::Force,
            if_generation: generation(),
            idempotency_key: IdempotencyKey::new("force").assert_value(),
        })
        .await
        .assert_value();

    assert_eq!(update.at_cursor.as_str(), "cursor-2");
    assert_eq!(stop.effective_mode, StopMode::Force);
    let requests = transport.requests.lock().await;
    let update_request = requests.assert_at(0);
    assert_eq!(update_request.assert_key("method"), "update");
    assert_eq!(
        update_request
            .assert_key("params")
            .assert_key("ifGeneration"),
        1
    );
    assert_eq!(
        update_request
            .assert_key("params")
            .assert_key("idempotencyKey"),
        "suspend"
    );
    let stop_request = requests.assert_at(1);
    assert_eq!(stop_request.assert_key("method"), "stop");
    assert_eq!(
        stop_request.assert_key("params").assert_key("mode"),
        "force"
    );
}

#[derive(Clone)]
struct WrongResponseIdentity;

#[async_trait]
impl JsonRpcTransport for WrongResponseIdentity {
    async fn request(&self, _request: String) -> Result<String, TransportError> {
        Ok(json!({
            "jsonrpc":"2.0","id":999,
            "result":{
                "generation":1,"runId":"run-1","phase":"running",
                "operational":{"labels":{},"logLevel":"info","dispatchState":"suspended","inFlight":0},
                "atCursor":"cursor-2","deduped":false
            }
        })
        .to_string())
    }
}

#[tokio::test]
async fn lifecycle_rejects_wrong_response_identity() {
    let error = ClusterClient::new(WrongResponseIdentity)
        .update(UpdateParams {
            labels: None,
            log_level: None,
            suspended: Some(true),
            if_generation: generation(),
            idempotency_key: IdempotencyKey::new("suspend").assert_value(),
        })
        .await
        .assert_error();
    assert!(matches!(
        error,
        ClientError::InvalidResponse(message) if message.contains("response id mismatch")
    ));
}
