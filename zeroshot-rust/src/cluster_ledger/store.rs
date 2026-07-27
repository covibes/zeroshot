use std::fmt;
use std::marker::PhantomData;
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use super::record::{
    StoredRecord, MAX_APPEND_BATCH_BYTES, MAX_APPEND_RECORDS, MAX_RECORD_PAYLOAD_BYTES,
};

mod contract;
pub mod fake;
pub mod sqlite;

pub use contract::LedgerStore;

pub const MAX_IDENTIFIER_BYTES: usize = 256;
pub const MAX_DISCOVERY_PAGE: usize = 1_024;

pub trait IdentifierKind {
    const LABEL: &'static str;
}

#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(transparent)]
pub struct BoundedIdentifier<K> {
    value: String,
    #[serde(skip)]
    kind: PhantomData<K>,
}

impl<K: IdentifierKind> BoundedIdentifier<K> {
    pub fn new(value: impl Into<String>) -> Result<Self, StoreError> {
        let value = value.into();
        validate_identifier(&value, K::LABEL)?;
        Ok(Self {
            value,
            kind: PhantomData,
        })
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.value
    }
}

impl<K> fmt::Display for BoundedIdentifier<K> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.value)
    }
}

impl<'de, K: IdentifierKind> Deserialize<'de> for BoundedIdentifier<K> {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Self::new(value).map_err(serde::de::Error::custom)
    }
}

#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub enum ResourceIdentifier {}

impl IdentifierKind for ResourceIdentifier {
    const LABEL: &'static str = "resource";
}

#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub enum OwnerIdentifier {}

impl IdentifierKind for OwnerIdentifier {
    const LABEL: &'static str = "owner";
}

#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub enum IdempotencyIdentifier {}

impl IdentifierKind for IdempotencyIdentifier {
    const LABEL: &'static str = "idempotency";
}

pub type ResourceId = BoundedIdentifier<ResourceIdentifier>;
pub type OwnerId = BoundedIdentifier<OwnerIdentifier>;
pub type IdempotencyId = BoundedIdentifier<IdempotencyIdentifier>;

fn validate_identifier(value: &str, label: &'static str) -> Result<(), StoreError> {
    if value.is_empty() || value.len() > MAX_IDENTIFIER_BYTES || value.chars().any(char::is_control)
    {
        return Err(StoreError::InvalidIdentifier(label));
    }
    Ok(())
}

#[derive(Clone, Copy, Debug, Default, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(transparent)]
pub struct Position(u64);

impl Position {
    pub const ZERO: Self = Self(0);
    pub const MAX: Self = Self(i64::MAX as u64);

    pub fn new(value: u64) -> Result<Self, StoreError> {
        if value > Self::MAX.0 {
            return Err(StoreError::PositionOverflow);
        }
        Ok(Self(value))
    }

    #[must_use]
    pub const fn get(self) -> u64 {
        self.0
    }

    pub fn checked_add(self, amount: usize) -> Result<Self, StoreError> {
        let amount = u64::try_from(amount).map_err(|_| StoreError::PositionOverflow)?;
        Self::new(
            self.0
                .checked_add(amount)
                .ok_or(StoreError::PositionOverflow)?,
        )
    }
}

