//! OECP client adapter for the native-v2 CLI.

use std::sync::Arc;

use async_trait::async_trait;
use openengine_cluster_client::{
    ClientError, ClusterClient, RunSubscriptionClient, RunSubscriptionEvent, SubscriptionTransport,
};
use openengine_cluster_protocol::{
    RunAttachEventNotification, RunAttachParams, RunForceParams, RunListParams,
    RunLogEventNotification, RunLogsParams, RunStatusParams, RunSubmitResult, RunWatchParams,
};
use tokio::sync::mpsc;

use super::{
    CliRunForceResult, CliRunListResult, CliRunStatusResult, CliRunWatchEventNotification,
    CliSubscription, CliSubscriptionItem, NativeV2CliBackend, NativeV2CliError, TargetAdd,
    TargetRunRequest, TargetSetup,
};

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

/// Named-target authority. The CLI does not interpret login credentials or runtime configuration.
#[async_trait]
pub trait TargetConnector: Send + Sync {
    type Transport: SubscriptionTransport + Send + Sync + 'static;

    async fn add(&self, request: TargetAdd) -> Result<(), NativeV2CliError>;
    async fn login(&self, name: &str) -> Result<(), NativeV2CliError>;
    async fn setup(&self, request: TargetSetup) -> Result<(), NativeV2CliError>;
    async fn submit(
        &self,
        name: &str,
        request: TargetRunRequest,
    ) -> Result<RunSubmitResult, NativeV2CliError>;
    async fn connect(&self, name: &str) -> Result<Arc<Self::Transport>, NativeV2CliError>;

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

pub struct NamedTargetCliBackend<C> {
    connector: C,
}

impl<C> NamedTargetCliBackend<C> {
    #[must_use]
    pub const fn new(connector: C) -> Self {
        Self { connector }
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

    async fn run_submit(
        &self,
        target: Option<&str>,
        request: TargetRunRequest,
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
        let transport = self.connector.connect(target).await?;
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
            return Ok(result);
        }
        let transport = self.connector.connect(target).await?;
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
        if let Some(subscription) = self
            .connector
            .hosted_run_watch(target, params.clone())
            .await?
        {
            return Ok(subscription);
        }
        let transport = self.connector.connect(target).await?;
        Ok(BoxedSubscription::new(spawn_watch(transport, params)))
    }

    async fn run_logs(
        &self,
        target: Option<&str>,
        params: RunLogsParams,
    ) -> Result<Self::Logs, NativeV2CliError> {
        let target = require_named_target(target)?;
        if let Some(subscription) = self
            .connector
            .hosted_run_logs(target, params.clone())
            .await?
        {
            return Ok(subscription);
        }
        let transport = self.connector.connect(target).await?;
        Ok(BoxedSubscription::new(spawn_logs(transport, params)))
    }

    async fn run_attach(
        &self,
        target: Option<&str>,
        params: RunAttachParams,
    ) -> Result<Self::Attach, NativeV2CliError> {
        let transport = self
            .connector
            .connect(require_named_target(target)?)
            .await?;
        Ok(BoxedSubscription::new(spawn_attach(transport, params)))
    }

    async fn run_force(
        &self,
        target: Option<&str>,
        params: RunForceParams,
    ) -> Result<CliRunForceResult, NativeV2CliError> {
        let target = require_named_target(target)?;
        if let Some(result) = self
            .connector
            .hosted_run_force(target, params.clone())
            .await?
        {
            return Ok(result);
        }
        let transport = self.connector.connect(target).await?;
        ClusterClient::new(transport.as_ref())
            .run_force(params)
            .await
            .map(Into::into)
            .map_err(protocol_error)
    }
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

fn protocol_error(error: impl std::fmt::Display) -> NativeV2CliError {
    NativeV2CliError::Protocol(error.to_string())
}

fn subscription_error(error: ClientError) -> NativeV2CliError {
    match error {
        ClientError::Transport(_) => NativeV2CliError::Disconnected,
        error => protocol_error(error),
    }
}

fn require_named_target(target: Option<&str>) -> Result<&str, NativeV2CliError> {
    target.ok_or_else(|| {
        NativeV2CliError::Target("local controller composition is unavailable".to_owned())
    })
}
