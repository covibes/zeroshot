//! Transport-neutral, cursorless, future-only log event streaming and subscription cancellation.

pub mod fixtures;
pub mod ports;

use std::sync::Arc;

use openengine_cluster_protocol::{
    LogRecord, LogsParams, LogsResult, SubscriptionId, DEFAULT_SUBSCRIPTION_QUEUE_CAPACITY,
};

pub use ports::{LogStore, LogSubscription};

use crate::subscription_stream::{BoundedEventHandle, BoundedEventStream, BoundedStreamItem};
use crate::{BackendError, ClusterBackend, Dispatcher};

/// One item yielded by [`LogEventStream`]: either a live log record, or a terminal slow-consumer
/// close (overflow). Ordinary cancellation (dropping [`LogsHandle`]) yields no `Closed` item -- the
/// stream simply stops.
pub type LogStreamItem = BoundedStreamItem<LogRecord>;

/// A single bounded live receiver with no buffering or replay -- unlike
/// [`crate::watch::WatchEventStream`], `logs` has no retained history to page through.
pub type LogEventStream = BoundedEventStream<LogRecord>;

/// Drop-to-cancel subscription handle. Cancellation only affects live-subscriber bookkeeping; it
/// never mutates admission or lifecycle cluster state.
pub type LogsHandle = BoundedEventHandle;

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
    let (stream, handle) = LogEventStream::new(subscription.receiver, subscription.overflowed);
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
