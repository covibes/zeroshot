//! Transport-neutral, cursorless, future-only log subscription store contract.

use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use async_trait::async_trait;
use openengine_cluster_protocol::LogRecord;
use tokio::sync::mpsc;

/// A freshly registered live log subscription: a bounded receiver plus the overflow flag the
/// store sets if this subscription's queue ever fills.
pub struct LogSubscription {
    pub receiver: mpsc::Receiver<LogRecord>,
    pub overflowed: Arc<AtomicBool>,
}

/// Backend-neutral, cursorless, future-only log observation port. There is no retained history to
/// replay: a subscriber only ever observes records published after it registers.
#[async_trait]
pub trait LogStore: Send + Sync {
    async fn subscribe(&self, queue_capacity: usize) -> LogSubscription;
}
