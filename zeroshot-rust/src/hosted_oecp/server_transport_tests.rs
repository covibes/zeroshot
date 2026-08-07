use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::net::TcpStream;
use tokio::sync::oneshot;
use tokio::time::Duration;
use tokio_tungstenite::{
    client_async_with_config,
    tungstenite::{
        http::{Request, StatusCode},
        ClientRequestBuilder, Message,
    },
};

use super::run_intent_test_support::{bind_listener, test_backend, TestServices, CAPABILITY};
use super::server::OECP_WEBSOCKET_PORT;
use super::server_auth::TransportCapability;
use super::server_auth::RUNTIME_CAPABILITY_HEADER;
use super::server_transport::{resolve_websocket_identity, serve_prepared, HostedListeners};

#[test]
fn websocket_identity_forwards_zero_cloud_headers_under_runtime_capability() {
    let capability = TransportCapability::parse(CAPABILITY.as_bytes()).expect("capability");
    let expires_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock")
        .as_secs()
        + 30;
    let request = Request::builder()
        .uri("/oecp")
        .header(RUNTIME_CAPABILITY_HEADER, CAPABILITY)
        .header("x-zero-capsule-id", "capsule")
        .header("x-zero-organization-id", "organization")
        .header("x-zero-actor-handle", "actor")
        .header("x-capsule-grant-expires-at", expires_at.to_string())
        .body(())
        .expect("WebSocket request");

    let identity =
        resolve_websocket_identity(&request, &capability).expect("trusted identity forwards");
    assert_eq!(identity.principal().as_str(), "actor");
    assert_eq!(identity.tenant().as_str(), "organization");
    assert_eq!(
        identity.binding_attributes().get("capsule_id"),
        Some("capsule")
    );
    assert_eq!(identity.expires_at_ms(), expires_at * 1_000);

    let mut wrong_capability = request;
    wrong_capability.headers_mut().insert(
        RUNTIME_CAPABILITY_HEADER,
        "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"
            .parse()
            .expect("header value"),
    );
    let error = resolve_websocket_identity(&wrong_capability, &capability)
        .expect_err("wrong capability is rejected");
    assert_eq!(error.0, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn dedicated_websocket_listener_initializes_on_capsule_agent_route() {
    assert_eq!(OECP_WEBSOCKET_PORT, 8_083);
    let backend = Arc::new(test_backend(Arc::new(TestServices::default())));
    let ndjson = bind_listener().await;
    let websocket = bind_listener().await;
    let websocket_address = websocket.local_addr().expect("websocket address");
    let run_intent = bind_listener().await;
    let capability =
        Arc::new(TransportCapability::parse(CAPABILITY.as_bytes()).expect("transport capability"));
    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    let serving = tokio::spawn(serve_prepared(
        HostedListeners::new(ndjson, websocket, run_intent),
        backend,
        capability,
        async move {
            let _ = shutdown_rx.await;
        },
    ));

    let stream = TcpStream::connect(websocket_address)
        .await
        .expect("connect WebSocket listener");
    let expires_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock")
        .as_secs()
        + 30;
    let uri = format!("ws://{websocket_address}/oecp")
        .parse()
        .expect("WebSocket URI");
    let request = ClientRequestBuilder::new(uri)
        .with_header(RUNTIME_CAPABILITY_HEADER, CAPABILITY)
        .with_header("x-zero-capsule-id", "capsule")
        .with_header("x-zero-organization-id", "organization")
        .with_header("x-zero-actor-handle", "actor")
        .with_header("x-capsule-grant-expires-at", expires_at.to_string());
    let (mut socket, response) = client_async_with_config(request, stream, None)
        .await
        .expect("complete WebSocket handshake");
    assert_eq!(response.status(), 101);
    socket
        .send(Message::Text(
            r#"{"jsonrpc":"2.0","id":7,"method":"initialize","params":{"protocolVersion":"openengine.cluster/v1"}}"#
                .into(),
        ))
        .await
        .expect("send initialize");
    let initialized = next_json_response(&mut socket).await;
    assert_eq!(initialized["id"], 7);
    assert_eq!(
        initialized["result"]["capabilities"]["graphProfiles"],
        json!(["openengine.graph.single-worker/v1"])
    );
    socket.close(None).await.expect("close WebSocket");
    shutdown_tx.send(()).expect("request server shutdown");
    serving
        .await
        .expect("server task joins")
        .expect("server shuts down");
}

async fn next_json_response<S>(socket: &mut tokio_tungstenite::WebSocketStream<S>) -> Value
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let message = socket
                .next()
                .await
                .expect("WebSocket response")
                .expect("valid WebSocket frame");
            if let Ok(text) = message.into_text() {
                break serde_json::from_str(&text).expect("JSON-RPC response");
            }
        }
    })
    .await
    .expect("initialize response deadline")
}
