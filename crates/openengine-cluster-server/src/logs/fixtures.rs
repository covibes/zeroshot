//! Minimal `LogStore`/`ClusterBackend` fixture for exercising the `logs` port contract,
//! independent of `openengine-cluster-testkit`'s production-shaped `InMemoryAdmissionStore`.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

use async_trait::async_trait;
use openengine_cluster_protocol::{
    ClusterStatus, GetParams, GetResult, InitializeParams, InitializeResult, LogRecord, LogsParams,
    LogsResult, ServerCapabilities, SubscriptionId,
};
use tokio::sync::{mpsc, Mutex};

use super::{subscribe_and_stream_logs, LogEventStream, LogStore, LogSubscription, LogsHandle};
use crate::{BackendError, ClusterBackend, ConnectionContext};

#[derive(Default)]
struct LiveSlots {
    slots: Vec<(mpsc::Sender<LogRecord>, Arc<AtomicBool>)>,
}

/// A minimal in-process [`LogStore`]: no retained history, only live fan-out to every currently
/// registered subscriber. A slot whose bounded queue is full is marked overflowed and dropped from
/// live fan-out; a slot whose receiver has already been dropped (cancelled) is dropped silently.
#[derive(Default)]
pub struct LogsFixtureStore {
    live: Mutex<LiveSlots>,
}

impl LogsFixtureStore {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn publish(&self, record: LogRecord) {
        let mut live = self.live.lock().await;
        live.slots.retain(
            |(sender, overflowed)| match sender.try_send(record.clone()) {
                Ok(()) => true,
                Err(mpsc::error::TrySendError::Full(_)) => {
                    overflowed.store(true, Ordering::Release);
                    false
                }
                Err(mpsc::error::TrySendError::Closed(_)) => false,
            },
        );
    }
}

#[async_trait]
impl LogStore for LogsFixtureStore {
    async fn subscribe(&self, queue_capacity: usize) -> LogSubscription {
        let (sender, receiver) = mpsc::channel(queue_capacity.max(1));
        let overflowed = Arc::new(AtomicBool::new(false));
        self.live
            .lock()
            .await
            .slots
            .push((sender, Arc::clone(&overflowed)));
        LogSubscription {
            receiver,
            overflowed,
        }
    }
}

/// Wraps a [`LogsFixtureStore`] as a minimal [`ClusterBackend`] advertising `logs: true`;
/// `initialize`/`get` return an empty status since this fixture exists only to exercise `logs`.
pub struct LogsFixtureBackend {
    pub store: Arc<LogsFixtureStore>,
    next_subscription_id: AtomicU64,
}

impl LogsFixtureBackend {
    #[must_use]
    pub fn new(store: Arc<LogsFixtureStore>) -> Self {
        Self {
            store,
            next_subscription_id: AtomicU64::new(1),
        }
    }
}

#[async_trait]
impl ClusterBackend for LogsFixtureBackend {
    async fn initialize(
        &self,
        _context: &ConnectionContext,
        _params: InitializeParams,
    ) -> Result<InitializeResult, BackendError> {
        Ok(InitializeResult::new(
            ServerCapabilities {
                logs: true,
                ..ServerCapabilities::default()
            },
            ClusterStatus::empty(),
        ))
    }

    async fn get(
        &self,
        _context: &ConnectionContext,
        _params: GetParams,
    ) -> Result<GetResult, BackendError> {
        Ok(GetResult {
            spec: None,
            status: ClusterStatus::empty(),
            at_cursor: None,
        })
    }

    async fn logs(
        &self,
        _context: &ConnectionContext,
        _params: LogsParams,
        queue_capacity: usize,
    ) -> Result<(LogsResult, LogEventStream, LogsHandle), BackendError> {
        let store: Arc<dyn LogStore> = Arc::clone(&self.store) as Arc<dyn LogStore>;
        let subscription_id = SubscriptionId::new(format!(
            "sub-{}",
            self.next_subscription_id.fetch_add(1, Ordering::Relaxed)
        ));
        Ok(subscribe_and_stream_logs(&store, subscription_id, queue_capacity).await)
    }
}
