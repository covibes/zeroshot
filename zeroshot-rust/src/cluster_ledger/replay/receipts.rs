use serde::de::DeserializeOwned;
use serde::Serialize;

use super::super::record::{CanonicalDigest, GenerationId, RecordPayload, RunSequence};
use super::super::store::MutationReceipt;
use super::{ReplayError, ReplayState};

fn decode_receipt_response<T>(receipt: &MutationReceipt) -> Result<T, ReplayError>
where
    T: DeserializeOwned + Serialize,
{
    let decoded =
        serde_json::from_slice(&receipt.response).map_err(|_| ReplayError::ReceiptCorrupt)?;
    let canonical = serde_json::to_vec(&decoded).map_err(|_| ReplayError::ReceiptCorrupt)?;
    if canonical != receipt.response {
        return Err(ReplayError::ReceiptCorrupt);
    }
    Ok(decoded)
}

pub(super) fn validate_receipt_binding(
    receipt: &MutationReceipt,
    state: &ReplayState,
    records: &[RecordPayload],
) -> Result<(), ReplayError> {
    let validator = receipt_validator(receipt.method.as_str())?;
    validator(receipt, state, records)
}

type ReceiptValidator =
    fn(&MutationReceipt, &ReplayState, &[RecordPayload]) -> Result<(), ReplayError>;

fn receipt_validator(method: &str) -> Result<ReceiptValidator, ReplayError> {
    match method {
        "admit" => Ok(validate_admission_receipt),
        "dispatch" => Ok(validate_dispatch_receipt),
        "settle" => Ok(validate_settlement_receipt),
        "safe_fault" => Ok(validate_safe_fault_receipt),
        "effect_intent" | "effect_receipt" => Ok(validate_effect_receipt),
        "terminal" => Ok(validate_terminal_receipt),
        "cleanup_receipt" => Ok(validate_cleanup_receipt),
        "protocol_apply" => Ok(validate_protocol_apply_receipt),
        _ => Err(ReplayError::ReceiptCorrupt),
    }
}

fn validate_admission_receipt(
    receipt: &MutationReceipt,
    _state: &ReplayState,
    records: &[RecordPayload],
) -> Result<(), ReplayError> {
    let response =
        decode_receipt_response::<super::super::mutations::AdmissionAllocation>(receipt)?;
    match records {
        [
            RecordPayload::Admission {
                generation, run, ..
            },
            RecordPayload::VerifiedInput {
                run: verified_run, ..
            },
        ] if response.generation == *generation && response.run == *run && verified_run == run => {
            Ok(())
        }
        _ => Err(ReplayError::ReceiptCorrupt),
    }
}

fn validate_dispatch_receipt(
    receipt: &MutationReceipt,
    _state: &ReplayState,
    records: &[RecordPayload],
) -> Result<(), ReplayError> {
    let response = decode_receipt_response::<super::super::mutations::DispatchAllocation>(receipt)?;
    match records {
        [
            RecordPayload::Dispatch {
                run,
                node_instance,
                execution,
            },
        ] if response.run == *run
            && response.node_instance == *node_instance
            && response.execution == *execution =>
        {
            Ok(())
        }
        _ => Err(ReplayError::ReceiptCorrupt),
    }
}

fn validate_settlement_receipt(
    receipt: &MutationReceipt,
    state: &ReplayState,
    records: &[RecordPayload],
) -> Result<(), ReplayError> {
    let response = decode_receipt_response::<super::super::mutations::SettlementResult>(receipt)?;
    let Some(RecordPayload::Settlement {
        run,
        execution,
        outcome_digest,
        accepted,
    }) = records.first()
    else {
        return Err(ReplayError::ReceiptCorrupt);
    };
    let binding = SettlementBinding {
        run: *run,
        execution: *execution,
        outcome_digest: *outcome_digest,
        accepted: *accepted,
    };
    let output_matches = validate_verified_output(records, binding);
    let authoritative_digest = authoritative_digest(state, binding)?;
    (response.execution == *execution
        && response.accepted == *accepted
        && response.authoritative_digest == authoritative_digest
        && output_matches)
        .then_some(())
        .ok_or(ReplayError::ReceiptCorrupt)
}

#[derive(Clone, Copy)]
struct SettlementBinding {
    run: RunSequence,
    execution: super::super::ExecutionId,
    outcome_digest: CanonicalDigest,
    accepted: bool,
}

fn validate_verified_output(records: &[RecordPayload], binding: SettlementBinding) -> bool {
    match &records[1..] {
        [] => true,
        [
            RecordPayload::VerifiedOutput {
                run: output_run,
                execution: output_execution,
                digest,
                ..
            },
        ] => {
            binding.accepted
                && *output_run == binding.run
                && *output_execution == binding.execution
                && *digest == binding.outcome_digest
        }
        _ => false,
    }
}

fn authoritative_digest(
    state: &ReplayState,
    binding: SettlementBinding,
) -> Result<CanonicalDigest, ReplayError> {
    if binding.accepted {
        Ok(binding.outcome_digest)
    } else {
        state
            .settlements
            .get(&binding.execution)
            .copied()
            .ok_or(ReplayError::ReceiptCorrupt)
    }
}

