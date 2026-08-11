//! Protocol store adapters backed by one coherent ordered-prefix fold.

use std::num::NonZeroU64;
use std::sync::Arc;

mod apply;
mod protocol;
mod state;

use async_trait::async_trait;
use openengine_cluster_protocol::{
    ApplyResult, DeleteResult, ResubmitResult, RetryResult, RunId, StopResult, UpdateResult,
};
use openengine_cluster_server::admission::{
    AdmissionSnapshot, AdmissionStore, CancellationSignal, CommitProposal, ControlJournal,
    ControlSnapshot, DeleteProposal, IdempotencyRecord, ResubmitProposal,
    StoreError as ProtocolStoreError, VerifiedIoLedger, VerifiedSeed,
};
use openengine_cluster_server::lifecycle::{
    CompletionResult, DispatchPermit, FailedCompletion, LifecycleSnapshot, LifecycleStore,
    RetryProposal, StopProposal, UpdateProposal, VerifiedCompletion,
};

use apply::{
    ensure_change_is_safe, prepare_apply_plan, prepare_changed_apply, prepare_unchanged_apply,
    ApplyPlan, ChangedApply,
};
use super::record::CanonicalDigest;
use super::store::{IdempotencyId, LedgerClock};
use super::{
    ClusterLedger, CommitRequest, CommitResult, LedgerError, LedgerErrorKind, MutationIdentity,
    ReceiptExpectation,
};
use protocol::{
    cancellation_guard, fingerprint_bytes, protocol_cursor, protocol_error,
    protocol_idempotency_record, protocol_run_id,
};
use state::FoldedProtocolState;

#[derive(Clone)]
pub struct ClusterLedgerAdapters {
    ledger: ClusterLedger,
    admission: AdmissionRecordContext,
}

#[derive(Clone)]
pub struct AdmissionRecordContext {
    catalog_digest: CanonicalDigest,
    profile_digest: CanonicalDigest,
    clock: Arc<dyn LedgerClock>,
    run_timeout_ms: NonZeroU64,
}

enum ApplyRacePlan {
    Existing(ApplyResult),
    Retry(ChangedApply),
}

impl AdmissionRecordContext {
    #[must_use]
    pub fn new(
        catalog_digest: CanonicalDigest,
        profile_digest: CanonicalDigest,
        clock: Arc<dyn LedgerClock>,
        run_timeout_ms: NonZeroU64,
    ) -> Self {
        Self {
            catalog_digest,
            profile_digest,
            clock,
            run_timeout_ms,
        }
    }

    #[must_use]
    pub fn catalog_digest(&self) -> &CanonicalDigest {
        &self.catalog_digest
    }

    #[must_use]
    pub fn profile_digest(&self) -> &CanonicalDigest {
        &self.profile_digest
    }

    fn absolute_deadline_ms(&self) -> Result<u64, ProtocolStoreError> {
        self.clock
            .now_ms()
            .checked_add(self.run_timeout_ms.get())
            .filter(|deadline| *deadline <= i64::MAX as u64)
            .ok_or_else(|| ProtocolStoreError::Internal("admission deadline overflow".into()))
    }
}

impl ClusterLedgerAdapters {
    #[must_use]
    pub fn new(ledger: ClusterLedger, admission: AdmissionRecordContext) -> Self {
        Self { ledger, admission }
    }

    #[must_use]
    pub const fn ledger(&self) -> &ClusterLedger {
        &self.ledger
    }

    async fn folded(&self) -> Result<FoldedProtocolState, ProtocolStoreError> {
        let state = self
            .ledger
            .validated_state(crate::fault::FaultContext::Recovery)
            .await
            .map_err(protocol_error)?;
        FoldedProtocolState::from_replay(&state)
    }

    fn existing_protocol_apply(
        &self,
        state: &super::ReplayState,
        key: &IdempotencyId,
        fingerprint: [u8; 32],
    ) -> Result<Option<ApplyResult>, ProtocolStoreError> {
        self.ledger
            .existing_receipt::<ApplyResult>(
                state,
                key,
                ReceiptExpectation::new(
                    crate::fault::FaultContext::Admission,
                    "protocol_apply",
                    fingerprint,
                ),
            )
            .map(|existing| {
                existing.map(|existing| {
                    let mut result = existing.value;
                    result.deduped = true;
                    result
                })
            })
            .map_err(protocol_error)
    }

    async fn commit_plan(
        &self,
        state: &mut super::ReplayState,
        plan: ApplyPlan,
        commit: ApplyCommit<'_>,
    ) -> Result<ApplyResult, ProtocolStoreError> {
        let changed = self.prepare_changed_apply(state, plan)?;
        if commit.cancellation.is_cancelled() {
            return Err(ProtocolStoreError::Cancelled);
        }
        self.commit_protocol_apply(state, changed, &commit).await
    }

