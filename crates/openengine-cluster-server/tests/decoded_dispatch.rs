use async_trait::async_trait;
use openengine_cluster_protocol::{
    ClusterStatus, GetParams, GetResult, InitializeParams, InitializeResult, RequestId,
    ServerCapabilities,
};
use openengine_cluster_server::{BackendError, ClusterBackend, ConnectionContext, Dispatcher};
use serde_json::{Map, Value};

struct EmptyBackend;

#[async_trait]
impl ClusterBackend for EmptyBackend {
    async fn initialize(
        &self,
        _context: &ConnectionContext,
        _params: InitializeParams,
    ) -> Result<InitializeResult, BackendError> {
        Ok(InitializeResult::new(
            ServerCapabilities::default(),
            ClusterStatus::empty(),
        ))
    }

    async fn get(
        &self,
        _context: &ConnectionContext,
        _params: GetParams,
    ) -> Result<GetResult, BackendError> {
        Ok(GetResult {
            spec: None,
            status: ClusterStatus::empty(),
            at_cursor: None,
            terminal_result: None,
        })
    }
}

#[tokio::test]
async fn decoded_routing_accepts_rust_values_and_matches_envelope_dispatch_byte_for_byte() {
    let dispatcher = Dispatcher::new(EmptyBackend, ConnectionContext::default());

    let decoded_response = dispatcher
        .dispatch_decoded(RequestId::Integer(1), "get", Value::Object(Map::new()))
        .await;
    assert_eq!(
        decoded_response,
        r#"{"jsonrpc":"2.0","id":1,"result":{"spec":null,"status":{"phase":"empty","observedGeneration":null,"currentRunId":null,"atCursor":null},"atCursor":null}}"#
    );

    let envelope_response = dispatcher
        .dispatch(r#"{"jsonrpc":"2.0","id":1,"method":"get","params":{}}"#)
        .await;
    assert_eq!(decoded_response, envelope_response);
}

#[tokio::test]
async fn decoded_unknown_method_precedes_parameter_shape_validation() {
    let dispatcher = Dispatcher::new(EmptyBackend, ConnectionContext::default());

    let response = dispatcher
        .dispatch_decoded(
            RequestId::String("decoded".to_owned()),
            "missing",
            Value::Array(Vec::new()),
        )
        .await;

    assert_eq!(
        response,
        r#"{"jsonrpc":"2.0","id":"decoded","error":{"code":-32601,"message":"Method not found"}}"#
    );
}

const ENVELOPE_ERROR_CASES: &[(&str, &str, &str)] = &[
    (
        "non-JSON input",
        "{",
        r#"{"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"Parse error"}}"#,
    ),
    (
        "JSON array",
        "[]",
        r#"{"jsonrpc":"2.0","id":null,"error":{"code":-32600,"message":"Invalid Request"}}"#,
    ),
    (
        "JSON scalar",
        "42",
        r#"{"jsonrpc":"2.0","id":null,"error":{"code":-32600,"message":"Invalid Request"}}"#,
    ),
    (
        "missing jsonrpc",
        r#"{"id":1,"method":"get","params":{}}"#,
        r#"{"jsonrpc":"2.0","id":null,"error":{"code":-32600,"message":"Invalid Request"}}"#,
    ),
    (
        "wrong jsonrpc",
        r#"{"jsonrpc":"1.0","id":1,"method":"get","params":{}}"#,
        r#"{"jsonrpc":"2.0","id":null,"error":{"code":-32600,"message":"Invalid Request"}}"#,
    ),
    (
        "missing id",
        r#"{"jsonrpc":"2.0","method":"get","params":{}}"#,
        r#"{"jsonrpc":"2.0","id":null,"error":{"code":-32600,"message":"Invalid Request"}}"#,
    ),
    (
        "non-scalar id",
        r#"{"jsonrpc":"2.0","id":{},"method":"get","params":{}}"#,
        r#"{"jsonrpc":"2.0","id":null,"error":{"code":-32600,"message":"Invalid Request"}}"#,
    ),
    (
        "unknown method with object params",
        r#"{"jsonrpc":"2.0","id":10,"method":"missing","params":{}}"#,
        r#"{"jsonrpc":"2.0","id":10,"error":{"code":-32601,"message":"Method not found"}}"#,
    ),
    (
        "unknown method with array params",
        r#"{"jsonrpc":"2.0","id":10,"method":"missing","params":[]}"#,
        r#"{"jsonrpc":"2.0","id":10,"error":{"code":-32601,"message":"Method not found"}}"#,
    ),
    (
        "unknown method with null params",
        r#"{"jsonrpc":"2.0","id":10,"method":"missing","params":null}"#,
        r#"{"jsonrpc":"2.0","id":10,"error":{"code":-32601,"message":"Method not found"}}"#,
    ),
    (
        "unknown method with string params",
        r#"{"jsonrpc":"2.0","id":10,"method":"missing","params":"scalar"}"#,
        r#"{"jsonrpc":"2.0","id":10,"error":{"code":-32601,"message":"Method not found"}}"#,
    ),
    (
        "unknown method with absent params",
        r#"{"jsonrpc":"2.0","id":10,"method":"missing"}"#,
        r#"{"jsonrpc":"2.0","id":10,"error":{"code":-32601,"message":"Method not found"}}"#,
    ),
    (
        "known method with absent params",
        r#"{"jsonrpc":"2.0","id":"absent","method":"get"}"#,
        r#"{"jsonrpc":"2.0","id":"absent","error":{"code":-32602,"message":"Invalid params"}}"#,
    ),
    (
        "known method with array params",
        r#"{"jsonrpc":"2.0","id":"array","method":"get","params":[]}"#,
        r#"{"jsonrpc":"2.0","id":"array","error":{"code":-32602,"message":"Invalid params"}}"#,
    ),
    (
        "known method with null params",
        r#"{"jsonrpc":"2.0","id":"null","method":"get","params":null}"#,
        r#"{"jsonrpc":"2.0","id":"null","error":{"code":-32602,"message":"Invalid params"}}"#,
    ),
    (
        "known method with string params",
        r#"{"jsonrpc":"2.0","id":"string","method":"get","params":"scalar"}"#,
        r#"{"jsonrpc":"2.0","id":"string","error":{"code":-32602,"message":"Invalid params"}}"#,
    ),
];

#[tokio::test]
async fn envelope_errors_retain_exact_frames_and_observable_validation_order() {
    let dispatcher = Dispatcher::new(EmptyBackend, ConnectionContext::default());

    for &(name, request, expected) in ENVELOPE_ERROR_CASES {
        assert_eq!(dispatcher.dispatch(request).await, expected, "{name}");
    }
}
