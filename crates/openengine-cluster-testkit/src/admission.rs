//! Deterministic admission fixtures. These types script verifier assertions and admission state;
//! they are not a native graph verifier or production executor.

use crate::fixture::*;

use std::collections::{BTreeMap, BTreeSet};

use async_trait::async_trait;
use openengine_cluster_protocol::{
    ApplyResult, CompiledGraphIr, Cursor, DeleteResult, DispatchState, Generation, GraphSpec,
    IdempotencyKey, OperationalStatus, Phase, ResubmitResult, RunId,
};
use openengine_cluster_server::admission::{
    AdmissionSnapshot, AdmissionStore, CancellationSignal, CommitProposal, ControlJournal,
    ControlSnapshot, DeleteProposal, IdempotencyRecord, ResubmitProposal, StoreError,
    VerifiedIoLedger, VerifiedSeed,
};
use openengine_cluster_server::lifecycle::{LeaseId, LifecycleSnapshot, MutationReceipt, TurnId};
use serde_json::Value;
use tokio::sync::Mutex;

mod delete;
mod fixtures;
mod inspection;
mod resubmit;
mod scripted_verifier;
pub use fixtures::*;
pub use inspection::StoreInspection;
pub use scripted_verifier::{ScriptedOutcome, ScriptedVerifier, VerifierBarrier};

