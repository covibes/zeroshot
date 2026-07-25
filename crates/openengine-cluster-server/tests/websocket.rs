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
async fn cancel_request_releases_in_flight_id_and_permits_id_reuse() {
    let (mut harness, gate) = spawn_gated_harness::<Harness>().await;

    // Blocks on the gate: this request never completes, so its `in_flight_ids`/`cancel_registry`
    // entries can only be released via the cancellation path, never via normal fall-through.
    harness.send_get(1).await;

    let cancel = json!({
        "jsonrpc": "2.0",
        "method": "$/cancelRequest",
        "params": {"id": 1},
    })
    .to_string();
    send_text(&mut harness.client, cancel).await;

    // `AbortHandle::abort()` only schedules the target task's cancellation; the guard that
    // releases `in_flight_ids` runs whenever the runtime actually gets around to polling (and
    // dropping) that task, not synchronously when `abort()` returns. Poll for the id becoming
    // reusable via bounded cooperative retries rather than a fixed sleep: a duplicate rejection is
    // a harmless, synchronous no-op (it never touches `in_flight_ids`, so resending is safe), and
    // it always arrives promptly since it never waits on the still-closed gate -- whereas an
    // *accepted* retry's task immediately blocks on that same still-closed gate exactly like the
    // original did, so it produces no prompt response at all. That absence, not its content,
    // is what distinguishes "admitted" from "still rejected" here, deterministically regardless
    // of scheduler load. The attempt cap still fails the test if the id is never released -- the
    // exact pre-fix bug (a cancelled request permanently reserving its id).
    let mut accepted = false;
    for attempt in 0..100_000 {
        harness.send_get(1).await;
        match tokio::time::timeout(Duration::from_millis(50), harness.recv_value()).await {
            Ok(response) => {
                assert_eq!(response["id"], 1);
                assert_eq!(
                    response["error"]["data"]["code"], "DUPLICATE_REQUEST_ID",
                    "a prompt response before the gate is released can only be a duplicate \
                     rejection (a real result would block on the still-closed gate); got \
                     {response}"
                );
                assert!(
                    attempt < 99_999,
                    "id 1 was never released after cancellation settled -- it is still \
                     permanently reserved in in_flight_ids"
                );
                tokio::task::yield_now().await;
            }
            Err(_) => {
                // No prompt response: this retry was admitted and its task is now parked on the
                // gate, exactly like the original was before cancellation.
                accepted = true;
                break;
            }
        }
    }
    assert!(accepted, "id 1 was never accepted for reuse");

    // Releasing the gate now only unblocks the accepted retry's still-pending backend call; no
    // response frame was ever emitted for the original cancelled request, so this is the only
    // frame left to receive.
    gate.notify_one();
    let second = tokio::time::timeout(Duration::from_secs(1), harness.recv_value())
        .await
        .expect("the accepted retry must complete once the gate is released");
    assert_eq!(second["id"], 1);
    assert!(second.get("result").is_some(), "{second}");

    shut_down(harness).await;
}

#[tokio::test]
async fn fast_completions_do_not_leak_or_corrupt_cancel_registry() {
    let store = Arc::new(FixtureStore::new(RunId::new("run-1"), Vec::new(), 8));
    let mut harness = spawn_server(FixtureBackend::new(store)).await;

    // Ungated backend: each `get` resolves as fast as the runtime allows. Repeatedly reusing the
    // same id and firing a `$/cancelRequest` immediately after each completion -- when the id is
    // already fully released and the notification can only ever hit an unknown-or-completed id --
    // is a high-volume regression/sanity net for that exact "silent no-op" contract and for the
    // general fast-completion-plus-cancellation interaction: every iteration must still receive
    // its own correct, uncorrupted response and the connection must never misbehave (unexpected
    // close, mismatched response, panic, deadlock) across 200 rapid cycles.
    for _ in 0..200 {
        send_text(&mut harness.client, request_text(1, "get", json!({}))).await;
        let response = tokio::time::timeout(Duration::from_secs(1), recv_json(&mut harness.client))
            .await
            .expect("each fast completion must receive its own uncorrupted response");
        assert_eq!(response["id"], 1);
        assert!(response.get("result").is_some(), "{response}");

        let cancel = json!({
            "jsonrpc": "2.0",
            "method": "$/cancelRequest",
            "params": {"id": 1},
        })
        .to_string();
        send_text(&mut harness.client, cancel).await;
    }

    shut_down(harness).await;
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
