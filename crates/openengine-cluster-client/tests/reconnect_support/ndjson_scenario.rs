//! End-to-end NDJSON overflow/reconnect scenario, shared by `tests/subscription_ndjson.rs`
//! (`Bookmark`) and `tests/backend_faults.rs` (`fault`) so the two scenarios stay byte-for-byte
//! identical apart from the published event. Kept separate from `reconnect_support/mod.rs` so
//! `tests/reconnect.rs`, which drives the in-process `WatchClient` instead of NDJSON, doesn't
//! need to compile or reference NDJSON-only wiring it never calls. The scenario body itself lives
//! in `scenario_harness`'s transport-generic `run_overflow_and_reconnect_scenario`; this module
//! only wires `NdjsonTransport`'s spawn/shutdown into that shared driver.

use std::io;

use openengine_cluster_client::NdjsonTransport;
use openengine_cluster_protocol::{RunId, WatchEvent};
use openengine_cluster_server::watch::fixtures::{await_ndjson_shutdown, spawn_ndjson, FixtureBackend};
use tokio::io::DuplexStream;
use tokio::task::JoinHandle;

use crate::scenario_harness::{run_overflow_and_reconnect_scenario, ScenarioTransport};

impl ScenarioTransport for NdjsonTransport<DuplexStream, DuplexStream> {
    async fn spawn(backend: FixtureBackend) -> (Self, JoinHandle<io::Result<()>>) {
        let (client_write, client_read, server) = spawn_ndjson(backend);
        (NdjsonTransport::new(client_read, client_write), server)
    }

    async fn shutdown(server: JoinHandle<io::Result<()>>) {
        await_ndjson_shutdown(server).await;
    }
}

/// Connects a fresh `FixtureStore`/`serve_ndjson` pair for `run_id` with the given subscription
/// queue `capacity`, then drives the full overflow / reconnect / dedup sequence with `event()` as
/// the published `WatchEvent`.
pub async fn ndjson_overflow_and_reconnect_scenario(
    run_id: RunId,
    capacity: usize,
    event: impl FnMut() -> WatchEvent,
) {
    run_overflow_and_reconnect_scenario::<NdjsonTransport<DuplexStream, DuplexStream>>(
        run_id, capacity, event,
    )
    .await;
}
