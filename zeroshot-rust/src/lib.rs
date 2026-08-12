use std::sync::Arc;

pub mod admission_manifest;
pub mod artifact_store;
pub mod cluster_ledger;
pub mod daemon_auth;
pub mod daemon_discovery;
pub mod daemon_listener;
pub mod execution;
pub mod full_v1_reducer;
pub mod hosted_oecp;
pub mod issue_provider;
mod native_admission;
pub mod native_credentials;
pub mod native_settings;
pub mod product_errors;
mod provider_value;
pub mod required_proof;
pub mod role_contract;
pub mod scheduler;
pub mod source_code_provider;
pub mod worker_bindings;
pub mod worker_catalog;
pub mod workspace_lease;

use openengine_cluster_server::identity::{
    ConnectionBinding, ConnectionIdentity, StaticConnectionIdentityResolver, SystemConnectionTime,
};
use openengine_cluster_server::{ClusterBackend, ConnectionContext, Dispatcher};

pub mod fault;
pub mod observability;
pub use native_admission::{
    native_foreground_graph, native_pi_foreground_graph, run_deterministic_worker,
    run_greeting_validator, NativeAdmissionOpenError, NativeBackend,
    NATIVE_FENCE_RENEW_INTERVAL_MS, NATIVE_FENCE_TTL_MS, NATIVE_VALIDATOR_MODE, NATIVE_WORKER_MODE,
};

pub trait NativeBackendFactory {
    type Backend: ClusterBackend;

    fn create(&self) -> Self::Backend;
}

#[derive(Clone)]
pub struct ProductionNativeBackendFactory {
    backend: NativeBackend,
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
