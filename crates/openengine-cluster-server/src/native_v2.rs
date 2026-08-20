//! Typed, transport-neutral native-v2 run surface.
//!
//! Subscription sources are backend-owned so the Zeroshot product can expose its durable ledger
//! streams directly without copying them into a second protocol store. Dropping a stream only
//! detaches that observer.

use async_trait::async_trait;
use openengine_cluster_protocol::{
    RunAttachEventNotification, RunAttachParams, RunAttachResult, RunForceParams, RunForceResult,
    RunListParams, RunListResult, RunLogEventNotification, RunLogsParams, RunLogsResult,
    RunStatusParams, RunStatusResult, RunSubmitParams, RunSubmitResult, RunWatchEventNotification,
    RunWatchParams, RunWatchResult, SubscriptionCloseReason,
};

use crate::{BackendError, ClusterBackend, Dispatcher};

/// One item supplied by a native-v2 observation backend.
#[derive(Clone, Debug, PartialEq)]
pub enum RunSubscriptionItem<E> {
    Event(E),
    Closed { reason: SubscriptionCloseReason },
}

/// Minimal adapter seam for product-owned durable or live subscriptions.
///
/// A source emits one [`RunSubscriptionItem::Closed`] before returning `None`; the stream wrapper
/// enforces that close as terminal. Dropping the source remains observation-only.
#[async_trait]
pub trait RunSubscriptionSource<E>: Send {
    async fn next(&mut self) -> Option<RunSubscriptionItem<E>>;
}

/// Type-erased subscription returned through [`ClusterBackend`].
pub struct RunSubscriptionStream<E> {
    source: Box<dyn RunSubscriptionSource<E>>,
    closed: bool,
}

impl<E> RunSubscriptionStream<E> {
    #[must_use]
    pub fn new(source: impl RunSubscriptionSource<E> + 'static) -> Self {
        Self {
            source: Box::new(source),
            closed: false,
        }
    }

    pub async fn next(&mut self) -> Option<RunSubscriptionItem<E>> {
        if self.closed {
            return None;
        }
        let item = self.source.next().await;
        if matches!(item, Some(RunSubscriptionItem::Closed { .. }) | None) {
            self.closed = true;
        }
        item
    }
}

pub type RunWatchEventStream = RunSubscriptionStream<RunWatchEventNotification>;
pub type RunLogEventStream = RunSubscriptionStream<RunLogEventNotification>;
pub type RunAttachEventStream = RunSubscriptionStream<RunAttachEventNotification>;

impl<B> Dispatcher<B>
where
    B: ClusterBackend,
{
    pub async fn run_submit(
        &self,
        params: RunSubmitParams,
    ) -> Result<RunSubmitResult, BackendError> {
        self.backend().run_submit(self.context(), params).await
    }

    pub async fn run_list(&self, params: RunListParams) -> Result<RunListResult, BackendError> {
        self.backend().run_list(self.context(), params).await
    }

    pub async fn run_status(
        &self,
        params: RunStatusParams,
    ) -> Result<RunStatusResult, BackendError> {
        self.backend().run_status(self.context(), params).await
    }

    pub async fn run_watch(
        &self,
        params: RunWatchParams,
    ) -> Result<(RunWatchResult, RunWatchEventStream), BackendError> {
        self.backend().run_watch(self.context(), params).await
    }

    pub async fn run_logs(
        &self,
        params: RunLogsParams,
    ) -> Result<(RunLogsResult, RunLogEventStream), BackendError> {
        self.backend().run_logs(self.context(), params).await
    }

    pub async fn run_attach(
        &self,
        params: RunAttachParams,
    ) -> Result<(RunAttachResult, RunAttachEventStream), BackendError> {
        self.backend().run_attach(self.context(), params).await
    }

    pub async fn run_force(&self, params: RunForceParams) -> Result<RunForceResult, BackendError> {
        self.backend().run_force(self.context(), params).await
    }
}
