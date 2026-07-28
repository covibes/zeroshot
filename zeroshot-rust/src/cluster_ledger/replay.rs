mod error;
mod receipts;
mod state;

pub use error::ReplayError;
pub use state::{AdmissionState, DispatchState, EffectState, ReplayState, VerifiedValue};
use receipts::validate_receipt_binding;

use super::record::{CanonicalDigest, RecordPayload, RunSequence, StoredRecord};
use super::store::{MutationReceipt, Position, PrefixSnapshot, ResourceId};

pub fn replay(
    snapshot: &PrefixSnapshot,
    resource: &ResourceId,
) -> Result<ReplayState, ReplayError> {
    let mut state = ReplayState::empty(resource.clone());
    let mut pending_mutation = Vec::new();
    for record in &snapshot.records {
        fold_record(&mut state, &mut pending_mutation, record)?;
    }
    validate_replayed_snapshot(&state, snapshot, &pending_mutation)?;
    Ok(state)
}

fn validate_replayed_snapshot(
    state: &ReplayState,
    snapshot: &PrefixSnapshot,
    pending_mutation: &[RecordPayload],
) -> Result<(), ReplayError> {
    if !pending_mutation.is_empty() {
        return Err(ReplayError::ReceiptCorrupt);
    }
    if state.position != snapshot.position {
        return Err(ReplayError::PositionMismatch);
    }
    validate_snapshot_receipts(state, snapshot)
}

fn validate_snapshot_receipts(
    state: &ReplayState,
    snapshot: &PrefixSnapshot,
) -> Result<(), ReplayError> {
    if state.mutation_receipts.len() != snapshot.receipts.len() {
        return Err(ReplayError::ReceiptCorrupt);
    }
    for receipt in &snapshot.receipts {
        receipt
            .validate()
            .map_err(|_| ReplayError::ReceiptCorrupt)?;
        if receipt.committed_position > snapshot.position {
            return Err(ReplayError::ReceiptCorrupt);
        }
        match state.mutation_receipts.get(&receipt.idempotency_key) {
            Some(existing) if existing != receipt => return Err(ReplayError::ReceiptCorrupt),
            Some(_) => {}
            None => return Err(ReplayError::ReceiptCorrupt),
        }
    }
    Ok(())
}

fn fold_record(
    state: &mut ReplayState,
    pending_mutation: &mut Vec<RecordPayload>,
    record: &StoredRecord,
) -> Result<(), ReplayError> {
    let expected = state
        .position
        .checked_add(1)
        .map_err(|_| ReplayError::PositionOverflow)?;
    let payload = record
        .validate(&state.resource, expected, state.last_hash)
        .map_err(ReplayError::Record)?;
    let pending_payload =
        (!matches!(&payload, RecordPayload::MutationReceipt { .. })).then(|| payload.clone());
    if state.terminal_outcome.is_some() && !record.kind.allowed_after_terminal() {
        return Err(ReplayError::PostTerminalRecord);
    }
    fold_payload(state, pending_mutation, payload, record.sequence)?;
    if let Some(payload) = pending_payload {
        pending_mutation.push(payload);
    }
    state.position = record.sequence;
    state.last_hash = record.record_hash;
    Ok(())
}

fn fold_payload(
    state: &mut ReplayState,
    pending_mutation: &mut Vec<RecordPayload>,
    payload: RecordPayload,
    position: Position,
) -> Result<(), ReplayError> {
    match payload {
        payload @ (RecordPayload::Admission { .. }
        | RecordPayload::Dispatch { .. }
        | RecordPayload::Settlement { .. }
        | RecordPayload::SafeFault { .. }) => fold_execution_payload(state, payload),
        payload @ (RecordPayload::EffectIntent { .. }
        | RecordPayload::EffectReceipt { .. }
        | RecordPayload::Terminal { .. }
        | RecordPayload::CleanupReceipt { .. }) => fold_state_payload(state, payload),
        payload @ (RecordPayload::VerifiedInput { .. } | RecordPayload::VerifiedOutput { .. }) => {
            fold_verified_payload(state, payload, position)
        }
        RecordPayload::MutationReceipt { receipt } => {
            fold_mutation_receipt(state, pending_mutation, receipt, position)
        }
    }
}

fn fold_execution_payload(
    state: &mut ReplayState,
    payload: RecordPayload,
) -> Result<(), ReplayError> {
    match payload {
        payload @ RecordPayload::Admission { .. } => fold_admission(state, payload),
        payload @ RecordPayload::Dispatch { .. } => fold_dispatch(state, payload),
        payload @ RecordPayload::Settlement { .. } => fold_settlement(state, payload),
        payload @ RecordPayload::SafeFault { .. } => fold_safe_fault(state, payload),
        _ => unreachable!("execution fold receives execution payload"),
    }
}

