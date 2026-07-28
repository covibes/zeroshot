//! Scripted lifecycle fixture helpers.

use async_trait::async_trait;
use openengine_cluster_protocol::{
    Cursor, DispatchState, Generation, IdempotencyKey, Phase, RetryResult, RunId, StopMode,
    StopResult, UpdateResult,
};
use openengine_cluster_server::admission::{IdempotencyRecord, StoreError};
use openengine_cluster_server::lifecycle::{
    CompletionResult, DispatchPermit, FailedCompletion, LifecycleEvent, LifecycleRecord,
    LifecycleSnapshot, LifecycleStore, MutationReceipt, RetryProposal, StopProposal, TurnId,
    UpdateProposal, VerifiedCompletion, VoidTurn,
};
use crate::admission::{append, enforce_generation, AppendKind, InMemoryAdmissionStore, StoreState};

mod dispatch;
mod params;
pub use params::{delete, fail, fail_exhausted, resubmit, resume, retry, stop, suspend};

fn dispatch_state_for_suspension(suspended: bool) -> DispatchState {
    if suspended {
        DispatchState::Suspended
    } else {
        DispatchState::Active
    }
}

fn dispatch_state_for_stop(mode: StopMode) -> DispatchState {
    match mode {
        StopMode::Drain => DispatchState::Draining,
        StopMode::Force => DispatchState::ForceStopping,
    }
}

impl StoreState {
    fn replay_mutation(
        &self,
        key: &IdempotencyKey,
        fingerprint: &openengine_cluster_protocol::RequestFingerprint,
    ) -> Result<Option<MutationReceipt>, StoreError> {
        let Some(existing) = self.idempotency_records.get(key) else {
            return Ok(None);
        };
        if existing.fingerprint != *fingerprint {
            return Err(StoreError::IdempotencyReuse);
        }
        Ok(Some(existing.receipt.clone()))
    }

    fn record_mutation(
        &mut self,
        key: IdempotencyKey,
        fingerprint: openengine_cluster_protocol::RequestFingerprint,
        receipt: MutationReceipt,
    ) {
        self.idempotency_records.insert(
            key,
            IdempotencyRecord {
                fingerprint,
                receipt,
            },
        );
        append(
            self,
            self.lifecycle
                .latest_cursor
                .clone()
                .or_else(|| self.control.cursor.clone()),
            AppendKind::Idempotency,
        );
    }

    fn lifecycle_identity(&self) -> Result<(Generation, RunId), StoreError> {
        match (self.control.generation, self.control.run_id.clone()) {
            (Some(generation), Some(run_id)) => Ok((generation, run_id)),
            _ => Err(StoreError::InvalidPhase {
                current: self.control.phase,
            }),
        }
    }

    pub(crate) fn allocate_cursor(&mut self) -> Cursor {
        self.next_cursor += 1;
        Cursor::new(format!("cursor-{}", self.next_cursor))
    }

    /// Appends an operational lifecycle mutation and projects it to the durable public watch
    /// algebra at the exact same cursor, per the closed `LifecycleEvent` -> `WatchEvent` mapping
    /// in `crate::watch`: no event site allocates a second cursor for one logical mutation.
    fn append_lifecycle(&mut self, event: LifecycleEvent) -> Cursor {
        let cursor = self.allocate_cursor();
        self.lifecycle.records.push(LifecycleRecord {
            cursor: cursor.clone(),
            event: event.clone(),
        });
        self.lifecycle.latest_cursor = Some(cursor.clone());
        append(self, Some(cursor.clone()), AppendKind::Lifecycle);
        if let Some(run_id) = self.control.run_id.clone() {
            let status = self.control.status_with_lifecycle(&self.lifecycle);
            let watch_event = crate::watch::watch_event_for_lifecycle(&event, status);
            self.record_public_event(&run_id, cursor.clone(), watch_event);
        }
        cursor
    }

