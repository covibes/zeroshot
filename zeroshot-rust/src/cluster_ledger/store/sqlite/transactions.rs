use rusqlite::{params, Transaction};

use super::super::{Fence, OwnerId, Position, ResourceId, StoreError};
use super::queries::{query_fence, to_sql_i64};

pub(super) struct FenceAcquisition<'a> {
    pub resource: &'a ResourceId,
    pub owner: &'a OwnerId,
    pub now: u64,
    pub expires_at_ms: u64,
}

pub(super) fn acquire_fence_transaction(
    transaction: &Transaction<'_>,
    request: FenceAcquisition<'_>,
) -> Result<Fence, StoreError> {
    let current = query_fence(transaction)?;
    if current
        .as_ref()
        .is_some_and(|fence| fence.expires_at_ms > request.now)
    {
        return Err(StoreError::FenceHeld);
    }
    let epoch = current.map_or(Ok(1_u64), |fence| {
        fence
            .epoch
            .checked_add(1)
            .ok_or(StoreError::PositionOverflow)
    })?;
    transaction
        .execute(
            "INSERT INTO fence(singleton, owner_id, epoch, expires_at_ms)
             VALUES (1, ?1, ?2, ?3)
             ON CONFLICT(singleton) DO UPDATE SET
                owner_id = excluded.owner_id,
                epoch = excluded.epoch,
                expires_at_ms = excluded.expires_at_ms",
            params![
                request.owner.as_str(),
                to_sql_i64(epoch)?,
                to_sql_i64(request.expires_at_ms)?
            ],
        )
        .map_err(|_| StoreError::Storage)?;
    Ok(Fence {
        resource: request.resource.clone(),
        owner: request.owner.clone(),
        epoch,
        expires_at_ms: request.expires_at_ms,
    })
}

pub(super) fn write_removal_tombstone(
    transaction: &Transaction<'_>,
    resource: &ResourceId,
    position: Position,
) -> Result<(), StoreError> {
    transaction
        .execute_batch(
            "DELETE FROM receipts;
             DELETE FROM records;
             DELETE FROM fence;
             DELETE FROM removal_tombstone;",
        )
        .map_err(|_| StoreError::Storage)?;
    transaction
        .execute(
            "INSERT INTO removal_tombstone(singleton, resource_id, removed_position)
             VALUES (1, ?1, ?2)",
            params![resource.as_str(), to_sql_i64(position.get())?],
        )
        .map_err(|_| StoreError::Storage)?;
    transaction
        .execute("DELETE FROM metadata", [])
        .map_err(|_| StoreError::Storage)?;
    Ok(())
}
