use async_trait::async_trait;
use openengine_cluster_protocol::{
    ClusterStatus, Cursor, GetParams, GetResult, InitializeParams, InitializeResult,
    ServerCapabilities, APPLICATION_ERROR, INVALID_PHASE, PROTOCOL_VERSION,
};
use openengine_cluster_server::{BackendError, ClusterBackend, ConnectionContext};
use serde_json::{json, Value};
use zeroshot_engine::{dispatcher_for_route, NativeBackendFactory, ProductionNativeBackendFactory};

fn graph() -> Value {
    json!({
        "profile": "openengine.graph.single-worker/v1",
        "initialInput": {"kind": "null"},
        "policy": {"policy": "policy.default@1", "default": "deny"},
        "root": {
            "kind": "step",
            "name": "worker",
            "worker": "legacy.zeroshot.ship@1",
            "input": {"kind": "null"},
            "output": {"kind": "null"},
            "inputBindings": [],
            "writeBindings": [],
            "timeoutMs": 1,
            "attempts": 1
        }
    })
}

async fn dispatch(method: &str, params: Value) -> Value {
    let dispatcher = dispatcher_for_route(
        &ProductionNativeBackendFactory,
        ConnectionContext::default(),
    );
    let response = dispatcher
        .dispatch(
            &json!({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).to_string(),
        )
        .await;
    serde_json::from_str(&response).expect("dispatcher response must be JSON")
}

fn empty_status() -> Value {
    json!({
        "phase": "empty",
        "observedGeneration": null,
        "currentRunId": null,
        "atCursor": null
    })
}

#[tokio::test]
async fn production_dispatcher_returns_canonical_empty_initialize_and_get() {
    let initialize = dispatch("initialize", json!({"protocolVersion": PROTOCOL_VERSION})).await;
    assert_eq!(
        initialize["result"],
        json!({
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": { "graphProfiles": [], "logs": false, "agentAttach": false },
            "status": empty_status()
        })
    );
    assert_eq!(
        initialize["result"]["capabilities"],
        json!({ "graphProfiles": [], "logs": false, "agentAttach": false })
    );

    let get = dispatch("get", json!({"atCursor": null})).await;
    assert_eq!(
        get["result"],
        json!({"spec": null, "status": empty_status(), "atCursor": null})
    );
}

#[tokio::test]
async fn valid_unsupported_operations_reach_backend_defaults() {
    let requests = [
        ("plan", json!({"graph": graph()})),
        (
            "apply",
            json!({
                "graph": graph(),
                "input": null,
                "dryRun": false,
                "idempotencyKey": "apply-1"
            }),
        ),
        (
            "update",
            json!({
                "suspended": true,
                "ifGeneration": 1,
                "idempotencyKey": "update-1"
            }),
        ),
        (
            "stop",
            json!({
                "mode": "drain",
                "ifGeneration": 1,
                "idempotencyKey": "stop-1"
            }),
        ),
    ];

    for (method, params) in requests {
        let response = dispatch(method, params).await;
        assert_eq!(response["error"]["code"], APPLICATION_ERROR, "{method}");
        assert_eq!(
            response["error"]["data"]["code"], INVALID_PHASE,
            "{method} must reach the backend default"
        );
        assert!(response.get("result").is_none(), "{method}");
    }
}

struct FakeFactory;

struct FakeBackend {
    route: String,
}

impl NativeBackendFactory for FakeFactory {
    type Backend = FakeBackend;

    fn create(&self, context: &ConnectionContext) -> Self::Backend {
        FakeBackend {
            route: context
                .peer_label
                .clone()
                .expect("test route must identify its isolated cluster"),
        }
    }
}

#[async_trait]
impl ClusterBackend for FakeBackend {
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
            at_cursor: Some(Cursor::new(self.route.clone())),
        })
    }
}

#[tokio::test]
async fn factory_injection_composes_the_selected_backend_with_its_route() {
    let context = ConnectionContext {
        peer_label: Some("cluster-route-7".to_owned()),
        ..ConnectionContext::default()
    };
    let dispatcher = dispatcher_for_route(&FakeFactory, context);
    let response: Value = serde_json::from_str(
        &dispatcher
            .dispatch(
                &json!({"jsonrpc": "2.0", "id": 7, "method": "get", "params": {}}).to_string(),
            )
            .await,
    )
    .expect("dispatcher response must be JSON");

    assert_eq!(response["result"]["atCursor"], "cluster-route-7");
}
