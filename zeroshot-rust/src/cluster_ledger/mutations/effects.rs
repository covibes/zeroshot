use crate::fault::{EngineFault, FaultContext};

use super::super::record::{CanonicalDigest, EffectId, RecordPayload, RunSequence};
use super::super::store::IdempotencyId;
use super::super::{
    ClusterLedger, CommitRequest, LedgerError, LedgerErrorKind, MutationIdentity,
    ReceiptExpectation,
};
use super::{
    CommitResult, EffectIntentResult, EffectReconciliation, SafeFaultConsequence, SafeFaultRecord,
    SafeFaultResult,
};

struct SafeFaultPlan {
    run: RunSequence,
    execution: Option<super::super::ExecutionId>,
    consequence_payload: RecordPayload,
    response: SafeFaultResult,
}

impl ClusterLedger {
    fn safe_fault_plan(
        &self,
        state: &super::super::ReplayState,
        consequence: SafeFaultConsequence,
    ) -> Result<SafeFaultPlan, LedgerError> {
        let run = self.safe_fault_run(state, consequence)?;
        let (execution, terminal, outcome_digest, consequence_payload) = match consequence {
            SafeFaultConsequence::Settle {
                execution,
                outcome_digest,
            } if state.active_dispatches.contains_key(&execution) => (
                Some(execution),
                false,
                outcome_digest,
                RecordPayload::Settlement {
                    run,
                    execution,
                    outcome_digest,
                    accepted: true,
                },
            ),
            SafeFaultConsequence::Settle { .. } => {
                return Err(
                    self.domain_error(FaultContext::Settlement, LedgerErrorKind::InvalidSettlement)
                );
            }
            SafeFaultConsequence::Terminal { outcome_digest } => (
                None,
                true,
                outcome_digest,
                RecordPayload::Terminal {
                    run,
                    outcome_digest,
                },
            ),
        };
        Ok(SafeFaultPlan {
            run,
            execution,
            consequence_payload,
            response: SafeFaultResult {
                execution,
                terminal,
                outcome_digest,
            },
        })
    }

    fn safe_fault_run(
        &self,
        state: &super::super::ReplayState,
        consequence: SafeFaultConsequence,
    ) -> Result<RunSequence, LedgerError> {
        let run = state
            .admission
            .as_ref()
            .filter(|_| state.terminal_outcome.is_none())
            .ok_or_else(|| {
                self.domain_error(FaultContext::Settlement, LedgerErrorKind::InvalidLifecycle)
            })?
            .run;
        if matches!(consequence, SafeFaultConsequence::Terminal { .. })
            && state
                .effects
                .values()
                .any(|effect| effect.receipt_digest.is_none())
        {
            return Err(
                self.domain_error(FaultContext::Settlement, LedgerErrorKind::InvalidLifecycle)
            );
        }
        Ok(run)
    }

    #[allow(clippy::too_many_arguments, reason = "frozen pre-6.7.2 public API")]
    pub async fn record_safe_fault(
        &self,
        key: IdempotencyId,
        fingerprint: [u8; 32],
        fault: &EngineFault,
        consequence: SafeFaultConsequence,
    ) -> Result<CommitResult<SafeFaultResult>, LedgerError> {
        self.record_safe_fault_request(key, fingerprint, SafeFaultRecord::new(fault, consequence))
            .await
    }

    async fn record_safe_fault_request(
        &self,
        key: IdempotencyId,
        fingerprint: [u8; 32],
        record: SafeFaultRecord<'_>,
    ) -> Result<CommitResult<SafeFaultResult>, LedgerError> {
        let SafeFaultRecord { fault, consequence } = record;
        let state = self.validated_state(FaultContext::Settlement).await?;
        if let Some(receipt) = self.existing_receipt(
            &state,
            &key,
            ReceiptExpectation::new(FaultContext::Settlement, "safe_fault", fingerprint),
        )? {
            return Ok(receipt);
        }
        let plan = self.safe_fault_plan(&state, consequence)?;
        let encoded_fault = fault
            .encode_json()
            .map_err(|_| self.domain_error(FaultContext::Settlement, LedgerErrorKind::Encoding))?;
        self.commit(
            CommitRequest::new(
                FaultContext::Settlement,
                &state,
                MutationIdentity::new(key, "safe_fault", fingerprint),
                &plan.response,
            )
            .with_payloads(vec![
                RecordPayload::SafeFault {
                    run: plan.run,
                    execution: plan.execution,
                    encoded_fault,
                },
                plan.consequence_payload,
            ]),
        )
        .await
    }

