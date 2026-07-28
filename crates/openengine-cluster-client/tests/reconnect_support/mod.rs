//! Shared slow-consumer-overflow / gap-free-reconnect-replay / dedup-and-`Finished` scenario
//! driven identically by `tests/reconnect.rs` (in-process `WatchClient`) and, via
//! `ndjson_scenario`/`websocket_scenario` on top of `scenario_harness`, `tests/subscription_ndjson.rs`
//! / `tests/websocket.rs` / `tests/backend_faults.rs` (`NdjsonWatchClient`/`WebSocketTransport` over
//! the wire), proving all transports produce byte-equivalent event/cursor sequences and that the
//! `fault` `WatchEvent` variant needs no special-casing.

use openengine_cluster_client::{
    EventOrClosed, ReconnectingEventStream, SubscriptionTransport, WatchSubscriptionEventStream,
};
use openengine_cluster_protocol::{
    ClusterStatus, Cursor, StopMode, SubscriptionCloseReason, WatchEvent,
};
use openengine_cluster_server::watch::fixtures::FixtureStore;

/// The fixture's queue is bounded to 2 entries; the third publish overflows it, forcing a
/// deterministic `SLOW_CONSUMER` close for these tests to reconnect from.
pub const FIXTURE_QUEUE_CAPACITY: usize = 2;

/// Minimal capability both reconnecting event streams share: pulling the next de-duplicated
/// event or terminal close.
pub trait EventStream {
    async fn next_event(&mut self) -> Option<EventOrClosed>;
}

impl EventStream for ReconnectingEventStream {
    async fn next_event(&mut self) -> Option<EventOrClosed> {
        self.next().await
    }
}

/// Covers every [`SubscriptionTransport`]-generic wire binding at once (NDJSON's
/// `NdjsonReconnectingEventStream` alias and `WebSocketTransport`'s
/// `WatchSubscriptionEventStream<'a, WebSocketTransport<S>>`), since both are the same generic
/// type parameterized by transport -- proving the two wire bindings share this exact scenario
/// logic rather than each needing their own impl.
impl<'a, T> EventStream for WatchSubscriptionEventStream<'a, T>
where
    T: SubscriptionTransport,
{
    async fn next_event(&mut self) -> Option<EventOrClosed> {
        self.next().await
    }
}

/// Publishes 3 copies of `event()` into the (2-capacity) `store`, drains `stream` until it
/// closes, and asserts the close is `SLOW_CONSUMER` with `cursor-2` as the last delivered cursor
/// after exactly `[cursor-1, cursor-2]` were observed. Returns the observed cursors. Generic over
/// the published `WatchEvent` so a caller can prove some variant other than `Bookmark` (e.g. a
/// `fault` event) overflows and replays through the exact same cursor mechanics, with no
/// special-casing.
pub async fn overflow_and_close_with(
    store: &FixtureStore,
    stream: &mut impl EventStream,
    mut event: impl FnMut() -> WatchEvent,
) -> Vec<Cursor> {
    // The fixture's queue holds two entries; the third overflows it.
    store.publish(event()).await;
    store.publish(event()).await;
    store.publish(event()).await;

    let mut received = Vec::new();
    loop {
        match stream.next_event().await.unwrap() {
            EventOrClosed::Event(record) => received.push(record.cursor.clone()),
            EventOrClosed::Closed {
                reason,
                last_delivered_cursor,
            } => {
                assert_eq!(reason, SubscriptionCloseReason::SlowConsumer);
                assert_eq!(last_delivered_cursor, Some(Cursor::new("cursor-2")));
                break;
            }
        }
    }
    assert_eq!(received, [Cursor::new("cursor-1"), Cursor::new("cursor-2")]);
    received
}

/// Given a freshly reconnected `stream` and the `received` cursors observed so far, asserts the
/// reconnect replays `cursor-3` with no gap, that a subsequent physical duplicate of the last
/// event is silently dropped, and that exactly one `Finished` event is observed, matching the
/// store's authoritative history.
pub async fn assert_reconnect_replays_and_dedups(
    store: &FixtureStore,
    stream: &mut impl EventStream,
    mut received: Vec<Cursor>,
) {
    // The reconnect must replay cursor-3 (recorded despite the overflow) with no gap.
    let Some(EventOrClosed::Event(record)) = stream.next_event().await else {
        panic!("expected the reconnect to replay the un-delivered cursor-3 event");
    };
    assert_eq!(record.cursor, Cursor::new("cursor-3"));
    received.push(record.cursor);

    // A legal at-least-once physical duplicate of the last event must be silently dropped, and
    // exactly one Finished event must be observed.
    store.republish_last().await;
    store
        .publish(WatchEvent::Finished {
            final_status: ClusterStatus::empty(),
            stop_mode: Some(StopMode::Drain),
        })
        .await;

    let mut finished_count = 0;
    while finished_count == 0 {
        match stream.next_event().await.unwrap() {
            EventOrClosed::Event(record) => {
                assert!(
                    !received.contains(&record.cursor),
                    "duplicate cursor delivered to the client: {:?}",
                    record.cursor
                );
                if matches!(record.event, WatchEvent::Finished { .. }) {
                    finished_count += 1;
                }
                received.push(record.cursor);
            }
            EventOrClosed::Closed { .. } => {
                panic!("stream closed before the Finished event was observed")
            }
        }
    }
    assert_eq!(finished_count, 1);
    assert_eq!(received, store.history_cursors().await);
}
