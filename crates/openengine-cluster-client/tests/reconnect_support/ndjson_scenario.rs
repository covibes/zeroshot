//! End-to-end NDJSON overflow/reconnect scenario, shared by `tests/subscription_ndjson.rs`
//! (`Bookmark`) and `tests/backend_faults.rs` (`fault`) so the two scenarios stay byte-for-byte
//! identical apart from the published event. Kept separate from `reconnect_support/mod.rs` so
//! `tests/reconnect.rs`, which drives the in-process `WatchClient` instead of NDJSON, doesn't
//! need to compile or reference NDJSON-only wiring it never calls.

use std::sync::Arc;

use openengine_cluster_client::{NdjsonTransport, NdjsonWatchClient};
use openengine_cluster_protocol::{RunId, WatchEvent, WatchParams};
use openengine_cluster_server::watch::fixtures::{
    await_ndjson_shutdown, spawn_ndjson, FixtureBackend, FixtureStore,
};

use crate::reconnect_support::{assert_reconnect_replays_and_dedups, overflow_and_close_with};

/// Connects a fresh `FixtureStore`/`serve_ndjson` pair for `run_id` with the given subscription
/// queue `capacity`, then drives the full overflow / reconnect / dedup sequence with `event()` as
/// the published `WatchEvent`.
pub async fn ndjson_overflow_and_reconnect_scenario(
    run_id: RunId,
    capacity: usize,
    mut event: impl FnMut() -> WatchEvent,
) {
    let store = Arc::new(FixtureStore::new(run_id.clone(), Vec::new(), capacity));
    let (client_write, client_read, server) = spawn_ndjson(FixtureBackend::new(Arc::clone(&store)));

    let transport = NdjsonTransport::new(client_read, client_write);
    let watch_client = NdjsonWatchClient::new(&transport);
    let (result, mut stream) = watch_client.watch(WatchParams::default()).await.unwrap();
    assert_eq!(result.run_id, Some(run_id));

    let received = overflow_and_close_with(&store, &mut stream, &mut event).await;

    let (_result, mut stream) = stream.reconnect().await.unwrap();
    assert_reconnect_replays_and_dedups(&store, &mut stream, received).await;

    drop(stream);
    drop(transport);
    await_ndjson_shutdown(server).await;
}
