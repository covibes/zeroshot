//! Client-side NDJSON `logs` subscription coverage: cancellation, independent request ids, and
//! unread-subscription backpressure isolation, driven over the wire against `serve_ndjson` instead
//! of the in-process `Dispatcher::logs` passthrough. Mirrors
//! `tests/subscription_ndjson.rs`'s equivalent `watch` coverage, minus dedup/reconnect (`logs` has
//! no cursor to resume from).

use std::sync::Arc;
use std::time::Duration;

use openengine_cluster_client::{
    ClusterClient, JsonRpcTransport, LogEventOrClosed, NdjsonLogsClient, NdjsonTransport,
};
use openengine_cluster_protocol::{
    BoundedLogTarget, BoundedLogMessage, GetParams, LogLevel, LogRecord, LogsParams,
};
use openengine_cluster_server::logs::fixtures::{LogsFixtureBackend, LogsFixtureStore};
use openengine_cluster_server::watch::fixtures::{await_ndjson_shutdown, spawn_ndjson};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, DuplexStream};

fn sample_log_record(message: &str) -> LogRecord {
    LogRecord {
        level: LogLevel::Info,
        target: BoundedLogTarget::new("worker-dispatch").expect("fixture target must be valid"),
        message: BoundedLogMessage::new(message).expect("fixture message must be valid"),
    }
}

#[tokio::test]
async fn cancel_stops_further_delivery() {
    let store = Arc::new(LogsFixtureStore::new());
    let (client_write, client_read, server) =
        spawn_ndjson(LogsFixtureBackend::new(Arc::clone(&store)));

    let transport = NdjsonTransport::new(client_read, client_write);
    let logs_client = NdjsonLogsClient::new(&transport);
    let (_result, mut stream) = logs_client.logs(LogsParams::default()).await.unwrap();

    store.publish(sample_log_record("first")).await;
    match stream.next().await.unwrap().unwrap() {
        LogEventOrClosed::Event(record) => assert_eq!(record.message.as_str(), "first"),
        other => panic!("expected an event, got {other:?}"),
    }

    stream.cancel().await.unwrap();

    // `cancel()` only writes a fire-and-forget notification line -- it does not wait for the
    // server to have applied it. Force a synchronous round trip on the same connection so the
    // subsequent publishes are guaranteed to happen only after the server's read loop has already
    // processed (and synchronously applied) the preceding cancel line.
    ClusterClient::new(&transport)
        .get(GetParams::default())
        .await
        .unwrap();

    // The server-side subscription task may already be parked awaiting the next live event at the
    // moment cancellation is processed, so at most one further event may still be delivered before
    // it observes cancellation and stops for good.
    store.publish(sample_log_record("maybe-leaked")).await;
    store.publish(sample_log_record("must-never-arrive")).await;

    let mut leaked = Vec::new();
    loop {
        match tokio::time::timeout(Duration::from_millis(300), stream.next()).await {
            Ok(Some(Ok(LogEventOrClosed::Event(record)))) => {
                leaked.push(record.message.as_str().to_owned())
            }
            Ok(Some(Ok(other))) => panic!("unexpected notification after cancel: {other:?}"),
            Ok(Some(Err(e))) => panic!("unexpected error: {e}"),
            Ok(None) | Err(_) => break,
        }
    }
    assert!(
        leaked.len() <= 1,
        "cancelled subscription received more than one post-cancel event: {leaked:?}"
    );
    if let Some(message) = leaked.first() {
        assert_eq!(
            message, "maybe-leaked",
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
async fn independent_request_id_source() {
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
                "result": {"subscriptionId": "sub-2"}
            }),
        )
        .await;
        write_json_line(
            &mut server_write,
            json!({
                "jsonrpc": "2.0",
                "id": first_id,
                "result": {"subscriptionId": "sub-1"}
            }),
        )
        .await;
    });

    let transport = NdjsonTransport::new(client_read, client_write);
    let first = NdjsonLogsClient::new(&transport);
    let second = NdjsonLogsClient::new(&transport);
    let (first_result, second_result) = tokio::join!(
        first.logs(LogsParams::default()),
        second.logs(LogsParams::default())
    );
    assert_ne!(
        first_result.unwrap().0.subscription_id,
        second_result.unwrap().0.subscription_id
    );
    server.await.unwrap();
}

