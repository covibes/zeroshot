//! WebSocket transport end-to-end coverage: unary dispatch byte-equivalence with the in-process
//! `Dispatcher`, bounded-frame framing (binary rejection, oversize close, malformed-JSON
//! tolerance), `$/cancelRequest` no-op semantics, duplicate in-flight request ids, and bounded
//! task admission -- the WebSocket counterparts of `tests/subscription_ndjson.rs`'s NDJSON
//! coverage, driven over raw tungstenite frames instead of NDJSON lines so binary/oversize/
//! malformed framing can be crafted directly.

use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use openengine_cluster_protocol::RunId;
use openengine_cluster_server::watch::fixtures::{
    await_websocket_shutdown, spawn_websocket, FixtureBackend, FixtureStore,
};
use openengine_cluster_server::{ClusterBackend, ConnectionContext, Dispatcher};
use serde_json::{json, Value};
use tokio::io::DuplexStream;
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::WebSocketStream;

#[path = "gated_backend_support/mod.rs"]
mod gated_backend_support;
use gated_backend_support::GatedBackend;

#[path = "admission_bound_support/mod.rs"]
mod admission_bound_support;
use admission_bound_support::{
    assert_duplicate_in_flight_ids_are_rejected,
    assert_excess_requests_are_rejected_with_server_busy, spawn_gated_harness, GatedHarnessSpawn,
    RequestChannel,
};

/// Matches `serve_websocket`'s documented `MAX_FRAME_BYTES` bound; hardcoded rather than imported
/// since it is an internal implementation detail, not part of the public contract (mirrors
/// `tests/subscription_ndjson.rs`'s identical `OVERSIZED_LINE_BYTES` convention).
const OVERSIZED_TEXT_BYTES: usize = 1024 * 1024 + 16;
const MAX_CONNECTION_TASKS: i64 = 256;

struct Harness {
    client: WebSocketStream<DuplexStream>,
    server: JoinHandle<std::io::Result<()>>,
}

async fn spawn_server<B>(backend: B) -> Harness
where
    B: ClusterBackend,
{
    let (client, server) = spawn_websocket(backend).await;
    Harness { client, server }
}

async fn send_text(client: &mut WebSocketStream<DuplexStream>, text: impl Into<String>) {
    client.send(Message::text(text.into())).await.unwrap();
}

async fn recv_json(client: &mut WebSocketStream<DuplexStream>) -> Value {
    match client
        .next()
        .await
        .expect("connection closed unexpectedly while awaiting a frame")
    {
        Ok(Message::Text(text)) => serde_json::from_str(&text).unwrap(),
        Ok(other) => panic!("expected a text frame, got {other:?}"),
        Err(error) => panic!("websocket read failed: {error}"),
    }
}

fn request_text(id: i64, method: &str, params: Value) -> String {
    json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}).to_string()
}

async fn shut_down(harness: Harness) {
    let Harness { mut client, server } = harness;
    // A real close handshake exercises `Message::Close -> break`, the same deterministic shutdown
    // path a well-behaved peer takes; already-closed connections (the binary/oversize tests) just
    // ignore the resulting error.
    let _ = client.close(None).await;
    drop(client);
    await_websocket_shutdown(server).await;
}

#[tokio::test]
async fn unary_initialize_and_get_match_in_process_dispatch() {
    let store = Arc::new(FixtureStore::new(RunId::new("run-1"), Vec::new(), 8));
    let mut harness = spawn_server(FixtureBackend::new(Arc::clone(&store))).await;

    let init_request = request_text(
        1,
        "initialize",
        json!({"protocolVersion": "openengine.cluster/v1"}),
    );
    send_text(&mut harness.client, init_request.clone()).await;
    let ws_init_response = recv_json(&mut harness.client).await;

    let get_request = request_text(2, "get", json!({}));
    send_text(&mut harness.client, get_request.clone()).await;
    let ws_get_response = recv_json(&mut harness.client).await;

    // AC1: in-process and WebSocket dispatcher results must be byte-equivalent for the same
    // request against an equivalently seeded backend.
    let in_process = Dispatcher::new(FixtureBackend::new(store), ConnectionContext::default());
    let in_process_init: Value = serde_json::from_str(&in_process.dispatch(&init_request).await)
        .expect("in-process initialize response must be valid JSON");
    let in_process_get: Value = serde_json::from_str(&in_process.dispatch(&get_request).await)
        .expect("in-process get response must be valid JSON");

    assert_eq!(ws_init_response, in_process_init);
    assert_eq!(ws_get_response, in_process_get);

    shut_down(harness).await;
}

