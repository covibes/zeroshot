use super::*;

pub(super) struct EmptySubscription<E>(std::marker::PhantomData<E>);

#[async_trait]
impl<E> CliSubscription<E> for EmptySubscription<E>
where
    E: Send,
{
    async fn next(&mut self) -> Result<Option<CliSubscriptionItem<E>>, NativeV2CliError> {
        Ok(None)
    }
}

pub(super) struct InProcessCliBackend {
    pub(super) controller: Arc<NativeV2CloudController>,
}

fn cli_protocol_error(error: impl std::fmt::Display) -> NativeV2CliError {
    NativeV2CliError::Protocol(error.to_string())
}

impl InProcessCliBackend {
    fn target(&self, target: &str) -> Result<(), NativeV2CliError> {
        if target == "candidate-cloud" {
            Ok(())
        } else {
            Err(NativeV2CliError::Target("unknown test target".to_owned()))
        }
    }
}

#[async_trait]
impl NativeV2CliBackend for InProcessCliBackend {
    type Watch = EmptySubscription<RunWatchEventNotification>;
    type Logs = EmptySubscription<RunLogEventNotification>;
    type Attach = EmptySubscription<RunAttachEventNotification>;

    async fn target_add(&self, _request: TargetAdd) -> Result<(), NativeV2CliError> {
        Err(NativeV2CliError::Target(
            "test backend has no target registry".to_owned(),
        ))
    }

    async fn target_login(&self, _name: &str) -> Result<(), NativeV2CliError> {
        Err(NativeV2CliError::Target(
            "test backend has no login authority".to_owned(),
        ))
    }

    async fn target_setup(&self, _request: TargetSetup) -> Result<(), NativeV2CliError> {
        Err(NativeV2CliError::Target(
            "test backend has no setup authority".to_owned(),
        ))
    }

    async fn run_submit(
        &self,
        target: &str,
        params: RunSubmitParams,
    ) -> Result<RunSubmitResult, NativeV2CliError> {
        self.target(target)?;
        ClusterBackend::run_submit(&*self.controller, &ConnectionContext::default(), params)
            .await
            .map_err(cli_protocol_error)
    }

    async fn run_list(
        &self,
        target: &str,
        params: RunListParams,
    ) -> Result<RunListResult, NativeV2CliError> {
        self.target(target)?;
        ClusterBackend::run_list(&*self.controller, &ConnectionContext::default(), params)
            .await
            .map_err(cli_protocol_error)
    }

    async fn run_status(
        &self,
        target: &str,
        params: RunStatusParams,
    ) -> Result<RunStatusResult, NativeV2CliError> {
        self.target(target)?;
        ClusterBackend::run_status(&*self.controller, &ConnectionContext::default(), params)
            .await
            .map_err(cli_protocol_error)
    }

    async fn run_watch(
        &self,
        _target: &str,
        _params: RunWatchParams,
    ) -> Result<Self::Watch, NativeV2CliError> {
        Err(NativeV2CliError::Target(
            "detached test run does not open watch".to_owned(),
        ))
    }

    async fn run_logs(
        &self,
        _target: &str,
        _params: RunLogsParams,
    ) -> Result<Self::Logs, NativeV2CliError> {
        Err(NativeV2CliError::Target(
            "test backend does not open logs".to_owned(),
        ))
    }

    async fn run_attach(
        &self,
        _target: &str,
        _params: RunAttachParams,
    ) -> Result<Self::Attach, NativeV2CliError> {
        Err(NativeV2CliError::Target(
            "test backend does not open attach".to_owned(),
        ))
    }

    async fn run_force(
        &self,
        target: &str,
        params: RunForceParams,
    ) -> Result<RunForceResult, NativeV2CliError> {
        self.target(target)?;
        ClusterBackend::run_force(&*self.controller, &ConnectionContext::default(), params)
            .await
            .map_err(cli_protocol_error)
    }
}