#[tokio::test]
async fn next_returns_an_error_instead_of_panicking_on_a_malformed_event_notification() {
    let (client_write, server_read) = tokio::io::duplex(1 << 16);
    let (mut server_write, client_read) = tokio::io::duplex(1 << 16);
    let server = tokio::spawn(async move {
        let mut server_read = BufReader::new(server_read);
        let logs = read_json_line(&mut server_read).await;
        write_json_line(
            &mut server_write,
            json!({
                "jsonrpc": "2.0",
                "id": logs["id"],
                "result": {"subscriptionId": "sub-1"}
            }),
        )
        .await;
        write_json_line(
            &mut server_write,
            json!({
                "jsonrpc": "2.0",
                "method": "event",
                "params": {"subscriptionId": "sub-1"}
            }),
        )
        .await;
    });

    let transport = NdjsonTransport::new(client_read, client_write);
    let logs_client = NdjsonLogsClient::new(&transport);
    let (_result, mut stream) = logs_client.logs(LogsParams::default()).await.unwrap();

    match stream.next().await {
        Some(Err(_)) => {}
        other => panic!("expected an error for a malformed event notification, got {other:?}"),
    }

    server.await.unwrap();
}

#[tokio::test]
async fn next_returns_an_error_instead_of_panicking_on_an_unexpected_notification_method() {
    let (client_write, server_read) = tokio::io::duplex(1 << 16);
    let (mut server_write, client_read) = tokio::io::duplex(1 << 16);
    let server = tokio::spawn(async move {
        let mut server_read = BufReader::new(server_read);
        let logs = read_json_line(&mut server_read).await;
        write_json_line(
            &mut server_write,
            json!({
                "jsonrpc": "2.0",
                "id": logs["id"],
                "result": {"subscriptionId": "sub-1"}
            }),
        )
        .await;
        write_json_line(
            &mut server_write,
            json!({
                "jsonrpc": "2.0",
                "method": "unexpected/method",
                "params": {"subscriptionId": "sub-1"}
            }),
        )
        .await;
    });

    let transport = NdjsonTransport::new(client_read, client_write);
    let logs_client = NdjsonLogsClient::new(&transport);
    let (_result, mut stream) = logs_client.logs(LogsParams::default()).await.unwrap();

    match stream.next().await {
        Some(Err(_)) => {}
        other => panic!("expected an error for an unexpected notification method, got {other:?}"),
    }

    server.await.unwrap();
}

/// Drives the wire side of `unread_subscription_overflow_does_not_block_unary_responses`: accepts
/// the `logs` subscription, floods `queue_capacity + 1` events to force a local client-side
/// overflow, then waits for both the resulting cancellation and an interleaved unary `get`.
async fn run_overflow_then_await_cancel_and_unary(
    server_read: DuplexStream,
    mut server_write: DuplexStream,
    queue_capacity: usize,
) {
    let mut server_read = BufReader::new(server_read);
    let logs = read_json_line(&mut server_read).await;
    write_json_line(
        &mut server_write,
        json!({
            "jsonrpc": "2.0",
            "id": logs["id"],
            "result": { "subscriptionId": "slow-subscription" }
        }),
    )
    .await;

    for index in 1..=queue_capacity + 1 {
        write_json_line(
            &mut server_write,
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
}

#[tokio::test]
async fn unread_subscription_overflow_does_not_block_unary_responses() {
    const CLIENT_QUEUE_CAPACITY: usize = 1024;

    let (client_write, server_read) = tokio::io::duplex(1 << 20);
    let (server_write, client_read) = tokio::io::duplex(1 << 20);
    let server = tokio::spawn(run_overflow_then_await_cancel_and_unary(
        server_read,
        server_write,
        CLIENT_QUEUE_CAPACITY,
    ));

    let transport = NdjsonTransport::new(client_read, client_write);
    let logs_client = NdjsonLogsClient::new(&transport);
    let (_result, mut stream) = logs_client.logs(LogsParams::default()).await.unwrap();

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
    let events = tokio::time::timeout(Duration::from_secs(2), async {
        let mut events = 0;
        loop {
            match stream.next().await {
                Some(Ok(LogEventOrClosed::Event(_))) => events += 1,
                Some(Ok(LogEventOrClosed::Closed { reason })) => {
                    assert_eq!(
                        reason,
                        openengine_cluster_protocol::SubscriptionCloseReason::SlowConsumer
                    );
                    break events;
                }
                Some(Err(e)) => panic!("unexpected error: {e}"),
                None => panic!("local overflow ended without a SLOW_CONSUMER close"),
            }
        }
    })
    .await
    .expect("buffered notifications and the local overflow close must drain");
    assert_eq!(events, CLIENT_QUEUE_CAPACITY);
}
