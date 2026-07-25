//! End-to-end NDJSON multiplexing coverage: unary/subscription correlation, bounded-frame error
//! handling, duplicate in-flight request ids, selective cancellation, slow-consumer overflow, and
//! deterministic EOF shutdown. Drives `serve_ndjson` directly over `tokio::io::duplex` pipes
//! against `FixtureBackend`/`FixtureStore` so every case is independent of the testkit's
//! production-shaped `InMemoryAdmissionStore`.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use openengine_cluster_protocol::{RunId, WatchEvent};
use openengine_cluster_server::watch::fixtures::{
    await_ndjson_shutdown, spawn_ndjson, FixtureBackend, FixtureStore,
};
use openengine_cluster_server::ClusterBackend;
use serde_json::{json, Value};
use tokio::io::{AsyncWriteExt, BufReader, DuplexStream};
use tokio::task::JoinHandle;

#[path = "ndjson_test_support/mod.rs"]
mod ndjson_test_support;
use ndjson_test_support::{read_line, read_value, request_line, write_line};

#[path = "gated_backend_support/mod.rs"]
mod gated_backend_support;
use gated_backend_support::GatedBackend;

#[path = "admission_bound_support/mod.rs"]
mod admission_bound_support;
use admission_bound_support::{
    assert_duplicate_in_flight_ids_are_rejected,
    assert_excess_requests_are_rejected_with_server_busy, spawn_gated_harness, GatedHarnessSpawn,
    RequestChannel,
};

/// Matches the issue's documented "> 1 MiB" oversized-frame threshold; the exact bound is an
/// internal `serve_ndjson` implementation detail, not part of the public contract.
const OVERSIZED_LINE_BYTES: usize = 1024 * 1024 + 16;

struct Harness {
    write: DuplexStream,
    read: BufReader<DuplexStream>,
    server: JoinHandle<std::io::Result<()>>,
}

fn spawn_server<B>(backend: B) -> Harness
where
    B: ClusterBackend,
{
    let (write, read, server) = spawn_ndjson(backend);
    Harness {
        write,
        read: BufReader::new(read),
        server,
    }
}

impl RequestChannel for Harness {
    async fn send_get(&mut self, id: i64) {
        write_line(&mut self.write, &request_line(id, "get", json!({}))).await;
    }

    async fn recv_value(&mut self) -> Value {
        read_value(&mut self.read).await
    }
}

impl GatedHarnessSpawn for Harness {
    async fn spawn_gated(backend: GatedBackend) -> Self {
        spawn_server(backend)
    }
}

fn cancel_line(subscription_id: &str) -> String {
    json!({
        "jsonrpc": "2.0",
        "method": "subscription/cancel",
        "params": {"subscriptionId": subscription_id},
    })
    .to_string()
}

async fn shut_down(harness: Harness) {
    let Harness { write, server, .. } = harness;
    drop(write);
    await_ndjson_shutdown(server).await;
}

#[tokio::test]
async fn unary_and_subscription_share_connection() {
    let run_id = RunId::new("run-1");
    let store = Arc::new(FixtureStore::new(run_id, Vec::new(), 8));
    let mut harness = spawn_server(FixtureBackend::new(Arc::clone(&store)));

    write_line(&mut harness.write, &request_line(1, "watch", json!({}))).await;
    let watch_response = read_value(&mut harness.read).await;
    let subscription_id = watch_response["result"]["subscriptionId"]
        .as_str()
        .unwrap()
        .to_owned();

    // Put a live event notification in flight before the unary request is even sent, then
    // interleave the unary request: both must resolve, correctly correlated, on one connection.
    store.publish(WatchEvent::Bookmark).await;
    write_line(&mut harness.write, &request_line(2, "get", json!({}))).await;

    let mut saw_get_response = false;
    let mut saw_event = false;
    for _ in 0..2 {
        let value = read_value(&mut harness.read).await;
        if value.get("method").is_some() {
            assert_eq!(value["method"], "event");
            assert_eq!(value["params"]["subscriptionId"], subscription_id);
            saw_event = true;
        } else {
            assert_eq!(value["id"], 2);
            assert!(value.get("result").is_some(), "{value}");
            saw_get_response = true;
        }
    }
    assert!(saw_get_response && saw_event);

    shut_down(harness).await;
}

#[tokio::test]
async fn oversized_and_malformed_frames_are_deterministic() {
    let store = Arc::new(FixtureStore::new(RunId::new("run-1"), Vec::new(), 8));
    let mut harness = spawn_server(FixtureBackend::new(store));

    let oversized = "a".repeat(OVERSIZED_LINE_BYTES);
    harness.write.write_all(oversized.as_bytes()).await.unwrap();
    harness.write.write_all(b"\n").await.unwrap();
    harness.write.flush().await.unwrap();
    write_line(&mut harness.write, "not valid json").await;
    write_line(&mut harness.write, &request_line(9, "get", json!({}))).await;

    let mut parse_errors = 0;
    let mut saw_get_response = false;
    while !saw_get_response {
        let value = read_value(&mut harness.read).await;
        if value["id"] == 9 {
            assert!(value.get("result").is_some(), "{value}");
            saw_get_response = true;
        } else {
            assert_eq!(value["error"]["code"], -32700, "{value}");
            parse_errors += 1;
        }
    }
    assert_eq!(parse_errors, 2);

    shut_down(harness).await;
}

