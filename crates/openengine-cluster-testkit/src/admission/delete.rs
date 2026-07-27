//! Authoritative terminal-cluster deletion with an exclusive cleanup fence.

use openengine_cluster_protocol::{DeleteResult, Phase, RunId};
use openengine_cluster_server::admission::{
    CancellationSignal, DeleteProposal, IdempotencyRecord, StoreError,
};
use openengine_cluster_server::lifecycle::MutationReceipt;

use super::{append, enforce_generation, AppendKind, StoreState};

impl StoreState {
    fn replay_delete(&self, proposal: &DeleteProposal) -> Result<Option<DeleteResult>, StoreError> {
        let Some(existing) = self
            .idempotency_records
            .get(&proposal.params.idempotency_key)
        else {
            return Ok(None);
        };
        if existing.fingerprint != proposal.fingerprint {
            return Err(StoreError::IdempotencyReuse);
        }
        let MutationReceipt::Delete(mut receipt) = existing.receipt.clone() else {
            return Err(StoreError::IdempotencyReuse);
        };
        receipt.deduped = true;
        Ok(Some(receipt))
    }

    /// Terminal-run deletion with an exclusive cleanup fence. An empty cluster is a history-free
    /// no-op; a terminal run either finalizes immediately (no pending cleanup armed) or flips
    /// `control.phase` to `Deleting` to fence apply/resubmit/dispatch/competing delete until the
    /// (test-only, simulated) backend cleanup executor resolves it via `resolve_pending_deletion`.
    pub(super) fn delete(
        &mut self,
        proposal: DeleteProposal,
        cancellation: &CancellationSignal,
    ) -> Result<DeleteResult, StoreError> {
        if let Some(receipt) = self.replay_delete(&proposal)? {
            return Ok(receipt);
        }
        enforce_generation(Some(proposal.params.if_generation), self.control.generation)?;
        enforce_run_id(
            proposal.params.if_run_id.as_ref(),
            self.control.run_id.as_ref(),
        )?;
        if !matches!(self.control.phase, Phase::Empty | Phase::Finished) {
            return Err(StoreError::InvalidPhase {
                current: self.control.phase,
            });
        }
        if cancellation.is_cancelled() {
            return Err(StoreError::Cancelled);
        }
        let result = self.resolve_delete_outcome();
        self.record_delete_receipt(proposal, result.clone());
        Ok(result)
    }

    fn resolve_delete_outcome(&mut self) -> DeleteResult {
        match self.control.phase {
            Phase::Empty => DeleteResult {
                deleted: false,
                phase: Phase::Empty,
                generation: None,
                run_id: None,
                at_cursor: None,
                deduped: false,
            },
            Phase::Finished if self.pending_cleanup => {
                let generation = self.control.generation;
                let run_id = self.control.run_id.clone();
                self.control.phase = Phase::Deleting;
                DeleteResult {
                    deleted: false,
                    phase: Phase::Deleting,
                    generation,
                    run_id,
                    at_cursor: self.lifecycle.latest_cursor.clone(),
                    deduped: false,
                }
            }
            Phase::Finished => self.finalize_delete(),
            _ => unreachable!("phase gate above admits only Empty or Finished"),
        }
    }

    fn record_delete_receipt(&mut self, proposal: DeleteProposal, result: DeleteResult) {
        let append_cursor = result.at_cursor.clone();
        self.idempotency_records.insert(
            proposal.params.idempotency_key,
            IdempotencyRecord {
                fingerprint: proposal.fingerprint,
                receipt: MutationReceipt::Delete(result),
            },
        );
        append(self, append_cursor, AppendKind::Idempotency);
    }
}

fn enforce_run_id(expected: Option<&RunId>, current: Option<&RunId>) -> Result<(), StoreError> {
    if expected == current {
        Ok(())
    } else {
        Err(StoreError::RunConflict {
            current: current.cloned(),
        })
    }
}
