//! OECP client adapter for the native-v2 CLI.

use std::sync::Arc;

use async_trait::async_trait;
use openengine_cluster_client::{
    ClusterClient, RunSubscriptionClient, RunSubscriptionEvent, SubscriptionTransport,
};
use openengine_cluster_protocol::{
    ConnectionDeleteRequest, ConnectionDeleteResult, ConnectionListRequest, ConnectionListResult,
    ConnectionMutationResult, ConnectionSetRequest, Cursor, RunAttachEventNotification,
    RunAttachParams, RunForceParams, RunListParams, RunLogEventNotification, RunLogsParams,
    RunProfile, RunProfileDefaultRequest, RunProfileDefaultResult, RunProfileDeleteResult,
    RunProfileListRequest, RunProfileListResult, RunProfileMutationResult, RunProfileSelector,
    RunProfileSetRequest, RunStatus, RunStatusParams, RunSubmitResult, RunWatchParams,
};
use tokio::sync::mpsc;

use super::{
    CliRunForceResult, CliRunListResult, CliRunStatus, CliRunStatusResult,
    CliRunWatchEventNotification, CliSubscription, CliSubscriptionItem, NativeV2CliBackend,
    NativeV2CliError, PreparedRunRequest, TargetAdd, TargetSetup,
};

#[path = "oecp/errors.rs"]
mod errors;
use errors::{protocol as protocol_error, require_named_target, subscription as subscription_error};

#[path = "oecp/target_connector.rs"]
mod target_connector;
pub use target_connector::TargetConnector;

pub struct BoxedSubscription<E> {
    inner: Box<dyn CliSubscription<E>>,
}

impl<E> BoxedSubscription<E> {
    pub fn new(subscription: impl CliSubscription<E> + 'static) -> Self {
        Self {
            inner: Box::new(subscription),
        }
    }
}

#[async_trait]
impl<E> CliSubscription<E> for BoxedSubscription<E>
where
    E: Send,
{
    async fn next(&mut self) -> Result<Option<CliSubscriptionItem<E>>, NativeV2CliError> {
        self.inner.next().await
    }
}

pub struct NamedTargetCliBackend<C> {
    connector: C,
}

