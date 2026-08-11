use async_trait::async_trait;
use openengine_cluster_protocol::{
    ApplyParams, ApplyResult, ClusterStatus, GetParams, GetResult, InitializeParams,
    InitializeResult, Phase, PlanParams, PlanResult, ServerCapabilities, SCHEMA_VIOLATION,
};
use openengine_cluster_server::{BackendError, ClusterBackend, ConnectionContext, Dispatcher};
use serde_json::json;

struct RoutingBackend;

#[async_trait]
impl ClusterBackend for RoutingBackend {
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

    async fn plan(
        &self,
        _context: &ConnectionContext,
        _params: PlanParams,
    ) -> Result<PlanResult, BackendError> {
        Ok(PlanResult {
            ok: false,
            diagnostics: vec![],
            bounds: None,
        })
    }

    async fn apply(
        &self,
        _context: &ConnectionContext,
        _params: ApplyParams,
    ) -> Result<ApplyResult, BackendError> {
        Err(BackendError::invalid_params(
            SCHEMA_VIOLATION,
            "invalid apply",
            Some(json!({"reason":"fixture"})),
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

fn graph() -> serde_json::Value {
    json!({
        "profile":"openengine.graph.single-worker/v1",
        "initialInput":{"kind":"null"},
        "policy":{"policy":"policy.default@1","default":"deny"},
        "root":{
            "kind":"step","name":"worker","worker":"legacy.zeroshot.ship@1",
            "input":{"kind":"null"},"output":{"kind":"null"},
            "inputBindings":[],"writeBindings":[],"timeoutMs":1,"attempts":1
        }
    })
}

#[tokio::test]
async fn admission_dispatch_routes_typed_plan_and_apply() {
    let dispatcher = Dispatcher::new(RoutingBackend, ConnectionContext::default());
    let plan: serde_json::Value = serde_json::from_str(
        &dispatcher
            .dispatch(
                &json!({"jsonrpc":"2.0","id":1,"method":"plan","params":{"graph":graph()}})
                    .to_string(),
            )
            .await,
    )
    .unwrap();
    assert_eq!(plan["result"], json!({"ok":false,"diagnostics":[]}));

    let apply: serde_json::Value = serde_json::from_str(
        &dispatcher
            .dispatch(
                &json!({
                    "jsonrpc":"2.0","id":2,"method":"apply",
                    "params":{"graph":graph(),"input":null,"idempotencyKey":"key"}
                })
                .to_string(),
            )
            .await,
    )
    .unwrap();
    assert_eq!(apply["error"]["code"], -32602);
    assert_eq!(apply["error"]["data"]["code"], SCHEMA_VIOLATION);
    assert_eq!(apply["error"]["data"]["details"]["reason"], "fixture");
    assert!(apply.get("result").is_none());
    assert_ne!(Phase::Admitting, Phase::Running);
}
