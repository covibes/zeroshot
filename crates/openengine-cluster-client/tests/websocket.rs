//! Client-side WebSocket transport: exercises `WebSocketTransport` -- the production WebSocket
//! counterpart to `NdjsonTransport` -- against a real `serve_websocket` server for unary
//! round-trips, `WatchSubscriptionClient` event/closed transcripts (slow-consumer overflow and
//! gap-free reconnect), `subscription/cancel`, and best-effort `$/cancelRequest` in-flight
//! cancellation. The counterpart of `openengine-cluster-server`'s own `tests/websocket.rs`, which
//! drives the same `serve_websocket` binding from raw tungstenite frames instead of this crate's
//! typed client.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use openengine_cluster_client::{
    ClusterClient, JsonRpcTransport, SubscriptionTransport, WebSocketTransport,
};
use openengine_cluster_protocol::{
    GetParams, GetResult, InitializeParams, InitializeResult, RequestId, RunId, WatchEvent,
    WatchParams, PROTOCOL_VERSION,
};
use openengine_cluster_server::watch::fixtures::{
    await_websocket_shutdown, spawn_websocket, FixtureBackend, FixtureStore,
};
use openengine_cluster_server::watch::{WatchEventStream, WatchHandle};
use openengine_cluster_server::{BackendError, ClusterBackend, ConnectionContext};
use serde_json::json;
use tokio::io::DuplexStream;
use tokio::sync::Notify;

#[path = "reconnect_support/mod.rs"]
mod reconnect_support;
use reconnect_support::FIXTURE_QUEUE_CAPACITY;

#[path = "reconnect_support/scenario_harness.rs"]
mod scenario_harness;

#[path = "reconnect_support/cancel_scenario.rs"]
mod cancel_scenario;
use cancel_scenario::run_cancel_stops_delivery_scenario;

#[path = "reconnect_support/websocket_scenario.rs"]
mod websocket_scenario;
use websocket_scenario::websocket_overflow_and_reconnect_scenario;

#[tokio::test]
async fn unary_initialize_and_get_round_trip_over_websocket_transport() {
    let store = Arc::new(FixtureStore::new(RunId::new("run-1"), Vec::new(), 8));
    let (ws, server) = spawn_websocket(FixtureBackend::new(store)).await;
    let transport = WebSocketTransport::new(ws);
    let client = ClusterClient::new(&transport);

    let init = client.initialize().await.unwrap();
    assert_eq!(init.protocol_version, PROTOCOL_VERSION);
    let get_result = client.get(GetParams::default()).await.unwrap();
    assert!(get_result.spec.is_none());

    drop(transport);
    await_websocket_shutdown(server).await;
}

#[tokio::test]
async fn reconnect_after_slow_consumer_recovers_with_no_gap_and_dedups_duplicates_over_websocket() {
    websocket_overflow_and_reconnect_scenario(RunId::new("run-1"), FIXTURE_QUEUE_CAPACITY, || {
        WatchEvent::Bookmark
    })
    .await;
}

// `cancel()` only writes a fire-and-forget notification -- it does not wait for the server to
// have applied it. `run_cancel_stops_delivery_scenario` forces a synchronous `get` round trip on
// the same connection so the subsequent publishes are guaranteed to happen only after the
// server's read loop has already processed (and synchronously applied) the preceding cancel,
// mirroring `subscription_ndjson.rs`'s identical NDJSON cancel test.
#[tokio::test]
async fn cancel_subscription_ends_the_stream_over_websocket() {
    run_cancel_stops_delivery_scenario::<WebSocketTransport<DuplexStream>>().await;
}

/// Wraps [`FixtureBackend`], gating only `get` on an explicit [`Notify`] and counting only calls
/// that actually complete past the gate -- so a `$/cancelRequest`-aborted call can never bump the
/// counter, letting a test prove no backend effect occurred. `initialize` is left ungated so a
/// test can prove the connection remains usable after aborting a gated `get`.
struct GatedBackend {
    inner: FixtureBackend,
    gate: Arc<Notify>,
    completed_gets: Arc<AtomicUsize>,
}

#[async_trait]
impl ClusterBackend for GatedBackend {
    async fn initialize(
        &self,
        context: &ConnectionContext,
        params: InitializeParams,
    ) -> Result<InitializeResult, BackendError> {
        self.inner.initialize(context, params).await
    }

    async fn get(
        &self,
        context: &ConnectionContext,
        params: GetParams,
    ) -> Result<GetResult, BackendError> {
        self.gate.notified().await;
        let result = self.inner.get(context, params).await;
        self.completed_gets.fetch_add(1, Ordering::SeqCst);
        result
    }

    async fn watch(
        &self,
        context: &ConnectionContext,
        params: WatchParams,
        queue_capacity: usize,
    ) -> Result<WatchResultTriple, BackendError> {
        self.inner.watch(context, params, queue_capacity).await
    }
}

type WatchResultTriple = (
    openengine_cluster_protocol::WatchResult,
    WatchEventStream,
    WatchHandle,
);

#[tokio::test]
async fn cancel_request_aborts_in_flight_response_with_no_effect_and_keeps_connection_usable() {
    let store = Arc::new(FixtureStore::new(RunId::new("run-1"), Vec::new(), 8));
    let completed_gets = Arc::new(AtomicUsize::new(0));
    let gate = Arc::new(Notify::new());
    let (ws, server) = spawn_websocket(GatedBackend {
        inner: FixtureBackend::new(store),
        gate: Arc::clone(&gate),
        completed_gets: Arc::clone(&completed_gets),
    })
    .await;
    let transport = WebSocketTransport::new(ws);

    let request = json!({
        "jsonrpc": "2.0", "id": "gated-get", "method": "get", "params": {}
    })
    .to_string();
    let mut pending = transport.request(request);
    tokio::select! {
        _ = &mut pending => panic!("gated get must not resolve before its gate is released"),
        () = tokio::time::sleep(Duration::from_millis(50)) => {}
    }

    // AC5: best-effort `$/cancelRequest` aborts response delivery for the in-flight request.
    transport
        .cancel_request(RequestId::String("gated-get".to_owned()))
        .await
        .unwrap();

    let outcome = tokio::time::timeout(Duration::from_millis(300), pending).await;
    assert!(outcome.is_err(), "a cancelled request must never resolve");
    assert_eq!(
        completed_gets.load(Ordering::SeqCst),
        0,
        "committed backend state must be unchanged -- the aborted call must never have completed"
    );

    // AC5: the connection remains usable after the cancellation.
    ClusterClient::new(&transport).initialize().await.unwrap();

    drop(transport);
    await_websocket_shutdown(server).await;
}