fn fold_state_payload(state: &mut ReplayState, payload: RecordPayload) -> Result<(), ReplayError> {
    match payload {
        payload @ RecordPayload::EffectIntent { .. } => fold_effect_intent(state, payload),
        payload @ RecordPayload::EffectReceipt { .. } => fold_effect_receipt(state, payload),
        payload @ RecordPayload::Terminal { .. } => fold_terminal(state, payload),
        RecordPayload::CleanupReceipt { cleanup_digest } => {
            fold_cleanup_receipt(state, cleanup_digest)
        }
        _ => unreachable!("state fold receives state payload"),
    }
}

fn fold_verified_payload(
    state: &mut ReplayState,
    payload: RecordPayload,
    position: Position,
) -> Result<(), ReplayError> {
    match payload {
        payload @ RecordPayload::VerifiedInput { .. } => {
            fold_verified_input(state, payload, position)
        }
        payload @ RecordPayload::VerifiedOutput { .. } => {
            fold_verified_output(state, payload, position)
        }
        _ => unreachable!("verified fold receives verified payload"),
    }
}

fn fold_admission(state: &mut ReplayState, payload: RecordPayload) -> Result<(), ReplayError> {
    let RecordPayload::Admission {
        generation,
        run,
        graph_digest,
        input_digest,
        policy_digest,
        catalog_digest,
        profile_digest,
        absolute_deadline_ms,
        canonical_graph,
        canonical_compiled_ir,
    } = payload
    else {
        unreachable!("admission fold receives admission payload");
    };
    if !state.active_dispatches.is_empty()
        || state
            .effects
            .values()
            .any(|effect| effect.receipt_digest.is_none())
        || generation.get() != state.identities.next_generation
        || run.get() != state.identities.next_run
    {
        return Err(ReplayError::InvalidOrder);
    }
    state.identities.next_generation =
        advance_identity(state.identities.next_generation, generation.get())?;
    state.identities.next_run = advance_identity(state.identities.next_run, run.get())?;
    state.admission = Some(AdmissionState {
        generation,
        run,
        graph_digest,
        input_digest,
        policy_digest,
        catalog_digest,
        profile_digest,
        absolute_deadline_ms,
        canonical_graph,
        canonical_compiled_ir,
    });
    Ok(())
}

fn fold_dispatch(state: &mut ReplayState, payload: RecordPayload) -> Result<(), ReplayError> {
    let RecordPayload::Dispatch {
        run,
        node_instance,
        execution,
    } = payload
    else {
        unreachable!("dispatch fold receives dispatch payload");
    };
    require_current_run(state, run)?;
    if state.active_dispatches.contains_key(&execution)
        || state.settlements.contains_key(&execution)
    {
        return Err(ReplayError::InvalidOrder);
    }
    state.identities.next_node_instance =
        advance_identity(state.identities.next_node_instance, node_instance.get())?;
    state.identities.next_execution =
        advance_identity(state.identities.next_execution, execution.get())?;
    state.active_dispatches.insert(
        execution,
        DispatchState {
            run,
            node_instance,
            execution,
        },
    );
    Ok(())
}

fn fold_settlement(state: &mut ReplayState, payload: RecordPayload) -> Result<(), ReplayError> {
    let RecordPayload::Settlement {
        run,
        execution,
        outcome_digest,
        accepted,
    } = payload
    else {
        unreachable!("settlement fold receives settlement payload");
    };
    if !accepted {
        if !state.settlements.contains_key(&execution)
            || state.settlement_runs.get(&execution) != Some(&run)
        {
            return Err(ReplayError::InvalidSettlement);
        }
        return Ok(());
    }
    require_current_run(state, run)?;
    if state.settlements.contains_key(&execution)
        || state
            .active_dispatches
            .remove(&execution)
            .is_none_or(|dispatch| dispatch.run != run)
    {
        return Err(ReplayError::InvalidSettlement);
    }
    state.settlements.insert(execution, outcome_digest);
    state.settlement_runs.insert(execution, run);
    Ok(())
}

fn fold_safe_fault(state: &mut ReplayState, payload: RecordPayload) -> Result<(), ReplayError> {
    let RecordPayload::SafeFault {
        run,
        execution,
        encoded_fault,
    } = payload
    else {
        unreachable!("safe fault fold receives safe fault payload");
    };
    require_current_run(state, run)?;
    if execution.is_some_and(|execution| {
        !state.active_dispatches.contains_key(&execution)
            && !state.settlements.contains_key(&execution)
    }) {
        return Err(ReplayError::InvalidOrder);
    }
    crate::fault::EngineFault::decode_json(&encoded_fault).map_err(|_| ReplayError::UnsafeFault)?;
    state.safe_faults.push(encoded_fault);
    Ok(())
}

