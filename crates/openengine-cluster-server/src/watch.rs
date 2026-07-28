//! Transport-neutral watch event streaming and subscription cancellation.

pub mod fixtures;
pub mod ports;

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use openengine_cluster_protocol::{
    Cursor, RunId, SubscriptionCloseReason, SubscriptionId, WatchParams, WatchResult,
    DEFAULT_SUBSCRIPTION_QUEUE_CAPACITY,
};
use tokio::sync::mpsc;

pub use ports::{
    ObservationStore, PublicEventRecord, ReplayPageRequest, ResolvedSubscription, SubscribeRequest,
};

use crate::admission::StoreError;
use crate::{BackendError, ClusterBackend, Dispatcher};

/// Parameters for [`subscribe_and_stream`], grouped to keep that function's argument count
/// reasonable.
pub struct SubscribeAndStreamRequest {
    pub subscription_id: SubscriptionId,
    pub params: WatchParams,
    pub queue_capacity: usize,
}

/// Establishes a subscription against `store` and wraps it as a [`WatchEventStream`]. Shared by
/// every [`ClusterBackend::watch`] implementation (production and test fixtures alike) so the
/// subscribe -> [`WatchResult`] -> stream handoff is only derived once; callers supply `map_err`
/// since how a [`StoreError`] maps to a [`BackendError`] is backend-specific (for example, only
/// the production coordinator's store can return every domain variant).
pub async fn subscribe_and_stream(
    store: &Arc<dyn ObservationStore>,
    request: SubscribeAndStreamRequest,
    map_err: impl FnOnce(StoreError) -> BackendError,
) -> Result<(WatchResult, WatchEventStream, WatchHandle), BackendError> {
    let SubscribeAndStreamRequest {
        subscription_id,
        params,
        queue_capacity,
    } = request;
    let resolved = store
        .subscribe(
            SubscribeRequest {
                run_id: params.run_id,
                from_cursor: params.from_cursor,
            },
            queue_capacity,
        )
        .await
        .map_err(map_err)?;
    let result = WatchResult {
        subscription_id,
        run_id: resolved.run_id.clone(),
        at_cursor: resolved.at_cursor.clone(),
    };
    let (stream, handle) = WatchEventStream::new(Arc::clone(store), resolved);
    Ok((result, stream, handle))
}

/// Bounded chunk size used when paging retained replay history. Never materializes the whole
/// retained suffix in memory at once.
const REPLAY_PAGE_SIZE: usize = 256;

/// One item yielded by [`WatchEventStream`]: either a durable public event, or a terminal
/// slow-consumer close (overflow). Ordinary cancellation (dropping [`WatchHandle`]) yields no
/// `Closed` item — the stream simply stops.
#[derive(Clone, Debug, PartialEq)]
pub enum WatchStreamItem {
    Record(PublicEventRecord),
    Closed {
        reason: SubscriptionCloseReason,
        last_delivered_cursor: Option<Cursor>,
    },
}

/// Pulls bounded replay pages until the captured tail is exhausted, then forwards live delivery.
pub struct WatchEventStream {
    store: Arc<dyn ObservationStore>,
    run_id: Option<RunId>,
    after: Option<Cursor>,
    replay_through: Option<Cursor>,
    buffered: VecDeque<PublicEventRecord>,
    receiver: Option<mpsc::Receiver<PublicEventRecord>>,
    overflowed: Arc<AtomicBool>,
    cancelled: Arc<AtomicBool>,
    closed: bool,
}

impl WatchEventStream {
    #[must_use]
    pub fn new(
        store: Arc<dyn ObservationStore>,
        resolved: ResolvedSubscription,
    ) -> (Self, WatchHandle) {
        let cancelled = Arc::new(AtomicBool::new(false));
        let stream = Self {
            store,
            run_id: resolved.run_id,
            after: resolved.resume_after,
            replay_through: resolved.replay_through,
            buffered: VecDeque::new(),
            receiver: Some(resolved.receiver),
            overflowed: resolved.overflowed,
            cancelled: Arc::clone(&cancelled),
            closed: false,
        };
        (stream, WatchHandle::new(cancelled))
    }