    fn prepare_changed_apply(
        &self,
        state: &mut super::ReplayState,
        plan: ApplyPlan,
    ) -> Result<ChangedApply, ProtocolStoreError> {
        match plan {
            ApplyPlan::Unchanged {
                proposal,
                generation,
            } => prepare_unchanged_apply(state, proposal, generation),
            ApplyPlan::Changed {
                proposal,
                canonical_compiled_ir,
            } => {
                ensure_change_is_safe(state)?;
                prepare_changed_apply(state, proposal, canonical_compiled_ir, &self.admission)
            }
        }
    }

    async fn commit_once(
        &self,
        state: &super::ReplayState,
        changed: ChangedApply,
        commit: &ApplyCommit<'_>,
    ) -> Result<CommitResult<ApplyResult>, LedgerError> {
        let ChangedApply { result, payloads } = changed;
        self.ledger
            .commit(
                CommitRequest::new(
                    crate::fault::FaultContext::Admission,
                    state,
                    MutationIdentity::new(commit.key.clone(), "protocol_apply", commit.fingerprint),
                    &result,
                )
                .with_payloads(payloads)
                .guarded(cancellation_guard(commit.cancellation)),
            )
            .await
    }

    fn protocol_commit_result(committed: CommitResult<ApplyResult>) -> ApplyResult {
        let mut value = committed.value;
        value.deduped = committed.replayed;
        value
    }

    async fn commit_protocol_apply(
        &self,
        state: &super::ReplayState,
        changed: ChangedApply,
        commit: &ApplyCommit<'_>,
    ) -> Result<ApplyResult, ProtocolStoreError> {
        match self.commit_once(state, changed, commit).await {
            Ok(committed) => Ok(Self::protocol_commit_result(committed)),
            Err(error) if error.kind() == &LedgerErrorKind::PositionConflict => {
                self.reconcile_protocol_apply_race(commit).await
            }
            Err(error) => Err(protocol_error(error)),
        }
    }

    async fn repeated_position_conflict(
        &self,
        commit: &ApplyCommit<'_>,
    ) -> Result<ApplyResult, ProtocolStoreError> {
        let latest = self
            .ledger
            .validated_state(crate::fault::FaultContext::Admission)
            .await
            .map_err(protocol_error)?;
        if let Some(existing) =
            self.existing_protocol_apply(&latest, &commit.key, commit.fingerprint)?
        {
            return Ok(existing);
        }
        // Preserve explicit generation semantics if another distinct mutation won the bounded
        // retry. Omitted generation remains an upsert, but repeated contention fails closed.
        prepare_apply_plan(&latest, commit.proposal.clone())?;
        Err(ProtocolStoreError::Internal(
            "native admission position changed during bounded reconciliation".into(),
        ))
    }

    fn prepare_race_retry(
        &self,
        current: &mut super::ReplayState,
        commit: &ApplyCommit<'_>,
    ) -> Result<ApplyRacePlan, ProtocolStoreError> {
        if let Some(existing) =
            self.existing_protocol_apply(current, &commit.key, commit.fingerprint)?
        {
            return Ok(ApplyRacePlan::Existing(existing));
        }
        let retry_plan = prepare_apply_plan(current, commit.proposal.clone())?;
        let retry = self.prepare_changed_apply(current, retry_plan)?;
        if commit.cancellation.is_cancelled() {
            return Err(ProtocolStoreError::Cancelled);
        }
        Ok(ApplyRacePlan::Retry(retry))
    }

    async fn reconcile_protocol_apply_race(
        &self,
        commit: &ApplyCommit<'_>,
    ) -> Result<ApplyResult, ProtocolStoreError> {
        let mut current = self
            .ledger
            .validated_state(crate::fault::FaultContext::Admission)
            .await
            .map_err(protocol_error)?;
        let retry = match self.prepare_race_retry(&mut current, commit)? {
            ApplyRacePlan::Existing(existing) => return Ok(existing),
            ApplyRacePlan::Retry(retry) => retry,
        };
        match self.commit_once(&current, retry, commit).await {
            Ok(retried) => Ok(Self::protocol_commit_result(retried)),
            Err(error) if error.kind() == &LedgerErrorKind::PositionConflict => {
                self.repeated_position_conflict(commit).await
            }
            Err(error) => Err(protocol_error(error)),
        }
    }
}

struct ApplyCommit<'a> {
    proposal: CommitProposal,
    key: IdempotencyId,
    fingerprint: [u8; 32],
    cancellation: &'a CancellationSignal,
}

#[async_trait]
impl ControlJournal for ClusterLedgerAdapters {
    async fn read_control(&self) -> Result<ControlSnapshot, ProtocolStoreError> {
        Ok(self.folded().await?.admission.control)
    }