    fn update_lifecycle(&mut self, proposal: UpdateProposal) -> Result<UpdateResult, StoreError> {
        proposal
            .params
            .validate()
            .map_err(|message| StoreError::SchemaViolation(message.into()))?;
        if let Some(receipt) = self.replay_update(&proposal)? {
            return Ok(receipt);
        }
        enforce_generation(Some(proposal.params.if_generation), self.control.generation)?;
        self.ensure_update_phase()?;
        self.apply_update_fields(&proposal.params)?;
        let cursor = self.append_lifecycle(LifecycleEvent::Updated {
            labels: proposal.params.labels.clone(),
            log_level: proposal.params.log_level,
            suspended: proposal.params.suspended,
        });
        let result = self.build_update_result(cursor)?;
        self.record_mutation(
            proposal.params.idempotency_key,
            proposal.fingerprint,
            MutationReceipt::Update(result.clone()),
        );
        Ok(result)
    }

    fn replay_update(&self, proposal: &UpdateProposal) -> Result<Option<UpdateResult>, StoreError> {
        let Some(receipt) =
            self.replay_mutation(&proposal.params.idempotency_key, &proposal.fingerprint)?
        else {
            return Ok(None);
        };
        let MutationReceipt::Update(mut receipt) = receipt else {
            return Err(StoreError::IdempotencyReuse);
        };
        receipt.deduped = true;
        Ok(Some(receipt))
    }

    fn ensure_update_phase(&self) -> Result<(), StoreError> {
        let current = self
            .lifecycle
            .dispatch_state()
            .ok_or_else(|| StoreError::Internal("running lifecycle metadata is absent".into()))?;
        if self.control.phase == Phase::Running
            && matches!(current, DispatchState::Active | DispatchState::Suspended)
        {
            Ok(())
        } else {
            Err(StoreError::InvalidPhase {
                current: self.control.phase,
            })
        }
    }

    fn apply_update_fields(
        &mut self,
        params: &openengine_cluster_protocol::UpdateParams,
    ) -> Result<(), StoreError> {
        let operational = self
            .lifecycle
            .operational
            .as_mut()
            .expect("running lifecycle metadata checked before update");
        if let Some(labels) = params.labels.clone() {
            operational.labels = labels;
        }
        if let Some(log_level) = params.log_level {
            operational.log_level = log_level;
        }
        if let Some(suspended) = params.suspended {
            operational.dispatch_state = dispatch_state_for_suspension(suspended);
        }
        operational.in_flight = u32::try_from(self.leases.len())
            .map_err(|_| StoreError::Internal("in-flight count exceeds u32".into()))?;
        Ok(())
    }

    fn build_update_result(&self, at_cursor: Cursor) -> Result<UpdateResult, StoreError> {
        let (generation, run_id) = self.lifecycle_identity()?;
        Ok(UpdateResult {
            generation,
            run_id,
            phase: self.control.phase,
            operational: self
                .lifecycle
                .operational
                .clone()
                .expect("running lifecycle metadata exists"),
            at_cursor,
            deduped: false,
        })
    }

    fn stop_lifecycle(&mut self, proposal: StopProposal) -> Result<StopResult, StoreError> {
        if let Some(receipt) = self.replay_stop(&proposal)? {
            return Ok(receipt);
        }
        enforce_generation(Some(proposal.params.if_generation), self.control.generation)?;
        let accepted_mode = proposal.params.mode;
        let effective_mode = self.effective_stop_mode(accepted_mode)?;
        self.begin_stop(accepted_mode, effective_mode);
        self.settle_stop(effective_mode);
        let result = self.build_stop_result(accepted_mode, effective_mode)?;
        self.record_mutation(
            proposal.params.idempotency_key,
            proposal.fingerprint,
            MutationReceipt::Stop(result.clone()),
        );
        Ok(result)
    }

    fn replay_stop(&self, proposal: &StopProposal) -> Result<Option<StopResult>, StoreError> {
        let Some(receipt) =
            self.replay_mutation(&proposal.params.idempotency_key, &proposal.fingerprint)?
        else {
            return Ok(None);
        };
        let MutationReceipt::Stop(mut receipt) = receipt else {
            return Err(StoreError::IdempotencyReuse);
        };
        receipt.deduped = true;
        Ok(Some(receipt))
    }

    fn effective_stop_mode(&self, accepted: StopMode) -> Result<StopMode, StoreError> {
        if self.control.phase != Phase::Running {
            return Err(StoreError::InvalidPhase {
                current: self.control.phase,
            });
        }
        let current = self
            .lifecycle
            .dispatch_state()
            .ok_or_else(|| StoreError::Internal("running lifecycle metadata is absent".into()))?;
        match (current, accepted) {
            (DispatchState::Active | DispatchState::Suspended, mode) => Ok(mode),
            (DispatchState::Draining, StopMode::Force) => Ok(StopMode::Force),
            (DispatchState::Draining, StopMode::Drain) => Ok(StopMode::Drain),
            _ => Err(StoreError::InvalidPhase {
                current: self.control.phase,
            }),
        }
    }

