use openengine_cluster_protocol::RunId;

use super::*;
use crate::watch::fixtures::{FixtureBackend, FixtureStore};
use crate::ConnectionContext;

/// Regression test for a race where `run_watch_subscription` sent the `watch` response before
/// registering the subscription's `WatchHandle` in `subscriptions`: a `subscription/cancel`
/// processed by the read loop in that window found nothing to remove and the subscription was
/// never cancellable again. Forces the response send to block (a pre-filled, capacity-1
/// outbound queue that nothing drains) so the task is parked exactly at that send call, then
/// asserts registration has already happened — true only when the insert precedes the send.
#[tokio::test]
async fn subscription_is_registered_before_its_response_send_can_complete() {
    let store = Arc::new(FixtureStore::new(RunId::new("run-1"), Vec::new(), 8));
    let dispatcher = Dispatcher::new(FixtureBackend::new(store), ConnectionContext::default());

    let (outbound_tx, mut outbound_rx) = mpsc::channel::<String>(1);
    outbound_tx.send("occupied".to_owned()).await.unwrap();

    let subscriptions: SubscriptionMap = Arc::new(Mutex::new(HashMap::new()));
    let state = ConnectionState {
        outbound_tx,
        subscriptions: Arc::clone(&subscriptions),
        in_flight_ids: Arc::new(Mutex::new(HashSet::new())),
    };

    tokio::spawn(run_watch_subscription(
        dispatcher,
        RequestId::Integer(1),
        Value::Object(serde_json::Map::new()),
        state,
    ));

    // Let the spawned task run dispatch_watch to completion; it then blocks indefinitely on
    // the full outbound queue, since nothing here drains it yet. Poll via bounded cooperative
    // yields rather than a fixed sleep: a real-time sleep is a race against however long the
    // spawned task actually takes to be scheduled, which flakes under the CPU contention of a
    // full `cargo test --workspace` run; yielding is deterministic regardless of load and the
    // attempt cap still fails the test if registration never happens.
    let mut attempts = 0;
    while subscriptions.lock().len() != 1 {
        attempts += 1;
        assert!(
            attempts < 100_000,
            "subscription was never registered before its response send could complete, \
             so a cancel racing the response would be lost"
        );
        tokio::task::yield_now().await;
    }

    // Drain the queue so the parked task can finish instead of leaking past the test.
    let _ = outbound_rx.recv().await;
    let _ = outbound_rx.recv().await;
}
