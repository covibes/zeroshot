use async_trait::async_trait;
use openengine_cluster_protocol::{
    ClusterStatus, GetParams, GetResult, InitializeParams, InitializeResult, ServerCapabilities,
};
use openengine_cluster_server::{BackendError, ClusterBackend, ConnectionContext};

pub(super) struct DefaultBackend;

#[async_trait]
impl ClusterBackend for DefaultBackend {
    async fn initialize(
        &self,
        _context: &ConnectionContext,
        _params: InitializeParams,
    ) -> Result<InitializeResult, BackendError> {
        default_initialize()
    }

    async fn get(
        &self,
        _context: &ConnectionContext,
        _params: GetParams,
    ) -> Result<GetResult, BackendError> {
        unexpected_get("default backend")
    }
}

pub(super) fn unexpected_get(context: &str) -> Result<GetResult, BackendError> {
    Err(BackendError::application(
        "TEST_UNEXPECTED_GET",
        format!("{context} test does not serve get"),
        None,
    ))
}

pub(super) fn default_initialize() -> Result<InitializeResult, BackendError> {
    Ok(InitializeResult::new(
        ServerCapabilities::default(),
        ClusterStatus::empty(),
    ))
}
