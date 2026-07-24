//! Atomic operational lifecycle store contract.

use async_trait::async_trait;
use openengine_cluster_protocol::{
    ApplyResult, Cursor, DispatchState, Generation, IdempotencyKey, Labels, LogLevel,
    OperationalStatus, RequestFingerprint, ResubmitResult, RetryParams, RetryResult, RunId,
    StopMode, StopParams, StopResult, TurnFailureKind, UpdateParams, UpdateResult,
};
use serde_json::Value;

use crate::admission::{CancellationObserver, StoreError};

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum MutationReceipt {
    Apply(ApplyResult),
    Update(UpdateResult),
    Stop(StopResult),
    Retry(RetryResult),
    Resubmit(ResubmitResult),
}

#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct LeaseId(String);

impl LeaseId {
    #[must_use]
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct TurnId(String);

impl TurnId {
    #[must_use]
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DispatchPermit {
    pub lease_id: LeaseId,
    pub turn_id: TurnId,
    pub cancellation: CancellationObserver,
    pub at_cursor: Cursor,
}

#[derive(Clone, Debug, PartialEq)]
pub struct VerifiedCompletion {
    pub lease_id: LeaseId,
    pub output: Value,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FailureRetryability {
    Retryable,
    AttemptsExhausted,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FailedCompletion {
    pub lease_id: LeaseId,
    pub kind: TurnFailureKind,
    pub retryability: FailureRetryability,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CompletionResult {
    pub turn_id: TurnId,
    pub at_cursor: Cursor,
    pub terminalized: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct VerifiedTurn {
    pub turn_id: TurnId,
    pub output: Value,
    pub cursor: Cursor,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VoidTurn {
    pub turn_id: TurnId,
    pub cursor: Cursor,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LifecycleRecord {
    pub cursor: Cursor,
    pub event: LifecycleEvent,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum LifecycleEvent {
    Dispatched {
        turn_id: TurnId,
    },
    Updated {
        labels: Option<Labels>,
        log_level: Option<LogLevel>,
        suspended: Option<bool>,
    },
    StopRequested {
        accepted_mode: StopMode,
        effective_mode: StopMode,
    },
    Verified {
        turn_id: TurnId,
    },
    Void {
        turn_id: TurnId,
    },
    Finished {
        mode: StopMode,
    },
    Failed {
        turn_id: TurnId,
        kind: TurnFailureKind,
        retryability: FailureRetryability,
    },
    Retried {
        failed_turn_id: TurnId,
        retry_turn_id: TurnId,
    },
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct LifecycleSnapshot {
    pub operational: Option<OperationalStatus>,
    pub latest_cursor: Option<Cursor>,
    pub records: Vec<LifecycleRecord>,
    pub verified_turns: Vec<VerifiedTurn>,
    pub void_turns: Vec<VoidTurn>,
    pub pending_failed_frontier: Option<TurnId>,
    pub pending_retry_turn: Option<TurnId>,
}

impl LifecycleSnapshot {
    #[must_use]
    pub fn dispatch_state(&self) -> Option<DispatchState> {
        self.operational
            .as_ref()
            .map(|status| status.dispatch_state)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UpdateProposal {
    pub params: UpdateParams,
    pub fingerprint: RequestFingerprint,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StopProposal {
    pub params: StopParams,
    pub fingerprint: RequestFingerprint,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RetryProposal {
    pub params: RetryParams,
    pub fingerprint: RequestFingerprint,
}

#[async_trait]
pub trait LifecycleStore: Send + Sync {
    async fn read_lifecycle_snapshot(&self) -> Result<LifecycleSnapshot, StoreError>;

    async fn update_lifecycle(&self, proposal: UpdateProposal) -> Result<UpdateResult, StoreError>;

    async fn stop_lifecycle(&self, proposal: StopProposal) -> Result<StopResult, StoreError>;

    async fn acquire_dispatch(&self, turn_id: TurnId) -> Result<DispatchPermit, StoreError>;

    async fn complete_dispatch(
        &self,
        completion: VerifiedCompletion,
    ) -> Result<CompletionResult, StoreError>;

    /// Internal primitive that records a dispatched turn's terminal failure and establishes it as
    /// the pending retryable frontier. Not RPC-exposed; no production graph executor calls this
    /// yet (see crate docs).
    async fn fail_dispatch(
        &self,
        failure: FailedCompletion,
    ) -> Result<CompletionResult, StoreError>;

    async fn retry_lifecycle(&self, proposal: RetryProposal) -> Result<RetryResult, StoreError>;
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LifecycleIdentity {
    pub generation: Generation,
    pub run_id: RunId,
    pub idempotency_key: IdempotencyKey,
}