use crate::watch::ObservationState;

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AppendKind {
    Control,
    VerifiedSeed,
    Idempotency,
    Lifecycle,
    VerifiedOutput,
    Void,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AppendReceipt {
    pub sequence: u64,
    pub cursor: Option<Cursor>,
    pub kind: AppendKind,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ControlReceipt {
    pub generation: Generation,
    pub run_id: RunId,
    pub cursor: Cursor,
    pub spec: GraphSpec,
}

#[derive(Debug, Default)]
pub struct InMemoryAdmissionStore {
    pub(crate) state: Mutex<StoreState>,
}

#[derive(Debug, Default)]
pub(crate) struct StoreState {
    pub(crate) control: ControlSnapshot,
    pub(crate) control_journal: Vec<ControlReceipt>,
    pub(crate) seed_ledger: Vec<VerifiedSeed>,
    pub(crate) idempotency_records: BTreeMap<IdempotencyKey, IdempotencyRecord>,
    pub(crate) append_order: Vec<AppendReceipt>,
    next_sequence: u64,
    next_run: u64,
    pub(crate) next_cursor: u64,
    pub(crate) lifecycle: LifecycleSnapshot,
    pub(crate) leases: BTreeMap<LeaseId, ActiveLease>,
    pub(crate) cancelled_leases: BTreeSet<LeaseId>,
    pub(crate) next_lease: u64,
    pub(crate) next_retry_turn: u64,
    pub(crate) retryable_history: RetryableHistory,
    pub(crate) observation: ObservationState,
    /// Set while a terminal run's `delete` is waiting on the (test-only, simulated) backend
    /// cleanup executor to confirm every backend-owned resource is authoritatively absent.
    pub(crate) pending_cleanup: bool,
}

/// Tracks the disposition of the most recent dispatch/lease completion, purely to compute a
/// stable `NO_RETRYABLE_FRONTIER` reason when no failure is currently pending. Not part of the
/// durable `LifecycleSnapshot` port: reconstructible test-fixture bookkeeping only.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub(crate) enum RetryableHistory {
    #[default]
    Exhausted,
    Success,
    Consumed,
}

#[derive(Clone, Debug)]
pub(crate) struct ActiveLease {
    pub(crate) turn_id: TurnId,
    pub(crate) cancellation: CancellationSignal,
}

impl StoreState {
    fn commit(
        &mut self,
        proposal: CommitProposal,
        cancellation: &CancellationSignal,
    ) -> Result<ApplyResult, StoreError> {
        if let Some(receipt) = self.replay(&proposal)? {
            return Ok(receipt);
        }
        enforce_generation(proposal.if_generation, self.control.generation)?;
        if !matches!(self.control.phase, Phase::Empty | Phase::Running) {
            return Err(StoreError::InvalidPhase {
                current: self.control.phase,
            });
        }
        let unchanged = self.is_unchanged(&proposal.compiled_ir)?;
        if self.control.phase == Phase::Running {
            let dispatch_state = self
                .lifecycle
                .operational
                .as_ref()
                .ok_or_else(|| StoreError::Internal("running lifecycle metadata is absent".into()))?
                .dispatch_state;
            if dispatch_state != DispatchState::Active || (!unchanged && !self.leases.is_empty()) {
                return Err(StoreError::InvalidPhase {
                    current: self.control.phase,
                });
            }
        }
        validate_commit_input(&proposal, unchanged)?;
        if cancellation.is_cancelled() {
            return Err(StoreError::Cancelled);
        }
        let result = if unchanged {
            self.unchanged_receipt()
        } else {
            self.changed_receipt(&proposal)?
        };
        self.record_idempotency(proposal, &result);
        Ok(result)
    }

    fn replay(&self, proposal: &CommitProposal) -> Result<Option<ApplyResult>, StoreError> {
        let Some(existing) = self.idempotency_records.get(&proposal.idempotency_key) else {
            return Ok(None);
        };
        if existing.fingerprint != proposal.fingerprint {
            return Err(StoreError::IdempotencyReuse);
        }
        let MutationReceipt::Apply(mut receipt) = existing.receipt.clone() else {
            return Err(StoreError::IdempotencyReuse);
        };
        receipt.deduped = true;
        Ok(Some(receipt))
    }

    fn is_unchanged(&self, desired: &CompiledGraphIr) -> Result<bool, StoreError> {
        self.control
            .compiled_ir
            .as_ref()
            .map(|current| {
                Ok(current
                    .identity()
                    .map_err(|error| StoreError::Internal(error.to_string()))?
                    == desired
                        .identity()
                        .map_err(|error| StoreError::Internal(error.to_string()))?)
            })
            .transpose()
            .map(Option::unwrap_or_default)
    }

    fn unchanged_receipt(&self) -> ApplyResult {
        ApplyResult {
            generation: self.control.generation,
            run_id: self.control.run_id.clone(),
            phase: self.control.phase,
            deduped: false,
            diff: None,
        }
    }

    fn changed_receipt(&mut self, proposal: &CommitProposal) -> Result<ApplyResult, StoreError> {
        self.next_run += 1;
        let generation_value = self
            .control
            .generation
            .map_or(1, |generation| generation.get() + 1);
        let generation = Generation::new(generation_value)
            .map_err(|error| StoreError::Internal(error.to_string()))?;
        let run_id = RunId::new(format!("run-{}", self.next_run));
        let input = proposal
            .input
            .clone()
            .assert_value_with("changed admission validated required input");
        self.control.spec = Some(proposal.graph.clone());
        self.control.compiled_ir = Some(proposal.compiled_ir.clone());
        self.install_run(run_id.clone(), generation, input);
        Ok(ApplyResult {
            generation: Some(generation),
            run_id: Some(run_id),
            phase: Phase::Running,
            deduped: false,
            diff: None,
        })
    }

    /// Mints a fresh run at `cursor`, resetting lease/lifecycle state and appending the control
    /// receipt, verified seed, and public admission-transition event. Assumes `self.control.spec`
    /// (and `compiled_ir`, where relevant) already holds the graph this run admits — callers that
    /// change the graph (`changed_receipt`) must set it before calling this; callers that reuse the
    /// admitted graph (`resubmit`) leave it untouched. Every freshly admitted run starts `Running`.
    fn install_run(&mut self, run_id: RunId, generation: Generation, input: Value) -> Cursor {
        self.next_cursor += 1;
        let cursor = Cursor::new(format!("cursor-{}", self.next_cursor));
        let spec = self
            .control
            .spec
            .clone()
            .assert_value_with("install_run requires an admitted graph spec");
        self.control.generation = Some(generation);
        self.control.run_id = Some(run_id.clone());
        self.control.phase = Phase::Running;
        self.control.cursor = Some(cursor.clone());
        for lease in self.leases.values() {
            lease.cancellation.cancel();
        }
        self.leases.clear();
        self.cancelled_leases.clear();
        self.retryable_history = RetryableHistory::Exhausted;
        self.lifecycle = LifecycleSnapshot {
            operational: Some(OperationalStatus::default()),
            latest_cursor: Some(cursor.clone()),
            records: Vec::new(),
            verified_turns: Vec::new(),
            void_turns: Vec::new(),
            pending_failed_frontier: None,
            pending_retry_turn: None,
        };
        self.control_journal.push(ControlReceipt {
            generation,
            run_id: run_id.clone(),
            cursor: cursor.clone(),
            spec: spec.clone(),
        });
        append(self, Some(cursor.clone()), AppendKind::Control);
        self.seed_ledger.push(VerifiedSeed {
            run_id: run_id.clone(),
            input: input.clone(),
            cursor: cursor.clone(),
        });
        append(self, Some(cursor.clone()), AppendKind::VerifiedSeed);
        let status = self.control.status_with_lifecycle(&self.lifecycle);
        self.record_public_event(
            &run_id.clone(),
            cursor.clone(),
            openengine_cluster_protocol::WatchEvent::Phase {
                status,
                admission: Some(Box::new(openengine_cluster_protocol::AdmissionTransition {
                    run_id,
                    spec,
                    seed_input: input,
                })),
            },
        );
        cursor
    }

    fn record_idempotency(&mut self, proposal: CommitProposal, result: &ApplyResult) {
        self.idempotency_records.insert(
            proposal.idempotency_key,
            IdempotencyRecord {
                fingerprint: proposal.fingerprint,
                receipt: MutationReceipt::Apply(result.clone()),
            },
        );
        append(self, self.control.cursor.clone(), AppendKind::Idempotency);
    }
}

fn validate_commit_input(proposal: &CommitProposal, unchanged: bool) -> Result<(), StoreError> {
    if unchanged {
        return if proposal.input.is_none() {
            Ok(())
        } else {
            Err(StoreError::SchemaViolation(
                "unchanged apply must omit input; use resubmit".into(),
            ))
        };
    }
    let input = proposal.input.as_ref().ok_or_else(|| {
        StoreError::SchemaViolation("apply that starts a run requires input".into())
    })?;
    proposal
        .graph
        .initial_input
        .validate_value(input)
        .map_err(|error| StoreError::SchemaViolation(error.to_string()))
}

#[async_trait]
impl ControlJournal for InMemoryAdmissionStore {
    async fn read_control(&self) -> Result<ControlSnapshot, StoreError> {
        Ok(self.state.lock().await.control.clone())
    }

    async fn lookup_idempotency(
        &self,
        key: &IdempotencyKey,
    ) -> Result<Option<IdempotencyRecord>, StoreError> {
        Ok(self
            .state
            .lock()
            .await
            .idempotency_records
            .get(key)
            .cloned())
    }
}

#[async_trait]
impl VerifiedIoLedger for InMemoryAdmissionStore {
    async fn read_verified_seed(&self, run_id: &RunId) -> Result<Option<VerifiedSeed>, StoreError> {
        Ok(self
            .state
            .lock()
            .await
            .seed_ledger
            .iter()
            .rev()
            .find(|seed| seed.run_id == *run_id)
            .cloned())
    }
}

#[async_trait]
impl AdmissionStore for InMemoryAdmissionStore {
    async fn read_snapshot(&self) -> Result<AdmissionSnapshot, StoreError> {
        let state = self.state.lock().await;
        Ok(admission_snapshot(&state))
    }

    async fn read_aggregate(&self) -> Result<(AdmissionSnapshot, LifecycleSnapshot), StoreError> {
        let state = self.state.lock().await;
        Ok((admission_snapshot(&state), state.lifecycle.clone()))
    }

    async fn commit(
        &self,
        proposal: CommitProposal,
        cancellation: &CancellationSignal,
    ) -> Result<ApplyResult, StoreError> {
        self.state.lock().await.commit(proposal, cancellation)
    }

    async fn resubmit(
        &self,
        proposal: ResubmitProposal,
        cancellation: &CancellationSignal,
    ) -> Result<ResubmitResult, StoreError> {
        self.state.lock().await.resubmit(proposal, cancellation)
    }

    async fn delete(
        &self,
        proposal: DeleteProposal,
        cancellation: &CancellationSignal,
    ) -> Result<DeleteResult, StoreError> {
        self.state.lock().await.delete(proposal, cancellation)
    }
}

fn admission_snapshot(state: &StoreState) -> AdmissionSnapshot {
    let seed = state.control.run_id.as_ref().and_then(|run_id| {
        state
            .seed_ledger
            .iter()
            .rev()
            .find(|seed| seed.run_id == *run_id)
            .cloned()
    });
    AdmissionSnapshot {
        control: state.control.clone(),
        seed,
    }
}

pub(crate) fn append(state: &mut StoreState, cursor: Option<Cursor>, kind: AppendKind) {
    state.next_sequence += 1;
    state.append_order.push(AppendReceipt {
        sequence: state.next_sequence,
        cursor,
        kind,
    });
}

pub(crate) fn enforce_generation(
    expected: Option<Generation>,
    current: Option<Generation>,
) -> Result<(), StoreError> {
    let matches = match expected {
        None => true,
        Some(expected) if expected.get() == 0 => current.is_none(),
        Some(expected) => current == Some(expected),
    };
    if matches {
        Ok(())
    } else {
        Err(StoreError::GenerationConflict { current })
    }
}