    /// Returns the next event, replaying retained history before switching to live delivery.
    /// Returns `None` once the subscription is cancelled or otherwise permanently done.
    pub async fn next(&mut self) -> Option<WatchStreamItem> {
        loop {
            if self.closed || self.consume_cancellation() {
                return None;
            }
            if let Some(item) = self.next_buffered() {
                return Some(item);
            }
            match self.advance_replay().await {
                ReplayAdvance::Progressed => continue,
                ReplayAdvance::Done => {}
                ReplayAdvance::Failed => return None,
            }
            return self.next_live().await;
        }
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

    /// Pops and returns the next already-buffered replayed record, if any.
    fn next_buffered(&mut self) -> Option<WatchStreamItem> {
        let record = self.buffered.pop_front()?;
        self.after = Some(record.cursor.clone());
        self.run_id.get_or_insert_with(|| record.run_id.clone());
        Some(WatchStreamItem::Record(record))
    }

    /// Pages in retained replay history up to the captured tail. Buffers a nonempty page and
    /// reports progress; clears `replay_through` (marking replay finished) once the tail is
    /// reached or the store has nothing further to offer; reports failure on a store error.
    async fn advance_replay(&mut self) -> ReplayAdvance {
        let (Some(run_id), Some(through)) = (self.run_id.clone(), self.replay_through.clone())
        else {
            self.replay_through = None;
            return ReplayAdvance::Done;
        };
        if self.after.as_ref() == Some(&through) {
            self.replay_through = None;
            return ReplayAdvance::Done;
        }
        match self
            .store
            .replay_page(ReplayPageRequest {
                run_id: &run_id,
                after: self.after.as_ref(),
                through: &through,
                limit: REPLAY_PAGE_SIZE,
            })
            .await
        {
            Ok(page) if !page.is_empty() => {
                self.buffered.extend(page);
                ReplayAdvance::Progressed
            }
            Ok(_) => {
                // No page progress despite an unfinished replay window: the store has nothing
                // further to offer, so fall through to live delivery.
                self.replay_through = None;
                ReplayAdvance::Done
            }
            Err(_) => {
                self.receiver = None;
                self.closed = true;
                ReplayAdvance::Failed
            }
        }
    }

    /// Awaits the next live-delivered record, or a terminal slow-consumer close once the live
    /// channel closes with the overflow flag set.
    async fn next_live(&mut self) -> Option<WatchStreamItem> {
        let Some(receiver) = self.receiver.as_mut() else {
            self.closed = true;
            return None;
        };
        match receiver.recv().await {
            Some(record) => {
                self.after = Some(record.cursor.clone());
                self.run_id.get_or_insert_with(|| record.run_id.clone());
                Some(WatchStreamItem::Record(record))
            }
            None => {
                self.receiver = None;
                self.closed = true;
                self.overflowed
                    .load(Ordering::Acquire)
                    .then(|| WatchStreamItem::Closed {
                        reason: SubscriptionCloseReason::SlowConsumer,
                        last_delivered_cursor: self.after.clone(),
                    })
            }
        }
    }
}

/// Outcome of one [`WatchEventStream::advance_replay`] step.
enum ReplayAdvance {
    /// A nonempty page was buffered; the caller should immediately retry from the buffer.
    Progressed,
    /// Replay is finished (either there was none to do, or the tail is reached); the caller
    /// should fall through to live delivery.
    Done,
    /// The store failed; the stream is now permanently closed.
    Failed,
}

/// Drop-to-cancel subscription handle. Cancellation only affects live-subscriber bookkeeping;
/// it never mutates admission or lifecycle cluster state.
pub struct WatchHandle {
    cancelled: Arc<AtomicBool>,
}

impl WatchHandle {
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

impl Drop for WatchHandle {
    fn drop(&mut self) {
        self.cancel();
    }
}

impl<B> Dispatcher<B>
where
    B: ClusterBackend,
{
    /// Non-NDJSON passthrough to the backend's watch subscription. NDJSON `watch`/
    /// `subscription/cancel` line framing is bound by a later issue; this only exposes the
    /// typed in-process subscription surface.
    pub async fn watch(
        &self,
        params: WatchParams,
    ) -> Result<(WatchResult, WatchEventStream, WatchHandle), BackendError> {
        self.backend()
            .watch(self.context(), params, DEFAULT_SUBSCRIPTION_QUEUE_CAPACITY)
            .await
    }
}
