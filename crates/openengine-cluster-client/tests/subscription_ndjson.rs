//! Client-side NDJSON watch dedup and reconnect: `NdjsonWatchClient`/
//! `NdjsonReconnectingEventStream` must recover from a `SLOW_CONSUMER` close by reconnecting from
//! the last delivered cursor with zero gap, and must silently drop legal at-least-once physical
//! duplicates, driven over the wire against `serve_ndjson` instead of the in-process
//! `Dispatcher::watch` passthrough exercised by `tests/reconnect.rs`.

use std::time::Duration;

use openengine_cluster_client::{EventOrClosed, NdjsonTransport, NdjsonWatchClient};
use openengine_cluster_protocol::{Cursor, RunId, SubscriptionCloseReason, WatchEvent, WatchParams};
use serde_json::json;
use tokio::io::DuplexStream;

#[path = "support/mod.rs"]
pub mod support;
use support::AssertValue;

#[path = "ndjson_test_support/mod.rs"]
mod ndjson_test_support;
use ndjson_test_support::{
    assert_distinct_ids_and_server, assert_unary_roundtrip, duplex_pair,
    serve_distinct_subscription_ids, spawn_overflow_scenario, CLIENT_QUEUE_CAPACITY,
};

#[path = "reconnect_support/mod.rs"]
mod reconnect_support;
use reconnect_support::FIXTURE_QUEUE_CAPACITY;

#[path = "reconnect_support/scenario_harness.rs"]
mod scenario_harness;

#[path = "reconnect_support/cancel_scenario.rs"]
mod cancel_scenario;
use cancel_scenario::run_cancel_stops_delivery_scenario;

#[path = "reconnect_support/ndjson_scenario.rs"]
mod ndjson_scenario;
use ndjson_scenario::ndjson_overflow_and_reconnect_scenario;

#[tokio::test]
async fn reconnect_after_slow_consumer_recovers_with_no_gap_and_dedups_duplicates_over_ndjson() {
    ndjson_overflow_and_reconnect_scenario(RunId::new("run-1"), FIXTURE_QUEUE_CAPACITY, || {
        WatchEvent::Bookmark
    })
    .await;
}

// `cancel()` only writes a fire-and-forget notification line -- it does not wait for the server
// to have applied it. `run_cancel_stops_delivery_scenario` forces a synchronous `get` round trip
// on the same connection so the subsequent publishes are guaranteed to happen only after the
// server's read loop has already processed (and synchronously applied) the preceding cancel line;
// NDJSON lines are read and handled strictly in order, so a response to a request sent after
// `cancel` can only arrive once the cancel itself has already been read and applied. No
// `subscription/closed` follows a plain cancel, so absence of further delivery is observed as the
// stream's `next()` simply never resolving again.
#[tokio::test]
async fn cancel_stops_further_delivery() {
    run_cancel_stops_delivery_scenario::<NdjsonTransport<DuplexStream, DuplexStream>>().await;
}

#[tokio::test]
async fn independent_watch_clients_share_one_collision_free_request_id_source() {
    let (client_write, server_read, server_write, client_read) = duplex_pair(1 << 16);
    let server = tokio::spawn(serve_distinct_subscription_ids(
        server_read,
        server_write,
        |subscription_id| json!({"subscriptionId": subscription_id, "runId": null, "atCursor": null}),
    ));

    let transport = NdjsonTransport::new(client_read, client_write);
    let first = NdjsonWatchClient::new(&transport);
    let second = NdjsonWatchClient::new(&transport);
    let (first_result, second_result) = tokio::join!(
        first.watch(WatchParams::default()),
        second.watch(WatchParams::default())
    );
    assert_distinct_ids_and_server(
        (
            first_result.assert_value().0.subscription_id,
            second_result.assert_value().0.subscription_id,
        ),
        server,
    )
    .await;
}

#[tokio::test]
async fn unread_subscription_overflow_does_not_block_unary_responses() {
    let (client_write, client_read, server) = spawn_overflow_scenario(
        json!({
            "subscriptionId": "slow-subscription",
            "runId": "run-1",
            "atCursor": null
        }),
        |index| {
            json!({
                "jsonrpc": "2.0",
                "method": "event",
                "params": {
                    "subscriptionId": "slow-subscription",
                    "runId": "run-1",
                    "cursor": format!("cursor-{index}"),
                    "event": {"type": "bookmark"}
                }
            })
        },
    );

    let transport = NdjsonTransport::new(client_read, client_write);
    let watch_client = NdjsonWatchClient::new(&transport);
    let (_result, mut stream) = watch_client
        .watch(WatchParams::default())
        .await
        .assert_value();

    assert_unary_roundtrip(&transport).await;

    server.await.assert_value();
    let (events, closed_cursor) = tokio::time::timeout(Duration::from_secs(2), async {
        let mut events = 0;
        loop {
            match stream
                .next()
                .await
                .assert_value_with("expected a local overflow close")
            {
                EventOrClosed::Event(_) => events += 1,
                EventOrClosed::Closed {
                    reason,
                    last_delivered_cursor,
                } => {
                    assert_eq!(reason, SubscriptionCloseReason::SlowConsumer);
                    break (events, last_delivered_cursor);
                }
            }
        }
    })
    .await
    .assert_value_with("buffered notifications and the local overflow close must drain");
    assert_eq!(events, CLIENT_QUEUE_CAPACITY);
    assert_eq!(closed_cursor, Some(Cursor::new("cursor-1024")));
    assert_eq!(stream.last_delivered_cursor(), closed_cursor.as_ref());
}
