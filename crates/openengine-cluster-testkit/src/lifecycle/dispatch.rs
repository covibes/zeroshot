//! Per-turn dispatch lease lifecycle: acquire, verified/void/failed completion, and retry.

use openengine_cluster_protocol::{
    Cursor, DispatchState, NoRetryableFrontierReason, Phase, RetryResult, StopMode,
};
use openengine_cluster_server::admission::{CancellationSignal, StoreError};
use openengine_cluster_server::lifecycle::{
    CompletionResult, DispatchPermit, FailedCompletion, FailureRetryability, LeaseId,
    LifecycleEvent, MutationReceipt, RetryProposal, TurnId, VerifiedCompletion, VerifiedTurn,
    VoidTurn,
};

use crate::admission::{
    append, enforce_generation, ActiveLease, AppendKind, RetryableHistory, StoreState,
};

impl StoreState {
    pub(super) fn acquire_dispatch(
        &mut self,
        turn_id: TurnId,
    ) -> Result<DispatchPermit, StoreError> {
        let current = self
            .lifecycle
            .operational
            .as_ref()
            .map_or(DispatchState::Stopped, |status| status.dispatch_state);
        if self.control.phase != Phase::Running || current != DispatchState::Active {
            return Err(StoreError::DispatchDenied { current });
        }
        if self
            .lifecycle
            .pending_retry_turn
            .as_ref()
            .is_some_and(|pending| pending != &turn_id)
        {
            return Err(StoreError::SchemaViolation(
                "a pending retry intent must dispatch before another turn".into(),
            ));
        }
        if self.turn_was_dispatched(&turn_id) {
            return Err(StoreError::SchemaViolation(
                "turn id has already been dispatched".into(),
            ));
        }
        self.next_lease += 1;
        let lease_id = LeaseId::new(format!("lease-{}", self.next_lease));
        let cancellation = CancellationSignal::default();
        self.leases.insert(
            lease_id.clone(),
            ActiveLease {
                turn_id: turn_id.clone(),
                cancellation: cancellation.clone(),
            },
        );
        self.lifecycle
            .operational
            .as_mut()
            .expect("active lifecycle metadata exists")
            .in_flight = u32::try_from(self.leases.len())
            .map_err(|_| StoreError::Internal("in-flight count exceeds u32".into()))?;
        if self.lifecycle.pending_retry_turn.as_ref() == Some(&turn_id) {
            self.lifecycle.pending_retry_turn = None;
        } else {
            // A fresh error-successor dispatch wins the frontier CAS against manual retry.
            if self.lifecycle.pending_failed_frontier.take().is_some() {
                self.retryable_history = RetryableHistory::Consumed;
            }
        }
        let cursor = self.append_lifecycle(LifecycleEvent::Dispatched {
            turn_id: turn_id.clone(),
        });
        Ok(DispatchPermit {
            lease_id,
            turn_id,
            cancellation: cancellation.observer(),
            at_cursor: cursor,
        })
    }

    pub(super) fn fail_dispatch(
        &mut self,
        failure: FailedCompletion,
    ) -> Result<CompletionResult, StoreError> {
        let lease = self
            .leases
            .remove(&failure.lease_id)
            .ok_or(StoreError::UnknownLease)?;
        let cursor = self.append_lifecycle(LifecycleEvent::Failed {
            turn_id: lease.turn_id.clone(),
            kind: failure.kind,
            retryability: failure.retryability,
        });
        match failure.retryability {
            FailureRetryability::Retryable => {
                self.lifecycle.pending_failed_frontier = Some(lease.turn_id.clone());
            }
            FailureRetryability::AttemptsExhausted => {
                self.lifecycle.pending_failed_frontier = None;
                self.retryable_history = RetryableHistory::Exhausted;
            }
        }
        let remaining = u32::try_from(self.leases.len())
            .map_err(|_| StoreError::Internal("in-flight count exceeds u32".into()))?;
        let draining = {
            let operational = self
                .lifecycle
                .operational
                .as_mut()
                .ok_or_else(|| StoreError::Internal("lifecycle metadata is absent".into()))?;
            operational.in_flight = remaining;
            operational.dispatch_state == DispatchState::Draining
        };
        let terminalized = draining && remaining == 0;
        if terminalized {
            self.finish(StopMode::Drain);
        }
        Ok(CompletionResult {
            turn_id: lease.turn_id,
            at_cursor: cursor,
            terminalized,
        })
    }

