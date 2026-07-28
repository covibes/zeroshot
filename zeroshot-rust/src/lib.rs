pub mod artifact_store;
pub mod cluster_ledger;
pub mod execution;
pub mod issue_provider;
mod provider_value;
pub mod scheduler;
pub mod source_code_provider;

use async_trait::async_trait;
use openengine_cluster_protocol::{
    ClusterStatus, GetParams, GetResult, InitializeParams, InitializeResult, ServerCapabilities,
};
use openengine_cluster_server::{BackendError, ClusterBackend, ConnectionContext, Dispatcher};

pub mod fault;
pub mod observability;

#[derive(Clone, Copy, Debug, Default)]
pub struct NativeBackend;

#[async_trait]
impl ClusterBackend for NativeBackend {
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
        })
    }
}

pub trait NativeBackendFactory {
    type Backend: ClusterBackend;

    fn create(&self, context: &ConnectionContext) -> Self::Backend;
}

#[derive(Clone, Copy, Debug, Default)]
pub struct ProductionNativeBackendFactory;

impl NativeBackendFactory for ProductionNativeBackendFactory {
    type Backend = NativeBackend;

    fn create(&self, _context: &ConnectionContext) -> Self::Backend {
        NativeBackend
    }
}

#[must_use]
pub fn dispatcher_for_route<F>(factory: &F, context: ConnectionContext) -> Dispatcher<F::Backend>
where
    F: NativeBackendFactory,
{
    let backend = factory.create(&context);
    Dispatcher::new(backend, context)
}