impl<'de> Deserialize<'de> for Position {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        u64::deserialize(deserializer)
            .and_then(|value| Self::new(value).map_err(serde::de::Error::custom))
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct Fence {
    pub resource: ResourceId,
    pub owner: OwnerId,
    pub epoch: u64,
    pub expires_at_ms: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct MutationReceipt {
    pub idempotency_key: IdempotencyId,
    pub method: String,
    pub fingerprint: [u8; 32],
    pub response: Vec<u8>,
    pub committed_position: Position,
}

impl MutationReceipt {
    pub fn validate(&self) -> Result<(), StoreError> {
        validate_identifier(&self.method, "method")?;
        if self.committed_position == Position::ZERO {
            return Err(StoreError::Corrupt("zero receipt position"));
        }
        if self.response.len() > super::record::MAX_RECORD_PAYLOAD_BYTES {
            return Err(StoreError::ReceiptTooLarge);
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct AppendBatch {
    pub records: Vec<StoredRecord>,
    pub receipt: Option<MutationReceipt>,
}

impl AppendBatch {
    pub fn new(
        records: Vec<StoredRecord>,
        receipt: Option<MutationReceipt>,
    ) -> Result<Self, StoreError> {
        let batch = Self { records, receipt };
        batch.validate()?;
        Ok(batch)
    }

    pub fn validate(&self) -> Result<(), StoreError> {
        if self.records.len() > MAX_APPEND_RECORDS
            || (self.records.is_empty() && self.receipt.is_none())
        {
            return Err(StoreError::BatchRecordBound);
        }
        let mut encoded_bytes = self.records.iter().try_fold(0_usize, |total, record| {
            if record.payload.len() > MAX_RECORD_PAYLOAD_BYTES {
                return Err(StoreError::BatchByteBound);
            }
            total
                .checked_add(record.encoded_len())
                .ok_or(StoreError::BatchByteBound)
        })?;
        if let Some(value) = &self.receipt {
            value.validate()?;
            encoded_bytes = encoded_bytes
                .checked_add(value.idempotency_key.as_str().len())
                .and_then(|total| total.checked_add(value.method.len()))
                .and_then(|total| total.checked_add(value.response.len()))
                .and_then(|total| total.checked_add(64))
                .ok_or(StoreError::BatchByteBound)?;
        }
        if encoded_bytes > MAX_APPEND_BATCH_BYTES {
            return Err(StoreError::BatchByteBound);
        }
        Ok(())
    }
}

pub(crate) fn validate_append_identity(
    resource: &ResourceId,
    expected: Position,
    actual: Position,
    batch: &AppendBatch,
) -> Result<Position, StoreError> {
    if actual != expected {
        return Err(StoreError::PositionConflict { expected, actual });
    }
    let committed_position = expected.checked_add(batch.records.len())?;
    for (offset, record) in batch.records.iter().enumerate() {
        let expected_sequence = expected.checked_add(offset + 1)?;
        if record.resource != *resource || record.sequence != expected_sequence {
            return Err(StoreError::Corrupt("append record identity"));
        }
    }
    if batch
        .receipt
        .as_ref()
        .is_some_and(|receipt| receipt.committed_position != committed_position)
    {
        return Err(StoreError::Corrupt("receipt position"));
    }
    Ok(committed_position)
}

pub(crate) fn fence_expiry(now_ms: u64, ttl_ms: u64) -> Result<u64, StoreError> {
    if ttl_ms == 0 {
        return Err(StoreError::FenceExpired);
    }
    let expires_at_ms = now_ms
        .checked_add(ttl_ms)
        .ok_or(StoreError::PositionOverflow)?;
    if expires_at_ms > i64::MAX as u64 {
        return Err(StoreError::PositionOverflow);
    }
    Ok(expires_at_ms)
}

pub(crate) fn wait_is_complete(
    position: Position,
    after: Position,
    now_ms: u64,
    deadline_ms: u64,
) -> bool {
    position > after || now_ms >= deadline_ms
}

pub(crate) struct WaitProbe<'a> {
    pub resource: &'a ResourceId,
    pub position: Position,
    pub after: Position,
    pub now_ms: u64,
    pub deadline_ms: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ResourceInfo {
    pub resource: ResourceId,
    pub position: Position,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DiscoveryPage {
    pub resources: Vec<ResourceInfo>,
    pub next_after: Option<ResourceId>,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct PrefixSnapshot {
    pub position: Position,
    pub records: Vec<StoredRecord>,
    pub receipts: Vec<MutationReceipt>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AppendOutcome {
    Committed(MutationReceipt),
    Replayed(MutationReceipt),
    CommittedWithoutReceipt(Position),
}

impl AppendOutcome {
    const fn is_new_commit(&self) -> bool {
        matches!(self, Self::Committed(_) | Self::CommittedWithoutReceipt(_))
    }
}

#[derive(Clone)]
pub struct AppendGuard(Option<Arc<dyn Fn() -> bool + Send + Sync>>);

impl AppendGuard {
    #[must_use]
    pub const fn allow() -> Self {
        Self(None)
    }

    #[must_use]
    pub fn cancelled_when(check: impl Fn() -> bool + Send + Sync + 'static) -> Self {
        Self(Some(Arc::new(check)))
    }

    pub fn check(&self) -> Result<(), StoreError> {
        if self.0.as_ref().is_some_and(|check| check()) {
            Err(StoreError::AppendCancelled)
        } else {
            Ok(())
        }
    }
}

impl Default for AppendGuard {
    fn default() -> Self {
        Self::allow()
    }
}

pub(crate) struct AppendRequest<'a> {
    pub(crate) resource: &'a ResourceId,
    pub(crate) fence: &'a Fence,
    pub(crate) expected: Position,
    pub(crate) batch: AppendBatch,
    pub(crate) guard: AppendGuard,
}

impl<'a> AppendRequest<'a> {
    #[must_use]
    pub(crate) fn new(
        resource: &'a ResourceId,
        fence: &'a Fence,
        expected: Position,
        batch: AppendBatch,
    ) -> Self {
        Self {
            resource,
            fence,
            expected,
            batch,
            guard: AppendGuard::allow(),
        }
    }

    #[must_use]
    pub(crate) fn guarded(mut self, guard: AppendGuard) -> Self {
        self.guard = guard;
        self
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FailPoint {
    BeforeCommit,
    AfterCommitBeforeResponse,
}

#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
pub enum StoreError {
    #[error("invalid {0} identifier")]
    InvalidIdentifier(&'static str),
    #[error("requested limit exceeds the fixed bound")]
    InvalidLimit,
    #[error("ledger resource already exists")]
    ResourceExists,
    #[error("ledger resource does not exist")]
    ResourceNotFound,
    #[error("ledger resource fence is held")]
    FenceHeld,
    #[error("ledger resource fence is stale")]
    StaleFence,
    #[error("ledger resource fence expired")]
    FenceExpired,
    #[error(
        "ledger position conflict: expected {}, actual {}",
        .expected.get(),
        .actual.get()
    )]
    PositionConflict {
        expected: Position,
        actual: Position,
    },
    #[error("ledger position exceeds SQLite range")]
    PositionOverflow,
    #[error("append batch record bound exceeded")]
    BatchRecordBound,
    #[error("append batch byte bound exceeded")]
    BatchByteBound,
    #[error("mutation receipt exceeds fixed bound")]
    ReceiptTooLarge,
    #[error("idempotency key reused with a different mutation")]
    IdempotencyConflict,
    #[error("append was cancelled before its first durable write")]
    AppendCancelled,
    #[error("ledger data is corrupt: {0}")]
    Corrupt(&'static str),
    #[error("ledger failpoint: {0:?}")]
    FailureInjected(FailPoint),
    #[error("ledger storage operation failed")]
    Storage,
}

pub trait LedgerClock: Send + Sync {
    fn now_ms(&self) -> u64;
}

#[derive(Clone, Copy, Debug, Default)]
pub struct SystemLedgerClock;

impl LedgerClock for SystemLedgerClock {
    fn now_ms(&self) -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("system clock must not precede Unix epoch")
            .as_millis()
            .try_into()
            .expect("system clock milliseconds must fit in u64")
    }
}

pub(crate) async fn completed_wait_position(
    store: &dyn LedgerStore,
    probe: WaitProbe<'_>,
) -> Result<Option<Position>, StoreError> {
    if wait_is_complete(probe.position, probe.after, probe.now_ms, probe.deadline_ms) {
        return Ok(Some(probe.position));
    }
    let reread = store.open(probe.resource).await?.position;
    Ok((reread > probe.after).then_some(reread))
}