#[tokio::test]
async fn binary_frame_closes_with_unsupported_data_code() {
    let store = Arc::new(FixtureStore::new(RunId::new("run-1"), Vec::new(), 8));
    let mut harness = spawn_server(FixtureBackend::new(store)).await;

    harness
        .client
        .send(Message::Binary(vec![1, 2, 3].into()))
        .await
        .unwrap();

    let close = tokio::time::timeout(Duration::from_secs(1), harness.client.next())
        .await
        .expect("server must close promptly on a binary frame");
    match close {
        Some(Ok(Message::Close(Some(frame)))) => assert_eq!(frame.code, CloseCode::Unsupported),
        other => panic!("expected a close frame with code 1003, got {other:?}"),
    }

    shut_down(harness).await;
}

#[tokio::test]
async fn oversized_text_frame_closes_with_message_too_big_code() {
    let store = Arc::new(FixtureStore::new(RunId::new("run-1"), Vec::new(), 8));
    let mut harness = spawn_server(FixtureBackend::new(store)).await;

    // The client has no outgoing size cap of its own; the server's `websocket_config()` bounds the
    // *receiving* side, so this exercises that bound deterministically.
    let oversized = "a".repeat(OVERSIZED_TEXT_BYTES);
    harness.client.send(Message::text(oversized)).await.unwrap();

    let close = tokio::time::timeout(Duration::from_secs(1), harness.client.next())
        .await
        .expect("server must close promptly on an oversized frame");
    match close {
        Some(Ok(Message::Close(Some(frame)))) => assert_eq!(frame.code, CloseCode::Size),
        other => panic!("expected a close frame with code 1009, got {other:?}"),
    }

    shut_down(harness).await;
}

#[tokio::test]
async fn malformed_json_frame_receives_parse_error_without_closing() {
    let store = Arc::new(FixtureStore::new(RunId::new("run-1"), Vec::new(), 8));
    let mut harness = spawn_server(FixtureBackend::new(store)).await;

    send_text(&mut harness.client, "not valid json").await;
    let error_response = recv_json(&mut harness.client).await;
    assert_eq!(error_response["error"]["code"], -32700);

    // The connection must remain usable after the parse error.
    send_text(&mut harness.client, request_text(9, "get", json!({}))).await;
    let get_response = recv_json(&mut harness.client).await;
    assert_eq!(get_response["id"], 9);
    assert!(get_response.get("result").is_some(), "{get_response}");

    shut_down(harness).await;
}

#[tokio::test]
async fn cancel_request_for_unknown_id_is_a_silent_no_op() {
    let store = Arc::new(FixtureStore::new(RunId::new("run-1"), Vec::new(), 8));
    let mut harness = spawn_server(FixtureBackend::new(store)).await;

    let cancel = json!({
        "jsonrpc": "2.0",
        "method": "$/cancelRequest",
        "params": {"id": "unknown-id"},
    })
    .to_string();
    send_text(&mut harness.client, cancel).await;

    // No response is emitted for the cancel notification itself; the connection must remain
    // usable, so a subsequent unary request completes normally.
    send_text(&mut harness.client, request_text(1, "get", json!({}))).await;
    let get_response =
        tokio::time::timeout(Duration::from_millis(500), recv_json(&mut harness.client))
            .await
            .expect("connection must remain usable after an unknown $/cancelRequest id");
    assert_eq!(get_response["id"], 1);
    assert!(get_response.get("result").is_some(), "{get_response}");

    shut_down(harness).await;
}

impl RequestChannel for Harness {
    async fn send_get(&mut self, id: i64) {
        send_text(&mut self.client, request_text(id, "get", json!({}))).await;
    }

    async fn recv_value(&mut self) -> Value {
        recv_json(&mut self.client).await
    }
}

impl GatedHarnessSpawn for Harness {
    async fn spawn_gated(backend: GatedBackend) -> Self {
        spawn_server(backend).await
    }
}

