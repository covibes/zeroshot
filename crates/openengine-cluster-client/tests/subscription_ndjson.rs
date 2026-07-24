//! Client-side NDJSON watch dedup and reconnect: `NdjsonWatchClient`/
//! `NdjsonReconnectingEventStream` must recover from a `SLOW_CONSUMER` close by reconnecting from
//! the last delivered cursor with zero gap, and must silently drop legal at-least-once physical
//! duplicates, driven over the wire against `serve_ndjson` instead of the in-process
//! `Dispatcher::watch` passthrough exercised by `tests/reconnect.rs`.

use std::sync::Arc;
use std::time::Duration;

use openengine_cluster_client::{
    ClusterClient, EventOrClosed, JsonRpcTransport, NdjsonTransport, NdjsonWatchClient,
};
use openengine_cluster_protocol::{
    Cursor, GetParams, RunId, SubscriptionCloseReason, WatchEvent, WatchParams,
};
use openengine_cluster_server::watch::fixtures::{
    await_ndjson_shutdown, spawn_ndjson, FixtureBackend, FixtureStore,
};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, DuplexStream};

#[path = "reconnect_support/mod.rs"]
mod reconnect_support;
use reconnect_support::FIXTURE_QUEUE_CAPACITY;

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

#[tokio::test]
async fn cancel_stops_further_delivery() {
    let run_id = RunId::new("run-1");
    let store = Arc::new(FixtureStore::new(run_id, Vec::new(), 8));
    let (client_write, client_read, server) = spawn_ndjson(FixtureBackend::new(Arc::clone(&store)));

    let transport = NdjsonTransport::new(client_read, client_write);
    let watch_client = NdjsonWatchClient::new(&transport);
    let (_result, mut stream) = watch_client.watch(WatchParams::default()).await.unwrap();

    store.publish(WatchEvent::Bookmark).await;
    match stream.next().await.unwrap() {
        EventOrClosed::Event(record) => assert_eq!(record.cursor, Cursor::new("cursor-1")),
        other => panic!("expected an event, got {other:?}"),
    }

    stream.cancel().await.unwrap();

    // `cancel()` only writes a fire-and-forget notification line -- it does not wait for the
    // server to have applied it. Force a synchronous round trip on the same connection so the
    // subsequent publishes are guaranteed to happen only after the server's read loop has already
    // processed (and synchronously applied) the preceding cancel line; NDJSON lines are read and
    // handled strictly in order, so a response to a request sent after `cancel` can only arrive
    // once the cancel itself has already been read and applied.
    ClusterClient::new(&transport)
        .get(GetParams::default())
        .await
        .unwrap();

    // The server-side subscription task may already be parked awaiting the next live event at
    // the moment cancellation is processed, so at most one further event (the one immediately
    // following cancellation) may still be delivered before it observes cancellation and stops
    // for good; no `subscription/closed` follows a plain cancel, so absence of further delivery
    // is observed as this stream's `next()` simply never resolving again.
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
    await_ndjson_shutdown(server).await;
}

async fn write_json_line(writer: &mut DuplexStream, value: Value) {
    writer
        .write_all(value.to_string().as_bytes())
        .await
        .unwrap();
    writer.write_all(b"\n").await.unwrap();
    writer.flush().await.unwrap();
}

async fn read_json_line(reader: &mut BufReader<DuplexStream>) -> Value {
    let mut line = String::new();
    assert!(reader.read_line(&mut line).await.unwrap() > 0);
    serde_json::from_str(&line).unwrap()
}

