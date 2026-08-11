use async_trait::async_trait;
use openengine_cluster_protocol::{
    ClusterStatus, Cursor, GetParams, GetResult, InitializeParams, InitializeResult,
    ServerCapabilities,
};
use openengine_cluster_server::identity::{
    BindingAttributes, ConnectionIdentity, ConnectionIdentityConfig, PrincipalId, TenantId,
};
use openengine_cluster_server::{BackendError, ClusterBackend, ConnectionContext};
use serde_json::{json, Value};
use zeroshot_engine::{dispatcher_for_route, NativeBackendFactory};

struct FakeFactory;

struct FakeBackend;

impl NativeBackendFactory for FakeFactory {
    type Backend = FakeBackend;

    fn create(&self) -> Self::Backend {
        FakeBackend
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
        context: &ConnectionContext,
        _params: GetParams,
    ) -> Result<GetResult, BackendError> {
        Ok(GetResult {
            spec: None,
            status: ClusterStatus::empty(),
            at_cursor: Some(Cursor::new(context.identity().tenant().as_str())),
        })
    }
}

#[tokio::test]
async fn factory_injection_composes_the_selected_backend_with_an_injected_route() {
    let context = ConnectionContext::new(
        ConnectionIdentity::new(ConnectionIdentityConfig {
            principal: PrincipalId::new("principal-7"),
            tenant: TenantId::new("cluster-route-7"),
            issued_at_ms: Some(1),
            expires_at_ms: u64::MAX,
            binding_attributes: BindingAttributes::default(),
        }),
        Default::default(),
    );
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
