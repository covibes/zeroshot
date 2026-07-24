use async_trait::async_trait;
use openengine_cluster_protocol::{
    ClusterStatus, GetParams, GetResult, GraphProfile, GraphProfileSet, InitializeParams,
    InitializeResult, ServerCapabilities,
};
use openengine_cluster_server::{BackendError, ClusterBackend, ConnectionContext, Dispatcher};
use serde_json::json;

struct DefaultCapabilitiesBackend;

#[async_trait]
impl ClusterBackend for DefaultCapabilitiesBackend {
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
        unreachable!()
    }
}

struct SingleWorkerCapabilitiesBackend;

#[async_trait]
impl ClusterBackend for SingleWorkerCapabilitiesBackend {
    async fn initialize(
        &self,
        _context: &ConnectionContext,
        _params: InitializeParams,
    ) -> Result<InitializeResult, BackendError> {
        Ok(InitializeResult::new(
            ServerCapabilities {
                graph_profiles: GraphProfileSet::new(vec![GraphProfile::SingleWorker]).unwrap(),
                logs: false,
            },
            ClusterStatus::empty(),
        ))
    }

    async fn get(
        &self,
        _context: &ConnectionContext,
        _params: GetParams,
    ) -> Result<GetResult, BackendError> {
        unreachable!()
    }
}

async fn initialize_capabilities<B: ClusterBackend>(
    dispatcher: &Dispatcher<B>,
) -> serde_json::Value {
    let response: serde_json::Value = serde_json::from_str(
        &dispatcher
            .dispatch(
                &json!({
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": "initialize",
                    "params": { "protocolVersion": "openengine.cluster/v1" }
                })
                .to_string(),
            )
            .await,
    )
    .unwrap();
    response["result"]["capabilities"]["graphProfiles"].clone()
}

#[tokio::test]
async fn default_backend_advertises_no_graph_profiles() {
    let dispatcher = Dispatcher::new(DefaultCapabilitiesBackend, ConnectionContext::default());
    assert_eq!(initialize_capabilities(&dispatcher).await, json!([]));
}

#[tokio::test]
async fn scripted_backend_echoes_its_advertised_profiles() {
    let dispatcher = Dispatcher::new(
        SingleWorkerCapabilitiesBackend,
        ConnectionContext::default(),
    );
    assert_eq!(
        initialize_capabilities(&dispatcher).await,
        json!(["openengine.graph.single-worker/v1"])
    );
}
