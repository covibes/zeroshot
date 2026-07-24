//! Deterministic in-memory `LogStore`. This is a testkit fixture, not a production log sink:
//! there is no retained history, only live fan-out to every currently registered subscriber.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use async_trait::async_trait;
use openengine_cluster_protocol::LogRecord;
use openengine_cluster_server::logs::{LogStore, LogSubscription};
use tokio::sync::{mpsc, Mutex};

#[derive(Clone)]
struct LiveSlot {
    sender: mpsc::Sender<LogRecord>,
    overflowed: Arc<AtomicBool>,
}

/// A minimal in-process [`LogStore`]: no retained history, only live fan-out. A slot whose
/// bounded queue is full is marked overflowed and dropped from live fan-out; a slot whose
/// receiver has already been dropped (cancelled) is dropped silently.
#[derive(Default)]
pub struct InMemoryLogStore {
    live: Mutex<Vec<LiveSlot>>,
}

impl InMemoryLogStore {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn publish(&self, record: LogRecord) {
        let mut live = self.live.lock().await;
        live.retain(|slot| match slot.sender.try_send(record.clone()) {
            Ok(()) => true,
            Err(mpsc::error::TrySendError::Full(_)) => {
                slot.overflowed.store(true, Ordering::Release);
                false
            }
            Err(mpsc::error::TrySendError::Closed(_)) => false,
        });
    }
}

#[async_trait]
impl LogStore for InMemoryLogStore {
    async fn subscribe(&self, queue_capacity: usize) -> LogSubscription {
        let (sender, receiver) = mpsc::channel(queue_capacity.max(1));
        let overflowed = Arc::new(AtomicBool::new(false));
        self.live.lock().await.push(LiveSlot {
            sender,
            overflowed: Arc::clone(&overflowed),
        });
        LogSubscription {
            receiver,
            overflowed,
        }
    }
}
