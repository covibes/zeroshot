use openengine_cluster_protocol::{Cursor, RequestFingerprint, RunId};
use openengine_cluster_server::admission::{CancellationSignal, IdempotencyRecord};
use openengine_cluster_server::lifecycle::MutationReceipt as ProtocolMutationReceipt;
use openengine_cluster_server::admission::StoreError as ProtocolStoreError;

use super::super::store::{AppendGuard, MutationReceipt, StoreError};
use super::super::{LedgerError, LedgerErrorKind};

pub(super) fn protocol_error(error: LedgerError) -> ProtocolStoreError {
    match error.kind() {
        LedgerErrorKind::IdempotencyConflict => ProtocolStoreError::IdempotencyReuse,
        LedgerErrorKind::Storage(StoreError::AppendCancelled) => ProtocolStoreError::Cancelled,
        _ => ProtocolStoreError::Internal("native cluster ledger operation failed".into()),
    }
}

pub(super) fn cancellation_guard(cancellation: &CancellationSignal) -> AppendGuard {
    let observer = cancellation.observer();
    AppendGuard::cancelled_when(move || observer.is_cancelled())
}

pub(super) fn protocol_cursor(position: super::super::store::Position) -> Cursor {
    Cursor::new(format!("ledger:{}", position.get()))
}

pub(super) fn protocol_run_id(run: super::super::RunSequence) -> RunId {
    RunId::new(format!("run:{}", run.get()))
}

pub(super) fn fingerprint_bytes(
    fingerprint: &RequestFingerprint,
) -> Result<[u8; 32], ProtocolStoreError> {
    decode_hex_32(fingerprint.as_str())
        .ok_or_else(|| ProtocolStoreError::Internal("request fingerprint is invalid".into()))
}

pub(super) fn protocol_idempotency_record(
    receipt: MutationReceipt,
) -> Result<Option<IdempotencyRecord>, ProtocolStoreError> {
    let fingerprint =
        serde_json::from_value(serde_json::Value::String(hex_32(receipt.fingerprint)))
            .map_err(|_| ProtocolStoreError::Internal("durable fingerprint is invalid".into()))?;
    let mutation_receipt = match receipt.method.as_str() {
        "protocol_apply" => ProtocolMutationReceipt::Apply(
            serde_json::from_slice(&receipt.response)
                .map_err(|_| ProtocolStoreError::Internal("apply receipt is invalid".into()))?,
        ),
        "protocol_update" => ProtocolMutationReceipt::Update(
            serde_json::from_slice(&receipt.response)
                .map_err(|_| ProtocolStoreError::Internal("update receipt is invalid".into()))?,
        ),
        "protocol_stop" => ProtocolMutationReceipt::Stop(
            serde_json::from_slice(&receipt.response)
                .map_err(|_| ProtocolStoreError::Internal("stop receipt is invalid".into()))?,
        ),
        _ => return Ok(None),
    };
    Ok(Some(IdempotencyRecord {
        fingerprint,
        receipt: mutation_receipt,
    }))
}

fn decode_hex_32(value: &str) -> Option<[u8; 32]> {
    if value.len() != 64 {
        return None;
    }
    let mut result = [0_u8; 32];
    for (index, pair) in value.as_bytes().chunks_exact(2).enumerate() {
        let high = hex_digit(pair[0])?;
        let low = hex_digit(pair[1])?;
        result[index] = (high << 4) | low;
    }
    Some(result)
}

const fn hex_digit(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        b'A'..=b'F' => Some(value - b'A' + 10),
        _ => None,
    }
}

fn hex_32(value: [u8; 32]) -> String {
    let mut result = String::with_capacity(64);
    for byte in value {
        use std::fmt::Write as _;
        write!(&mut result, "{byte:02x}").expect("writing to String cannot fail");
    }
    result
}
