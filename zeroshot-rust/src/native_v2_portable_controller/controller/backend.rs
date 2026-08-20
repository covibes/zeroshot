use async_trait::async_trait;
use openengine_cluster_protocol::{
    GetParams, GetResult, InitializeParams, InitializeResult, RUN_CONFLICT, RunAttachParams,
    RunAttachResult, RunForceParams, RunForceResult, RunListParams, RunListResult, RunLogsParams,
    RunLogsResult, RunStatusParams, RunStatusResult, RunSubmitParams, RunSubmitResult,
    RunWatchParams, RunWatchResult,
};
use openengine_cluster_server::native_v2::{
    RunAttachEventStream, RunLogEventStream, RunWatchEventStream,
};
use openengine_cluster_server::{BackendError, ClusterBackend, ConnectionContext};

use super::PortableRunController;

#[async_trait]
impl ClusterBackend for PortableRunController {
    async fn initialize(
        &self,
        context: &ConnectionContext,
        params: InitializeParams,
    ) -> Result<InitializeResult, BackendError> {
        ClusterBackend::initialize(self.inner.as_ref(), context, params).await
    }

    async fn get(
        &self,
        context: &ConnectionContext,
        params: GetParams,
    ) -> Result<GetResult, BackendError> {
        ClusterBackend::get(self.inner.as_ref(), context, params).await
    }

    async fn run_submit(
        &self,
        _context: &ConnectionContext,
        _params: RunSubmitParams,
    ) -> Result<RunSubmitResult, BackendError> {
        Err(BackendError::application(
            RUN_CONFLICT,
            "portable controller already owns one immutable run",
            Some(serde_json::json!({ "runId": self.run_id })),
        ))
    }

    async fn run_list(
        &self,
        context: &ConnectionContext,
        params: RunListParams,
    ) -> Result<RunListResult, BackendError> {
        ClusterBackend::run_list(self.inner.as_ref(), context, params).await
    }

    async fn run_status(
        &self,
        context: &ConnectionContext,
        params: RunStatusParams,
    ) -> Result<RunStatusResult, BackendError> {
        self.require_run(&params.run_id)?;
        ClusterBackend::run_status(self.inner.as_ref(), context, params).await
    }

    async fn run_watch(
        &self,
        context: &ConnectionContext,
        params: RunWatchParams,
    ) -> Result<(RunWatchResult, RunWatchEventStream), BackendError> {
        self.require_run(&params.run_id)?;
        ClusterBackend::run_watch(self.inner.as_ref(), context, params).await
    }

    async fn run_logs(
        &self,
        context: &ConnectionContext,
        params: RunLogsParams,
    ) -> Result<(RunLogsResult, RunLogEventStream), BackendError> {
        self.require_run(&params.run_id)?;
        ClusterBackend::run_logs(self.inner.as_ref(), context, params).await
    }

    async fn run_attach(
        &self,
        context: &ConnectionContext,
        params: RunAttachParams,
    ) -> Result<(RunAttachResult, RunAttachEventStream), BackendError> {
        self.require_run(&params.run_id)?;
        ClusterBackend::run_attach(self.inner.as_ref(), context, params).await
    }

    async fn run_force(
        &self,
        context: &ConnectionContext,
        params: RunForceParams,
    ) -> Result<RunForceResult, BackendError> {
        self.require_run(&params.run_id)?;
        ClusterBackend::run_force(self.inner.as_ref(), context, params).await
    }
}
