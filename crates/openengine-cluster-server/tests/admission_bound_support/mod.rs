//! Transport-generic duplicate-in-flight-id and bounded-task-admission scenarios, used identically
//! by `tests/subscription_ndjson.rs` (over NDJSON) and `tests/websocket.rs` (over WebSocket) since
//! both drive the exact same admission/dedup behavior against the shared `Dispatcher`/
//! connection-task machinery, independent of wire framing.

use std::sync::Arc;
use std::time::Duration;

use openengine_cluster_protocol::RunId;
use openengine_cluster_server::watch::fixtures::{FixtureBackend, FixtureStore};
use serde_json::Value;
use tokio::sync::Notify;

use crate::gated_backend_support::GatedBackend;

/// Minimal capability both wire harnesses share: writing a `get` request with a given id and
/// reading the next decoded JSON-RPC frame, regardless of wire framing (NDJSON lines vs WebSocket
/// text frames).
pub trait RequestChannel {
    async fn send_get(&mut self, id: i64);
    async fn recv_value(&mut self) -> Value;
}

/// Spawn glue letting [`spawn_gated_harness`] construct any wire harness `H` against a fresh
/// gated backend without each binding needing its own copy of that setup.
pub trait GatedHarnessSpawn: Sized {
    async fn spawn_gated(backend: GatedBackend) -> Self;
}

/// Constructs a fresh `FixtureStore`/[`GatedBackend`] pair (gating only `get`) and spawns `H`
/// against it, returning the harness alongside the gate so a test can release it once its
/// in-flight-request assertions are set up.
pub async fn spawn_gated_harness<H: GatedHarnessSpawn>() -> (H, Arc<Notify>) {
    let store = Arc::new(FixtureStore::new(RunId::new("run-1"), Vec::new(), 8));
    let gate = Arc::new(Notify::new());
    let harness = H::spawn_gated(GatedBackend {
        inner: FixtureBackend::new(store),
        gate: Arc::clone(&gate),
    })
    .await;
    (harness, gate)
}

/// Sends two `get` requests sharing request id `1` while `gate` blocks the first from completing,
/// asserts the second is rejected as a synchronous `DUPLICATE_REQUEST_ID` error (the first request
/// is still blocked on the gate, so the only frame that can possibly exist yet is the duplicate
/// rejection for the second), then releases the gate and asserts the first request completes
/// normally.
pub async fn assert_duplicate_in_flight_ids_are_rejected<H: RequestChannel>(
    harness: &mut H,
    gate: &Notify,
) {
    harness.send_get(1).await;
    harness.send_get(1).await;

    let duplicate = harness.recv_value().await;
    assert_eq!(duplicate["id"], 1);
    assert_eq!(duplicate["error"]["code"], -32600);
    assert_eq!(duplicate["error"]["data"]["code"], "DUPLICATE_REQUEST_ID");

    gate.notify_one();
    let first = harness.recv_value().await;
    assert_eq!(first["id"], 1);
    assert!(first.get("result").is_some(), "{first}");
}

/// Sends `max_connection_tasks + 1` distinct-id `get` requests, all blocked on `harness`'s gated
/// backend, and asserts the request past the bound is rejected with a synchronous `SERVER_BUSY`
/// error that does not wait for any of the blocked backend calls to complete.
pub async fn assert_excess_requests_are_rejected_with_server_busy<H: RequestChannel>(
    harness: &mut H,
    max_connection_tasks: i64,
) {
    for id in 1..=max_connection_tasks + 1 {
        harness.send_get(id).await;
    }

    let rejected = tokio::time::timeout(Duration::from_secs(1), harness.recv_value())
        .await
        .expect("the bounded admission rejection must not wait for blocked backend calls");
    assert_eq!(rejected["id"], max_connection_tasks + 1);
    assert_eq!(rejected["error"]["code"], -32000);
    assert_eq!(rejected["error"]["data"]["code"], "SERVER_BUSY");
}
