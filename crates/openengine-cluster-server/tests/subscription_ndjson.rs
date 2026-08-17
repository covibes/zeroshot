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

#[path = "support/assert_at.rs"]
mod assert_at;
#[path = "support/assert_value.rs"]
mod assert_value;

use assert_at::AssertAt;
use assert_value::AssertValue;

#[path = "ndjson_test_support/mod.rs"]
mod ndjson_test_support;
use ndjson_test_support::{read_line, read_value, request_line, write_line};

#[path = "gated_backend_support/mod.rs"]
mod gated_backend_support;
use gated_backend_support::GatedBackend;

#[path = "admission_bound_support/mod.rs"]
mod admission_bound_support;
use admission_bound_support::{
    assert_duplicate_cancellation_is_malformed, assert_duplicate_in_flight_ids_are_rejected,
    assert_excess_requests_are_rejected_with_server_busy,
    assert_malformed_frame_is_dropped_at_task_saturation,
    assert_subscription_envelope_validation_for_binding,
    assert_wrong_version_envelope_retains_duplicate_precedence, spawn_gated_harness,
    DuplicateCancellationChannel, GatedHarnessSpawn, RequestChannel, SubscriptionCountingBackend,
    SubscriptionValidationHarness,
};

/// Matches the issue's documented "> 1 MiB" oversized-frame threshold; the exact bound is an
/// internal `serve_ndjson` implementation detail, not part of the public contract.
const OVERSIZED_LINE_BYTES: usize = 1024 * 1024 + 16;

fn field<'a>(value: &'a Value, path: &[&str]) -> &'a Value {
    path.iter()
        .fold(value, |current, name| current.assert_at(*name))
}

fn string_field<'a>(value: &'a Value, path: &[&str]) -> &'a str {
    field(value, path).as_str().assert_value()
}

fn response_subscription_id(value: &Value) -> String {
    string_field(value, &["result", "subscriptionId"]).to_owned()
}

async fn open_watch(harness: &mut Harness, id: i64) -> String {
    write_line(&mut harness.write, &request_line(id, "watch", json!({}))).await;
    response_subscription_id(&read_value(&mut harness.read).await)
}

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

fn empty_watch_harness(capacity: usize) -> (Arc<FixtureStore>, Harness) {
    let store = Arc::new(FixtureStore::new(RunId::new("run-1"), Vec::new(), capacity));
    let harness = spawn_server(FixtureBackend::new(Arc::clone(&store)));
    (store, harness)
}

impl RequestChannel for Harness {
    async fn send_get(&mut self, id: i64) {
        write_line(&mut self.write, &request_line(id, "get", json!({}))).await;
    }

    async fn send_raw(&mut self, text: &str) {
        write_line(&mut self.write, text).await;
    }

    async fn recv_raw(&mut self) -> String {
        read_line(&mut self.read).await
    }

    async fn recv_value(&mut self) -> Value {
        read_value(&mut self.read).await
    }
}

impl GatedHarnessSpawn for Harness {
    async fn spawn_gated(backend: GatedBackend) -> Self {
        spawn_server(backend)
    }

    async fn shut_down(self) {
        shut_down(self).await;
    }
}

impl SubscriptionValidationHarness for Harness {
    async fn spawn_subscription_validation(backend: SubscriptionCountingBackend) -> Self {
        spawn_server(backend)
    }
}

struct NdjsonDuplicateCancellation<'a> {
    harness: &'a mut Harness,
    store: Arc<FixtureStore>,
    subscription_id: Option<String>,
}

