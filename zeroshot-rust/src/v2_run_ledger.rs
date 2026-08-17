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

use crate::full_v1_reducer::{ExecutionId, ExecutionVoidReason, StructuralOccurrence};
use crate::native_v2_contract::{AdmittedRun, ExecutionRef, NodeCompletion};

#[path = "v2_run_ledger/fake.rs"]
pub mod fake;
#[path = "v2_run_ledger/sqlite.rs"]
pub mod sqlite;
#[path = "v2_run_ledger/state.rs"]
mod state;

pub(crate) use state::{apply_event, cursor_for, cursor_sequence, initial_cursor, validate_create};

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
pub struct SafeLogLine(Box<str>);

impl SafeLogLine {
    pub fn new(value: impl Into<String>) -> Result<Self, RunLedgerError> {
        let value = value.into();
        match (value.len() <= MAX_SAFE_LOG_BYTES, value.contains('\0')) {
            (false, _) => Err(RunLedgerError::SafeLogTooLarge),
            (_, true) => Err(RunLedgerError::InvalidSafeLog),
            (true, false) => Ok(Self(value.into_boxed_str())),
        }
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
        let value = String::deserialize(deserializer)?;
        match Self::new(value) {
            Ok(line) => Ok(line),
            Err(error) => Err(de::Error::custom(error)),
        }
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
