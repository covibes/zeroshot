//! Transport-neutral, cursorless, future-only log event streaming and subscription cancellation.

pub mod fixtures;
pub mod ports;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use openengine_cluster_protocol::{
    LogRecord, LogsParams, LogsResult, SubscriptionCloseReason, SubscriptionId,
    DEFAULT_SUBSCRIPTION_QUEUE_CAPACITY,
};
use tokio::sync::mpsc;

pub use ports::{LogStore, LogSubscription};

use crate::{BackendError, ClusterBackend, Dispatcher};

/// One item yielded by [`LogEventStream`]: either a live log record, or a terminal slow-consumer
/// close (overflow). Ordinary cancellation (dropping [`LogsHandle`]) yields no `Closed` item -- the
/// stream simply stops.
#[derive(Clone, Debug, PartialEq)]
pub enum LogStreamItem {
    Record(LogRecord),
    Closed { reason: SubscriptionCloseReason },
}

/// A single bounded live receiver with no buffering or replay -- unlike [`crate::watch::WatchEventStream`],
/// `logs` has no retained history to page through.
pub struct LogEventStream {
    receiver: Option<mpsc::Receiver<LogRecord>>,
    overflowed: Arc<AtomicBool>,
    cancelled: Arc<AtomicBool>,
    closed: bool,
}

impl LogEventStream {
    #[must_use]
    pub fn new(subscription: LogSubscription) -> (Self, LogsHandle) {
        let cancelled = Arc::new(AtomicBool::new(false));
        let stream = Self {
            receiver: Some(subscription.receiver),
            overflowed: subscription.overflowed,
            cancelled: Arc::clone(&cancelled),
            closed: false,
        };
        (stream, LogsHandle::new(cancelled))
    }

    /// Returns the next live log record, or a terminal slow-consumer close. Returns `None` once
    /// the subscription is cancelled or otherwise permanently done.
    pub async fn next(&mut self) -> Option<LogStreamItem> {
        if self.closed || self.consume_cancellation() {
            return None;
        }
        self.next_live().await
    }

    /// Marks the stream permanently closed if cancellation was requested, returning whether it
    /// was.
    fn consume_cancellation(&mut self) -> bool {
        if !self.cancelled.load(Ordering::Acquire) {
            return false;
        }
        self.receiver = None;
        self.closed = true;
        true
    }

    /// Awaits the next live-delivered record, or a terminal slow-consumer close once the live
    /// channel closes with the overflow flag set.
    async fn next_live(&mut self) -> Option<LogStreamItem> {
        let Some(receiver) = self.receiver.as_mut() else {
            self.closed = true;
            return None;
        };
        match receiver.recv().await {
            Some(record) => Some(LogStreamItem::Record(record)),
            None => {
                self.receiver = None;
                self.closed = true;
                self.overflowed
                    .load(Ordering::Acquire)
                    .then_some(LogStreamItem::Closed {
                        reason: SubscriptionCloseReason::SlowConsumer,
                    })
            }
        }
    }
}

/// Drop-to-cancel subscription handle. Cancellation only affects live-subscriber bookkeeping; it
/// never mutates admission or lifecycle cluster state.
pub struct LogsHandle {
    cancelled: Arc<AtomicBool>,
}

impl LogsHandle {
    fn new(cancelled: Arc<AtomicBool>) -> Self {
        Self { cancelled }
    }

    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
    }

    #[must_use]
    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Acquire)
    }
}

impl Drop for LogsHandle {
    fn drop(&mut self) {
        self.cancel();
    }
}

/// Establishes a subscription against `store` and wraps it as a [`LogEventStream`]. Shared by
/// every [`ClusterBackend::logs`] implementation (production and test fixtures alike). Infallible:
/// v1 `logs` has nothing a backend can reject once its capability is advertised.
pub async fn subscribe_and_stream_logs(
    store: &Arc<dyn LogStore>,
    subscription_id: SubscriptionId,
    queue_capacity: usize,
) -> (LogsResult, LogEventStream, LogsHandle) {
    let subscription = store.subscribe(queue_capacity).await;
    let result = LogsResult { subscription_id };
    let (stream, handle) = LogEventStream::new(subscription);
    (result, stream, handle)
}

impl<B> Dispatcher<B>
where
    B: ClusterBackend,
{
    /// Non-NDJSON passthrough to the backend's `logs` subscription. NDJSON `logs`/
    /// `subscription/cancel` line framing lives in `stdio.rs`; this only exposes the typed
    /// in-process subscription surface.
    pub async fn logs(
        &self,
        params: LogsParams,
    ) -> Result<(LogsResult, LogEventStream, LogsHandle), BackendError> {
        self.backend()
            .logs(self.context(), params, DEFAULT_SUBSCRIPTION_QUEUE_CAPACITY)
            .await
    }
}
