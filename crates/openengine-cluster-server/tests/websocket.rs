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
    assert_duplicate_cancellation_is_malformed, assert_duplicate_in_flight_ids_are_rejected,
    assert_excess_requests_are_rejected_with_server_busy,
    assert_malformed_frame_is_dropped_at_task_saturation,
    assert_subscription_envelope_validation_for_binding,
    assert_wrong_version_envelope_retains_duplicate_precedence, spawn_gated_harness,
    DuplicateCancellationChannel, GatedHarnessSpawn, RequestChannel, SubscriptionCountingBackend,
    SubscriptionValidationHarness,
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
    client.send(Message::text(text.into())).await.assert_value();
}

async fn recv_text(client: &mut WebSocketStream<DuplexStream>) -> String {
    let message = client.next().await.assert_value().assert_value();
    match message {
        Message::Text(text) => Some(text.to_string()),
        _ => None,
    }
    .assert_value()
}

async fn recv_json(client: &mut WebSocketStream<DuplexStream>) -> Value {
    serde_json::from_str(&recv_text(client).await).assert_value()
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

async fn assert_frame_closes(message: Message, expected_code: CloseCode) {
    let store = Arc::new(FixtureStore::new(RunId::new("run-1"), Vec::new(), 8));
    let mut harness = spawn_server(FixtureBackend::new(store)).await;
    harness.client.send(message).await.assert_value();
    let close = tokio::time::timeout(Duration::from_secs(1), harness.client.next())
        .await
        .assert_value();
    let frame = match close {
        Some(Ok(Message::Close(Some(frame)))) => Some(frame),
        _ => None,
    }
    .assert_value();
    assert_eq!(frame.code, expected_code);
    shut_down(harness).await;
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
    let in_process_init: Value =
        serde_json::from_str(&in_process.dispatch(&init_request).await).assert_value();
    let in_process_get: Value =
        serde_json::from_str(&in_process.dispatch(&get_request).await).assert_value();

    assert_eq!(ws_init_response, in_process_init);
    assert_eq!(ws_get_response, in_process_get);

    shut_down(harness).await;
}

#[tokio::test]
async fn binary_frame_closes_with_unsupported_data_code() {
    assert_frame_closes(
        Message::Binary(vec![1, 2, 3].into()),
        CloseCode::Unsupported,
    )
    .await;
}

#[tokio::test]
async fn oversized_text_frame_closes_with_message_too_big_code() {
    // The client has no outgoing size cap of its own; the server's `websocket_config()` bounds the
    // *receiving* side, so this exercises that bound deterministically.
    let oversized = "a".repeat(OVERSIZED_TEXT_BYTES);
    assert_frame_closes(Message::text(oversized), CloseCode::Size).await;
}

#[tokio::test]
async fn malformed_json_frame_receives_parse_error_without_closing() {
    let store = Arc::new(FixtureStore::new(RunId::new("run-1"), Vec::new(), 8));
    let mut harness = spawn_server(FixtureBackend::new(store)).await;

    send_text(&mut harness.client, "not valid json").await;
    let error_response = recv_json(&mut harness.client).await;
    assert_eq!(error_response.assert_at("error").assert_at("code"), -32700);

    // The connection must remain usable after the parse error.
    send_text(&mut harness.client, request_text(9, "get", json!({}))).await;
    let get_response = recv_json(&mut harness.client).await;
    assert_eq!(get_response.assert_at("id"), 9);
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
            .assert_value();
    assert_eq!(get_response.assert_at("id"), 1);
    assert!(get_response.get("result").is_some(), "{get_response}");

    shut_down(harness).await;
}

impl RequestChannel for Harness {
    async fn send_get(&mut self, id: i64) {
        send_text(&mut self.client, request_text(id, "get", json!({}))).await;
    }

    async fn send_raw(&mut self, text: &str) {
        send_text(&mut self.client, text).await;
    }

    async fn recv_raw(&mut self) -> String {
        recv_text(&mut self.client).await
    }

    async fn recv_value(&mut self) -> Value {
        recv_json(&mut self.client).await
    }
}

impl GatedHarnessSpawn for Harness {
    async fn spawn_gated(backend: GatedBackend) -> Self {
        spawn_server(backend).await
    }

    async fn shut_down(self) {
        shut_down(self).await;
    }
}

impl SubscriptionValidationHarness for Harness {
    async fn spawn_subscription_validation(backend: SubscriptionCountingBackend) -> Self {
        spawn_server(backend).await
    }
}

struct WebsocketDuplicateCancellation<'a> {
    harness: &'a mut Harness,
    gate: Arc<tokio::sync::Notify>,
}

