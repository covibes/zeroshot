//! Client-side watch dedup and reconnect: `WatchClient`/`ReconnectingEventStream` must recover
//! from a `SLOW_CONSUMER` close by reconnecting from the last delivered cursor with zero gap,
//! and must silently drop legal at-least-once physical duplicates, against a minimal fixture
//! store independent of the testkit's `InMemoryAdmissionStore`.

use std::sync::Arc;

use openengine_cluster_client::WatchClient;
use openengine_cluster_protocol::{RunId, WatchEvent, WatchParams};
use openengine_cluster_server::watch::fixtures::{FixtureBackend, FixtureStore};
use openengine_cluster_server::{ConnectionContext, Dispatcher};

#[path = "support/mod.rs"]
pub mod support;
use support::AssertValue;

#[path = "reconnect_support/mod.rs"]
mod reconnect_support;
use reconnect_support::{
    assert_reconnect_replays_and_dedups, overflow_and_close_with, FIXTURE_QUEUE_CAPACITY,
};

#[tokio::test]
async fn reconnect_after_slow_consumer_recovers_with_no_gap_and_dedups_duplicates() {
    let run_id = RunId::new("run-1");
    let store = Arc::new(FixtureStore::new(
        run_id.clone(),
        Vec::new(),
        FIXTURE_QUEUE_CAPACITY,
    ));
    let dispatcher = Dispatcher::new(
        FixtureBackend::new(Arc::clone(&store)),
        ConnectionContext::default(),
    );
    let client = WatchClient::new(dispatcher);

    let (result, mut stream, _handle) = client.watch(WatchParams::default()).await.assert_value();
    assert_eq!(result.run_id, Some(run_id));

    let received = overflow_and_close_with(&store, &mut stream, || WatchEvent::Bookmark).await;

    let (_result, mut stream, _handle) = client.reconnect(stream).await.assert_value();
    assert_reconnect_replays_and_dedups(&store, &mut stream, received).await;
}