impl DuplicateCancellationChannel for NdjsonDuplicateCancellation<'_> {
    async fn arrange_targets(&mut self) {
        self.harness
            .send_raw(&request_line(1, "watch", json!({})))
            .await;
        let established = self.harness.recv_value().await;
        self.subscription_id = Some(response_subscription_id(&established));
    }

    async fn send_duplicate_cancellation(&mut self) {
        let subscription_id = self.subscription_id.as_deref().assert_value();
        self.harness
            .send_raw(&format!(
                r#"{{"jsonrpc":"2.0","method":"subscription/cancel","params":{{"subscriptionId":"other","subscriptionId":"{subscription_id}"}}}}"#
            ))
            .await;
    }

    async fn recv_raw(&mut self) -> String {
        self.harness.recv_raw().await
    }

    async fn assert_targets_remain_active(&mut self) {
        self.store.publish(WatchEvent::Bookmark).await;
        let event = self.harness.recv_value().await;
        assert_eq!(event.assert_at("method"), "event");
        assert_eq!(
            field(&event, &["params", "subscriptionId"]),
            self.subscription_id.as_deref().assert_value()
        );
    }

    async fn assert_unknown_member_cancellation_is_accepted(&mut self) {
        let subscription_id = self.subscription_id.as_deref().assert_value();
        self.harness
            .send_raw(&format!(
                r#"{{"jsonrpc":"2.0","method":"subscription/cancel","params":{{"subscriptionId":"{subscription_id}"}},"extension":true}}"#
            ))
            .await;
        self.harness.send_get(99).await;
        let sync = self.harness.recv_value().await;
        assert_eq!(sync.assert_at("id"), 99);
        assert!(sync.get("result").is_some(), "{sync}");

        self.store.publish(WatchEvent::Bookmark).await;
        assert!(
            tokio::time::timeout(Duration::from_millis(100), self.harness.recv_raw())
                .await
                .is_err(),
            "subscription/cancel with an unknown top-level member must cancel the subscription"
        );
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
    let (store, mut harness) = empty_watch_harness(8);

    let subscription_id = open_watch(&mut harness, 1).await;

    // Put a live event notification in flight before the unary request is even sent, then
    // interleave the unary request: both must resolve, correctly correlated, on one connection.
    store.publish(WatchEvent::Bookmark).await;
    write_line(&mut harness.write, &request_line(2, "get", json!({}))).await;

    let mut saw_get_response = false;
    let mut saw_event = false;
    for _ in 0..2 {
        let value = read_value(&mut harness.read).await;
        if value.get("method").is_some() {
            assert_eq!(value.assert_at("method"), "event");
            assert_eq!(
                string_field(&value, &["params", "subscriptionId"]),
                subscription_id
            );
            saw_event = true;
        } else {
            assert_eq!(value.assert_at("id"), 2);
            assert!(value.get("result").is_some(), "{value}");
            saw_get_response = true;
        }
    }
    assert!(saw_get_response && saw_event);

    shut_down(harness).await;
}

