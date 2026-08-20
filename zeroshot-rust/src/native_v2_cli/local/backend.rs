use super::*;

#[async_trait]
impl NativeV2CliBackend for LocalCliBackend {
    type Watch = ChannelSubscription<RunWatchEventNotification>;
    type Logs = ChannelSubscription<RunLogEventNotification>;
    type Attach = ChannelSubscription<RunAttachEventNotification>;

    async fn target_add(&self, _request: TargetAdd) -> Result<(), NativeV2CliError> {
        Err(local_message(
            "target commands are not local run operations",
        ))
    }

    async fn target_login(&self, _name: &str) -> Result<(), NativeV2CliError> {
        Err(local_message(
            "target commands are not local run operations",
        ))
    }

    async fn target_setup(&self, _request: TargetSetup) -> Result<(), NativeV2CliError> {
        Err(local_message(
            "target commands are not local run operations",
        ))
    }

    async fn run_submit(
        &self,
        target: Option<&str>,
        request: TargetRunRequest,
    ) -> Result<RunSubmitResult, NativeV2CliError> {
        require_local(target)?;
        let run_id = self.start_controller(request).await?;
        Ok(RunSubmitResult { run_id })
    }

    async fn run_list(
        &self,
        target: Option<&str>,
        _params: RunListParams,
    ) -> Result<RunListResult, NativeV2CliError> {
        require_local(target)?;
        self.list_local().await
    }

    async fn run_status(
        &self,
        target: Option<&str>,
        params: RunStatusParams,
    ) -> Result<RunStatusResult, NativeV2CliError> {
        require_local(target)?;
        self.status_local(params).await
    }

    async fn run_watch(
        &self,
        target: Option<&str>,
        params: RunWatchParams,
    ) -> Result<Self::Watch, NativeV2CliError> {
        require_local(target)?;
        let transport = self.connect_run(&params.run_id).await?;
        Ok(spawn_watch(transport, params))
    }

    async fn run_logs(
        &self,
        target: Option<&str>,
        params: RunLogsParams,
    ) -> Result<Self::Logs, NativeV2CliError> {
        require_local(target)?;
        let transport = self.connect_run(&params.run_id).await?;
        Ok(spawn_logs(transport, params))
    }

    async fn run_attach(
        &self,
        target: Option<&str>,
        params: RunAttachParams,
    ) -> Result<Self::Attach, NativeV2CliError> {
        require_local(target)?;
        let transport = self.connect_run(&params.run_id).await?;
        Ok(spawn_attach(transport, params))
    }

    async fn run_force(
        &self,
        target: Option<&str>,
        params: RunForceParams,
    ) -> Result<RunForceResult, NativeV2CliError> {
        require_local(target)?;
        self.force_local(params).await
    }
}