#[tokio::test]
async fn duplicate_request_ids_are_rejected() {
    let (mut harness, gate) = spawn_gated_harness::<Harness>().await;

    assert_duplicate_in_flight_ids_are_rejected(&mut harness, &gate).await;

    shut_down(harness).await;
}

#[tokio::test]
async fn excess_requests_are_rejected_without_unbounded_task_admission() {
    const MAX_CONNECTION_TASKS: i64 = 256;

    let (mut harness, _gate) = spawn_gated_harness::<Harness>().await;

    assert_excess_requests_are_rejected_with_server_busy(&mut harness, MAX_CONNECTION_TASKS).await;

    shut_down(harness).await;
}

/// Publishes one bookmark event and asserts both `sub_a` and `sub_b` observe it as `cursor-1`.
async fn assert_shared_bookmark_delivered(
    harness: &mut Harness,
    store: &FixtureStore,
    sub_a: &str,
    sub_b: &str,
) {
    store.publish(WatchEvent::Bookmark).await; // cursor-1, delivered to both.
    let mut by_sub: HashMap<String, Vec<String>> = HashMap::new();
    for _ in 0..2 {
        let value = read_value(&mut harness.read).await;
        let sub = value["params"]["subscriptionId"]
            .as_str()
            .unwrap()
            .to_owned();
        let cursor = value["params"]["cursor"].as_str().unwrap().to_owned();
        by_sub.entry(sub).or_default().push(cursor);
    }
    assert_eq!(by_sub[sub_a], vec!["cursor-1".to_owned()]);
    assert_eq!(by_sub[sub_b], vec!["cursor-1".to_owned()]);
}

/// Cancels `sub_a`, confirms cancellation was synchronously applied via a subsequent unary `get`,
/// publishes two more events, and asserts the at-most-one-post-cancel-leak model: `sub_b` observes
/// both further events while `sub_a` observes at most one further event (and if any, exactly
/// `cursor-2`, the one immediately following cancellation).
async fn assert_cancel_stops_only_selected_subscription(
    harness: &mut Harness,
    store: &FixtureStore,
    sub_a: &str,
    sub_b: &str,
) {
    write_line(&mut harness.write, &cancel_line(sub_a)).await;
    // A subsequent unary request on the same connection is only answered after the read loop has
    // already processed (and synchronously applied) the preceding cancel line.
    write_line(&mut harness.write, &request_line(100, "get", json!({}))).await;
    let sync_response = read_value(&mut harness.read).await;
    assert_eq!(sync_response["id"], 100);
    assert!(sync_response.get("result").is_some(), "{sync_response}");

    store.publish(WatchEvent::Bookmark).await; // cursor-2
    store.publish(WatchEvent::Bookmark).await; // cursor-3

    // `sub_b` is unaffected and must observe both further events. `sub_a`'s consumer task may
    // already have been parked awaiting the next live event at the moment of cancellation, so at
    // most one further event (the one immediately following cancellation) may still be delivered
    // to it before it observes cancellation on its next poll and stops for good.
    let mut frames = Vec::new();
    for _ in 0..4 {
        match tokio::time::timeout(Duration::from_millis(300), read_line(&mut harness.read)).await {
            Ok(line) => frames.push(serde_json::from_str::<Value>(&line).unwrap()),
            Err(_) => break,
        }
    }
    assert!(
        frames.len() <= 3,
        "more frames arrived than the at-most-one-post-cancel-leak model allows: {frames:?}"
    );

    let mut sub_a_cursors = Vec::new();
    let mut sub_b_cursors = Vec::new();
    for value in &frames {
        let sub = value["params"]["subscriptionId"].as_str().unwrap();
        let cursor = value["params"]["cursor"].as_str().unwrap().to_owned();
        if sub == sub_a {
            sub_a_cursors.push(cursor);
        } else if sub == sub_b {
            sub_b_cursors.push(cursor);
        } else {
            panic!("unexpected subscriptionId {sub}");
        }
    }
    assert_eq!(
        sub_b_cursors,
        vec!["cursor-2".to_owned(), "cursor-3".to_owned()]
    );
    assert!(
        sub_a_cursors.len() <= 1,
        "cancelled subscription received more than one post-cancel event: {sub_a_cursors:?}"
    );
    if let Some(leaked) = sub_a_cursors.first() {
        assert_eq!(
            *leaked, "cursor-2",
            "cancellation failed to stop delivery before the next published event"
        );
    }
}

