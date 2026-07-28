//! Shared wire-level assertion for "an oversized/unencodable subscription event ends its own
//! subscription without panicking the server task, and the connection keeps serving unary
//! requests afterward" -- `logs` and `agent_attach` need byte-for-byte the same establish/publish/
//! assert shape over `serve_ndjson`, differing only in the establishment method/params and how the
//! oversized event is published, so it exists exactly once instead of being hand-copied per
//! capability. Used by `tests/logs.rs` and `tests/agent_attach.rs`.

use std::future::Future;

use serde_json::{json, Value};
use tokio::io::{BufReader, DuplexStream};

use super::ndjson_test_support::{read_value, request_line, write_line};

/// Grouped connection halves for [`assert_oversized_event_does_not_block_unary_responses`],
/// keeping that function's argument count reasonable.
pub struct OversizedEventWire<'a> {
    pub write: &'a mut DuplexStream,
    pub read: &'a mut BufReader<DuplexStream>,
}

/// Establishes a subscription over `wire` by sending `method`/`params`, publishes an oversized
/// event via `publish_oversized`, then asserts the connection still answers a unary `get`
/// afterward -- proving the oversized/unencodable event was dropped instead of ever reaching the
/// wire or panicking the server task.
pub async fn assert_oversized_event_does_not_block_unary_responses<F>(
    wire: OversizedEventWire<'_>,
    method: &str,
    params: Value,
    publish_oversized: impl FnOnce() -> F,
) where
    F: Future<Output = ()>,
{
    let OversizedEventWire { write, read } = wire;
    write_line(write, &request_line(1, method, params)).await;
    let established = read_value(read).await;
    assert!(established.get("result").is_some(), "{established}");

    publish_oversized().await;

    write_line(write, &request_line(2, "get", json!({}))).await;
    let get_response = read_value(read).await;
    assert_eq!(get_response["id"], 2);
    assert!(
        get_response.get("result").is_some(),
        "connection must keep serving unary requests after an unencodable event: {get_response}"
    );
}
