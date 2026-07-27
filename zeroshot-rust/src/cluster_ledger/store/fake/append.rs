use super::super::{
    validate_append_identity, AppendBatch, AppendOutcome, FailPoint, Fence, LedgerClock, Position,
    ResourceId, StoreError,
};
use super::{FakeState, ResourceData};

pub(super) fn take_failpoint(state: &mut FakeState, point: FailPoint) -> bool {
    if state.next_failpoint == Some(point) {
        state.next_failpoint = None;
        true
    } else {
        false
    }
}

pub(super) fn validate_fence(
    clock: &dyn LedgerClock,
    data: &ResourceData,
    fence: &Fence,
) -> Result<(), StoreError> {
    let current = data.fence.as_ref().ok_or(StoreError::StaleFence)?;
    if current != fence {
        return Err(StoreError::StaleFence);
    }
    if current.expires_at_ms <= clock.now_ms() {
        return Err(StoreError::FenceExpired);
    }
    Ok(())
}

pub(super) fn existing_outcome(
    data: &ResourceData,
    batch: &AppendBatch,
) -> Result<Option<AppendOutcome>, StoreError> {
    let Some(receipt) = &batch.receipt else {
        return Ok(None);
    };
    let Some(existing) = data.receipts.get(&receipt.idempotency_key) else {
        return Ok(None);
    };
    if existing.method == receipt.method && existing.fingerprint == receipt.fingerprint {
        Ok(Some(AppendOutcome::Replayed(existing.clone())))
    } else {
        Err(StoreError::IdempotencyConflict)
    }
}

pub(super) fn validate_append(
    data: &ResourceData,
    resource: &ResourceId,
    expected: Position,
    batch: &AppendBatch,
) -> Result<(), StoreError> {
    let actual = Position::new(
        u64::try_from(data.records.len()).map_err(|_| StoreError::PositionOverflow)?,
    )?;
    validate_append_identity(resource, expected, actual, batch).map(|_| ())
}

pub(super) fn apply_append(
    data: &mut ResourceData,
    expected: Position,
    batch: AppendBatch,
) -> Result<AppendOutcome, StoreError> {
    let committed_position = expected.checked_add(batch.records.len())?;
    data.records.extend(batch.records);
    let outcome = if let Some(receipt) = batch.receipt {
        data.receipts
            .insert(receipt.idempotency_key.clone(), receipt.clone());
        AppendOutcome::Committed(receipt)
    } else {
        AppendOutcome::CommittedWithoutReceipt(committed_position)
    };
    data.notify.notify_waiters();
    Ok(outcome)
}
