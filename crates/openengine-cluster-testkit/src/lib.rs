//! Deterministic fixtures for Cluster Protocol conformance tests.

pub mod admission;
mod admission_artifacts;
pub mod agent_attach;
mod agent_attach_artifacts;
pub mod artifacts;
pub mod capability_vectors;
pub mod conformance;
pub mod fixture;
pub mod graph_verifier_artifacts;
pub mod lifecycle;
mod lifecycle_artifacts;
pub mod logs;
mod logs_artifacts;
mod negative_graph_fixtures;
mod schema_helpers;
pub mod watch;
mod watch_artifacts;
pub mod worker_artifacts;
pub mod worker_profiles;

pub use conformance::{run_backend_conformance, BackendFactory};

use async_trait::async_trait;
use openengine_cluster_protocol::{
    ClusterStatus, GetParams, GetResult, InitializeParams, InitializeResult, ServerCapabilities,
};
use openengine_cluster_server::{BackendError, ClusterBackend, ConnectionContext};

#[derive(Clone, Copy, Debug, Default)]
pub struct EmptyBackend;

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
