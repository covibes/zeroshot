use async_trait::async_trait;
use openengine_cluster_protocol::{
    ConnectionDeleteRequest, ConnectionDeleteResult, ConnectionListRequest, ConnectionListResult,
    ConnectionMutationResult, ConnectionSetRequest,
};
use openengine_cluster_protocol::{
    RunForceParams, RunListParams, RunLogEventNotification, RunLogsParams, RunStatusParams,
    RunSubmitResult, RunWatchParams, TargetOecpSessionRequest, TargetRunRequest,
};
use openengine_cluster_protocol::{
    RunProfile, RunProfileDefaultRequest, RunProfileDefaultResult, RunProfileDeleteResult,
    RunProfileListRequest, RunProfileListResult, RunProfileMutationResult, RunProfileRunRequest,
    RunProfileSelector, RunProfileSetRequest,
};
use zeroshot_engine::native_v2_cli::oecp::BoxedSubscription;
use zeroshot_engine::native_v2_cli::{
    CliRunForceResult, CliRunListResult, CliRunStatusResult, CliRunWatchEventNotification,
};

use super::{TargetAuthorityError, TargetOecpAccess, TargetRecord};

/// The external contract which hosting must implement before the native-v2 CLI can reach cloud.
#[async_trait]
pub trait TargetControlAuthority: Send + Sync {
    async fn discover(&self, target: &TargetRecord) -> Result<(), TargetAuthorityError>;
    async fn login(&self, target: &TargetRecord) -> Result<(), TargetAuthorityError>;
    async fn submit(
        &self,
        target: &TargetRecord,
        request: &TargetRunRequest,
    ) -> Result<RunSubmitResult, TargetAuthorityError>;
    async fn oecp_session(
        &self,
        target: &TargetRecord,
        request: &TargetOecpSessionRequest,
    ) -> Result<TargetOecpAccess, TargetAuthorityError>;
    async fn connection_list(
        &self,
        target: &TargetRecord,
        request: ConnectionListRequest,
    ) -> Result<ConnectionListResult, TargetAuthorityError>;
    async fn connection_set(
        &self,
        target: &TargetRecord,
        request: ConnectionSetRequest,
    ) -> Result<ConnectionMutationResult, TargetAuthorityError>;
    async fn connection_delete(
        &self,
        target: &TargetRecord,
        request: ConnectionDeleteRequest,
    ) -> Result<ConnectionDeleteResult, TargetAuthorityError>;
    async fn profile_list(
        &self,
        _target: &TargetRecord,
        _request: RunProfileListRequest,
    ) -> Result<RunProfileListResult, TargetAuthorityError> {
        profile_unavailable()
    }
    async fn profile_show(
        &self,
        _target: &TargetRecord,
        _selector: RunProfileSelector,
    ) -> Result<RunProfile, TargetAuthorityError> {
        profile_unavailable()
    }
    async fn profile_set(
        &self,
        _target: &TargetRecord,
        _request: RunProfileSetRequest,
    ) -> Result<RunProfileMutationResult, TargetAuthorityError> {
        profile_unavailable()
    }
    async fn profile_delete(
        &self,
        _target: &TargetRecord,
        _selector: RunProfileSelector,
    ) -> Result<RunProfileDeleteResult, TargetAuthorityError> {
        profile_unavailable()
    }
    async fn profile_default(
        &self,
        _target: &TargetRecord,
        _request: RunProfileDefaultRequest,
    ) -> Result<RunProfileDefaultResult, TargetAuthorityError> {
        profile_unavailable()
    }
    async fn profile_run(
        &self,
        _target: &TargetRecord,
        _request: &RunProfileRunRequest,
    ) -> Result<RunSubmitResult, TargetAuthorityError> {
        Err(TargetAuthorityError::new("profile runs are unavailable"))
    }
    async fn hosted_run_list(
        &self,
        target: &TargetRecord,
        params: RunListParams,
    ) -> Result<CliRunListResult, TargetAuthorityError>;
    async fn hosted_run_status(
        &self,
        target: &TargetRecord,
        params: RunStatusParams,
    ) -> Result<CliRunStatusResult, TargetAuthorityError>;
    async fn hosted_run_watch(
        &self,
        target: &TargetRecord,
        params: RunWatchParams,
    ) -> Result<BoxedSubscription<CliRunWatchEventNotification>, TargetAuthorityError>;
    async fn hosted_run_logs(
        &self,
        target: &TargetRecord,
        params: RunLogsParams,
    ) -> Result<BoxedSubscription<RunLogEventNotification>, TargetAuthorityError>;
    async fn hosted_run_force(
        &self,
        target: &TargetRecord,
        params: RunForceParams,
    ) -> Result<CliRunForceResult, TargetAuthorityError>;
}

fn profile_unavailable<T>() -> Result<T, TargetAuthorityError> {
    Err(TargetAuthorityError::new(
        "profile management is unavailable",
    ))
}