#[tokio::test]
async fn cancel_releases_only_the_selected_subscription() {
    let store = Arc::new(FixtureStore::new(RunId::new("run-1"), Vec::new(), 8));
    let mut harness = spawn_server(FixtureBackend::new(Arc::clone(&store)));

    write_line(&mut harness.write, &request_line(1, "watch", json!({}))).await;
    let response_a = read_value(&mut harness.read).await;
    let sub_a = response_a["result"]["subscriptionId"]
        .as_str()
        .unwrap()
        .to_owned();

    write_line(&mut harness.write, &request_line(2, "watch", json!({}))).await;
    let response_b = read_value(&mut harness.read).await;
    let sub_b = response_b["result"]["subscriptionId"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_ne!(sub_a, sub_b);

    assert_shared_bookmark_delivered(&mut harness, &store, &sub_a, &sub_b).await;
    assert_cancel_stops_only_selected_subscription(&mut harness, &store, &sub_a, &sub_b).await;

    shut_down(harness).await;
}

#[tokio::test]
async fn slow_consumer_closes_with_the_last_delivered_cursor() {
    const FIXTURE_QUEUE_CAPACITY: usize = 2;
    let store = Arc::new(FixtureStore::new(
        RunId::new("run-1"),
        Vec::new(),
        FIXTURE_QUEUE_CAPACITY,
    ));
    let mut harness = spawn_server(FixtureBackend::new(Arc::clone(&store)));

    write_line(&mut harness.write, &request_line(1, "watch", json!({}))).await;
    let response = read_value(&mut harness.read).await;
    let subscription_id = response["result"]["subscriptionId"]
        .as_str()
        .unwrap()
        .to_owned();

    // The bounded queue holds two entries; the third publish overflows it.
    store.publish(WatchEvent::Bookmark).await;
    store.publish(WatchEvent::Bookmark).await;
    store.publish(WatchEvent::Bookmark).await;

    let mut closed = None;
    while closed.is_none() {
        let value = read_value(&mut harness.read).await;
        assert_eq!(value["params"]["subscriptionId"], subscription_id);
        match value["method"].as_str().unwrap() {
            "event" => {}
            "subscription/closed" => closed = Some(value),
            other => panic!("unexpected notification method {other}"),
        }
    }
    let closed = closed.unwrap();
    assert_eq!(closed["params"]["reason"], "SLOW_CONSUMER");
    assert_eq!(closed["params"]["lastDeliveredCursor"], "cursor-2");

    shut_down(harness).await;
}

#[tokio::test]
async fn eof_terminates_deterministically() {
    let store = Arc::new(FixtureStore::new(RunId::new("run-1"), Vec::new(), 8));
    let harness = spawn_server(FixtureBackend::new(store));
    shut_down(harness).await;
}

/// Regression test: cancelling a subscription on a run that never publishes again used to leak
/// its streaming task and channel forever. The task is parked inside `next_live`'s
/// `receiver.recv().await` whenever it is idle, and dropping the old `WatchHandle` on cancel never
/// woke it -- nothing rechecks `WatchEventStream`'s cancelled flag until the stream's next poll,
/// which never comes for an idle run. A leaked task only surfaces at shutdown: `serve_ndjson`
/// waits out the full `SHUTDOWN_GRACE_PERIOD` before force-aborting whatever tasks remain, so
/// shutdown taking close to that grace period (rather than resolving promptly) is the symptom.
#[tokio::test]
async fn cancelling_an_idle_subscription_releases_its_task_promptly() {
    let store = Arc::new(FixtureStore::new(RunId::new("run-1"), Vec::new(), 8));
    let mut harness = spawn_server(FixtureBackend::new(store));

    write_line(&mut harness.write, &request_line(1, "watch", json!({}))).await;
    let response = read_value(&mut harness.read).await;
    let subscription_id = response["result"]["subscriptionId"]
        .as_str()
        .unwrap()
        .to_owned();

    // Cancel while idle: no event is ever published on this run, so the streaming task is parked
    // awaiting the next live event with nothing left to ever wake it via the old flag-only design.
    write_line(&mut harness.write, &cancel_line(&subscription_id)).await;
    // A subsequent unary request on the same connection only answers after the read loop has
    // already processed (and synchronously applied) the preceding cancel line.
    write_line(&mut harness.write, &request_line(2, "get", json!({}))).await;
    let sync_response = read_value(&mut harness.read).await;
    assert_eq!(sync_response["id"], 2);
    assert!(sync_response.get("result").is_some(), "{sync_response}");

    let started = tokio::time::Instant::now();
    shut_down(harness).await;
    let elapsed = started.elapsed();
    assert!(
        elapsed < Duration::from_millis(150),
        "shutdown took {elapsed:?}, close to or exceeding SHUTDOWN_GRACE_PERIOD -- the cancelled \
         idle subscription's task was likely never woken and had to be force-aborted instead of \
         exiting on its own"
    );
}
