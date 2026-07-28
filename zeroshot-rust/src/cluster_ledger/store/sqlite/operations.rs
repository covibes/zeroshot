use std::path::{Path, PathBuf};

use sha2::{Digest as _, Sha256};
use rusqlite::{params, Transaction};

use super::super::{
    validate_append_identity, AppendBatch, AppendOutcome, MutationReceipt, Position, ResourceId,
    StoreError,
};
use super::queries::{family_to_i64, kind_to_i64, query_receipt, to_sql_i64};
use super::SqliteLedgerStore;
use crate::cluster_ledger::record::StoredRecord;

#[must_use]
pub fn database_path(root: &Path, resource: &ResourceId) -> PathBuf {
    let digest = Sha256::digest(resource.as_str().as_bytes());
    let mut name = String::with_capacity(64 + ".sqlite3".len());
    for byte in digest {
        use std::fmt::Write as _;
        write!(&mut name, "{byte:02x}").expect("writing to String cannot fail");
    }
    name.push_str(".sqlite3");
    root.join(name)
}

pub fn fixed_32(bytes: Vec<u8>) -> Option<[u8; 32]> {
    bytes.try_into().ok()
}

pub(super) fn existing_receipt_outcome(
    transaction: &Transaction<'_>,
    batch: &AppendBatch,
) -> Result<Option<AppendOutcome>, StoreError> {
    let Some(receipt) = &batch.receipt else {
        return Ok(None);
    };
    let Some(existing) = query_receipt(transaction, &receipt.idempotency_key)? else {
        return Ok(None);
    };
    if existing.method == receipt.method && existing.fingerprint == receipt.fingerprint {
        Ok(Some(AppendOutcome::Replayed(existing)))
    } else {
        Err(StoreError::IdempotencyConflict)
    }
}

pub(super) fn validate_append_transaction(
    transaction: &Transaction<'_>,
    resource: &ResourceId,
    expected: Position,
    batch: &AppendBatch,
) -> Result<Position, StoreError> {
    let actual = SqliteLedgerStore::position(transaction)?;
    validate_append_identity(resource, expected, actual, batch)
}

pub(super) fn insert_records(
    transaction: &Transaction<'_>,
    records: &[StoredRecord],
) -> Result<(), StoreError> {
    for record in records {
        transaction
            .execute(
                "INSERT INTO records(
                    sequence, family, kind, version, payload, previous_hash, record_hash
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    to_sql_i64(record.sequence.get())?,
                    family_to_i64(record.family),
                    kind_to_i64(record.kind),
                    i64::from(record.version),
                    &record.payload,
                    &record.previous_hash[..],
                    &record.record_hash[..],
                ],
            )
            .map_err(|_| StoreError::Storage)?;
    }
    Ok(())
}

pub(super) fn insert_receipt(
    transaction: &Transaction<'_>,
    receipt: Option<MutationReceipt>,
    committed_position: Position,
) -> Result<AppendOutcome, StoreError> {
    let Some(receipt) = receipt else {
        return Ok(AppendOutcome::CommittedWithoutReceipt(committed_position));
    };
    transaction
        .execute(
            "INSERT INTO receipts(
                idempotency_key, method, fingerprint, response, committed_position
             ) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                receipt.idempotency_key.as_str(),
                receipt.method,
                &receipt.fingerprint[..],
                receipt.response,
                to_sql_i64(receipt.committed_position.get())?,
            ],
        )
        .map_err(|_| StoreError::Storage)?;
    Ok(AppendOutcome::Committed(receipt))
}
