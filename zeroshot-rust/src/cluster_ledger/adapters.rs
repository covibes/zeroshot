//! Protocol store adapters backed by one coherent ordered-prefix fold.

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
use super::store::IdempotencyId;
use super::{ClusterLedger, CommitRequest, MutationIdentity, ReceiptExpectation};
use protocol::{
    cancellation_guard, fingerprint_bytes, protocol_cursor, protocol_error,
    protocol_idempotency_record, protocol_run_id,
};
use state::FoldedProtocolState;

#[derive(Clone)]
pub struct ClusterLedgerAdapters {
    ledger: ClusterLedger,
}

impl ClusterLedgerAdapters {
    #[must_use]
    pub const fn new(ledger: ClusterLedger) -> Self {
        Self { ledger }
    }

    #[must_use]
    pub const fn ledger(&self) -> &ClusterLedger {
        &self.ledger
    }

    async fn folded(&self) -> Result<FoldedProtocolState, ProtocolStoreError> {
        let state = self.ledger.state().await.map_err(protocol_error)?;
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
        let changed = match plan {
            ApplyPlan::Unchanged {
                proposal,
                generation,
            } => prepare_unchanged_apply(state, proposal, generation)?,
            ApplyPlan::Changed {
                proposal,
                canonical_compiled_ir,
            } => {
                ensure_change_is_safe(state)?;
                prepare_changed_apply(state, proposal, canonical_compiled_ir)?
            }
        };
        if commit.cancellation.is_cancelled() {
            return Err(ProtocolStoreError::Cancelled);
        }
        self.commit_protocol_apply(state, changed, commit).await
    }

    async fn commit_protocol_apply(
        &self,
        state: &super::ReplayState,
        changed: ChangedApply,
        commit: ApplyCommit<'_>,
    ) -> Result<ApplyResult, ProtocolStoreError> {
        let ChangedApply { result, payloads } = changed;
        let committed = self
            .ledger
            .commit(
                CommitRequest::new(
                    crate::fault::FaultContext::Admission,
                    state,
                    MutationIdentity::new(commit.key, "protocol_apply", commit.fingerprint),
                    &result,
                )
                .with_payloads(payloads)
                .guarded(cancellation_guard(commit.cancellation)),
            )
            .await
            .map_err(protocol_error)?;
        let mut value = committed.value;
        value.deduped = committed.replayed;
        Ok(value)
    }
}

struct ApplyCommit<'a> {
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
        let plan = prepare_apply_plan(&state, proposal)?;
        self.commit_plan(
            &mut state,
            plan,
            ApplyCommit {
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
