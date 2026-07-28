//! Deterministic in-memory durable observation/subscription store. This is a testkit fixture,
//! not a production ledger: retained history and live fan-out live entirely in process memory.

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use async_trait::async_trait;
use openengine_cluster_protocol::{
    BackendFault, ClusterStatus, Cursor, DeleteResult, NodeAddress, Phase, RunId, WatchEvent,
    WorkerOutcome,
};
use openengine_cluster_server::admission::{ControlSnapshot, StoreError};
use openengine_cluster_server::lifecycle::{LifecycleEvent, LifecycleSnapshot};
use openengine_cluster_server::watch::{
    ObservationStore, PublicEventRecord, ReplayPageRequest, ResolvedSubscription, SubscribeRequest,
};
use serde_json::Value;
use tokio::sync::mpsc;

use crate::admission::{InMemoryAdmissionStore, StoreState};

/// Projects an operational lifecycle mutation to the closed public watch event algebra. The
/// `Dispatched`/`Verified`/`Void`/`Failed`/`Retried` dispatch/lease turn events are internal
/// cursor advances with no public fold change; `Updated`/`StopRequested` fold into the observable
/// phase; `Finished` is always the terminal event for its run.
pub(crate) fn watch_event_for_lifecycle(
    event: &LifecycleEvent,
    status: ClusterStatus,
) -> WatchEvent {
    match event {
        LifecycleEvent::Dispatched { .. }
        | LifecycleEvent::Verified { .. }
        | LifecycleEvent::Void { .. }
        | LifecycleEvent::Failed { .. }
        | LifecycleEvent::Retried { .. } => WatchEvent::Bookmark,
        LifecycleEvent::Updated { .. } | LifecycleEvent::StopRequested { .. } => {
            WatchEvent::Phase {
                status,
                admission: None,
            }
        }
        LifecycleEvent::Finished { mode } => WatchEvent::Finished {
            final_status: status,
            stop_mode: Some(*mode),
        },
    }
}

#[derive(Clone)]
struct LiveSlot {
    sender: mpsc::Sender<PublicEventRecord>,
    overflowed: Arc<AtomicBool>,
}

#[derive(Debug, Default)]
pub(crate) struct ObservationState {
    history: BTreeMap<RunId, Vec<PublicEventRecord>>,
    tombstoned: BTreeMap<RunId, Option<Cursor>>,
    live: BTreeMap<RunId, Vec<LiveSlot>>,
    parked: Vec<LiveSlot>,
}

impl std::fmt::Debug for LiveSlot {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("LiveSlot")
            .field("overflowed", &self.overflowed.load(Ordering::Relaxed))
            .finish()
    }
}

impl ObservationState {
    /// Records a durable public event for `run_id` at `cursor`, fanning it out to every live
    /// subscriber. On the first record ever seen for a run, any parked (run-less) subscribers
    /// attach to this run and receive this same event, satisfying "park until the next committed
    /// run." A slot whose bounded queue is full is marked overflowed and dropped from live
    /// fan-out; a slot whose receiver has already been dropped (cancelled) is dropped silently.
    pub(crate) fn record(&mut self, run_id: &RunId, cursor: Cursor, event: WatchEvent) {
        let record = PublicEventRecord {
            run_id: run_id.clone(),
            cursor,
            event,
        };
        let is_new_run = !self.history.contains_key(run_id);
        self.history
            .entry(run_id.clone())
            .or_default()
            .push(record.clone());
        if is_new_run {
            let parked = std::mem::take(&mut self.parked);
            if !parked.is_empty() {
                self.live.entry(run_id.clone()).or_default().extend(parked);
            }
        }
        self.fan_out(run_id, &record);
    }

    fn fan_out(&mut self, run_id: &RunId, record: &PublicEventRecord) {
        if let Some(slots) = self.live.get_mut(run_id) {
            slots.retain_mut(|slot| match slot.sender.try_send(record.clone()) {
                Ok(()) => true,
                Err(mpsc::error::TrySendError::Full(_)) => {
                    slot.overflowed.store(true, Ordering::Release);
                    false
                }
                Err(mpsc::error::TrySendError::Closed(_)) => false,
            });
        }
    }