#[tokio::test]
async fn independent_watch_clients_share_one_collision_free_request_id_source() {
    let (client_write, server_read) = tokio::io::duplex(1 << 16);
    let (mut server_write, client_read) = tokio::io::duplex(1 << 16);
    let server = tokio::spawn(async move {
        let mut server_read = BufReader::new(server_read);
        let first = read_json_line(&mut server_read).await;
        let second = read_json_line(&mut server_read).await;
        let first_id = first["id"].clone();
        let second_id = second["id"].clone();
        assert_ne!(first_id, second_id);

        write_json_line(
            &mut server_write,
            json!({
                "jsonrpc": "2.0",
                "id": second_id,
                "result": {"subscriptionId": "sub-2", "runId": null, "atCursor": null}
            }),
        )
        .await;
        write_json_line(
            &mut server_write,
            json!({
                "jsonrpc": "2.0",
                "id": first_id,
                "result": {"subscriptionId": "sub-1", "runId": null, "atCursor": null}
            }),
        )
        .await;
    });

    let transport = NdjsonTransport::new(client_read, client_write);
    let first = NdjsonWatchClient::new(&transport);
    let second = NdjsonWatchClient::new(&transport);
    let (first_result, second_result) = tokio::join!(
        first.watch(WatchParams::default()),
        second.watch(WatchParams::default())
    );
    assert_ne!(
        first_result.unwrap().0.subscription_id,
        second_result.unwrap().0.subscription_id
    );
    server.await.unwrap();
}

#[tokio::test]
async fn unread_subscription_overflow_does_not_block_unary_responses() {
    const CLIENT_QUEUE_CAPACITY: usize = 1024;

    let (client_write, server_read) = tokio::io::duplex(1 << 20);
    let (mut server_write, client_read) = tokio::io::duplex(1 << 20);
    let server = tokio::spawn(async move {
        let mut server_read = BufReader::new(server_read);
        let watch = read_json_line(&mut server_read).await;
        write_json_line(
            &mut server_write,
            json!({
                "jsonrpc": "2.0",
                "id": watch["id"],
                "result": {
                    "subscriptionId": "slow-subscription",
                    "runId": "run-1",
                    "atCursor": null
                }
            }),
        )
        .await;

        for index in 1..=CLIENT_QUEUE_CAPACITY + 1 {
            write_json_line(
                &mut server_write,
                json!({
                    "jsonrpc": "2.0",
                    "method": "event",
                    "params": {
                        "subscriptionId": "slow-subscription",
                        "runId": "run-1",
                        "cursor": format!("cursor-{index}"),
                        "event": {"type": "bookmark"}
                    }
                }),
            )
            .await;
        }

        let mut saw_cancel = false;
        let mut saw_unary = false;
        while !(saw_cancel && saw_unary) {
            let request = read_json_line(&mut server_read).await;
            if request["method"] == "subscription/cancel" {
                assert_eq!(request["params"]["subscriptionId"], "slow-subscription");
                saw_cancel = true;
            } else {
                assert_eq!(request["method"], "get");
                write_json_line(
                    &mut server_write,
                    json!({"jsonrpc": "2.0", "id": request["id"], "result": {}}),
                )
                .await;
                saw_unary = true;
            }
        }
    });

    let transport = NdjsonTransport::new(client_read, client_write);
    let watch_client = NdjsonWatchClient::new(&transport);
    let (_result, mut stream) = watch_client.watch(WatchParams::default()).await.unwrap();

    let unary =
        json!({"jsonrpc": "2.0", "id": "unary-1", "method": "get", "params": {}}).to_string();
    let response = tokio::time::timeout(Duration::from_secs(2), transport.request(unary))
        .await
        .expect("an unread subscription must not block the shared response pump")
        .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&response).unwrap()["id"],
        "unary-1"
    );

    server.await.unwrap();
    let (events, closed_cursor) = tokio::time::timeout(Duration::from_secs(2), async {
        let mut events = 0;
        loop {
            match stream.next().await {
                Some(EventOrClosed::Event(_)) => events += 1,
                Some(EventOrClosed::Closed {
                    reason,
                    last_delivered_cursor,
                }) => {
                    assert_eq!(reason, SubscriptionCloseReason::SlowConsumer);
                    break (events, last_delivered_cursor);
                }
                None => panic!("local overflow ended without a SLOW_CONSUMER close"),
            }
        }
    })
    .await
    .expect("buffered notifications and the local overflow close must drain");
    assert_eq!(events, CLIENT_QUEUE_CAPACITY);
    assert_eq!(closed_cursor, Some(Cursor::new("cursor-1024")));
    assert_eq!(stream.last_delivered_cursor(), closed_cursor.as_ref());
}
