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
    fn target(&self, target: Option<&str>) -> Result<(), NativeV2CliError> {
        if target == Some("candidate-cloud") {
            Ok(())
        } else {
            Err(NativeV2CliError::Target("unknown test target".to_owned()))
        }
    }
}

#[async_trait]
impl NativeV2CliBackend for InProcessCliBackend {
    type Watch = EmptySubscription<CliRunWatchEventNotification>;
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
        target: Option<&str>,
        request: PreparedRunRequest,
    ) -> Result<RunSubmitResult, NativeV2CliError> {
        self.target(target)?;
        let PreparedRunRequest {
            run_id,
            intent,
            connections,
            ..
        } = request;
        let params = RunSubmitParams {
            run_id,
            submission: RunSubmission {
                title: intent.title,
                graph: intent.graph,
                initial_input: intent.initial_input,
                runtime: intent.runtime,
                source: ResolvedSource {
                    repository: SourceRepositoryId::new("acme/project")
                        .map_err(cli_protocol_error)?,
                    branch: SourceBranchId::new("main").map_err(cli_protocol_error)?,
                    revision: SourceRevisionId::new("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
                        .map_err(cli_protocol_error)?,
                },
                submission_key: intent.submission_key,
            },
        };
        let environment = RunEnvironment::exact(&params.submission.runtime, connections)
            .map_err(cli_protocol_error)?;
        self.controller
            .submit_with_exact_environment(params, environment)
            .await
            .map(|receipt| RunSubmitResult {
                run_id: receipt.run_id,
            })
            .map_err(cli_protocol_error)
    }

    async fn run_list(
        &self,
        target: Option<&str>,
        params: RunListParams,
    ) -> Result<CliRunListResult, NativeV2CliError> {
        self.target(target)?;
        ClusterBackend::run_list(&*self.controller, &ConnectionContext::default(), params)
            .await
            .map(Into::into)
            .map_err(cli_protocol_error)
    }

    async fn run_status(
        &self,
        target: Option<&str>,
        params: RunStatusParams,
    ) -> Result<CliRunStatusResult, NativeV2CliError> {
        self.target(target)?;
        ClusterBackend::run_status(&*self.controller, &ConnectionContext::default(), params)
            .await
            .map(Into::into)
            .map_err(cli_protocol_error)
    }

    async fn run_watch(
        &self,
        _target: Option<&str>,
        _params: RunWatchParams,
    ) -> Result<Self::Watch, NativeV2CliError> {
        Err(NativeV2CliError::Target(
            "detached test run does not open watch".to_owned(),
        ))
    }

    async fn run_logs(
        &self,
        _target: Option<&str>,
        _params: RunLogsParams,
    ) -> Result<Self::Logs, NativeV2CliError> {
        Err(NativeV2CliError::Target(
            "test backend does not open logs".to_owned(),
        ))
    }

    async fn run_attach(
        &self,
        _target: Option<&str>,
        _params: RunAttachParams,
    ) -> Result<Self::Attach, NativeV2CliError> {
        Err(NativeV2CliError::Target(
            "test backend does not open attach".to_owned(),
        ))
    }

    async fn run_force(
        &self,
        target: Option<&str>,
        params: RunForceParams,
    ) -> Result<CliRunForceResult, NativeV2CliError> {
        self.target(target)?;
        ClusterBackend::run_force(&*self.controller, &ConnectionContext::default(), params)
            .await
            .map(Into::into)
            .map_err(cli_protocol_error)
    }
}