    /// Redelivers the last recorded event for `run_id` to every live subscriber without
    /// allocating a new cursor, simulating a legal at-least-once physical retry. Returns `false`
    /// if the run has no recorded history.
    fn redeliver_last(&mut self, run_id: &RunId) -> bool {
        let Some(record) = self
            .history
            .get(run_id)
            .and_then(|records| records.last())
            .cloned()
        else {
            return false;
        };
        self.fan_out(run_id, &record);
        true
    }
}

impl StoreState {
    pub(crate) fn record_public_event(
        &mut self,
        run_id: &RunId,
        cursor: Cursor,
        event: WatchEvent,
    ) {
        self.observation.record(run_id, cursor, event);
    }

    /// Finalizes a terminal run's deletion: tombstones its watch history (the same
    /// `ObservationState.tombstoned`/`StoreError::RunGone` plumbing `tombstone_run` uses) and
    /// resets control and lifecycle to their empty defaults, so the next apply starts at
    /// generation 1.
    pub(crate) fn finalize_delete(&mut self) -> DeleteResult {
        let tombstoned_at = self.lifecycle.latest_cursor.clone();
        if let Some(run_id) = self.control.run_id.clone() {
            self.observation.tombstoned.insert(run_id, tombstoned_at);
        }
        self.control = ControlSnapshot::default();
        self.lifecycle = LifecycleSnapshot::default();
        DeleteResult {
            deleted: true,
            phase: Phase::Empty,
            generation: None,
            run_id: None,
            at_cursor: None,
            deduped: false,
        }
    }
}

/// Resolves the run a `watch` request attaches to: the explicit `run_id` (validated against the
/// tombstone/history ports), or the current run when none was requested.
fn resolve_watch_run_id(
    state: &StoreState,
    requested: Option<RunId>,
) -> Result<Option<RunId>, StoreError> {
    match requested {
        Some(run_id) => {
            if let Some(tombstoned_at) = state.observation.tombstoned.get(&run_id) {
                return Err(StoreError::RunGone {
                    tombstoned_at: tombstoned_at.clone(),
                });
            }
            if !state.observation.history.contains_key(&run_id) {
                return Err(StoreError::UnknownRun);
            }
            Ok(Some(run_id))
        }
        None => Ok(state.control.run_id.clone()),
    }
}

/// Rejects a forged `fromCursor`: one supplied without a resolved run, or one that never appears
/// in that run's retained history.
fn validate_from_cursor(
    state: &StoreState,
    run_id: Option<&RunId>,
    from_cursor: Option<&Cursor>,
) -> Result<(), StoreError> {
    match (run_id, from_cursor) {
        (Some(run_id), Some(from_cursor)) => {
            let known = state
                .observation
                .history
                .get(run_id)
                .is_some_and(|records| records.iter().any(|record| &record.cursor == from_cursor));
            if known {
                Ok(())
            } else {
                Err(StoreError::UnknownRun)
            }
        }
        (None, Some(_)) => Err(StoreError::UnknownRun),
        _ => Ok(()),
    }
}

#[async_trait]
impl ObservationStore for InMemoryAdmissionStore {
    async fn subscribe(
        &self,
        request: SubscribeRequest,
        queue_capacity: usize,
    ) -> Result<ResolvedSubscription, StoreError> {
        let mut state = self.state.lock().await;

        let run_id = resolve_watch_run_id(&state, request.run_id)?;
        validate_from_cursor(&state, run_id.as_ref(), request.from_cursor.as_ref())?;

        let replay_through = run_id.as_ref().and_then(|run_id| {
            state
                .observation
                .history
                .get(run_id)
                .and_then(|records| records.last())
                .map(|record| record.cursor.clone())
        });

        let (sender, receiver) = mpsc::channel(queue_capacity.max(1));
        let overflowed = Arc::new(AtomicBool::new(false));
        let slot = LiveSlot {
            sender,
            overflowed: Arc::clone(&overflowed),
        };
        match &run_id {
            Some(run_id) => {
                state
                    .observation
                    .live
                    .entry(run_id.clone())
                    .or_default()
                    .push(slot);
            }
            None => state.observation.parked.push(slot),
        }

        Ok(ResolvedSubscription {
            run_id,
            at_cursor: replay_through.clone(),
            resume_after: request.from_cursor,
            replay_through,
            receiver,
            overflowed,
        })
    }