#[tokio::test]
async fn duplicate_in_flight_request_ids_are_rejected() {
    let (mut harness, gate) = spawn_gated_harness::<Harness>().await;

    assert_duplicate_in_flight_ids_are_rejected(&mut harness, &gate).await;

    shut_down(harness).await;
}

#[tokio::test]
async fn excess_requests_are_rejected_with_server_busy() {
    let (mut harness, _gate) = spawn_gated_harness::<Harness>().await;

    assert_excess_requests_are_rejected_with_server_busy(&mut harness, MAX_CONNECTION_TASKS).await;

    shut_down(harness).await;
}

/// Sends `get(id)` while `gate` blocks it, confirms admission via a duplicate-id rejection (which
/// can only exist once the first request's admission -- and, by construction, its cancel-registry
/// registration -- has already run), sends `$/cancelRequest(id)`, then proves the connection's
/// single reader loop has already processed that cancellation by round-tripping an unrelated,
/// ungated `initialize` request: message N+1 cannot have been read before message N finished
/// handling. Finally asserts no response for `id` ever arrives within a bounded window.
async fn cancel_pending_get_and_confirm_no_response(harness: &mut Harness, id: i64, sync_id: i64) {
    harness.send_get(id).await;
    harness.send_get(id).await;
    let duplicate = harness.recv_value().await;
    assert_eq!(duplicate["id"], id);
    assert_eq!(duplicate["error"]["code"], -32600);
    assert_eq!(duplicate["error"]["data"]["code"], "DUPLICATE_REQUEST_ID");

    let cancel = json!({
        "jsonrpc": "2.0",
        "method": "$/cancelRequest",
        "params": {"id": id},
    })
    .to_string();
    send_text(&mut harness.client, cancel).await;

    send_text(
        &mut harness.client,
        request_text(
            sync_id,
            "initialize",
            json!({"protocolVersion": "openengine.cluster/v1"}),
        ),
    )
    .await;
    let sync_response = recv_json(&mut harness.client).await;
    assert_eq!(sync_response["id"], sync_id);
    assert!(sync_response.get("result").is_some(), "{sync_response}");

    let no_response = tokio::time::timeout(Duration::from_millis(500), harness.client.next()).await;
    assert!(
        no_response.is_err(),
        "cancelled request {id} must never emit a response, got {no_response:?}"
    );
}

#[tokio::test]
async fn cancelled_pending_request_releases_its_id_and_never_emits_a_response() {
    let (mut harness, gate) = spawn_gated_harness::<Harness>().await;

    cancel_pending_get_and_confirm_no_response(&mut harness, 1, 99).await;

    // AC1: id 1 must be free for reuse once its cancelled predecessor has cleaned up, rather than
    // being rejected forever as a duplicate.
    harness.send_get(1).await;
    gate.notify_one();
    let reused = tokio::time::timeout(Duration::from_secs(1), harness.recv_value())
        .await
        .expect("id 1 must be reusable once its cancelled predecessor has cleaned up");
    assert_eq!(reused["id"], 1);
    assert!(reused.get("result").is_some(), "{reused}");

    shut_down(harness).await;
}

#[tokio::test]
async fn cancelled_request_id_remains_independently_cancellable_after_reuse() {
    let (mut harness, gate) = spawn_gated_harness::<Harness>().await;

    // A: cancel request id 1.
    cancel_pending_get_and_confirm_no_response(&mut harness, 1, 100).await;

    // B: reuse id 1 -- AC1 (admitted, not DUPLICATE_REQUEST_ID) plus AC4: an old request's cleanup
    // must never disturb a newer same-id request's own cancel-registry registration, so B must
    // remain independently cancellable on its own merits.
    cancel_pending_get_and_confirm_no_response(&mut harness, 1, 101).await;

    // C: reuse id 1 once more, this time letting it complete normally end to end.
    harness.send_get(1).await;
    gate.notify_one();
    let completed = tokio::time::timeout(Duration::from_secs(1), harness.recv_value())
        .await
        .expect("id 1 must remain reusable and completable after two cancellations");
    assert_eq!(completed["id"], 1);
    assert!(completed.get("result").is_some(), "{completed}");

    shut_down(harness).await;
}