fn validate_safe_fault_receipt(
    receipt: &MutationReceipt,
    _state: &ReplayState,
    records: &[RecordPayload],
) -> Result<(), ReplayError> {
    let response = decode_receipt_response::<super::super::mutations::SafeFaultResult>(receipt)?;
    let valid = match records {
        [
            RecordPayload::SafeFault {
                run,
                execution: Some(fault_execution),
                ..
            },
            RecordPayload::Settlement {
                run: settlement_run,
                execution,
                outcome_digest,
                accepted: true,
            },
        ] => validate_fault_settlement(
            &response,
            FaultSettlement {
                run: *run,
                settlement_run: *settlement_run,
                fault_execution: *fault_execution,
                execution: *execution,
                outcome_digest: *outcome_digest,
            },
        ),
        [
            RecordPayload::SafeFault {
                run,
                execution: None,
                ..
            },
            RecordPayload::Terminal {
                run: terminal_run,
                outcome_digest,
            },
        ] => {
            run == terminal_run
                && response.execution.is_none()
                && response.terminal
                && response.outcome_digest == *outcome_digest
        }
        _ => false,
    };
    valid.then_some(()).ok_or(ReplayError::ReceiptCorrupt)
}

struct FaultSettlement {
    run: RunSequence,
    settlement_run: RunSequence,
    fault_execution: super::super::ExecutionId,
    execution: super::super::ExecutionId,
    outcome_digest: CanonicalDigest,
}

fn validate_fault_settlement(
    response: &super::super::mutations::SafeFaultResult,
    binding: FaultSettlement,
) -> bool {
    binding.run == binding.settlement_run
        && binding.fault_execution == binding.execution
        && response.execution == Some(binding.execution)
        && !response.terminal
        && response.outcome_digest == binding.outcome_digest
}

fn validate_effect_receipt(
    receipt: &MutationReceipt,
    _state: &ReplayState,
    records: &[RecordPayload],
) -> Result<(), ReplayError> {
    let response = decode_receipt_response::<super::super::mutations::EffectIntentResult>(receipt)?;
    let effect = match records {
        [RecordPayload::EffectIntent { effect, .. }] if receipt.method == "effect_intent" => effect,
        [RecordPayload::EffectReceipt { effect, .. }] if receipt.method == "effect_receipt" => {
            effect
        }
        _ => return Err(ReplayError::ReceiptCorrupt),
    };
    (response.effect == *effect)
        .then_some(())
        .ok_or(ReplayError::ReceiptCorrupt)
}

fn validate_terminal_receipt(
    receipt: &MutationReceipt,
    _state: &ReplayState,
    records: &[RecordPayload],
) -> Result<(), ReplayError> {
    let response = decode_receipt_response::<CanonicalDigest>(receipt)?;
    match records {
        [RecordPayload::Terminal { outcome_digest, .. }] if response == *outcome_digest => Ok(()),
        _ => Err(ReplayError::ReceiptCorrupt),
    }
}

fn validate_cleanup_receipt(
    receipt: &MutationReceipt,
    _state: &ReplayState,
    records: &[RecordPayload],
) -> Result<(), ReplayError> {
    let response = decode_receipt_response::<CanonicalDigest>(receipt)?;
    match records {
        [RecordPayload::CleanupReceipt { cleanup_digest }] if response == *cleanup_digest => Ok(()),
        _ => Err(ReplayError::ReceiptCorrupt),
    }
}

fn validate_protocol_apply_receipt(
    receipt: &MutationReceipt,
    state: &ReplayState,
    records: &[RecordPayload],
) -> Result<(), ReplayError> {
    let response = decode_receipt_response::<openengine_cluster_protocol::ApplyResult>(receipt)?;
    let (generation, run) = protocol_apply_identity(state, records)?;
    let expected_run = format!("run:{}", run.get());
    let valid = response
        .generation
        .map(openengine_cluster_protocol::Generation::get)
        == Some(generation.get())
        && response
            .run_id
            .as_ref()
            .map(openengine_cluster_protocol::RunId::as_str)
            == Some(expected_run.as_str())
        && response.phase == openengine_cluster_protocol::Phase::Running
        && !response.deduped
        && response.diff.is_none();
    valid.then_some(()).ok_or(ReplayError::ReceiptCorrupt)
}

fn protocol_apply_identity(
    state: &ReplayState,
    records: &[RecordPayload],
) -> Result<(GenerationId, RunSequence), ReplayError> {
    match records {
        [
            RecordPayload::Admission {
                generation, run, ..
            },
            RecordPayload::VerifiedInput {
                run: verified_run, ..
            },
        ] if verified_run == run => Ok((*generation, *run)),
        [] if state.terminal_outcome.is_none() => state
            .admission
            .as_ref()
            .map(|admission| (admission.generation, admission.run))
            .ok_or(ReplayError::ReceiptCorrupt),
        _ => Err(ReplayError::ReceiptCorrupt),
    }
}
