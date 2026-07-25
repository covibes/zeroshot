//! Shared `ClusterBackend` wrapper that gates only `get` behind an explicit [`Notify`], making
//! duplicate-in-flight-request-id and bounded-task-admission cases deterministic instead of
//! racing the backend call. Used identically by `tests/subscription_ndjson.rs` (over NDJSON) and
//! `tests/websocket.rs` (over WebSocket) since both drive the exact same admission/dedup behavior
//! against the shared `Dispatcher`/connection-task machinery, independent of wire framing.

use std::sync::Arc;

use async_trait::async_trait;
use openengine_cluster_protocol::{
    GetParams, GetResult, InitializeParams, InitializeResult, WatchParams, WatchResult,
};
use openengine_cluster_server::watch::fixtures::FixtureBackend;
use openengine_cluster_server::watch::{WatchEventStream, WatchHandle};
use openengine_cluster_server::{BackendError, ClusterBackend, ConnectionContext};
use tokio::sync::Notify;

pub struct GatedBackend {
    pub inner: FixtureBackend,
    pub gate: Arc<Notify>,
}

#[async_trait]
impl ClusterBackend for GatedBackend {
    async fn initialize(
        &self,
        context: &ConnectionContext,
        params: InitializeParams,
    ) -> Result<InitializeResult, BackendError> {
        self.inner.initialize(context, params).await
    }

    async fn get(
        &self,
        context: &ConnectionContext,
        params: GetParams,
    ) -> Result<GetResult, BackendError> {
        self.gate.notified().await;
        self.inner.get(context, params).await
    }

    async fn watch(
        &self,
        context: &ConnectionContext,
        params: WatchParams,
        queue_capacity: usize,
    ) -> Result<(WatchResult, WatchEventStream, WatchHandle), BackendError> {
        self.inner.watch(context, params, queue_capacity).await
    }
}
