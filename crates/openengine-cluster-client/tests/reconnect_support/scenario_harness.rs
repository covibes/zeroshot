//! Transport-generic driver for the shared overflow/reconnect/dedup scenario in
//! `reconnect_support::mod`, used by `ndjson_scenario` and `websocket_scenario` so every wire
//! binding runs the exact same scenario body instead of each copying it. Kept out of
//! `reconnect_support/mod.rs` (rather than folded in) so `tests/reconnect.rs`, which drives the
//! in-process `WatchClient` and never spawns a wire transport, doesn't need to compile or
//! reference this wire-only glue.

use std::io;
use std::sync::Arc;

use openengine_cluster_client::{SubscriptionTransport, WatchSubscriptionClient};
use openengine_cluster_protocol::{RunId, WatchEvent, WatchParams};
use openengine_cluster_server::watch::fixtures::{FixtureBackend, FixtureStore};
use tokio::task::JoinHandle;

use crate::reconnect_support::{assert_reconnect_replays_and_dedups, overflow_and_close_with};
use crate::support::AssertValue;

/// Spawn/shutdown glue letting [`run_overflow_and_reconnect_scenario`] (and, via
/// `cancel_scenario`, `run_cancel_stops_delivery_scenario`) drive identical scenarios over any
/// [`SubscriptionTransport`]-generic wire binding (NDJSON, WebSocket, ...) without each binding
/// needing its own copy of the scenario body.
pub trait ScenarioTransport: SubscriptionTransport + Sized {
    async fn spawn(backend: FixtureBackend) -> (Self, JoinHandle<io::Result<()>>);
    async fn shutdown(server: JoinHandle<io::Result<()>>);
}

/// Connects a fresh `FixtureStore`/`T` pair for `run_id` with the given subscription queue
/// `capacity`, then drives the full overflow / reconnect / dedup sequence with `event()` as the
/// published `WatchEvent`. Generic over [`ScenarioTransport`] so every wire binding shares this
/// exact scenario logic rather than duplicating it per transport.
pub async fn run_overflow_and_reconnect_scenario<T: ScenarioTransport>(
    run_id: RunId,
    capacity: usize,
    mut event: impl FnMut() -> WatchEvent,
) {
    let store = Arc::new(FixtureStore::new(run_id.clone(), Vec::new(), capacity));
    let (transport, server) = T::spawn(FixtureBackend::new(Arc::clone(&store))).await;

    let watch_client = WatchSubscriptionClient::new(&transport);
    let (result, mut stream) = watch_client
        .watch(WatchParams::default())
        .await
        .assert_value();
    assert_eq!(result.run_id, Some(run_id));

    let received = overflow_and_close_with(&store, &mut stream, &mut event).await;

    let (_result, mut stream) = stream.reconnect().await.assert_value();
    assert_reconnect_replays_and_dedups(&store, &mut stream, received).await;

    drop(stream);
    drop(transport);
    T::shutdown(server).await;
}