    fn begin_stop(&mut self, accepted_mode: StopMode, effective_mode: StopMode) {
        let operational = self
            .lifecycle
            .operational
            .as_mut()
            .expect("running lifecycle metadata checked before stop");
        operational.stop_mode = Some(effective_mode);
        operational.dispatch_state = dispatch_state_for_stop(effective_mode);
        self.append_lifecycle(LifecycleEvent::StopRequested {
            accepted_mode,
            effective_mode,
        });
    }

    fn settle_stop(&mut self, mode: StopMode) {
        match mode {
            StopMode::Drain if self.leases.is_empty() => self.finish(StopMode::Drain),
            StopMode::Drain => {}
            StopMode::Force => self.force_void_leases(),
        }
    }

    fn force_void_leases(&mut self) {
        for (lease_id, lease) in std::mem::take(&mut self.leases) {
            lease.cancellation.cancel();
            self.cancelled_leases.insert(lease_id);
            let cursor = self.append_lifecycle(LifecycleEvent::Void {
                turn_id: lease.turn_id.clone(),
            });
            self.lifecycle.void_turns.push(VoidTurn {
                turn_id: lease.turn_id,
                cursor: cursor.clone(),
            });
            append(self, Some(cursor), AppendKind::Void);
        }
        self.finish(StopMode::Force);
    }

    fn build_stop_result(
        &self,
        accepted_mode: StopMode,
        effective_mode: StopMode,
    ) -> Result<StopResult, StoreError> {
        let (generation, run_id) = self.lifecycle_identity()?;
        Ok(StopResult {
            generation,
            run_id,
            phase: self.control.phase,
            accepted_mode,
            effective_mode,
            operational: self
                .lifecycle
                .operational
                .clone()
                .expect("lifecycle metadata exists"),
            at_cursor: self
                .lifecycle
                .latest_cursor
                .clone()
                .expect("admitted lifecycle has a cursor"),
            deduped: false,
        })
    }

    fn finish(&mut self, mode: StopMode) {
        if self.control.phase == Phase::Finished {
            return;
        }
        {
            let operational = self
                .lifecycle
                .operational
                .as_mut()
                .expect("admitted lifecycle metadata exists");
            operational.dispatch_state = DispatchState::Stopped;
            operational.stop_mode = Some(mode);
            operational.in_flight = 0;
        }
        self.control.phase = Phase::Finished;
        self.append_lifecycle(LifecycleEvent::Finished { mode });
        self.lifecycle.pending_failed_frontier = None;
        self.lifecycle.pending_retry_turn = None;
    }
}

#[async_trait]
impl LifecycleStore for InMemoryAdmissionStore {
    async fn read_lifecycle_snapshot(&self) -> Result<LifecycleSnapshot, StoreError> {
        Ok(self.state.lock().await.lifecycle.clone())
    }

    async fn update_lifecycle(&self, proposal: UpdateProposal) -> Result<UpdateResult, StoreError> {
        self.state.lock().await.update_lifecycle(proposal)
    }

    async fn stop_lifecycle(&self, proposal: StopProposal) -> Result<StopResult, StoreError> {
        self.state.lock().await.stop_lifecycle(proposal)
    }

    async fn acquire_dispatch(&self, turn_id: TurnId) -> Result<DispatchPermit, StoreError> {
        self.state.lock().await.acquire_dispatch(turn_id)
    }

    async fn complete_dispatch(
        &self,
        completion: VerifiedCompletion,
    ) -> Result<CompletionResult, StoreError> {
        self.state.lock().await.complete_dispatch(completion)
    }

    async fn fail_dispatch(
        &self,
        failure: FailedCompletion,
    ) -> Result<CompletionResult, StoreError> {
        self.state.lock().await.fail_dispatch(failure)
    }

    async fn retry_lifecycle(&self, proposal: RetryProposal) -> Result<RetryResult, StoreError> {
        self.state.lock().await.retry_lifecycle(proposal)
    }
}
