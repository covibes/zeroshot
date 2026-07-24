//! Shared raw NDJSON line I/O primitives for driving `serve_ndjson` directly over
//! `tokio::io::duplex` pipes without a typed protocol client. Used by `tests/subscription_ndjson.rs`
//! and `tests/logs.rs`.

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, DuplexStream};

pub async fn write_line(writer: &mut DuplexStream, line: &str) {
    writer.write_all(line.as_bytes()).await.unwrap();
    writer.write_all(b"\n").await.unwrap();
    writer.flush().await.unwrap();
}

pub async fn read_line(reader: &mut BufReader<DuplexStream>) -> String {
    let mut line = String::new();
    let read = reader.read_line(&mut line).await.unwrap();
    assert!(
        read > 0,
        "connection closed unexpectedly while awaiting a line"
    );
    while line.ends_with(['\n', '\r']) {
        line.pop();
    }
    line
}

pub async fn read_value(reader: &mut BufReader<DuplexStream>) -> Value {
    serde_json::from_str(&read_line(reader).await).unwrap()
}

pub fn request_line(id: i64, method: &str, params: Value) -> String {
    json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}).to_string()
}
