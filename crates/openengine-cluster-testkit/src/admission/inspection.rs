//! Deterministic store inspection and corruption controls for conformance tests.

use std::collections::BTreeMap;

use openengine_cluster_protocol::{IdempotencyKey, OperationalStatus};
use openengine_cluster_server::admission::{
    AdmissionSnapshot, IdempotencyRecord, StoreError, VerifiedSeed,
};
use openengine_cluster_server::lifecycle::{
    CompletionResult, DispatchPermit, FailedCompletion, LeaseId, LifecycleSnapshot, LifecycleStore,
    TurnId, VerifiedCompletion,
};

use super::{AppendReceipt, ControlReceipt, ControlSnapshot, InMemoryAdmissionStore};

#[derive(Clone, Debug, Default, PartialEq)]
pub struct StoreInspection {
    pub control: ControlSnapshot,
    pub control_journal: Vec<ControlReceipt>,
    pub seed_ledger: Vec<VerifiedSeed>,
    pub idempotency_records: BTreeMap<IdempotencyKey, IdempotencyRecord>,
    pub append_order: Vec<AppendReceipt>,
    pub lifecycle: LifecycleSnapshot,
    pub active_turns: Vec<TurnId>,
}

impl StoreInspection {
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.control == ControlSnapshot::default()
            && self.control_journal.is_empty()
            && self.seed_ledger.is_empty()
            && self.idempotency_records.is_empty()
            && self.append_order.is_empty()
            && self.lifecycle == LifecycleSnapshot::default()
            && self.active_turns.is_empty()
    }
}

impl InMemoryAdmissionStore {
    pub async fn inspect(&self) -> StoreInspection {
        let state = self.state.lock().await;
        StoreInspection {
            control: state.control.clone(),
            control_journal: state.control_journal.clone(),
            seed_ledger: state.seed_ledger.clone(),
            idempotency_records: state.idempotency_records.clone(),
            append_order: state.append_order.clone(),
            lifecycle: state.lifecycle.clone(),
            active_turns: state
                .leases
                .values()
                .map(|lease| lease.turn_id.clone())
                .collect(),
        }
    }

    pub async fn acquire_dispatch(&self, turn_id: TurnId) -> Result<DispatchPermit, StoreError> {
        <Self as LifecycleStore>::acquire_dispatch(self, turn_id).await
    }

    pub async fn complete_dispatch(
        &self,
        completion: VerifiedCompletion,
    ) -> Result<CompletionResult, StoreError> {
        <Self as LifecycleStore>::complete_dispatch(self, completion).await
    }

    pub async fn fail_dispatch(
        &self,
        failure: FailedCompletion,
    ) -> Result<CompletionResult, StoreError> {
        <Self as LifecycleStore>::fail_dispatch(self, failure).await
    }

    /// Signals a store-owned lease cancellation without settling it.
    /// This exists only to prove rejected completions preserve aggregate invariants.
    pub async fn cancel_dispatch_for_test(&self, lease_id: &LeaseId) -> bool {
        let state = self.state.lock().await;
        state.leases.get(lease_id).is_some_and(|lease| {
            lease.cancellation.cancel();
            true
        })
    }

    /// Corrupts this test fixture by removing the active run's verified seed.
    /// This exists only to prove that authoritative reads reject torn logical stores.
    pub async fn remove_active_seed_for_test(&self) {
        let mut state = self.state.lock().await;
        let active_run_id = state.control.run_id.clone();
        state
            .seed_ledger
            .retain(|seed| Some(&seed.run_id) != active_run_id.as_ref());
    }

    /// Replaces the logical aggregate snapshot in this test fixture.
    /// This exists only to prove that authoritative reads reject malformed durable state.
    pub async fn replace_snapshot_for_test(&self, snapshot: AdmissionSnapshot) {
        let mut state = self.state.lock().await;
        state.control = snapshot.control;
        state.seed_ledger = snapshot.seed.into_iter().collect();
        state.lifecycle = if state.control.spec.is_none() {
            LifecycleSnapshot::default()
        } else {
            LifecycleSnapshot {
                operational: Some(OperationalStatus::default()),
                latest_cursor: state.control.cursor.clone(),
                records: Vec::new(),
                verified_turns: Vec::new(),
                void_turns: Vec::new(),
                pending_failed_frontier: None,
                pending_retry_turn: None,
            }
        };
    }

    /// Replaces only operational durable state to prove authoritative fold validation.
    pub async fn replace_lifecycle_snapshot_for_test(&self, snapshot: LifecycleSnapshot) {
        self.state.lock().await.lifecycle = snapshot;
    }
}