fn fold_effect_intent(state: &mut ReplayState, payload: RecordPayload) -> Result<(), ReplayError> {
    let RecordPayload::EffectIntent {
        run,
        effect,
        request_digest,
    } = payload
    else {
        unreachable!("effect intent fold receives effect intent payload");
    };
    require_current_run(state, run)?;
    if state.effects.contains_key(&effect) {
        return Err(ReplayError::InvalidOrder);
    }
    state.identities.next_effect = advance_identity(state.identities.next_effect, effect.get())?;
    state.effects.insert(
        effect,
        EffectState {
            run,
            effect,
            request_digest,
            receipt_digest: None,
        },
    );
    Ok(())
}

fn fold_effect_receipt(state: &mut ReplayState, payload: RecordPayload) -> Result<(), ReplayError> {
    let RecordPayload::EffectReceipt {
        run,
        effect,
        receipt_digest,
    } = payload
    else {
        unreachable!("effect receipt fold receives effect receipt payload");
    };
    require_current_run(state, run)?;
    let intent = state
        .effects
        .get_mut(&effect)
        .ok_or(ReplayError::InvalidOrder)?;
    if intent.receipt_digest.replace(receipt_digest).is_some() {
        return Err(ReplayError::InvalidOrder);
    }
    Ok(())
}

fn fold_terminal(state: &mut ReplayState, payload: RecordPayload) -> Result<(), ReplayError> {
    let RecordPayload::Terminal {
        run,
        outcome_digest,
    } = payload
    else {
        unreachable!("terminal fold receives terminal payload");
    };
    require_current_run(state, run)?;
    if state
        .effects
        .values()
        .any(|effect| effect.receipt_digest.is_none())
    {
        return Err(ReplayError::InvalidOrder);
    }
    if state.terminal_outcome.replace(outcome_digest).is_some() {
        return Err(ReplayError::PostTerminalRecord);
    }
    state.active_dispatches.clear();
    Ok(())
}

fn fold_cleanup_receipt(
    state: &mut ReplayState,
    cleanup_digest: CanonicalDigest,
) -> Result<(), ReplayError> {
    if state.terminal_outcome.is_none() {
        return Err(ReplayError::InvalidOrder);
    }
    state.cleanup_receipts.push(cleanup_digest);
    Ok(())
}

fn fold_verified_input(
    state: &mut ReplayState,
    payload: RecordPayload,
    position: Position,
) -> Result<(), ReplayError> {
    let RecordPayload::VerifiedInput {
        run,
        digest,
        canonical_bytes,
    } = payload
    else {
        unreachable!("verified input fold receives verified input payload");
    };
    require_current_run(state, run)?;
    if state
        .admission
        .as_ref()
        .is_none_or(|admission| admission.input_digest != digest)
        || state
            .verified_inputs
            .insert(
                run,
                VerifiedValue {
                    digest,
                    canonical_bytes,
                    position,
                },
            )
            .is_some()
    {
        return Err(ReplayError::InvalidOrder);
    }
    Ok(())
}

fn fold_verified_output(
    state: &mut ReplayState,
    payload: RecordPayload,
    position: Position,
) -> Result<(), ReplayError> {
    let RecordPayload::VerifiedOutput {
        run,
        execution,
        digest,
        canonical_bytes,
    } = payload
    else {
        unreachable!("verified output fold receives verified output payload");
    };
    require_current_run(state, run)?;
    if state.settlements.get(&execution) != Some(&digest)
        || state
            .verified_outputs
            .insert(
                execution,
                VerifiedValue {
                    digest,
                    canonical_bytes,
                    position,
                },
            )
            .is_some()
    {
        return Err(ReplayError::InvalidOrder);
    }
    Ok(())
}

fn fold_mutation_receipt(
    state: &mut ReplayState,
    pending_mutation: &mut Vec<RecordPayload>,
    receipt: MutationReceipt,
    position: Position,
) -> Result<(), ReplayError> {
    receipt
        .validate()
        .map_err(|_| ReplayError::ReceiptCorrupt)?;
    validate_receipt_binding(&receipt, state, pending_mutation)?;
    if receipt.committed_position != position
        || state
            .mutation_receipts
            .insert(receipt.idempotency_key.clone(), receipt)
            .is_some()
    {
        return Err(ReplayError::ReceiptCorrupt);
    }
    pending_mutation.clear();
    Ok(())
}

fn require_current_run(state: &ReplayState, run: RunSequence) -> Result<(), ReplayError> {
    match &state.admission {
        Some(admission) if admission.run == run => Ok(()),
        _ => Err(ReplayError::InvalidOrder),
    }
}

fn advance_identity(current: u64, observed: u64) -> Result<u64, ReplayError> {
    if observed != current {
        return Err(ReplayError::InvalidOrder);
    }
    observed
        .checked_add(1)
        .filter(|value| *value <= i64::MAX as u64)
        .ok_or(ReplayError::PositionOverflow)
}