    async fn replay_page(
        &self,
        request: ReplayPageRequest<'_>,
    ) -> Result<Vec<PublicEventRecord>, StoreError> {
        let state = self.state.lock().await;
        let Some(records) = state.observation.history.get(request.run_id) else {
            return Err(StoreError::UnknownRun);
        };
        let start = match request.after {
            Some(after) => records
                .iter()
                .position(|record| &record.cursor == after)
                .map_or(0, |index| index + 1),
            None => 0,
        };
        let mut page = Vec::new();
        for record in records.iter().skip(start) {
            let reached_through = &record.cursor == request.through;
            page.push(record.clone());
            if page.len() >= request.limit || reached_through {
                break;
            }
        }
        Ok(page)
    }
}

/// The synthetic testkit-only node execution hook backing `NodeBegin`/`NodeEnd` golden vectors.
/// This is decoupled from the real `acquire_dispatch`/`complete_dispatch` lease mechanism since
/// no native graph executor exists yet.
#[derive(Clone, Debug)]
pub enum NodeEventBody {
    Begin { input: Value },
    End { outcome: WorkerOutcome },
}

impl InMemoryAdmissionStore {
    /// Marks `run_id`'s retained history as deleted for future `subscribe` calls. Existing live
    /// subscriptions already attached to the run are left alone; the tombstone is a boundary
    /// prerequisite for a future authoritative delete contract.
    pub async fn tombstone_run(&self, run_id: RunId) {
        let mut state = self.state.lock().await;
        let tombstoned_at = state
            .observation
            .history
            .get(&run_id)
            .and_then(|records| records.last())
            .map(|record| record.cursor.clone());
        state.observation.tombstoned.insert(run_id, tombstoned_at);
    }

    /// Test-only: simulates the backend cleanup executor arming the pending-cleanup fence so the
    /// next `delete` of a terminal run holds `Deleting` instead of finalizing immediately. No
    /// production cleanup executor calls this yet.
    pub async fn arm_pending_cleanup(&self) {
        self.state.lock().await.pending_cleanup = true;
    }

    /// Test-only: simulates the backend cleanup executor confirming every backend-owned resource
    /// is authoritatively absent, resolving a held `Deleting` fence. No production cleanup
    /// executor calls this yet.
    pub async fn resolve_pending_deletion(&self) -> DeleteResult {
        let mut state = self.state.lock().await;
        assert_eq!(
            state.control.phase,
            Phase::Deleting,
            "resolve_pending_deletion requires a held deleting fence"
        );
        state.pending_cleanup = false;
        state.finalize_delete()
    }

    /// Redelivers the last recorded public event for `run_id` to every live subscriber without
    /// allocating a new cursor. This exists only to prove that legal at-least-once duplicate
    /// physical delivery does not corrupt server-side state; client-side dedup handles it.
    pub async fn redeliver_last_event_for_test(&self, run_id: &RunId) -> bool {
        self.state.lock().await.observation.redeliver_last(run_id)
    }

    /// Emits a synthetic `NodeBegin`/`NodeEnd` golden-vector event for `run_id`, allocating one
    /// new public cursor. Test-only: real node execution is out of scope for this slice.
    pub async fn emit_node_event(
        &self,
        run_id: &RunId,
        node: NodeAddress,
        body: NodeEventBody,
    ) -> Cursor {
        let mut state = self.state.lock().await;
        let cursor = state.allocate_cursor();
        let event = match body {
            NodeEventBody::Begin { input } => WatchEvent::NodeBegin { node, input },
            NodeEventBody::End { outcome } => WatchEvent::NodeEnd { node, outcome },
        };
        state.record_public_event(run_id, cursor.clone(), event);
        cursor
    }

    /// Emits a synthetic `Fault` golden-vector event for `run_id`, allocating one new public
    /// cursor. Test-only: no production backend reports a real `BackendFault` through this hook
    /// yet; native mapping is out of scope for this slice.
    pub async fn emit_fault_event(&self, run_id: &RunId, fault: BackendFault) -> Cursor {
        let mut state = self.state.lock().await;
        let cursor = state.allocate_cursor();
        state.record_public_event(run_id, cursor.clone(), WatchEvent::Fault { fault });
        cursor
    }
}