impl DuplicateCancellationChannel for WebsocketDuplicateCancellation<'_> {
    async fn arrange_targets(&mut self) {
        self.harness.send_get(1).await;
        self.harness.send_get(2).await;
    }

    async fn send_duplicate_cancellation(&mut self) {
        self.harness
            .send_raw(r#"{"jsonrpc":"2.0","method":"$/cancelRequest","params":{"id":1,"id":2}}"#)
            .await;
    }

    async fn recv_raw(&mut self) -> String {
        self.harness.recv_raw().await
    }

    async fn assert_targets_remain_active(&mut self) {
        let mut completed_ids = Vec::new();
        for _ in 0..2 {
            self.gate.notify_one();
            completed_ids.push(
                self.harness
                    .recv_value()
                    .await
                    .assert_at("id")
                    .as_i64()
                    .assert_value(),
            );
        }
        completed_ids.sort_unstable();
        assert_eq!(completed_ids, [1, 2]);
    }

    async fn assert_unknown_member_cancellation_is_accepted(&mut self) {
        self.harness.send_get(3).await;
        self.harness
            .send_raw(
                r#"{"jsonrpc":"2.0","method":"$/cancelRequest","params":{"id":3},"extension":true}"#,
            )
            .await;
        self.harness
            .send_raw(
                r#"{"jsonrpc":"2.0","id":99,"method":"initialize","params":{"protocolVersion":"openengine.cluster/v1"}}"#,
            )
            .await;
        let sync = self.harness.recv_value().await;
        assert_eq!(sync.assert_at("id"), 99);
        assert!(sync.get("result").is_some(), "{sync}");
        assert!(
            tokio::time::timeout(Duration::from_millis(100), self.harness.recv_raw())
                .await
                .is_err(),
            "$/cancelRequest with an unknown top-level member must cancel the request"
        );
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

#[tokio::test]
async fn wrong_version_envelope_retains_duplicate_id_precedence() {
    let (mut harness, gate) = spawn_gated_harness::<Harness>().await;
    assert_wrong_version_envelope_retains_duplicate_precedence(&mut harness, &gate).await;
    shut_down(harness).await;
}

#[tokio::test]
async fn wrong_version_subscription_methods_are_invalid_requests() {
    assert_subscription_envelope_validation_for_binding::<Harness>().await;
}

#[tokio::test]
async fn malformed_frame_remains_subject_to_task_slot_saturation() {
    let (mut harness, _gate) = spawn_gated_harness::<Harness>().await;
    assert_malformed_frame_is_dropped_at_task_saturation(&mut harness, MAX_CONNECTION_TASKS).await;
    shut_down(harness).await;
}

#[tokio::test]
async fn duplicate_cancel_request_keys_are_malformed_and_cancel_nothing() {
    let (mut harness, gate) = spawn_gated_harness::<Harness>().await;
    {
        let mut channel = WebsocketDuplicateCancellation {
            harness: &mut harness,
            gate,
        };
        assert_duplicate_cancellation_is_malformed(&mut channel).await;
    }
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
    assert_eq!(duplicate.assert_at("id"), id);
    assert_eq!(duplicate.assert_at("error").assert_at("code"), -32600);
    assert_eq!(
        duplicate
            .assert_at("error")
            .assert_at("data")
            .assert_at("code"),
        "DUPLICATE_REQUEST_ID"
    );

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
    assert_eq!(sync_response.assert_at("id"), sync_id);
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
        .assert_value();
    assert_eq!(reused.assert_at("id"), 1);
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
        .assert_value();
    assert_eq!(completed.assert_at("id"), 1);
    assert!(completed.get("result").is_some(), "{completed}");

    shut_down(harness).await;
}
#[path = "support/assert_value.rs"]
mod assert_value;
use assert_value::AssertValue;
#[path = "support/assert_at.rs"]
mod assert_at;
use assert_at::AssertAt;
