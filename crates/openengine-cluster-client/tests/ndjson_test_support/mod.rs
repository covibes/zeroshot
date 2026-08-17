use std::time::Duration;

use openengine_cluster_client::JsonRpcTransport;
use openengine_cluster_protocol::SubscriptionId;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, DuplexStream};

use crate::support::{AssertValue, JsonAt};

pub const CLIENT_QUEUE_CAPACITY: usize = 1024;

pub fn duplex_pair(capacity: usize) -> (DuplexStream, DuplexStream, DuplexStream, DuplexStream) {
    let (client_write, server_read) = tokio::io::duplex(capacity);
    let (server_write, client_read) = tokio::io::duplex(capacity);
    (client_write, server_read, server_write, client_read)
}

pub async fn assert_distinct_ids_and_server(
    ids: (SubscriptionId, SubscriptionId),
    server: tokio::task::JoinHandle<()>,
) {
    assert_ne!(ids.0, ids.1);
    server.await.assert_value();
}

pub fn spawn_overflow_scenario(
    subscription_result: Value,
    event: impl Fn(usize) -> Value + Send + 'static,
) -> (DuplexStream, DuplexStream, tokio::task::JoinHandle<()>) {
    let (client_write, server_read, server_write, client_read) = duplex_pair(1 << 20);
    let server = tokio::spawn(serve_overflow_then_unary(
        (server_read, server_write),
        CLIENT_QUEUE_CAPACITY,
        subscription_result,
        event,
    ));
    (client_write, client_read, server)
}

pub async fn write_json_line(writer: &mut DuplexStream, value: Value) {
    writer
        .write_all(value.to_string().as_bytes())
        .await
        .assert_value();
    writer.write_all(b"\n").await.assert_value();
    writer.flush().await.assert_value();
}

pub async fn read_json_line(reader: &mut BufReader<DuplexStream>) -> Value {
    let mut line = Vec::new();
    assert!(reader.read_until(b'\n', &mut line).await.assert_value() > 0);
    serde_json::from_slice(&line).assert_value()
}

pub async fn serve_distinct_subscription_ids(
    server_read: DuplexStream,
    mut server_write: DuplexStream,
    result: impl Fn(&str) -> Value,
) {
    let mut server_read = BufReader::new(server_read);
    let first = read_json_line(&mut server_read).await;
    let second = read_json_line(&mut server_read).await;
    let first_id = first.assert_key("id").clone();
    let second_id = second.assert_key("id").clone();
    assert_ne!(first_id, second_id);

    write_json_line(
        &mut server_write,
        json!({"jsonrpc": "2.0", "id": second_id, "result": result("sub-2")}),
    )
    .await;
    write_json_line(
        &mut server_write,
        json!({"jsonrpc": "2.0", "id": first_id, "result": result("sub-1")}),
    )
    .await;
}

pub async fn serve_overflow_then_unary(
    connection: (DuplexStream, DuplexStream),
    queue_capacity: usize,
    subscription_result: Value,
    event: impl Fn(usize) -> Value,
) {
    let (server_read, mut server_write) = connection;
    let mut server_read = BufReader::new(server_read);
    let subscribe = read_json_line(&mut server_read).await;
    write_json_line(
        &mut server_write,
        json!({
            "jsonrpc": "2.0",
            "id": subscribe.assert_key("id"),
            "result": subscription_result
        }),
    )
    .await;

    for index in 1..=queue_capacity + 1 {
        write_json_line(&mut server_write, event(index)).await;
    }

    let mut saw_cancel = false;
    let mut saw_unary = false;
    while !(saw_cancel && saw_unary) {
        let request = read_json_line(&mut server_read).await;
        if request.assert_key("method") == "subscription/cancel" {
            assert_eq!(
                request.assert_key("params").assert_key("subscriptionId"),
                "slow-subscription"
            );
            saw_cancel = true;
        } else {
            assert_eq!(request.assert_key("method"), "get");
            write_json_line(
                &mut server_write,
                json!({"jsonrpc": "2.0", "id": request.assert_key("id"), "result": {}}),
            )
            .await;
            saw_unary = true;
        }
    }
}

pub async fn assert_unary_roundtrip(transport: &impl JsonRpcTransport) {
    let request =
        json!({"jsonrpc": "2.0", "id": "unary-1", "method": "get", "params": {}}).to_string();
    let response = tokio::time::timeout(Duration::from_secs(2), transport.request(request))
        .await
        .assert_value_with("an unread subscription must not block the shared response pump")
        .assert_value();
    assert_eq!(
        serde_json::from_str::<Value>(&response)
            .assert_value()
            .assert_key("id"),
        "unary-1"
    );
}
