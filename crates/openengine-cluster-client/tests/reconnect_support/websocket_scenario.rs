//! End-to-end WebSocket overflow/reconnect scenario, mirroring `reconnect_support::ndjson_scenario`
//! but driven over `WebSocketTransport` and `serve_websocket` instead of NDJSON, proving the two
//! wire bindings reproduce byte-equivalent event/cursor sequences through the exact same generic
//! `SubscriptionTransport`/`WatchSubscriptionClient` machinery. The scenario body itself lives in
//! `scenario_harness`'s transport-generic `run_overflow_and_reconnect_scenario`; this module only
//! wires `WebSocketTransport`'s spawn/shutdown into that shared driver.

use std::io;

use openengine_cluster_client::WebSocketTransport;
use openengine_cluster_protocol::{RunId, WatchEvent};
use openengine_cluster_server::watch::fixtures::{
    await_websocket_shutdown, spawn_websocket, FixtureBackend,
};
use tokio::io::DuplexStream;
use tokio::task::JoinHandle;

use crate::scenario_harness::{run_overflow_and_reconnect_scenario, ScenarioTransport};

impl ScenarioTransport for WebSocketTransport<DuplexStream> {
    async fn spawn(backend: FixtureBackend) -> (Self, JoinHandle<io::Result<()>>) {
        let (ws, server) = spawn_websocket(backend).await;
        (WebSocketTransport::new(ws), server)
    }

    async fn shutdown(server: JoinHandle<io::Result<()>>) {
        await_websocket_shutdown(server).await;
    }
}

/// Connects a fresh `FixtureStore`/`serve_websocket` pair for `run_id` with the given subscription
/// queue `capacity`, then drives the full overflow / reconnect / dedup sequence with `event()` as
/// the published `WatchEvent`.
pub async fn websocket_overflow_and_reconnect_scenario(
    run_id: RunId,
    capacity: usize,
    event: impl FnMut() -> WatchEvent,
) {
    run_overflow_and_reconnect_scenario::<WebSocketTransport<DuplexStream>>(
        run_id, capacity, event,
    )
    .await;
}
