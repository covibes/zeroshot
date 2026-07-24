//! Shared "single bounded live receiver, no buffering or replay, drop-to-cancel handle" stream
//! machinery for future-only, overflow-closing subscription capabilities (`logs`, `agent_attach`).
//! Generic over the delivered event type so the `next`/cancellation/overflow race handling exists
//! exactly once instead of being hand-copied per capability.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use openengine_cluster_protocol::SubscriptionCloseReason;
use tokio::sync::{mpsc, Notify};

/// One item yielded by [`BoundedEventStream`]: either a live event, or a terminal slow-consumer
/// close (overflow). Ordinary cancellation (dropping [`BoundedEventHandle`]) yields no `Closed`
/// item -- the stream simply stops.
#[derive(Clone, Debug, PartialEq)]
pub enum BoundedStreamItem<E> {
    Event(E),
    Closed { reason: SubscriptionCloseReason },
}

/// A single bounded live receiver with no buffering or replay -- unlike
/// [`crate::watch::WatchEventStream`], these capabilities have no retained history to page
/// through.
pub struct BoundedEventStream<E> {
    receiver: Option<mpsc::Receiver<E>>,
    overflowed: Arc<AtomicBool>,
    cancelled: Arc<AtomicBool>,
    cancel_notify: Arc<Notify>,
    closed: bool,
}

impl<E> BoundedEventStream<E> {
    #[must_use]
    pub fn new(
        receiver: mpsc::Receiver<E>,
        overflowed: Arc<AtomicBool>,
    ) -> (Self, BoundedEventHandle) {
        let cancelled = Arc::new(AtomicBool::new(false));
        let cancel_notify = Arc::new(Notify::new());
        let stream = Self {
            receiver: Some(receiver),
            overflowed,
            cancelled: Arc::clone(&cancelled),
            cancel_notify: Arc::clone(&cancel_notify),
            closed: false,
        };
        (stream, BoundedEventHandle::new(cancelled, cancel_notify))
    }

    /// Returns the next live event, or a terminal slow-consumer close. Returns `None` once the
    /// subscription is cancelled or otherwise permanently done.
    pub async fn next(&mut self) -> Option<BoundedStreamItem<E>> {
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

    /// Awaits the next live-delivered event, or a terminal slow-consumer close once the live
    /// channel closes with the overflow flag set.
    async fn next_live(&mut self) -> Option<BoundedStreamItem<E>> {
        let cancel_notify = Arc::clone(&self.cancel_notify);
        let Some(receiver) = self.receiver.as_mut() else {
            self.closed = true;
            return None;
        };
        tokio::select! {
            biased;
            () = cancel_notify.notified() => {
                self.receiver = None;
                self.closed = true;
                None
            }
            item = receiver.recv() => match item {
                Some(event) => Some(BoundedStreamItem::Event(event)),
                None => {
                    self.receiver = None;
                    self.closed = true;
                    self.overflowed
                        .load(Ordering::Acquire)
                        .then_some(BoundedStreamItem::Closed {
                            reason: SubscriptionCloseReason::SlowConsumer,
                        })
                }
            },
        }
    }
}

/// Drop-to-cancel subscription handle. Cancellation only affects live-subscriber bookkeeping; it
/// never mutates admission or lifecycle cluster state.
pub struct BoundedEventHandle {
    cancelled: Arc<AtomicBool>,
    cancel_notify: Arc<Notify>,
}

impl BoundedEventHandle {
    fn new(cancelled: Arc<AtomicBool>, cancel_notify: Arc<Notify>) -> Self {
        Self {
            cancelled,
            cancel_notify,
        }
    }

    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
        self.cancel_notify.notify_one();
    }

    #[must_use]
    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Acquire)
    }
}

impl Drop for BoundedEventHandle {
    fn drop(&mut self) {
        self.cancel();
    }
}