#[tokio::test]
async fn oversized_and_malformed_frames_are_deterministic() {
    let (_store, mut harness) = empty_watch_harness(8);

    let oversized = "a".repeat(OVERSIZED_LINE_BYTES);
    harness
        .write
        .write_all(oversized.as_bytes())
        .await
        .assert_value();
    harness.write.write_all(b"\n").await.assert_value();
    harness.write.flush().await.assert_value();
    write_line(&mut harness.write, "not valid json").await;
    write_line(&mut harness.write, &request_line(9, "get", json!({}))).await;

    let mut parse_errors = 0;
    let mut saw_get_response = false;
    while !saw_get_response {
        let value = read_value(&mut harness.read).await;
        if value.assert_at("id") == 9 {
            assert!(value.get("result").is_some(), "{value}");
            saw_get_response = true;
        } else {
            assert_eq!(field(&value, &["error", "code"]), -32700, "{value}");
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
async fn wrong_version_envelope_retains_duplicate_id_precedence() {
    let (mut harness, gate) = spawn_gated_harness::<Harness>().await;
    assert_wrong_version_envelope_retains_duplicate_precedence(&mut harness, &gate).await;
    shut_down(harness).await;
}

#[tokio::test]
async fn wrong_version_subscription_methods_are_invalid_requests() {
    assert_subscription_envelope_validation_for_binding::<Harness>().await;
}

#[tokio::test]
async fn malformed_frame_remains_subject_to_task_slot_saturation() {
    let (mut harness, _gate) = spawn_gated_harness::<Harness>().await;
    assert_malformed_frame_is_dropped_at_task_saturation(&mut harness, 256).await;
    shut_down(harness).await;
}

#[tokio::test]
async fn duplicate_subscription_cancel_keys_are_malformed_and_cancel_nothing() {
    let store = Arc::new(FixtureStore::new(RunId::new("run-1"), Vec::new(), 8));
    let mut harness = spawn_server(FixtureBackend::new(Arc::clone(&store)));
    {
        let mut channel = NdjsonDuplicateCancellation {
            harness: &mut harness,
            store,
            subscription_id: None,
        };
        assert_duplicate_cancellation_is_malformed(&mut channel).await;
    }
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
        let sub = string_field(&value, &["params", "subscriptionId"]).to_owned();
        let cursor = string_field(&value, &["params", "cursor"]).to_owned();
        by_sub.entry(sub).or_default().push(cursor);
    }
    assert_eq!(
        by_sub.get(sub_a).assert_value(),
        &vec!["cursor-1".to_owned()]
    );
    assert_eq!(
        by_sub.get(sub_b).assert_value(),
        &vec!["cursor-1".to_owned()]
    );
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
    assert_eq!(sync_response.assert_at("id"), 100);
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
            Ok(line) => frames.push(serde_json::from_str::<Value>(&line).assert_value()),
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
        let sub = string_field(value, &["params", "subscriptionId"]);
        let cursor = string_field(value, &["params", "cursor"]).to_owned();
        if sub == sub_a {
            sub_a_cursors.push(cursor);
        } else if sub == sub_b {
            sub_b_cursors.push(cursor);
        }
        assert!(
            sub == sub_a || sub == sub_b,
            "unexpected subscriptionId {sub}"
        );
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

    let sub_a = open_watch(&mut harness, 1).await;

    let sub_b = open_watch(&mut harness, 2).await;
    assert_ne!(sub_a, sub_b);

    assert_shared_bookmark_delivered(&mut harness, &store, &sub_a, &sub_b).await;
    assert_cancel_stops_only_selected_subscription(&mut harness, &store, &sub_a, &sub_b).await;

    shut_down(harness).await;
}

#[tokio::test]
async fn slow_consumer_closes_with_the_last_delivered_cursor() {
    const FIXTURE_QUEUE_CAPACITY: usize = 2;
    let (store, mut harness) = empty_watch_harness(FIXTURE_QUEUE_CAPACITY);

    let subscription_id = open_watch(&mut harness, 1).await;

    // The bounded queue holds two entries; the third publish overflows it.
    store.publish(WatchEvent::Bookmark).await;
    store.publish(WatchEvent::Bookmark).await;
    store.publish(WatchEvent::Bookmark).await;

    let mut closed = None;
    while closed.is_none() {
        let value = read_value(&mut harness.read).await;
        assert_eq!(
            string_field(&value, &["params", "subscriptionId"]),
            subscription_id
        );
        let method = string_field(&value, &["method"]);
        if method == "subscription/closed" {
            closed = Some(value);
        } else {
            assert_eq!(method, "event", "unexpected notification method {method}");
        }
    }
    let closed = closed.assert_value();
    assert_eq!(field(&closed, &["params", "reason"]), "SLOW_CONSUMER");
    assert_eq!(
        field(&closed, &["params", "lastDeliveredCursor"]),
        "cursor-2"
    );

    shut_down(harness).await;
}

#[tokio::test]
async fn eof_terminates_deterministically() {
    let (_store, harness) = empty_watch_harness(8);
    shut_down(harness).await;
}

#[path = "subscription_ndjson/idle_cancel.rs"]
mod idle_cancel;