    pub async fn record_effect_intent(
        &self,
        key: IdempotencyId,
        fingerprint: [u8; 32],
        request_digest: CanonicalDigest,
    ) -> Result<CommitResult<EffectIntentResult>, LedgerError> {
        let mut state = self.validated_state(FaultContext::Execution).await?;
        if let Some(receipt) = self.existing_receipt(
            &state,
            &key,
            ReceiptExpectation::new(FaultContext::Execution, "effect_intent", fingerprint),
        )? {
            return Ok(receipt);
        }
        let run = state
            .admission
            .as_ref()
            .ok_or_else(|| {
                self.domain_error(FaultContext::Execution, LedgerErrorKind::InvalidLifecycle)
            })?
            .run;
        if state.terminal_outcome.is_some() {
            return Err(
                self.domain_error(FaultContext::Execution, LedgerErrorKind::InvalidLifecycle)
            );
        }
        let effect = state.identities.allocate_effect().map_err(|_| {
            self.domain_error(FaultContext::Execution, LedgerErrorKind::BoundViolation)
        })?;
        let response = EffectIntentResult { effect };
        self.commit(
            CommitRequest::new(
                FaultContext::Execution,
                &state,
                MutationIdentity::new(key, "effect_intent", fingerprint),
                &response,
            )
            .with_payloads(vec![RecordPayload::EffectIntent {
                run,
                effect,
                request_digest,
            }]),
        )
        .await
    }

    #[allow(clippy::too_many_arguments, reason = "frozen pre-6.7.2 public API")]
    pub async fn reconcile_effect(
        &self,
        key: IdempotencyId,
        fingerprint: [u8; 32],
        effect: EffectId,
        receipt_digest: CanonicalDigest,
    ) -> Result<CommitResult<EffectIntentResult>, LedgerError> {
        self.reconcile_effect_request(
            key,
            fingerprint,
            EffectReconciliation::new(effect, receipt_digest),
        )
        .await
    }

    async fn reconcile_effect_request(
        &self,
        key: IdempotencyId,
        fingerprint: [u8; 32],
        request: EffectReconciliation,
    ) -> Result<CommitResult<EffectIntentResult>, LedgerError> {
        let EffectReconciliation {
            effect,
            receipt_digest,
        } = request;
        let state = self.validated_state(FaultContext::Settlement).await?;
        if let Some(receipt) = self.existing_receipt(
            &state,
            &key,
            ReceiptExpectation::new(FaultContext::Settlement, "effect_receipt", fingerprint),
        )? {
            return Ok(receipt);
        }
        let run = state
            .admission
            .as_ref()
            .ok_or_else(|| {
                self.domain_error(FaultContext::Settlement, LedgerErrorKind::InvalidLifecycle)
            })?
            .run;
        if state.terminal_outcome.is_some()
            || state
                .effects
                .get(&effect)
                .is_none_or(|intent| intent.receipt_digest.is_some())
        {
            return Err(
                self.domain_error(FaultContext::Settlement, LedgerErrorKind::InvalidLifecycle)
            );
        }
        let response = EffectIntentResult { effect };
        self.commit(
            CommitRequest::new(
                FaultContext::Settlement,
                &state,
                MutationIdentity::new(key, "effect_receipt", fingerprint),
                &response,
            )
            .with_payloads(vec![RecordPayload::EffectReceipt {
                run,
                effect,
                receipt_digest,
            }]),
        )
        .await
    }

    pub async fn terminalize(
        &self,
        key: IdempotencyId,
        fingerprint: [u8; 32],
        outcome_digest: CanonicalDigest,
    ) -> Result<CommitResult<CanonicalDigest>, LedgerError> {
        let state = self.validated_state(FaultContext::Settlement).await?;
        if let Some(receipt) = self.existing_receipt(
            &state,
            &key,
            ReceiptExpectation::new(FaultContext::Settlement, "terminal", fingerprint),
        )? {
            return Ok(receipt);
        }
        let run = state
            .admission
            .as_ref()
            .ok_or_else(|| {
                self.domain_error(FaultContext::Settlement, LedgerErrorKind::InvalidLifecycle)
            })?
            .run;
        if state.terminal_outcome.is_some()
            || state
                .effects
                .values()
                .any(|effect| effect.receipt_digest.is_none())
        {
            return Err(
                self.domain_error(FaultContext::Settlement, LedgerErrorKind::InvalidLifecycle)
            );
        }
        self.commit(
            CommitRequest::new(
                FaultContext::Settlement,
                &state,
                MutationIdentity::new(key, "terminal", fingerprint),
                &outcome_digest,
            )
            .with_payloads(vec![RecordPayload::Terminal {
                run,
                outcome_digest,
            }]),
        )
        .await
    }

    pub async fn record_cleanup_receipt(
        &self,
        key: IdempotencyId,
        fingerprint: [u8; 32],
        cleanup_digest: CanonicalDigest,
    ) -> Result<CommitResult<CanonicalDigest>, LedgerError> {
        let state = self.validated_state(FaultContext::Cleanup).await?;
        if let Some(receipt) = self.existing_receipt(
            &state,
            &key,
            ReceiptExpectation::new(FaultContext::Cleanup, "cleanup_receipt", fingerprint),
        )? {
            return Ok(receipt);
        }
        if state.terminal_outcome.is_none() {
            return Err(self.domain_error(FaultContext::Cleanup, LedgerErrorKind::TerminalRequired));
        }
        self.commit(
            CommitRequest::new(
                FaultContext::Cleanup,
                &state,
                MutationIdentity::new(key, "cleanup_receipt", fingerprint),
                &cleanup_digest,
            )
            .with_payloads(vec![RecordPayload::CleanupReceipt { cleanup_digest }]),
        )
        .await
    }
}