impl<C> NamedTargetCliBackend<C> {
    #[must_use]
    pub const fn new(connector: C) -> Self {
        Self { connector }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum RunLocation {
    Direct,
    Cloud,
    Task,
}

impl<C> NamedTargetCliBackend<C>
where
    C: TargetConnector,
{
    async fn run_location(
        &self,
        target: &str,
        run_id: &openengine_cluster_protocol::RunId,
    ) -> Result<RunLocation, NativeV2CliError> {
        let status = self
            .connector
            .hosted_run_status(
                target,
                RunStatusParams {
                    run_id: run_id.clone(),
                },
            )
            .await?;
        Ok(match status {
            None => RunLocation::Direct,
            Some(status) if task_is_active(&status.status) => RunLocation::Task,
            Some(_) => RunLocation::Cloud,
        })
    }
}

pub struct ChannelSubscription<E> {
    receiver: mpsc::Receiver<Result<CliSubscriptionItem<E>, NativeV2CliError>>,
    task: tokio::task::JoinHandle<()>,
}

impl<E> Drop for ChannelSubscription<E> {
    fn drop(&mut self) {
        // Aborting drops the OECP subscription stream. It deliberately does not send a run stop.
        self.task.abort();
    }
}

#[async_trait]
impl<E> CliSubscription<E> for ChannelSubscription<E>
where
    E: Send,
{
    async fn next(&mut self) -> Result<Option<CliSubscriptionItem<E>>, NativeV2CliError> {
        self.receiver.recv().await.transpose()
    }
}

#[async_trait]
impl<C> NativeV2CliBackend for NamedTargetCliBackend<C>
where
    C: TargetConnector,
{
    type Watch = BoxedSubscription<CliRunWatchEventNotification>;
    type Logs = BoxedSubscription<RunLogEventNotification>;
    type Attach = BoxedSubscription<RunAttachEventNotification>;

    async fn target_add(&self, request: TargetAdd) -> Result<(), NativeV2CliError> {
        self.connector.add(request).await
    }

    async fn target_login(&self, name: &str) -> Result<(), NativeV2CliError> {
        self.connector.login(name).await
    }

    async fn target_setup(&self, request: TargetSetup) -> Result<(), NativeV2CliError> {
        self.connector.setup(request).await
    }

    async fn connection_list(
        &self,
        target: Option<&str>,
        request: ConnectionListRequest,
    ) -> Result<ConnectionListResult, NativeV2CliError> {
        self.connector
            .connection_list(require_named_target(target)?, request)
            .await
    }

    async fn connection_set(
        &self,
        target: Option<&str>,
        request: ConnectionSetRequest,
    ) -> Result<ConnectionMutationResult, NativeV2CliError> {
        self.connector
            .connection_set(require_named_target(target)?, request)
            .await
    }

    async fn connection_delete(
        &self,
        target: Option<&str>,
        request: ConnectionDeleteRequest,
    ) -> Result<ConnectionDeleteResult, NativeV2CliError> {
        self.connector
            .connection_delete(require_named_target(target)?, request)
            .await
    }

    async fn profile_list(
        &self,
        target: Option<&str>,
        request: RunProfileListRequest,
    ) -> Result<RunProfileListResult, NativeV2CliError> {
        self.connector
            .profile_list(require_named_target(target)?, request)
            .await
    }

    async fn profile_show(
        &self,
        target: Option<&str>,
        selector: RunProfileSelector,
    ) -> Result<RunProfile, NativeV2CliError> {
        self.connector
            .profile_show(require_named_target(target)?, selector)
            .await
    }

    async fn profile_set(
        &self,
        target: Option<&str>,
        request: RunProfileSetRequest,
    ) -> Result<RunProfileMutationResult, NativeV2CliError> {
        self.connector
            .profile_set(require_named_target(target)?, request)
            .await
    }

    async fn profile_delete(
        &self,
        target: Option<&str>,
        selector: RunProfileSelector,
    ) -> Result<RunProfileDeleteResult, NativeV2CliError> {
        self.connector
            .profile_delete(require_named_target(target)?, selector)
            .await
    }

    async fn profile_default(
        &self,
        target: Option<&str>,
        request: RunProfileDefaultRequest,
    ) -> Result<RunProfileDefaultResult, NativeV2CliError> {
        self.connector
            .profile_default(require_named_target(target)?, request)
            .await
    }

    async fn run_submit(
        &self,
        target: Option<&str>,
        request: PreparedRunRequest,
    ) -> Result<RunSubmitResult, NativeV2CliError> {
        self.connector
            .submit(require_named_target(target)?, request)
            .await
    }

    async fn run_list(
        &self,
        target: Option<&str>,
        params: RunListParams,
    ) -> Result<CliRunListResult, NativeV2CliError> {
        let target = require_named_target(target)?;
        if let Some(result) = self
            .connector
            .hosted_run_list(target, params.clone())
            .await?
        {
            return Ok(result);
        }
        let transport = self.connector.connect(target, None).await?;
        ClusterClient::new(transport.as_ref())
            .run_list(params)
            .await
            .map(Into::into)
            .map_err(protocol_error)
    }

    async fn run_status(
        &self,
        target: Option<&str>,
        params: RunStatusParams,
    ) -> Result<CliRunStatusResult, NativeV2CliError> {
        let target = require_named_target(target)?;
        if let Some(result) = self
            .connector
            .hosted_run_status(target, params.clone())
            .await?
        {
            if !task_is_active(&result.status) {
                return Ok(result);
            }
        }
        let transport = self
            .connector
            .connect(target, Some(params.run_id.clone()))
            .await?;
        ClusterClient::new(transport.as_ref())
            .run_status(params)
            .await
            .map(Into::into)
            .map_err(protocol_error)
    }

    async fn run_watch(
        &self,
        target: Option<&str>,
        params: RunWatchParams,
    ) -> Result<Self::Watch, NativeV2CliError> {
        let target = require_named_target(target)?;
        let params = match self.run_location(target, &params.run_id).await? {
            RunLocation::Cloud => {
                return self
                    .connector
                    .hosted_run_watch(target, params)
                    .await?
                    .ok_or_else(|| {
                        NativeV2CliError::Target(
                            "hosted target did not provide its run watch".to_owned(),
                        )
                    });
            }
            RunLocation::Task => RunWatchParams {
                run_id: params.run_id,
                from_cursor: task_cursor(params.from_cursor),
            },
            RunLocation::Direct => params,
        };
        let transport = self
            .connector
            .connect(target, Some(params.run_id.clone()))
            .await?;
        Ok(BoxedSubscription::new(spawn_watch(transport, params)))
    }

    async fn run_logs(
        &self,
        target: Option<&str>,
        params: RunLogsParams,
    ) -> Result<Self::Logs, NativeV2CliError> {
        let target = require_named_target(target)?;
        let params = match self.run_location(target, &params.run_id).await? {
            RunLocation::Cloud => {
                return self
                    .connector
                    .hosted_run_logs(target, params)
                    .await?
                    .ok_or_else(|| {
                        NativeV2CliError::Target(
                            "hosted target did not provide its retained logs".to_owned(),
                        )
                    });
            }
            RunLocation::Task => RunLogsParams {
                run_id: params.run_id,
                from_cursor: task_cursor(params.from_cursor),
                execution: params.execution,
            },
            RunLocation::Direct => params,
        };
        let transport = self
            .connector
            .connect(target, Some(params.run_id.clone()))
            .await?;
        Ok(BoxedSubscription::new(spawn_logs(transport, params)))
    }

    async fn run_attach(
        &self,
        target: Option<&str>,
        params: RunAttachParams,
    ) -> Result<Self::Attach, NativeV2CliError> {
        let transport = self
            .connector
            .connect(require_named_target(target)?, Some(params.run_id.clone()))
            .await?;
        Ok(BoxedSubscription::new(spawn_attach(transport, params)))
    }

    async fn run_force(
        &self,
        target: Option<&str>,
        params: RunForceParams,
    ) -> Result<CliRunForceResult, NativeV2CliError> {
        let target = require_named_target(target)?;
        match self.run_location(target, &params.run_id).await? {
            RunLocation::Cloud => {
                return self
                    .connector
                    .hosted_run_force(target, params)
                    .await?
                    .ok_or_else(|| {
                        NativeV2CliError::Target(
                            "hosted target did not provide its force operation".to_owned(),
                        )
                    });
            }
            RunLocation::Task | RunLocation::Direct => {}
        }
        let transport = self
            .connector
            .connect(target, Some(params.run_id.clone()))
            .await?;
        ClusterClient::new(transport.as_ref())
            .run_force(params)
            .await
            .map(Into::into)
            .map_err(protocol_error)
    }
}

fn task_is_active(status: &CliRunStatus) -> bool {
    matches!(
        status,
        CliRunStatus::Target(
            RunStatus::Admitted {} | RunStatus::Running { .. } | RunStatus::Stopping { .. }
        )
    )
}

fn task_cursor(cursor: Option<Cursor>) -> Option<Cursor> {
    cursor.filter(|cursor| cursor.as_str().starts_with("v2:"))
}

pub(super) fn spawn_watch<T>(
    transport: Arc<T>,
    params: RunWatchParams,
) -> ChannelSubscription<CliRunWatchEventNotification>
where
    T: SubscriptionTransport + Send + Sync + 'static,
{
    let (sender, receiver) = mpsc::channel(32);
    let task = tokio::spawn(async move {
        match RunSubscriptionClient::new(transport.as_ref())
            .run_watch(params)
            .await
        {
            Ok((_result, mut stream)) => forward(&mut stream, sender).await,
            Err(error) => {
                let _ = sender.send(Err(subscription_error(error))).await;
            }
        }
    });
    ChannelSubscription { receiver, task }
}

pub(super) fn spawn_logs<T>(
    transport: Arc<T>,
    params: RunLogsParams,
) -> ChannelSubscription<RunLogEventNotification>
where
    T: SubscriptionTransport + Send + Sync + 'static,
{
    let (sender, receiver) = mpsc::channel(32);
    let task = tokio::spawn(async move {
        match RunSubscriptionClient::new(transport.as_ref())
            .run_logs(params)
            .await
        {
            Ok((_result, mut stream)) => forward(&mut stream, sender).await,
            Err(error) => {
                let _ = sender.send(Err(subscription_error(error))).await;
            }
        }
    });
    ChannelSubscription { receiver, task }
}

pub(super) fn spawn_attach<T>(
    transport: Arc<T>,
    params: RunAttachParams,
) -> ChannelSubscription<RunAttachEventNotification>
where
    T: SubscriptionTransport + Send + Sync + 'static,
{
    let (sender, receiver) = mpsc::channel(32);
    let task = tokio::spawn(async move {
        match RunSubscriptionClient::new(transport.as_ref())
            .run_attach(params)
            .await
        {
            Ok((_result, mut stream)) => forward(&mut stream, sender).await,
            Err(error) => {
                let _ = sender.send(Err(subscription_error(error))).await;
            }
        }
    });
    ChannelSubscription { receiver, task }
}

async fn forward<T, E, O>(
    stream: &mut openengine_cluster_client::RunSubscriptionEventStream<'_, T, E>,
    sender: mpsc::Sender<Result<CliSubscriptionItem<O>, NativeV2CliError>>,
) where
    T: SubscriptionTransport,
    E: serde::de::DeserializeOwned + Send,
    O: From<E> + Send,
{
    while let Some(item) = stream.next().await {
        let item = match item {
            Ok(RunSubscriptionEvent::Event(event)) => Ok(CliSubscriptionItem::Event(event.into())),
            Ok(RunSubscriptionEvent::Closed { reason, .. }) => {
                let closed = CliSubscriptionItem::Closed { reason };
                let _ = sender.send(Ok(closed)).await;
                return;
            }
            Err(error) => {
                let _ = sender.send(Err(subscription_error(error))).await;
                return;
            }
        };
        if sender.send(item).await.is_err() {
            return;
        }
    }
}
