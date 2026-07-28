use rusqlite::{params, OptionalExtension, Transaction};

use super::operations;
use super::super::{Fence, IdempotencyId, MutationReceipt, OwnerId, Position, ResourceId, StoreError};
use crate::cluster_ledger::record::{RecordFamily, RecordKind, StoredRecord};

pub(super) fn query_fence(transaction: &Transaction<'_>) -> Result<Option<Fence>, StoreError> {
    let resource_value: String = transaction
        .query_row(
            "SELECT resource_id FROM metadata WHERE singleton = 1",
            [],
            |row| row.get(0),
        )
        .map_err(|_| StoreError::Storage)?;
    let resource =
        ResourceId::new(resource_value).map_err(|_| StoreError::Corrupt("resource identifier"))?;
    transaction
        .query_row(
            "SELECT owner_id, epoch, expires_at_ms FROM fence WHERE singleton = 1",
            [],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            },
        )
        .optional()
        .map_err(|_| StoreError::Storage)?
        .map(|(owner, epoch, expires_at_ms)| {
            Ok(Fence {
                resource,
                owner: OwnerId::new(owner).map_err(|_| StoreError::Corrupt("owner identifier"))?,
                epoch: u64::try_from(epoch).map_err(|_| StoreError::Corrupt("fence epoch"))?,
                expires_at_ms: u64::try_from(expires_at_ms)
                    .map_err(|_| StoreError::Corrupt("fence expiry"))?,
            })
        })
        .transpose()
}

pub(super) fn query_records(
    transaction: &Transaction<'_>,
    resource: &ResourceId,
    after: Position,
    limit: usize,
) -> Result<Vec<StoredRecord>, StoreError> {
    let mut statement = transaction
        .prepare(
            "SELECT sequence, family, kind, version, payload, previous_hash, record_hash
             FROM records WHERE sequence > ?1 ORDER BY sequence LIMIT ?2",
        )
        .map_err(|_| StoreError::Storage)?;
    let rows = statement
        .query_map(
            params![
                to_sql_i64(after.get())?,
                i64::try_from(limit).map_err(|_| StoreError::InvalidLimit)?
            ],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, Vec<u8>>(4)?,
                    row.get::<_, Vec<u8>>(5)?,
                    row.get::<_, Vec<u8>>(6)?,
                ))
            },
        )
        .map_err(|_| StoreError::Storage)?;
    rows.map(|row| decode_record(resource, row.map_err(|_| StoreError::Storage)?))
        .collect()
}

fn decode_record(
    resource: &ResourceId,
    row: (i64, i64, i64, i64, Vec<u8>, Vec<u8>, Vec<u8>),
) -> Result<StoredRecord, StoreError> {
    let (sequence, family, kind, version, payload, previous_hash, record_hash) = row;
    Ok(StoredRecord {
        resource: resource.clone(),
        sequence: Position::new(
            u64::try_from(sequence).map_err(|_| StoreError::Corrupt("record sequence"))?,
        )?,
        family: family_from_i64(family)?,
        kind: kind_from_i64(kind)?,
        version: u16::try_from(version).map_err(|_| StoreError::Corrupt("record version"))?,
        payload,
        previous_hash: operations::fixed_32(previous_hash)
            .ok_or(StoreError::Corrupt("previous hash"))?,
        record_hash: operations::fixed_32(record_hash).ok_or(StoreError::Corrupt("record hash"))?,
    })
}

pub(super) fn query_receipts(
    transaction: &Transaction<'_>,
    through: Option<Position>,
) -> Result<Vec<MutationReceipt>, StoreError> {
    let mut statement = transaction
        .prepare(
            "SELECT idempotency_key, method, fingerprint, response, committed_position
             FROM receipts
             WHERE (?1 IS NULL OR committed_position <= ?1)
             ORDER BY idempotency_key",
        )
        .map_err(|_| StoreError::Storage)?;
    let through = through
        .map(|position| to_sql_i64(position.get()))
        .transpose()?;
    let rows = statement
        .query_map([through], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Vec<u8>>(2)?,
                row.get::<_, Vec<u8>>(3)?,
                row.get::<_, i64>(4)?,
            ))
        })
        .map_err(|_| StoreError::Storage)?;
    rows.map(|row| decode_receipt(row.map_err(|_| StoreError::Storage)?))
        .collect()
}

fn decode_receipt(
    row: (String, String, Vec<u8>, Vec<u8>, i64),
) -> Result<MutationReceipt, StoreError> {
    let (key, method, fingerprint, response, position) = row;
    let receipt = MutationReceipt {
        idempotency_key: IdempotencyId::new(key)
            .map_err(|_| StoreError::Corrupt("idempotency identifier"))?,
        method,
        fingerprint: operations::fixed_32(fingerprint)
            .ok_or(StoreError::Corrupt("receipt fingerprint"))?,
        response,
        committed_position: Position::new(
            u64::try_from(position).map_err(|_| StoreError::Corrupt("receipt position"))?,
        )?,
    };
    receipt
        .validate()
        .map_err(|_| StoreError::Corrupt("receipt fields"))?;
    Ok(receipt)
}

pub(super) fn query_receipt(
    transaction: &Transaction<'_>,
    key: &IdempotencyId,
) -> Result<Option<MutationReceipt>, StoreError> {
    transaction
        .query_row(
            "SELECT method, fingerprint, response, committed_position
             FROM receipts WHERE idempotency_key = ?1",
            [key.as_str()],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Vec<u8>>(1)?,
                    row.get::<_, Vec<u8>>(2)?,
                    row.get::<_, i64>(3)?,
                ))
            },
        )
        .optional()
        .map_err(|_| StoreError::Storage)?
        .map(|(method, fingerprint, response, position)| {
            decode_receipt((
                key.as_str().to_owned(),
                method,
                fingerprint,
                response,
                position,
            ))
        })
        .transpose()
}

pub(super) fn to_sql_i64(value: u64) -> Result<i64, StoreError> {
    i64::try_from(value).map_err(|_| StoreError::PositionOverflow)
}

pub(super) const fn family_to_i64(family: RecordFamily) -> i64 {
    match family {
        RecordFamily::Control => 1,
        RecordFamily::VerifiedIo => 2,
    }
}

fn family_from_i64(value: i64) -> Result<RecordFamily, StoreError> {
    match value {
        1 => Ok(RecordFamily::Control),
        2 => Ok(RecordFamily::VerifiedIo),
        _ => Err(StoreError::Corrupt("record family")),
    }
}

pub(super) const fn kind_to_i64(kind: RecordKind) -> i64 {
    kind as i64
}

fn kind_from_i64(value: i64) -> Result<RecordKind, StoreError> {
    const KINDS: [RecordKind; 11] = [
        RecordKind::Admission,
        RecordKind::Dispatch,
        RecordKind::Settlement,
        RecordKind::SafeFault,
        RecordKind::EffectIntent,
        RecordKind::EffectReceipt,
        RecordKind::Terminal,
        RecordKind::CleanupReceipt,
        RecordKind::VerifiedInput,
        RecordKind::VerifiedOutput,
        RecordKind::MutationReceipt,
    ];
    let index = usize::try_from(
        value
            .checked_sub(1)
            .ok_or(StoreError::Corrupt("record kind"))?,
    )
    .map_err(|_| StoreError::Corrupt("record kind"))?;
    KINDS
        .get(index)
        .copied()
        .ok_or(StoreError::Corrupt("record kind"))
}
