use std::sync::Arc;

pub mod artifact_store;
pub mod cluster_ledger;
pub mod daemon_auth;
pub mod daemon_discovery;
pub mod daemon_listener;
pub mod execution;
pub mod full_v1_reducer;
pub mod issue_provider;
mod provider_value;
pub mod required_proof;
pub mod product_errors;
pub mod scheduler;
pub mod source_code_provider;
pub mod worker_catalog;
pub mod workspace_lease;

use async_trait::async_trait;
use openengine_cluster_protocol::{
    ClusterStatus, GetParams, GetResult, InitializeParams, InitializeResult, ServerCapabilities,
};
use openengine_cluster_server::identity::{
    ConnectionBinding, ConnectionIdentity, StaticConnectionIdentityResolver, SystemConnectionTime,
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

    fn create(&self) -> Self::Backend;
}

#[derive(Clone, Copy, Debug, Default)]
pub struct ProductionNativeBackendFactory;

impl NativeBackendFactory for ProductionNativeBackendFactory {
    type Backend = NativeBackend;

    fn create(&self) -> Self::Backend {
        NativeBackend
    }
}

#[must_use]
pub fn dispatcher_for_route<F>(factory: &F, context: ConnectionContext) -> Dispatcher<F::Backend>
where
    F: NativeBackendFactory,
{
    let backend = factory.create();
    Dispatcher::new(backend, context)
}

#[must_use]
pub fn binding_for_route<F>(
    factory: &F,
    identity: ConnectionIdentity,
) -> ConnectionBinding<F::Backend, StaticConnectionIdentityResolver, SystemConnectionTime>
where
    F: NativeBackendFactory,
{
    ConnectionBinding::new(
        Arc::new(factory.create()),
        StaticConnectionIdentityResolver::new(identity),
        SystemConnectionTime,
        Default::default(),
    )
}
