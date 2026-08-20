//! Client-side NDJSON `logs` subscription coverage: cancellation, independent request ids, and
//! unread-subscription backpressure isolation, driven over the wire against `serve_ndjson` instead
//! of the in-process `Dispatcher::logs` passthrough. Mirrors
//! `tests/subscription_ndjson.rs`'s equivalent `watch` coverage, minus dedup/reconnect (`logs` has
//! no cursor to resume from).

use std::sync::Arc;
use std::time::Duration;

use openengine_cluster_client::{
    LogEventOrClosed, NdjsonLogsClient, NdjsonLogsEventStream, NdjsonTransport,
};
use openengine_cluster_protocol::{LogLevel, LogRecord, LogsParams};
use openengine_cluster_server::logs::fixtures::{
    fixture_log_record, LogsFixtureBackend, LogsFixtureStore,
};
use openengine_cluster_server::watch::fixtures::{await_ndjson_shutdown, spawn_ndjson};
use serde_json::{json, Value};
use tokio::io::{BufReader, DuplexStream};

#[path = "support/mod.rs"]
pub mod support;
use support::{AssertValue, JsonAt};

#[path = "ndjson_test_support/mod.rs"]
mod ndjson_test_support;
use ndjson_test_support::{
    assert_distinct_ids_and_server, assert_unary_roundtrip, duplex_pair, read_json_line,
    serve_distinct_subscription_ids, spawn_overflow_scenario, write_json_line,
    CLIENT_QUEUE_CAPACITY,
};

#[path = "cancel_leak_support/mod.rs"]
mod cancel_leak_support;
use cancel_leak_support::assert_cancel_stops_further_delivery;

fn sample_log_record(message: &str) -> LogRecord {
    fixture_log_record(LogLevel::Info, message)
        .assert_value_with("fixture log record must be valid")
}

async fn open_log_stream<'a>(
    transport: &'a NdjsonTransport<DuplexStream, DuplexStream>,
) -> NdjsonLogsEventStream<'a, DuplexStream, DuplexStream> {
    NdjsonLogsClient::new(transport)
        .logs(LogsParams::default())
        .await
        .assert_value()
        .1
}

#[tokio::test]
async fn cancel_stops_further_delivery() {
    let store = Arc::new(LogsFixtureStore::new());
    let (client_write, client_read, server) =
        spawn_ndjson(LogsFixtureBackend::new(Arc::clone(&store)));

    let transport = NdjsonTransport::new(client_read, client_write);
    let mut stream = open_log_stream(&transport).await;

    store.publish(sample_log_record("first")).await;
    let record = match stream.next().await.assert_value().assert_value() {
        LogEventOrClosed::Event(record) => Some(record),
        LogEventOrClosed::Closed { .. } => None,
    }
    .assert_value_with("expected the first log event");
    assert_eq!(record.message.as_str(), "first");

    assert_cancel_stops_further_delivery(
        &mut stream,
        &transport,
        |text| store.publish(sample_log_record(text)),
        |item| match item {
            LogEventOrClosed::Event(record) => Some(record.message.as_str().to_owned()),
            LogEventOrClosed::Closed { .. } => None,
        },
    )
    .await;

    drop(stream);
    drop(transport);
    await_ndjson_shutdown(server).await;
}

#[tokio::test]
async fn independent_request_id_source() {
    let (client_write, server_read, server_write, client_read) = duplex_pair(1 << 16);
    let server = tokio::spawn(serve_distinct_subscription_ids(
        server_read,
        server_write,
        |subscription_id| json!({"subscriptionId": subscription_id}),
    ));

    let transport = NdjsonTransport::new(client_read, client_write);
    let first = NdjsonLogsClient::new(&transport);
    let second = NdjsonLogsClient::new(&transport);
    let (first_result, second_result) = tokio::join!(
        first.logs(LogsParams::default()),
        second.logs(LogsParams::default())
    );
    let ids = (
        first_result.assert_value().0.subscription_id,
        second_result.assert_value().0.subscription_id,
    );
    assert_distinct_ids_and_server(ids, server).await;
}

#[tokio::test]
async fn next_returns_an_error_instead_of_panicking_on_a_malformed_event_notification() {
    assert_stream_rejects_notification("event", json!({"subscriptionId": "sub-1"})).await;
}

async fn assert_stream_rejects_notification(method: &str, params: Value) {
    let (client_write, server_read) = tokio::io::duplex(1 << 16);
    let (mut server_write, client_read) = tokio::io::duplex(1 << 16);
    let method = method.to_owned();
    let server = tokio::spawn(async move {
        let mut server_read = BufReader::new(server_read);
        let logs = read_json_line(&mut server_read).await;
        write_json_line(
            &mut server_write,
            json!({
                "jsonrpc": "2.0",
                "id": logs.assert_key("id"),
                "result": {"subscriptionId": "sub-1"}
            }),
        )
        .await;
        write_json_line(
            &mut server_write,
            json!({
                "jsonrpc": "2.0",
                "method": method,
                "params": params
            }),
        )
        .await;
    });

    let transport = NdjsonTransport::new(client_read, client_write);
    let mut stream = open_log_stream(&transport).await;

    assert!(matches!(stream.next().await, Some(Err(_))));

    server.await.assert_value();
}

#[tokio::test]
async fn next_returns_an_error_instead_of_panicking_on_an_unexpected_notification_method() {
    assert_stream_rejects_notification("unexpected/method", json!({"subscriptionId": "sub-1"}))
        .await;
}

/// Drives the wire side of `unread_subscription_overflow_does_not_block_unary_responses`: accepts
/// the `logs` subscription, floods `queue_capacity + 1` events to force a local client-side
/// overflow, then waits for both the resulting cancellation and an interleaved unary `get`.
#[tokio::test]
async fn unread_subscription_overflow_does_not_block_unary_responses() {
    let (client_write, client_read, server) =
        spawn_overflow_scenario(json!({"subscriptionId": "slow-subscription"}), |index| {
            json!({
                "jsonrpc": "2.0",
                "method": "event",
                "params": {
                    "subscriptionId": "slow-subscription",
                    "record": {
                        "level": "info",
                        "target": "worker-dispatch",
                        "message": format!("message-{index}")
                    }
                }
            })
        });

    let transport = NdjsonTransport::new(client_read, client_write);
    let mut stream = open_log_stream(&transport).await;

    assert_unary_roundtrip(&transport).await;

    server.await.assert_value();
    let events = tokio::time::timeout(Duration::from_secs(2), async {
        let mut events = 0;
        loop {
            match stream
                .next()
                .await
                .assert_value_with("expected a local overflow close")
                .assert_value()
            {
                LogEventOrClosed::Event(_) => events += 1,
                LogEventOrClosed::Closed { reason } => {
                    assert_eq!(
                        reason,
                        openengine_cluster_protocol::SubscriptionCloseReason::SlowConsumer
                    );
                    break events;
                }
            }
        }
    })
    .await
    .assert_value_with("buffered notifications and the local overflow close must drain");
    assert_eq!(events, CLIENT_QUEUE_CAPACITY);
}