    async fn lookup_idempotency(
        &self,
        key: &openengine_cluster_protocol::IdempotencyKey,
    ) -> Result<Option<IdempotencyRecord>, ProtocolStoreError> {
        let key = IdempotencyId::new(key.as_str())
            .map_err(|_| ProtocolStoreError::Internal("invalid idempotency key".into()))?;
        let receipt = self
            .ledger
            .receipt(crate::fault::FaultContext::Recovery, &key)
            .await
            .map_err(protocol_error)?;
        match receipt {
            Some(receipt) => protocol_idempotency_record(receipt),
            None => Ok(None),
        }
    }
}

#[async_trait]
impl VerifiedIoLedger for ClusterLedgerAdapters {
    async fn read_verified_seed(
        &self,
        run_id: &RunId,
    ) -> Result<Option<VerifiedSeed>, ProtocolStoreError> {
        let folded = self.folded().await?;
        Ok(folded.admission.seed.filter(|seed| &seed.run_id == run_id))
    }
}

#[async_trait]
impl AdmissionStore for ClusterLedgerAdapters {
    async fn read_snapshot(&self) -> Result<AdmissionSnapshot, ProtocolStoreError> {
        Ok(self.folded().await?.admission)
    }

    async fn read_aggregate(
        &self,
    ) -> Result<(AdmissionSnapshot, LifecycleSnapshot), ProtocolStoreError> {
        let folded = self.folded().await?;
        Ok((folded.admission, folded.lifecycle))
    }

    async fn commit(
        &self,
        proposal: CommitProposal,
        cancellation: &CancellationSignal,
    ) -> Result<ApplyResult, ProtocolStoreError> {
        let key = IdempotencyId::new(proposal.idempotency_key.as_str())
            .map_err(|_| ProtocolStoreError::Internal("invalid idempotency key".into()))?;
        let fingerprint = fingerprint_bytes(&proposal.fingerprint)?;
        let mut state = self
            .ledger
            .validated_state(crate::fault::FaultContext::Admission)
            .await
            .map_err(protocol_error)?;
        if let Some(existing) = self.existing_protocol_apply(&state, &key, fingerprint)? {
            return Ok(existing);
        }
        let plan = prepare_apply_plan(&state, proposal.clone())?;
        self.commit_plan(
            &mut state,
            plan,
            ApplyCommit {
                proposal,
                key,
                fingerprint,
                cancellation,
            },
        )
        .await
    }

    async fn resubmit(
        &self,
        _proposal: ResubmitProposal,
        _cancellation: &CancellationSignal,
    ) -> Result<ResubmitResult, ProtocolStoreError> {
        Err(ProtocolStoreError::InvalidPhase {
            current: self.folded().await?.admission.control.phase,
        })
    }

    async fn delete(
        &self,
        _proposal: DeleteProposal,
        _cancellation: &CancellationSignal,
    ) -> Result<DeleteResult, ProtocolStoreError> {
        Err(ProtocolStoreError::InvalidPhase {
            current: self.folded().await?.admission.control.phase,
        })
    }
}

#[async_trait]
impl LifecycleStore for ClusterLedgerAdapters {
    async fn read_lifecycle_snapshot(&self) -> Result<LifecycleSnapshot, ProtocolStoreError> {
        Ok(self.folded().await?.lifecycle)
    }

    async fn update_lifecycle(
        &self,
        _proposal: UpdateProposal,
    ) -> Result<UpdateResult, ProtocolStoreError> {
        Err(ProtocolStoreError::InvalidPhase {
            current: self.folded().await?.admission.control.phase,
        })
    }

    async fn stop_lifecycle(
        &self,
        _proposal: StopProposal,
    ) -> Result<StopResult, ProtocolStoreError> {
        Err(ProtocolStoreError::InvalidPhase {
            current: self.folded().await?.admission.control.phase,
        })
    }

    async fn acquire_dispatch(
        &self,
        _turn_id: openengine_cluster_server::lifecycle::TurnId,
    ) -> Result<DispatchPermit, ProtocolStoreError> {
        Err(ProtocolStoreError::DispatchDenied {
            current: self
                .folded()
                .await?
                .lifecycle
                .dispatch_state()
                .unwrap_or(openengine_cluster_protocol::DispatchState::Stopped),
        })
    }

    async fn complete_dispatch(
        &self,
        _completion: VerifiedCompletion,
    ) -> Result<CompletionResult, ProtocolStoreError> {
        Err(ProtocolStoreError::UnknownLease)
    }

    async fn fail_dispatch(
        &self,
        _failure: FailedCompletion,
    ) -> Result<CompletionResult, ProtocolStoreError> {
        Err(ProtocolStoreError::UnknownLease)
    }

    async fn retry_lifecycle(
        &self,
        _proposal: RetryProposal,
    ) -> Result<RetryResult, ProtocolStoreError> {
        Err(ProtocolStoreError::DispatchDenied {
            current: self
                .folded()
                .await?
                .lifecycle
                .dispatch_state()
                .unwrap_or(openengine_cluster_protocol::DispatchState::Stopped),
        })
    }
}
