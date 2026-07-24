//! Terminal-run resubmission: mints a new run at the same admitted generation.

use openengine_cluster_protocol::{Phase, ResubmitResult, RunId};
use openengine_cluster_server::admission::{
    CancellationSignal, IdempotencyRecord, ResubmitProposal, StoreError,
};
use openengine_cluster_server::lifecycle::MutationReceipt;

use super::{append, enforce_generation, AppendKind, StoreState};

impl StoreState {
    fn replay_resubmit(
        &self,
        proposal: &ResubmitProposal,
    ) -> Result<Option<ResubmitResult>, StoreError> {
        let Some(existing) = self
            .idempotency_records
            .get(&proposal.params.idempotency_key)
        else {
            return Ok(None);
        };
        if existing.fingerprint != proposal.fingerprint {
            return Err(StoreError::IdempotencyReuse);
        }
        let MutationReceipt::Resubmit(mut receipt) = existing.receipt.clone() else {
            return Err(StoreError::IdempotencyReuse);
        };
        receipt.deduped = true;
        Ok(Some(receipt))
    }

    pub(super) fn resubmit(
        &mut self,
        proposal: ResubmitProposal,
        cancellation: &CancellationSignal,
    ) -> Result<ResubmitResult, StoreError> {
        if let Some(receipt) = self.replay_resubmit(&proposal)? {
            return Ok(receipt);
        }
        enforce_generation(Some(proposal.params.if_generation), self.control.generation)?;
        let current_run_id = self.control.run_id.clone();
        if current_run_id.as_ref() != Some(&proposal.params.if_run_id) {
            return Err(StoreError::RunConflict {
                current: current_run_id,
            });
        }
        if !self.control.phase.is_terminal() {
            return Err(StoreError::InvalidPhase {
                current: self.control.phase,
            });
        }
        let prior_run_id = current_run_id.expect("terminal phase implies an admitted run");
        let input = self.resubmit_input(&proposal, &prior_run_id)?;
        if cancellation.is_cancelled() {
            return Err(StoreError::Cancelled);
        }
        let generation = self
            .control
            .generation
            .expect("terminal phase implies a generation");
        self.next_run += 1;
        let run_id = RunId::new(format!("run-{}", self.next_run));
        let at_cursor = self.install_run(run_id.clone(), generation, input);
        let operational = self
            .lifecycle
            .operational
            .clone()
            .expect("install_run sets lifecycle operational");
        let result = ResubmitResult {
            generation,
            prior_run_id,
            run_id,
            phase: Phase::Running,
            operational,
            at_cursor,
            deduped: false,
        };
        self.idempotency_records.insert(
            proposal.params.idempotency_key,
            IdempotencyRecord {
                fingerprint: proposal.fingerprint,
                receipt: MutationReceipt::Resubmit(result.clone()),
            },
        );
        append(self, self.control.cursor.clone(), AppendKind::Idempotency);
        Ok(result)
    }

    fn resubmit_input(
        &self,
        proposal: &ResubmitProposal,
        prior_run_id: &RunId,
    ) -> Result<serde_json::Value, StoreError> {
        match &proposal.params.replacement_input {
            Some(replacement) => {
                let spec = self
                    .control
                    .spec
                    .as_ref()
                    .expect("terminal phase implies an admitted graph");
                spec.initial_input
                    .validate_value(replacement)
                    .map_err(|error| StoreError::SchemaViolation(error.to_string()))?;
                Ok(replacement.clone())
            }
            None => self
                .seed_ledger
                .iter()
                .rev()
                .find(|seed| seed.run_id == *prior_run_id)
                .map(|seed| seed.input.clone())
                .ok_or_else(|| StoreError::Internal("terminal run has no verified seed".into())),
        }
    }
}