    fn no_retryable_frontier_reason(&self) -> NoRetryableFrontierReason {
        if !self.leases.is_empty() {
            NoRetryableFrontierReason::Active
        } else {
            match self.retryable_history {
                RetryableHistory::Exhausted => NoRetryableFrontierReason::Exhausted,
                RetryableHistory::Success => NoRetryableFrontierReason::Success,
                RetryableHistory::Consumed => NoRetryableFrontierReason::Consumed,
            }
        }
    }

    pub(super) fn retry_lifecycle(
        &mut self,
        proposal: RetryProposal,
    ) -> Result<RetryResult, StoreError> {
        if let Some(receipt) = self.replay_retry(&proposal)? {
            return Ok(receipt);
        }
        enforce_generation(Some(proposal.params.if_generation), self.control.generation)?;
        if self.control.phase == Phase::Finished {
            return Err(StoreError::InvalidPhase {
                current: self.control.phase,
            });
        }
        let current = self
            .lifecycle
            .operational
            .as_ref()
            .map_or(DispatchState::Stopped, |status| status.dispatch_state);
        if current != DispatchState::Active {
            return Err(StoreError::DispatchDenied { current });
        }
        if !self.leases.is_empty() {
            return Err(StoreError::NoRetryableFrontier {
                reason: NoRetryableFrontierReason::Active,
            });
        }
        if self.lifecycle.pending_retry_turn.is_some() {
            return Err(StoreError::NoRetryableFrontier {
                reason: NoRetryableFrontierReason::Consumed,
            });
        }
        let Some(failed_turn_id) = self.lifecycle.pending_failed_frontier.clone() else {
            return Err(StoreError::NoRetryableFrontier {
                reason: self.no_retryable_frontier_reason(),
            });
        };
        let retry_turn_id = self.next_retry_turn_id();
        self.lifecycle.pending_failed_frontier = None;
        self.lifecycle.pending_retry_turn = Some(retry_turn_id.clone());
        self.retryable_history = RetryableHistory::Consumed;
        let cursor = self.append_lifecycle(LifecycleEvent::Retried {
            failed_turn_id: failed_turn_id.clone(),
            retry_turn_id: retry_turn_id.clone(),
        });
        let result = self.build_retry_result(failed_turn_id, retry_turn_id, cursor)?;
        self.record_mutation(
            proposal.params.idempotency_key,
            proposal.fingerprint,
            MutationReceipt::Retry(result.clone()),
        );
        Ok(result)
    }

    fn turn_was_dispatched(&self, turn_id: &TurnId) -> bool {
        self.lifecycle.records.iter().any(|record| {
            matches!(
                &record.event,
                LifecycleEvent::Dispatched {
                    turn_id: dispatched
                } if dispatched == turn_id
            )
        })
    }

    fn next_retry_turn_id(&mut self) -> TurnId {
        loop {
            self.next_retry_turn += 1;
            let candidate = TurnId::new(format!("retry-{}", self.next_retry_turn));
            if !self.turn_was_dispatched(&candidate)
                && self.lifecycle.pending_retry_turn.as_ref() != Some(&candidate)
            {
                return candidate;
            }
        }
    }

    fn replay_retry(&self, proposal: &RetryProposal) -> Result<Option<RetryResult>, StoreError> {
        let Some(receipt) =
            self.replay_mutation(&proposal.params.idempotency_key, &proposal.fingerprint)?
        else {
            return Ok(None);
        };
        let MutationReceipt::Retry(mut receipt) = receipt else {
            return Err(StoreError::IdempotencyReuse);
        };
        receipt.deduped = true;
        Ok(Some(receipt))
    }

