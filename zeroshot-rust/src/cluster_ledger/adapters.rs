//! Protocol store adapters backed by one coherent ordered-prefix fold.

mod protocol;
mod state;

use async_trait::async_trait;
use openengine_cluster_protocol::{
    canonical_value_bytes, ApplyResult, Generation, Phase, ResubmitResult, RetryResult, RunId,
    StopResult, UpdateResult,
};
use openengine_cluster_server::admission::{
    AdmissionSnapshot, AdmissionStore, CancellationSignal, CommitProposal, ControlJournal,
    ControlSnapshot, IdempotencyRecord, ResubmitProposal, StoreError as ProtocolStoreError,
    VerifiedIoLedger, VerifiedSeed,
};
use openengine_cluster_server::lifecycle::{
    CompletionResult, DispatchPermit, FailedCompletion, LifecycleSnapshot, LifecycleStore,
    RetryProposal, StopProposal, UpdateProposal, VerifiedCompletion,
};

use super::record::{CanonicalDigest, RecordPayload};
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

enum ApplyPlan {
    Unchanged {
        proposal: CommitProposal,
        generation: Option<Generation>,
    },
    Changed {
        proposal: CommitProposal,
        canonical_compiled_ir: Vec<u8>,
    },
}

struct ChangedApply {
    result: ApplyResult,
    payloads: Vec<RecordPayload>,
}

fn prepare_unchanged_apply(
    state: &super::ReplayState,
    proposal: CommitProposal,
    generation: Option<Generation>,
) -> Result<ChangedApply, ProtocolStoreError> {
    if proposal.input.is_some() {
        return Err(ProtocolStoreError::SchemaViolation(
            "unchanged admission cannot replace verified input".into(),
        ));
    }
    let current = state
        .admission
        .as_ref()
        .expect("unchanged admission requires current state");
    Ok(ChangedApply {
        result: ApplyResult {
            generation,
            run_id: Some(protocol_run_id(current.run)),
            phase: Phase::Running,
            deduped: false,
            diff: None,
        },
        payloads: Vec::new(),
    })
}

fn ensure_change_is_safe(state: &super::ReplayState) -> Result<(), ProtocolStoreError> {
    if !state.active_dispatches.is_empty()
        || state
            .effects
            .values()
            .any(|effect| effect.receipt_digest.is_none())
    {
        return Err(ProtocolStoreError::InvalidPhase {
            current: Phase::Running,
        });
    }
    Ok(())
}

fn prepare_changed_apply(
    state: &mut super::ReplayState,
    proposal: CommitProposal,
    canonical_compiled_ir: Vec<u8>,
) -> Result<ChangedApply, ProtocolStoreError> {
    let generation = state
        .identities
        .allocate_generation()
        .map_err(|_| ProtocolStoreError::Internal("generation allocation failed".into()))?;
    let run = state
        .identities
        .allocate_run()
        .map_err(|_| ProtocolStoreError::Internal("run allocation failed".into()))?;
    let canonical_graph = serde_json::to_vec(&proposal.graph)
        .map_err(|_| ProtocolStoreError::Internal("graph encoding failed".into()))?;
    let canonical_input = canonical_value_bytes(proposal.input.as_ref().ok_or_else(|| {
        ProtocolStoreError::SchemaViolation("changed admission requires verified input".into())
    })?)
    .map_err(|_| ProtocolStoreError::SchemaViolation("input is not canonical".into()))?;
    let input_digest = CanonicalDigest::of(&canonical_input);
    let payloads = changed_apply_payloads(
        &proposal,
        ChangedPayloads {
            generation,
            run,
            canonical_graph,
            canonical_input,
            input_digest,
            canonical_compiled_ir,
        },
    );
    Ok(ChangedApply {
        result: ApplyResult {
            generation: Some(Generation::new(generation.get()).map_err(|_| {
                ProtocolStoreError::Internal("generation exceeds protocol range".into())
            })?),
            run_id: Some(protocol_run_id(run)),
            phase: Phase::Running,
            deduped: false,
            diff: None,
        },
        payloads,
    })
}

struct ChangedPayloads {
    generation: super::GenerationId,
    run: super::RunSequence,
    canonical_graph: Vec<u8>,
    canonical_input: Vec<u8>,
    input_digest: CanonicalDigest,
    canonical_compiled_ir: Vec<u8>,
}

fn changed_apply_payloads(
    proposal: &CommitProposal,
    changed: ChangedPayloads,
) -> Vec<RecordPayload> {
    let ChangedPayloads {
        generation,
        run,
        canonical_graph,
        canonical_input,
        input_digest,
        canonical_compiled_ir,
    } = changed;
    vec![
        RecordPayload::Admission {
            generation,
            run,
            graph_digest: CanonicalDigest::of(&canonical_graph),
            input_digest,
            policy_digest: CanonicalDigest::of(&canonical_compiled_ir),
            catalog_digest: CanonicalDigest::of(b"worker-catalog/v1"),
            profile_digest: CanonicalDigest::of(proposal.compiled_ir.profile.as_str().as_bytes()),
            absolute_deadline_ms: u64::MAX,
            canonical_graph,
            canonical_compiled_ir,
        },
        RecordPayload::VerifiedInput {
            run,
            digest: input_digest,
            canonical_bytes: canonical_input,
        },
    ]
}

fn current_protocol_generation(
    state: &super::ReplayState,
) -> Result<Option<Generation>, ProtocolStoreError> {
    state
        .admission
        .as_ref()
        .map(|admission| {
            Generation::new(admission.generation.get())
                .map_err(|_| ProtocolStoreError::Internal("durable generation is invalid".into()))
        })
        .transpose()
}

fn validate_protocol_generation(
    expected: Option<Generation>,
    current: Option<Generation>,
) -> Result<(), ProtocolStoreError> {
    let matches = match expected {
        None => true,
        Some(expected) if expected.get() == 0 => current.is_none(),
        Some(expected) => current == Some(expected),
    };
    if matches {
        Ok(())
    } else {
        Err(ProtocolStoreError::GenerationConflict { current })
    }
}

fn ensure_apply_phase(state: &super::ReplayState) -> Result<(), ProtocolStoreError> {
    if state.terminal_outcome.is_some() {
        Err(ProtocolStoreError::InvalidPhase {
            current: Phase::Finished,
        })
    } else {
        Ok(())
    }
}

fn prepare_apply_plan(
    state: &super::ReplayState,
    proposal: CommitProposal,
) -> Result<ApplyPlan, ProtocolStoreError> {
    ensure_apply_phase(state)?;
    let current_generation = current_protocol_generation(state)?;
    validate_protocol_generation(proposal.if_generation, current_generation)?;
    let canonical_compiled_ir = proposal
        .compiled_ir
        .canonical_bytes()
        .map_err(|_| ProtocolStoreError::Internal("compiled graph encoding failed".into()))?;
    let unchanged = state
        .admission
        .as_ref()
        .is_some_and(|admission| admission.canonical_compiled_ir == canonical_compiled_ir);
    Ok(if unchanged {
        ApplyPlan::Unchanged {
            proposal,
            generation: current_generation,
        }
    } else {
        ApplyPlan::Changed {
            proposal,
            canonical_compiled_ir,
        }
    })
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
