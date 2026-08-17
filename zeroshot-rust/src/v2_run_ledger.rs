//! Aggressively lean durable run history for the native-v2 product.
//!
//! This is intentionally a fresh store boundary. It records only the facts needed to identify,
//! observe, reduce, and stop one admitted run. Execution recovery, retries, fencing, proofs,
//! effect receipts, hash chains, and controller takeover do not belong here.

use std::collections::BTreeMap;
use std::fmt;

use async_trait::async_trait;
use openengine_cluster_protocol::{
    Cursor, IdempotencyKey, Phase, PositiveInteger, RunId, Sha256Digest, TerminalResult,
    WorkerOutcome,
};
use serde::de;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;
use thiserror::Error;

use crate::full_v1_reducer::{ExecutionVoidReason, StructuralOccurrence};
use crate::native_v2_contract::{AdmittedRun, ExecutionId, ExecutionRef, NodeCompletion};

#[path = "v2_run_ledger/fake.rs"]
pub mod fake;
#[path = "v2_run_ledger/sqlite.rs"]
pub mod sqlite;

pub const INITIAL_CURSOR: &str = "v2:0";
pub const MAX_ADMITTED_RUN_BYTES: usize = 2 * 1024 * 1024;
pub const MAX_EVENT_BYTES: usize = 1024 * 1024;
pub const MAX_SAFE_LOG_BYTES: usize = 16 * 1024;

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CreateRun {
    pub run_id: RunId,
    pub submission_key: IdempotencyKey,
    pub submission_digest: Sha256Digest,
    pub admitted: AdmittedRun,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CreateRunOutcome {
    Created(StoredRun),
    Existing(StoredRun),
}

impl CreateRunOutcome {
    #[must_use]
    pub const fn stored(&self) -> &StoredRun {
        match self {
            Self::Created(run) | Self::Existing(run) => run,
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct StoredRun {
    pub submission_key: IdempotencyKey,
    pub submission_digest: Sha256Digest,
    pub admitted: AdmittedRun,
    pub snapshot: RunSnapshot,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RunPhase {
    Admitted,
    Running,
    Stopping,
    Finished,
}

impl RunPhase {
    #[must_use]
    pub const fn protocol_phase(&self) -> Phase {
        match self {
            Self::Admitted => Phase::Admitting,
            Self::Running | Self::Stopping => Phase::Running,
            Self::Finished => Phase::Finished,
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RunSnapshot {
    pub run_id: RunId,
    pub cursor: Cursor,
    pub phase: RunPhase,
    pub force_stop_requested: bool,
    pub executions: BTreeMap<ExecutionId, NodeSnapshot>,
    pub terminal: Option<TerminalResult>,
}

impl RunSnapshot {
    #[must_use]
    pub fn admitted(run_id: RunId) -> Self {
        Self {
            run_id,
            cursor: initial_cursor(),
            phase: RunPhase::Admitted,
            force_stop_requested: false,
            executions: BTreeMap::new(),
            terminal: None,
        }
    }

    pub fn active_executions(&self) -> impl Iterator<Item = &NodeSnapshot> {
        self.executions
            .values()
            .filter(|node| matches!(node.state, NodeState::Active))
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct NodeSnapshot {
    pub reference: ExecutionRef,
    pub occurrence: StructuralOccurrence,
    pub attempt: PositiveInteger,
    pub input: Value,
    pub started_at: Cursor,
    pub state: NodeState,
}

impl NodeSnapshot {
    #[must_use]
    pub const fn outcome(&self) -> Option<&WorkerOutcome> {
        match &self.state {
            NodeState::Completed { outcome, .. } => Some(outcome),
            NodeState::Active | NodeState::Voided { .. } => None,
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NodeState {
    Active,
    Completed {
        at: Cursor,
        outcome: WorkerOutcome,
    },
    Voided {
        at: Cursor,
        reason: ExecutionVoidReason,
    },
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields, tag = "kind", rename_all = "snake_case")]
pub enum RunEvent {
    RunStarted,
    NodeStarted {
        reference: ExecutionRef,
        occurrence: StructuralOccurrence,
        attempt: PositiveInteger,
        input: Value,
    },
    NodeCompleted {
        completion: NodeCompletion,
    },
    ExecutionVoided {
        reference: ExecutionRef,
        reason: ExecutionVoidReason,
    },
    SafeLog {
        execution: Option<ExecutionId>,
        stream: SafeLogStream,
        line: SafeLogLine,
    },
    ForceStopRequested,
    Terminal {
        result: TerminalResult,
    },
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SafeLogStream {
    Output,
    Error,
    System,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(transparent)]
pub struct SafeLogLine(String);

impl SafeLogLine {
    pub fn new(value: impl Into<String>) -> Result<Self, RunLedgerError> {
        let value = value.into();
        if value.len() > MAX_SAFE_LOG_BYTES {
            return Err(RunLedgerError::SafeLogTooLarge);
        }
        if value.contains('\0') {
            return Err(RunLedgerError::InvalidSafeLog);
        }
        Ok(Self(value))
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl<'de> Deserialize<'de> for SafeLogLine {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        Self::new(String::deserialize(deserializer)?).map_err(de::Error::custom)
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct StoredRunEvent {
    pub cursor: Cursor,
    pub event: RunEvent,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct AppendResult {
    pub snapshot: RunSnapshot,
    pub events: Vec<StoredRunEvent>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SnapshotAndTail {
    /// Current projection and cursor, read atomically with `events`.
    pub snapshot: RunSnapshot,
    /// Durable events strictly after the requested cursor.
    pub events: Vec<StoredRunEvent>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RunSummary {
    pub run_id: RunId,
    pub cursor: Cursor,
    pub phase: RunPhase,
    pub force_stop_requested: bool,
    pub active_executions: Vec<ExecutionId>,
}

impl From<&RunSnapshot> for RunSummary {
    fn from(snapshot: &RunSnapshot) -> Self {
        Self {
            run_id: snapshot.run_id.clone(),
            cursor: snapshot.cursor.clone(),
            phase: snapshot.phase.clone(),
            force_stop_requested: snapshot.force_stop_requested,
            active_executions: snapshot
                .active_executions()
                .map(|node| node.reference.execution)
                .collect(),
        }
    }
}

#[derive(Clone, Debug, Error, PartialEq)]
pub enum RunLedgerError {
    #[error("run was not found")]
    RunNotFound,
    #[error("submission key already identifies a different admitted run")]
    SubmissionConflict { existing_run_id: RunId },
    #[error("run ID already identifies a different submission")]
    RunIdConflict,
    #[error("cursor is not a native-v2 run cursor")]
    InvalidCursor,
    #[error("cursor is ahead of the run")]
    CursorAhead,
    #[error("admitted run exceeds the storage bound")]
    AdmittedRunTooLarge,
    #[error("event exceeds the storage bound")]
    EventTooLarge,
    #[error("safe log line exceeds the storage bound")]
    SafeLogTooLarge,
    #[error("safe log line contains an invalid NUL byte")]
    InvalidSafeLog,
    #[error("invalid run event: {0}")]
    InvalidEvent(&'static str),
    #[error("run ledger storage is unavailable")]
    Storage,
    #[error("run ledger storage is corrupt")]
    Corrupt,
}

#[async_trait]
pub trait RunLedger: Send + Sync {
    async fn create_or_get(&self, request: CreateRun) -> Result<CreateRunOutcome, RunLedgerError>;

    async fn get(&self, run_id: &RunId) -> Result<Option<StoredRun>, RunLedgerError>;

    async fn list(&self) -> Result<Vec<RunSummary>, RunLedgerError>;

    /// Atomically appends a non-empty batch in its supplied order.
    async fn append(
        &self,
        run_id: &RunId,
        events: Vec<RunEvent>,
    ) -> Result<AppendResult, RunLedgerError>;

    /// Records force-stop intent once. Repeated requests and requests after terminal are no-ops.
    async fn request_force_stop(&self, run_id: &RunId) -> Result<AppendResult, RunLedgerError>;

    /// Reads the current projection and reconnect tail under the same store snapshot.
    async fn snapshot_and_tail(
        &self,
        run_id: &RunId,
        after: Option<&Cursor>,
    ) -> Result<SnapshotAndTail, RunLedgerError>;
}

pub(crate) fn initial_cursor() -> Cursor {
    Cursor::new(INITIAL_CURSOR)
}

pub(crate) fn cursor_for(sequence: u64) -> Cursor {
    Cursor::new(format!("v2:{sequence}"))
}

pub(crate) fn cursor_sequence(cursor: &Cursor) -> Result<u64, RunLedgerError> {
    cursor
        .as_str()
        .strip_prefix("v2:")
        .and_then(|value| value.parse().ok())
        .ok_or(RunLedgerError::InvalidCursor)
}

pub(crate) fn validate_create(request: &CreateRun) -> Result<(), RunLedgerError> {
    bounded_json(&request.admitted, MAX_ADMITTED_RUN_BYTES)
        .map_err(|_| RunLedgerError::AdmittedRunTooLarge)
}

pub(crate) fn validate_event(event: &RunEvent) -> Result<(), RunLedgerError> {
    bounded_json(event, MAX_EVENT_BYTES).map_err(|_| RunLedgerError::EventTooLarge)
}

fn bounded_json(value: &impl Serialize, maximum: usize) -> Result<(), ()> {
    let bytes = serde_json::to_vec(value).map_err(|_| ())?;
    if bytes.len() > maximum {
        Err(())
    } else {
        Ok(())
    }
}

pub(crate) fn apply_event(
    snapshot: &mut RunSnapshot,
    event: &RunEvent,
    sequence: u64,
) -> Result<(), RunLedgerError> {
    if snapshot.terminal.is_some() {
        return Err(RunLedgerError::InvalidEvent("run is already terminal"));
    }
    validate_event(event)?;
    apply_event_kind(snapshot, event, sequence)?;
    snapshot.cursor = cursor_for(sequence);
    Ok(())
}

fn apply_event_kind(
    snapshot: &mut RunSnapshot,
    event: &RunEvent,
    sequence: u64,
) -> Result<(), RunLedgerError> {
    match event {
        RunEvent::RunStarted => apply_run_started(snapshot),
        RunEvent::NodeStarted { .. } => apply_node_started(snapshot, event, sequence),
        RunEvent::NodeCompleted { completion } => {
            apply_node_completed(snapshot, completion, sequence)
        }
        RunEvent::ExecutionVoided { reference, reason } => {
            apply_execution_voided(snapshot, reference, *reason, sequence)
        }
        RunEvent::SafeLog { execution, .. } => apply_safe_log(snapshot, *execution),
        RunEvent::ForceStopRequested => apply_force_stop(snapshot),
        RunEvent::Terminal { result } => apply_terminal(snapshot, result),
    }
}

fn apply_run_started(snapshot: &mut RunSnapshot) -> Result<(), RunLedgerError> {
    if snapshot.phase != RunPhase::Admitted {
        return Err(RunLedgerError::InvalidEvent("run already started"));
    }
    snapshot.phase = RunPhase::Running;
    Ok(())
}

fn apply_node_started(
    snapshot: &mut RunSnapshot,
    event: &RunEvent,
    sequence: u64,
) -> Result<(), RunLedgerError> {
    let RunEvent::NodeStarted {
        reference,
        occurrence,
        attempt,
        input,
    } = event
    else {
        unreachable!("node-start helper is called only for node-start events");
    };
    require_running(snapshot)?;
    require_run(snapshot, reference)?;
    require_new_dispatch(snapshot, reference)?;
    snapshot.executions.insert(
        reference.execution,
        NodeSnapshot {
            reference: reference.clone(),
            occurrence: occurrence.clone(),
            attempt: *attempt,
            input: input.clone(),
            started_at: cursor_for(sequence),
            state: NodeState::Active,
        },
    );
    Ok(())
}

fn require_new_dispatch(
    snapshot: &RunSnapshot,
    reference: &ExecutionRef,
) -> Result<(), RunLedgerError> {
    if snapshot.force_stop_requested {
        return Err(RunLedgerError::InvalidEvent(
            "cannot dispatch after force-stop",
        ));
    }
    if snapshot.executions.contains_key(&reference.execution) {
        return Err(RunLedgerError::InvalidEvent(
            "execution was already dispatched",
        ));
    }
    Ok(())
}

fn apply_node_completed(
    snapshot: &mut RunSnapshot,
    completion: &NodeCompletion,
    sequence: u64,
) -> Result<(), RunLedgerError> {
    require_run(snapshot, &completion.reference)?;
    completion
        .outcome
        .validate()
        .map_err(|_| RunLedgerError::InvalidEvent("invalid worker outcome"))?;
    let node = active_node_mut(snapshot, &completion.reference)?;
    node.state = NodeState::Completed {
        at: cursor_for(sequence),
        outcome: completion.outcome.clone(),
    };
    Ok(())
}

fn apply_execution_voided(
    snapshot: &mut RunSnapshot,
    reference: &ExecutionRef,
    reason: ExecutionVoidReason,
    sequence: u64,
) -> Result<(), RunLedgerError> {
    require_run(snapshot, reference)?;
    let node = active_node_mut(snapshot, reference)?;
    node.state = NodeState::Voided {
        at: cursor_for(sequence),
        reason,
    };
    Ok(())
}

fn apply_safe_log(
    snapshot: &RunSnapshot,
    execution: Option<ExecutionId>,
) -> Result<(), RunLedgerError> {
    let Some(execution) = execution else {
        return Ok(());
    };
    if snapshot.executions.contains_key(&execution) {
        Ok(())
    } else {
        Err(RunLedgerError::InvalidEvent(
            "log references an unknown execution",
        ))
    }
}

fn apply_force_stop(snapshot: &mut RunSnapshot) -> Result<(), RunLedgerError> {
    if snapshot.force_stop_requested {
        return Err(RunLedgerError::InvalidEvent(
            "force-stop was already requested",
        ));
    }
    snapshot.force_stop_requested = true;
    snapshot.phase = RunPhase::Stopping;
    Ok(())
}

fn apply_terminal(
    snapshot: &mut RunSnapshot,
    result: &TerminalResult,
) -> Result<(), RunLedgerError> {
    if snapshot.active_executions().next().is_some() {
        return Err(RunLedgerError::InvalidEvent(
            "cannot finish with active executions",
        ));
    }
    snapshot.terminal = Some(result.clone());
    snapshot.phase = RunPhase::Finished;
    Ok(())
}

fn require_running(snapshot: &RunSnapshot) -> Result<(), RunLedgerError> {
    if snapshot.phase == RunPhase::Running {
        Ok(())
    } else {
        Err(RunLedgerError::InvalidEvent("run is not dispatchable"))
    }
}

fn require_run(snapshot: &RunSnapshot, reference: &ExecutionRef) -> Result<(), RunLedgerError> {
    if snapshot.run_id == reference.run_id {
        Ok(())
    } else {
        Err(RunLedgerError::InvalidEvent(
            "execution belongs to another run",
        ))
    }
}

fn active_node_mut<'a>(
    snapshot: &'a mut RunSnapshot,
    reference: &ExecutionRef,
) -> Result<&'a mut NodeSnapshot, RunLedgerError> {
    let node = snapshot
        .executions
        .get_mut(&reference.execution)
        .ok_or(RunLedgerError::InvalidEvent("execution was not dispatched"))?;
    if node.reference != *reference {
        return Err(RunLedgerError::InvalidEvent(
            "execution reference does not match dispatch",
        ));
    }
    if !matches!(node.state, NodeState::Active) {
        return Err(RunLedgerError::InvalidEvent("execution is already settled"));
    }
    Ok(node)
}

impl fmt::Display for RunPhase {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let value = match self {
            Self::Admitted => "admitted",
            Self::Running => "running",
            Self::Stopping => "stopping",
            Self::Finished => "finished",
        };
        formatter.write_str(value)
    }
}

#[cfg(test)]
#[path = "v2_run_ledger/tests.rs"]
mod tests;
