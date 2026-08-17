//! OECP client adapter for the native-v2 CLI.

use std::sync::Arc;

use async_trait::async_trait;
use openengine_cluster_client::{
    ClusterClient, RunSubscriptionClient, RunSubscriptionEvent, SubscriptionTransport,
};
use openengine_cluster_protocol::{
    RunAttachEventNotification, RunAttachParams, RunForceParams, RunForceResult, RunListParams,
    RunListResult, RunLogEventNotification, RunLogsParams, RunStatusParams, RunStatusResult,
    RunSubmitParams, RunSubmitResult, RunWatchEventNotification, RunWatchParams,
};
use tokio::sync::mpsc;

use super::{
    CliSubscription, CliSubscriptionItem, NativeV2CliBackend, NativeV2CliError, TargetAdd,
    TargetSetup,
};

/// Named-target authority. The CLI does not interpret login credentials or runtime configuration.
#[async_trait]
pub trait TargetConnector: Send + Sync {
    type Transport: SubscriptionTransport + Send + Sync + 'static;

    async fn add(&self, request: TargetAdd) -> Result<(), NativeV2CliError>;
    async fn login(&self, name: &str) -> Result<(), NativeV2CliError>;
    async fn setup(&self, request: TargetSetup) -> Result<(), NativeV2CliError>;
    async fn connect(&self, name: &str) -> Result<Arc<Self::Transport>, NativeV2CliError>;
}

pub struct OecpCliBackend<C> {
    connector: C,
}

impl<C> OecpCliBackend<C> {
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
impl<C> NativeV2CliBackend for OecpCliBackend<C>
where
    C: TargetConnector,
{
    type Watch = ChannelSubscription<RunWatchEventNotification>;
    type Logs = ChannelSubscription<RunLogEventNotification>;
    type Attach = ChannelSubscription<RunAttachEventNotification>;

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
        target: &str,
        params: RunSubmitParams,
    ) -> Result<RunSubmitResult, NativeV2CliError> {
        let transport = self.connector.connect(target).await?;
        ClusterClient::new(transport.as_ref())
            .run_submit(params)
            .await
            .map_err(protocol_error)
    }

    async fn run_list(
        &self,
        target: &str,
        params: RunListParams,
    ) -> Result<RunListResult, NativeV2CliError> {
        let transport = self.connector.connect(target).await?;
        ClusterClient::new(transport.as_ref())
            .run_list(params)
            .await
            .map_err(protocol_error)
    }

    async fn run_status(
        &self,
        target: &str,
        params: RunStatusParams,
    ) -> Result<RunStatusResult, NativeV2CliError> {
        let transport = self.connector.connect(target).await?;
        ClusterClient::new(transport.as_ref())
            .run_status(params)
            .await
            .map_err(protocol_error)
    }

    async fn run_watch(
        &self,
        target: &str,
        params: RunWatchParams,
    ) -> Result<Self::Watch, NativeV2CliError> {
        let transport = self.connector.connect(target).await?;
        Ok(spawn_watch(transport, params))
    }

    async fn run_logs(
        &self,
        target: &str,
        params: RunLogsParams,
    ) -> Result<Self::Logs, NativeV2CliError> {
        let transport = self.connector.connect(target).await?;
        Ok(spawn_logs(transport, params))
    }

    async fn run_attach(
        &self,
        target: &str,
        params: RunAttachParams,
    ) -> Result<Self::Attach, NativeV2CliError> {
        let transport = self.connector.connect(target).await?;
        Ok(spawn_attach(transport, params))
    }

    async fn run_force(
        &self,
        target: &str,
        params: RunForceParams,
    ) -> Result<RunForceResult, NativeV2CliError> {
        let transport = self.connector.connect(target).await?;
        ClusterClient::new(transport.as_ref())
            .run_force(params)
            .await
            .map_err(protocol_error)
    }
}

fn spawn_watch<T>(
    transport: Arc<T>,
    params: RunWatchParams,
) -> ChannelSubscription<RunWatchEventNotification>
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
                let _ = sender.send(Err(protocol_error(error))).await;
            }
        }
    });
    ChannelSubscription { receiver, task }
}

fn spawn_logs<T>(
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
                let _ = sender.send(Err(protocol_error(error))).await;
            }
        }
    });
    ChannelSubscription { receiver, task }
}

fn spawn_attach<T>(
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
                let _ = sender.send(Err(protocol_error(error))).await;
            }
        }
    });
    ChannelSubscription { receiver, task }
}

async fn forward<T, E>(
    stream: &mut openengine_cluster_client::RunSubscriptionEventStream<'_, T, E>,
    sender: mpsc::Sender<Result<CliSubscriptionItem<E>, NativeV2CliError>>,
) where
    T: SubscriptionTransport,
    E: serde::de::DeserializeOwned + Send,
{
    while let Some(item) = stream.next().await {
        let item = match item {
            Ok(RunSubscriptionEvent::Event(event)) => Ok(CliSubscriptionItem::Event(event)),
            Ok(RunSubscriptionEvent::Closed { reason, .. }) => {
                let closed = CliSubscriptionItem::Closed { reason };
                let _ = sender.send(Ok(closed)).await;
                return;
            }
            Err(error) => {
                let _ = sender.send(Err(protocol_error(error))).await;
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
