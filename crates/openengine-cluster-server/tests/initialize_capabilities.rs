use async_trait::async_trait;
use openengine_cluster_protocol::{
    ClusterStatus, GetParams, GetResult, GraphProfile, GraphProfileSet, InitializeParams,
    InitializeResult, ServerCapabilities,
};
use openengine_cluster_server::{BackendError, ClusterBackend, ConnectionContext, Dispatcher};
use serde_json::json;

#[path = "support/assert_at.rs"]
mod assert_at;
#[path = "support/assert_value.rs"]
mod assert_value;
#[path = "support/unexpected_get.rs"]
mod unexpected_get;

use assert_at::AssertAt;
use assert_value::AssertValue;
use unexpected_get::DefaultBackend;

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
                graph_profiles: GraphProfileSet::new(vec![GraphProfile::SingleWorker])
                    .assert_value(),
                logs: false,
                agent_attach: false,
            },
            ClusterStatus::empty(),
        ))
    }

    async fn get(
        &self,
        context: &ConnectionContext,
        params: GetParams,
    ) -> Result<GetResult, BackendError> {
        ClusterBackend::get(&DefaultBackend, context, params).await
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
    .assert_value();
    response
        .assert_at("result")
        .assert_at("capabilities")
        .assert_at("graphProfiles")
        .clone()
}

#[tokio::test]
async fn default_backend_advertises_no_graph_profiles() {
    let dispatcher = Dispatcher::new(DefaultBackend, ConnectionContext::default());
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
