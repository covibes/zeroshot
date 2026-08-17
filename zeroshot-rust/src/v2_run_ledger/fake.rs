//! Deterministic in-memory implementation of the native-v2 run ledger port.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex, MutexGuard};

use async_trait::async_trait;
use openengine_cluster_protocol::{Cursor, IdempotencyKey, RunId};

use super::{
    AppendResult, CreateRun, CreateRunOutcome, RunEvent, RunLedger, RunLedgerError, RunSummary,
    SnapshotAndTail, StoredRun, StoredRunEvent, apply_event, cursor_for, cursor_sequence,
    validate_create,
};

#[derive(Clone, Default)]
pub struct FakeRunLedger {
    inner: Arc<Mutex<State>>,
}

#[derive(Default)]
struct State {
    runs: BTreeMap<RunId, FakeRun>,
    submissions: BTreeMap<IdempotencyKey, RunId>,
}

struct FakeRun {
    stored: StoredRun,
    events: Vec<StoredRunEvent>,
}

impl FakeRunLedger {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    fn state(&self) -> MutexGuard<'_, State> {
        self.inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

#[async_trait]
impl RunLedger for FakeRunLedger {
    async fn create_or_get(&self, request: CreateRun) -> Result<CreateRunOutcome, RunLedgerError> {
        validate_create(&request)?;
        let mut state = self.state();
        if let Some(existing_id) = state.submissions.get(&request.submission_key) {
            let existing = &state
                .runs
                .get(existing_id)
                .ok_or(RunLedgerError::Corrupt)?
                .stored;
            if existing.submission_digest == request.submission_digest
                && existing.admitted == request.admitted
            {
                return Ok(CreateRunOutcome::Existing(existing.clone()));
            }
            return Err(RunLedgerError::SubmissionConflict {
                existing_run_id: existing_id.clone(),
            });
        }
        if state.runs.contains_key(&request.run_id) {
            return Err(RunLedgerError::RunIdConflict);
        }
        let stored = StoredRun {
            submission_key: request.submission_key.clone(),
            submission_digest: request.submission_digest,
            admitted: request.admitted,
            snapshot: super::RunSnapshot::admitted(request.run_id.clone()),
        };
        state
            .submissions
            .insert(request.submission_key, request.run_id.clone());
        state.runs.insert(
            request.run_id,
            FakeRun {
                stored: stored.clone(),
                events: Vec::new(),
            },
        );
        Ok(CreateRunOutcome::Created(stored))
    }

    async fn get(&self, run_id: &RunId) -> Result<Option<StoredRun>, RunLedgerError> {
        Ok(self.state().runs.get(run_id).map(|run| run.stored.clone()))
    }

    async fn list(&self) -> Result<Vec<RunSummary>, RunLedgerError> {
        Ok(self
            .state()
            .runs
            .values()
            .map(|run| RunSummary::from(&run.stored.snapshot))
            .collect())
    }

    async fn append(
        &self,
        run_id: &RunId,
        events: Vec<RunEvent>,
    ) -> Result<AppendResult, RunLedgerError> {
        let mut state = self.state();
        let run = state
            .runs
            .get_mut(run_id)
            .ok_or(RunLedgerError::RunNotFound)?;
        append_locked(run, events)
    }

    async fn request_force_stop(&self, run_id: &RunId) -> Result<AppendResult, RunLedgerError> {
        let mut state = self.state();
        let run = state
            .runs
            .get_mut(run_id)
            .ok_or(RunLedgerError::RunNotFound)?;
        if run.stored.snapshot.force_stop_requested || run.stored.snapshot.terminal.is_some() {
            return Ok(AppendResult {
                snapshot: run.stored.snapshot.clone(),
                events: Vec::new(),
            });
        }
        append_locked(run, vec![RunEvent::ForceStopRequested])
    }

    async fn snapshot_and_tail(
        &self,
        run_id: &RunId,
        after: Option<&Cursor>,
    ) -> Result<SnapshotAndTail, RunLedgerError> {
        let state = self.state();
        let run = state.runs.get(run_id).ok_or(RunLedgerError::RunNotFound)?;
        let after = after.map_or(Ok(0), cursor_sequence)?;
        let current = cursor_sequence(&run.stored.snapshot.cursor)?;
        if after > current {
            return Err(RunLedgerError::CursorAhead);
        }
        Ok(SnapshotAndTail {
            snapshot: run.stored.snapshot.clone(),
            events: run
                .events
                .iter()
                .filter(|event| {
                    cursor_sequence(&event.cursor).is_ok_and(|sequence| sequence > after)
                })
                .cloned()
                .collect(),
        })
    }
}

fn append_locked(run: &mut FakeRun, events: Vec<RunEvent>) -> Result<AppendResult, RunLedgerError> {
    if events.is_empty() {
        return Err(RunLedgerError::InvalidEvent("event batch is empty"));
    }
    let mut snapshot = run.stored.snapshot.clone();
    let mut sequence = cursor_sequence(&snapshot.cursor)?;
    let mut stored_events = Vec::with_capacity(events.len());
    for event in events {
        sequence = sequence.checked_add(1).ok_or(RunLedgerError::Storage)?;
        apply_event(&mut snapshot, &event, sequence)?;
        stored_events.push(StoredRunEvent {
            cursor: cursor_for(sequence),
            event,
        });
    }
    // The fake commits only after the whole batch validates, matching the durable adapter.
    run.events.extend(stored_events.iter().cloned());
    run.stored.snapshot = snapshot.clone();
    Ok(AppendResult {
        snapshot,
        events: stored_events,
    })
}
