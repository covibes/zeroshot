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
    let (_result, mut stream) = watch_client.watch(WatchParams::default()).await.unwrap();

    store.publish(WatchEvent::Bookmark).await;
    match stream.next().await.unwrap() {
        EventOrClosed::Event(record) => assert_eq!(record.cursor, Cursor::new("cursor-1")),
        other => panic!("expected an event, got {other:?}"),
    }

    stream.cancel().await.unwrap();

    ClusterClient::new(&transport)
        .get(GetParams::default())
        .await
        .unwrap();

    // The server-side subscription task may already be parked awaiting the next live event at
    // the moment cancellation is processed, so at most one further event (the one immediately
    // following cancellation) may still be delivered before it observes cancellation and stops
    // for good.
    store.publish(WatchEvent::Bookmark).await; // may leak as cursor-2
    store.publish(WatchEvent::Bookmark).await; // cursor-3, must never arrive

    let mut leaked = Vec::new();
    loop {
        match tokio::time::timeout(Duration::from_millis(300), stream.next()).await {
            Ok(Some(EventOrClosed::Event(record))) => leaked.push(record.cursor),
            Ok(Some(other)) => panic!("unexpected notification after cancel: {other:?}"),
            Ok(None) | Err(_) => break,
        }
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
