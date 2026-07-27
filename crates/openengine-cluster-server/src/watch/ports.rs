//! Transport-neutral observation/subscription store contract.

use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use async_trait::async_trait;
use openengine_cluster_protocol::{Cursor, RunId, WatchEvent};
use tokio::sync::mpsc;

use crate::admission::StoreError;

#[derive(Clone, Debug)]
pub struct SubscribeRequest {
    pub run_id: Option<RunId>,
    pub from_cursor: Option<Cursor>,
}

/// Bounded replay page request: strictly after `after` (or from the beginning when `None`)
/// through and including `through`, capped at `limit` records.
#[derive(Clone, Copy, Debug)]
pub struct ReplayPageRequest<'a> {
    pub run_id: &'a RunId,
    pub after: Option<&'a Cursor>,
    pub through: &'a Cursor,
    pub limit: usize,
}

/// A durable public event together with the run it belongs to. `run_id` lets a stream that
/// started parked (no run selected yet) learn which run it attached to from the first delivered
/// record, and lets client-side dedup/reconnect key strictly by `(runId, cursor)`.
#[derive(Clone, Debug, PartialEq)]
pub struct PublicEventRecord {
    pub run_id: RunId,
    pub cursor: Cursor,
    pub event: WatchEvent,
}

/// The atomic snapshot-to-tail handoff result: the resolved run/cursor identity plus a live
/// receiver already registered under the same store-lock critical section that captured
/// `replay_through`. No event committed after registration can be missed by the receiver.
pub struct ResolvedSubscription {
    pub run_id: Option<RunId>,
    /// The coherent tail captured at subscription establishment; echoed to the caller as
    /// `WatchResult.atCursor`. Null while parked (no run resolved yet).
    pub at_cursor: Option<Cursor>,
    /// The exclusive lower bound the stream must replay strictly after (the caller's
    /// `fromCursor`, or `None` to replay this run's retained history from the beginning).
    pub resume_after: Option<Cursor>,
    /// The inclusive upper bound of the captured retained suffix; replay pages stop here before
    /// the stream switches to live delivery.
    pub replay_through: Option<Cursor>,
    pub receiver: mpsc::Receiver<PublicEventRecord>,
    /// Set by the store when this subscription's bounded live queue overflowed. Checked by the
    /// stream consumer after the receiver channel closes to distinguish a slow-consumer close
    /// from an ordinary cancellation/drop close.
    pub overflowed: Arc<AtomicBool>,
}

/// Backend-neutral durable observation port. Implementations must resolve the run, capture the
/// coherent retained replay suffix, and register live delivery under one atomic critical section
/// so that no committed event can fall in the gap between snapshot and registration.
#[async_trait]
pub trait ObservationStore: Send + Sync {
    async fn subscribe(
        &self,
        request: SubscribeRequest,
        queue_capacity: usize,
    ) -> Result<ResolvedSubscription, StoreError>;

    /// Reads a bounded page of retained history per `request`, strictly after `after` (inclusive
    /// of the requested cursor is the caller's responsibility to have already replayed) through
    /// and including `through`. Never materializes the full retained suffix at once.
    async fn replay_page(
        &self,
        request: ReplayPageRequest<'_>,
    ) -> Result<Vec<PublicEventRecord>, StoreError>;
}