    fn build_retry_result(
        &self,
        retried_turn_id: TurnId,
        retry_turn_id: TurnId,
        at_cursor: Cursor,
    ) -> Result<RetryResult, StoreError> {
        let (generation, run_id) = self.lifecycle_identity()?;
        Ok(RetryResult {
            generation,
            run_id,
            phase: self.control.phase,
            retried_turn_id: retried_turn_id.as_str().to_owned(),
            retry_turn_id: retry_turn_id.as_str().to_owned(),
            operational: self
                .lifecycle
                .operational
                .clone()
                .expect("active lifecycle metadata exists"),
            at_cursor,
            deduped: false,
        })
    }

    pub(super) fn complete_dispatch(
        &mut self,
        completion: VerifiedCompletion,
    ) -> Result<CompletionResult, StoreError> {
        if self.cancelled_leases.contains(&completion.lease_id)
            || self.control.phase == Phase::Finished
        {
            return Err(StoreError::CompletionRejected);
        }
        let lease = self
            .leases
            .get(&completion.lease_id)
            .ok_or(StoreError::UnknownLease)?;
        if lease.cancellation.is_cancelled() {
            self.record_cancelled_completion(&completion.lease_id)?;
            return Err(StoreError::CompletionRejected);
        }
        let lease = self
            .leases
            .remove(&completion.lease_id)
            .expect("dispatch lease was validated under the aggregate lock");
        let cursor = self.append_lifecycle(LifecycleEvent::Verified {
            turn_id: lease.turn_id.clone(),
        });
        self.lifecycle.verified_turns.push(VerifiedTurn {
            turn_id: lease.turn_id.clone(),
            output: completion.output,
            cursor: cursor.clone(),
        });
        self.retryable_history = RetryableHistory::Success;
        append(self, Some(cursor.clone()), AppendKind::VerifiedOutput);
        let remaining = u32::try_from(self.leases.len())
            .map_err(|_| StoreError::Internal("in-flight count exceeds u32".into()))?;
        let draining = {
            let operational = self
                .lifecycle
                .operational
                .as_mut()
                .ok_or_else(|| StoreError::Internal("lifecycle metadata is absent".into()))?;
            operational.in_flight = remaining;
            operational.dispatch_state == DispatchState::Draining
        };
        let terminalized = draining && remaining == 0;
        if terminalized {
            self.finish(StopMode::Drain);
        }
        Ok(CompletionResult {
            turn_id: lease.turn_id,
            at_cursor: self
                .lifecycle
                .latest_cursor
                .clone()
                .expect("completion allocates a cursor"),
            terminalized,
        })
    }

    fn record_cancelled_completion(&mut self, lease_id: &LeaseId) -> Result<(), StoreError> {
        let lease = self
            .leases
            .remove(lease_id)
            .expect("cancelled dispatch lease was validated under the aggregate lock");
        self.cancelled_leases.insert(lease_id.clone());
        let cursor = self.append_lifecycle(LifecycleEvent::Void {
            turn_id: lease.turn_id.clone(),
        });
        self.lifecycle.void_turns.push(VoidTurn {
            turn_id: lease.turn_id,
            cursor: cursor.clone(),
        });
        append(self, Some(cursor), AppendKind::Void);

        let remaining = u32::try_from(self.leases.len())
            .map_err(|_| StoreError::Internal("in-flight count exceeds u32".into()))?;
        let draining = {
            let operational = self
                .lifecycle
                .operational
                .as_mut()
                .ok_or_else(|| StoreError::Internal("lifecycle metadata is absent".into()))?;
            operational.in_flight = remaining;
            operational.dispatch_state == DispatchState::Draining
        };
        if draining && remaining == 0 {
            self.finish(StopMode::Drain);
        }
        Ok(())
    }
}
