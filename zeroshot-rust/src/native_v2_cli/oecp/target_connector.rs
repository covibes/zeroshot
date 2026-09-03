use std::sync::Arc;

use async_trait::async_trait;
use openengine_cluster_client::SubscriptionTransport;
use openengine_cluster_protocol::{
    ConnectionDeleteRequest, ConnectionDeleteResult, ConnectionListRequest, ConnectionListResult,
    ConnectionMutationResult, ConnectionSetRequest, RunForceParams, RunListParams,
    RunLogEventNotification, RunLogsParams, RunProfile, RunProfileDefaultRequest,
    RunProfileDefaultResult, RunProfileDeleteResult, RunProfileListRequest, RunProfileListResult,
    RunProfileMutationResult, RunProfileSelector, RunProfileSetRequest, RunStatusParams,
    RunSubmitResult, RunWatchParams,
};

use super::BoxedSubscription;
use crate::native_v2_cli::{
    CliRunForceResult, CliRunListResult, CliRunStatusResult, CliRunWatchEventNotification,
    NativeV2CliError, PreparedRunRequest, TargetAdd, TargetSetup,
};

/// Named-target authority. The CLI does not interpret login credentials or runtime configuration.
#[async_trait]
pub trait TargetConnector: Send + Sync {
    type Transport: SubscriptionTransport + Send + Sync + 'static;

    async fn add(&self, request: TargetAdd) -> Result<(), NativeV2CliError>;
    async fn login(&self, name: &str) -> Result<(), NativeV2CliError>;
    async fn setup(&self, request: TargetSetup) -> Result<(), NativeV2CliError>;
    async fn connection_list(
        &self,
        name: &str,
        request: ConnectionListRequest,
    ) -> Result<ConnectionListResult, NativeV2CliError>;
    async fn connection_set(
        &self,
        name: &str,
        request: ConnectionSetRequest,
    ) -> Result<ConnectionMutationResult, NativeV2CliError>;
    async fn connection_delete(
        &self,
        name: &str,
        request: ConnectionDeleteRequest,
    ) -> Result<ConnectionDeleteResult, NativeV2CliError>;
    async fn profile_list(
        &self,
        name: &str,
        request: RunProfileListRequest,
    ) -> Result<RunProfileListResult, NativeV2CliError>;
    async fn profile_show(
        &self,
        name: &str,
        selector: RunProfileSelector,
    ) -> Result<RunProfile, NativeV2CliError>;
    async fn profile_set(
        &self,
        name: &str,
        request: RunProfileSetRequest,
    ) -> Result<RunProfileMutationResult, NativeV2CliError>;
    async fn profile_delete(
        &self,
        name: &str,
        selector: RunProfileSelector,
    ) -> Result<RunProfileDeleteResult, NativeV2CliError>;
    async fn profile_default(
        &self,
        name: &str,
        request: RunProfileDefaultRequest,
    ) -> Result<RunProfileDefaultResult, NativeV2CliError>;
    async fn submit(
        &self,
        name: &str,
        request: PreparedRunRequest,
    ) -> Result<RunSubmitResult, NativeV2CliError>;
    async fn connect(
        &self,
        name: &str,
        run_id: Option<openengine_cluster_protocol::RunId>,
    ) -> Result<Arc<Self::Transport>, NativeV2CliError>;
    async fn hosted_run_list(
        &self,
        name: &str,
        params: RunListParams,
    ) -> Result<Option<CliRunListResult>, NativeV2CliError>;
    async fn hosted_run_status(
        &self,
        name: &str,
        params: RunStatusParams,
    ) -> Result<Option<CliRunStatusResult>, NativeV2CliError>;
    async fn hosted_run_watch(
        &self,
        name: &str,
        params: RunWatchParams,
    ) -> Result<Option<BoxedSubscription<CliRunWatchEventNotification>>, NativeV2CliError>;
    async fn hosted_run_logs(
        &self,
        name: &str,
        params: RunLogsParams,
    ) -> Result<Option<BoxedSubscription<RunLogEventNotification>>, NativeV2CliError>;
    async fn hosted_run_force(
        &self,
        name: &str,
        params: RunForceParams,
    ) -> Result<Option<CliRunForceResult>, NativeV2CliError>;
}
