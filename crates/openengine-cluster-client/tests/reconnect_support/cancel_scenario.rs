//! Transport-generic driver for the shared `subscription/cancel`-stops-delivery scenario, used
//! directly by `tests/subscription_ndjson.rs` and `tests/websocket.rs`. Kept out of
//! `scenario_harness.rs` (rather than folded in) so `tests/backend_faults.rs`, which never
//! exercises `subscription/cancel`, doesn't need to compile or reference this scenario.

use std::sync::Arc;
use std::time::Duration;

use openengine_cluster_client::{ClusterClient, EventOrClosed, WatchSubscriptionClient};
use openengine_cluster_protocol::{Cursor, GetParams, RunId, WatchEvent, WatchParams};
use openengine_cluster_server::watch::fixtures::{FixtureBackend, FixtureStore};

use crate::scenario_harness::ScenarioTransport;
use crate::support::AssertValue;

/// Connects a fresh `FixtureStore`/`T` pair, cancels a live watch subscription after its first
/// event, and proves cancellation stops delivery: a synchronous `get` round trip on the same
/// connection forces the server to have already applied the preceding fire-and-forget
/// `subscription/cancel` (requests on one connection are read and handled strictly in order), then
/// at most one further event -- the one the server-side subscription task may already have been
/// parked awaiting when it observed cancellation -- may still leak before delivery stops for good.
/// Generic over [`ScenarioTransport`] so every wire binding shares this exact scenario logic
/// rather than duplicating it per transport.
pub async fn run_cancel_stops_delivery_scenario<T: ScenarioTransport>() {
    let run_id = RunId::new("run-1");
    let store = Arc::new(FixtureStore::new(run_id, Vec::new(), 8));
    let (transport, server) = T::spawn(FixtureBackend::new(Arc::clone(&store))).await;

    let watch_client = WatchSubscriptionClient::new(&transport);
    let (_result, mut stream) = watch_client
        .watch(WatchParams::default())
        .await
        .assert_value();

    store.publish(WatchEvent::Bookmark).await;
    let record = match stream.next().await.assert_value() {
        EventOrClosed::Event(record) => Some(record),
        EventOrClosed::Closed { .. } => None,
    }
    .assert_value_with("expected the first watch event");
    assert_eq!(record.cursor, Cursor::new("cursor-1"));

    stream.cancel().await.assert_value();

    ClusterClient::new(&transport)
        .get(GetParams::default())
        .await
        .assert_value();

    // The server-side subscription task may already be parked awaiting the next live event at
    // the moment cancellation is processed, so at most one further event (the one immediately
    // following cancellation) may still be delivered before it observes cancellation and stops
    // for good.
    for _ in 0..2 {
        store.publish(WatchEvent::Bookmark).await;
    }

    let mut leaked = Vec::new();
    while let Ok(Some(item)) = tokio::time::timeout(Duration::from_millis(300), stream.next()).await
    {
        let cursor = match item {
            EventOrClosed::Event(record) => Some(record.cursor),
            EventOrClosed::Closed { .. } => None,
        }
        .assert_value_with("expected only an event after cancellation");
        leaked.push(cursor);
    }
    assert!(
        leaked.len() <= 1,
        "cancelled subscription received more than one post-cancel event: {leaked:?}"
    );
    if let Some(cursor) = leaked.first() {
        assert_eq!(
            *cursor,
            Cursor::new("cursor-2"),
            "cancellation failed to stop delivery before the next published event"
        );
    }

    drop(stream);
    drop(transport);
    T::shutdown(server).await;
}
