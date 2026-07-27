use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use rusqlite::{Connection, OpenFlags, Transaction, TransactionBehavior};
use tokio::sync::Notify;

use super::{
    completed_wait_position, fence_expiry, AppendBatch, AppendGuard, AppendOutcome, AppendRequest,
    DiscoveryPage, FailPoint, Fence, IdempotencyId, LedgerClock, LedgerStore, MutationReceipt,
    OwnerId, Position, PrefixSnapshot, ResourceId, ResourceInfo, StoreError, WaitProbe,
    MAX_DISCOVERY_PAGE,
};
use crate::cluster_ledger::record::{StoredRecord, MAX_RANGE_RECORDS};

mod creation;
mod discovery;
mod lifecycle;
mod operations;
mod queries;
mod schema;
mod settings;
mod transactions;

pub use operations::database_path;
pub use schema::{APPLICATION_ID, SCHEMA_VERSION};
pub use settings::SqliteSettings;
use queries::{query_fence, query_receipt, query_receipts, query_records, to_sql_i64};
use discovery::{
    configure_connection, discover_database, lock_resource_file, remove_database_files,
    validate_schema,
};
use transactions::{acquire_fence_transaction, write_removal_tombstone, FenceAcquisition};

#[derive(Clone)]
pub struct SqliteLedgerStore {
    root: Arc<PathBuf>,
    clock: Arc<dyn LedgerClock>,
    writer: Arc<Mutex<()>>,
    notifications: Arc<Mutex<BTreeMap<ResourceId, Arc<Notify>>>>,
    next_failpoint: Arc<Mutex<Option<FailPoint>>>,
}

struct AppendDecision {
    outcome: AppendOutcome,
    notify: bool,
}

struct RemovalRequest<'a> {
    resource: &'a ResourceId,
    fence: &'a Fence,
    expected: Position,
}

impl SqliteLedgerStore {
    fn take_failpoint(&self, point: FailPoint) -> bool {
        let mut value = self
            .next_failpoint
            .lock()
            .expect("SQLite failpoint mutex must not be poisoned");
        if *value == Some(point) {
            *value = None;
            true
        } else {
            false
        }
    }

    fn notify_for(&self, resource: &ResourceId) -> Arc<Notify> {
        self.notifications
            .lock()
            .expect("SQLite notification mutex must not be poisoned")
            .entry(resource.clone())
            .or_default()
            .clone()
    }

    fn connect_existing(&self, resource: &ResourceId) -> Result<Connection, StoreError> {
        let path = self.path_for(resource);
        if !path.is_file() {
            return Err(StoreError::ResourceNotFound);
        }
        let connection = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(|_| StoreError::Storage)?;
        configure_connection(&connection)?;
        validate_schema(&connection, resource)?;
        Ok(connection)
    }

    fn position(transaction: &Transaction<'_>) -> Result<Position, StoreError> {
        let (count, maximum): (i64, Option<i64>) = transaction
            .query_row("SELECT count(*), max(sequence) FROM records", [], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })
            .map_err(|_| StoreError::Storage)?;
        let maximum = maximum.unwrap_or(0);
        if count != maximum {
            return Err(StoreError::Corrupt("record sequence gap"));
        }
        u64::try_from(maximum)
            .map_err(|_| StoreError::Corrupt("negative record position"))
            .and_then(Position::new)
    }

    fn check_fence_tx(
        &self,
        transaction: &Transaction<'_>,
        fence: &Fence,
    ) -> Result<(), StoreError> {
        let current = query_fence(transaction)?.ok_or(StoreError::StaleFence)?;
        if current != *fence {
            return Err(StoreError::StaleFence);
        }
        if current.expires_at_ms <= self.clock.now_ms() {
            return Err(StoreError::FenceExpired);
        }
        Ok(())
    }

    fn append(&self, request: AppendRequest<'_>) -> Result<AppendOutcome, StoreError> {
        request.batch.validate()?;
        if self.take_failpoint(FailPoint::BeforeCommit) {
            return Err(StoreError::FailureInjected(FailPoint::BeforeCommit));
        }
        let _writer = self
            .writer
            .lock()
            .expect("SQLite writer mutex must not be poisoned");
        let resource = request.resource;
        let mut connection = self.connect_existing(resource)?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| StoreError::Storage)?;
        let decision = self.append_transaction(&transaction, request)?;
        transaction.commit().map_err(|_| StoreError::Storage)?;
        if decision.notify {
            self.notify_for(resource).notify_waiters();
            if self.take_failpoint(FailPoint::AfterCommitBeforeResponse) {
                return Err(StoreError::FailureInjected(
                    FailPoint::AfterCommitBeforeResponse,
                ));
            }
        }
        Ok(decision.outcome)
    }

    fn append_transaction(
        &self,
        transaction: &Transaction<'_>,
        request: AppendRequest<'_>,
    ) -> Result<AppendDecision, StoreError> {
        self.check_fence_tx(transaction, request.fence)?;
        if let Some(outcome) = operations::existing_receipt_outcome(transaction, &request.batch)? {
            return Ok(AppendDecision {
                outcome,
                notify: false,
            });
        }
        let committed_position = operations::validate_append_transaction(
            transaction,
            request.resource,
            request.expected,
            &request.batch,
        )?;
        request.guard.check()?;
        operations::insert_records(transaction, &request.batch.records)?;
        let outcome =
            operations::insert_receipt(transaction, request.batch.receipt, committed_position)?;
        Ok(AppendDecision {
            outcome,
            notify: true,
        })
    }

    fn remove_resource(&self, request: RemovalRequest<'_>) -> Result<(), StoreError> {
        let path = self.path_for(request.resource);
        let _resource_lock = lock_resource_file(&path)?;
        let mut connection = self.connect_existing(request.resource)?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| StoreError::Storage)?;
        self.check_fence_tx(&transaction, request.fence)?;
        let actual = Self::position(&transaction)?;
        if actual != request.expected {
            return Err(StoreError::PositionConflict {
                expected: request.expected,
                actual,
            });
        }
        write_removal_tombstone(&transaction, request.resource, request.expected)?;
        transaction.commit().map_err(|_| StoreError::Storage)?;
        drop(connection);
        remove_database_files(&path)?;
        self.notifications
            .lock()
            .expect("SQLite notification mutex must not be poisoned")
            .remove(request.resource);
        Ok(())
    }
}

#[async_trait]
impl LedgerStore for SqliteLedgerStore {
    async fn discover(
        &self,
        after: Option<&ResourceId>,
        limit: usize,
    ) -> Result<DiscoveryPage, StoreError> {
        if limit == 0 || limit > MAX_DISCOVERY_PAGE {
            return Err(StoreError::InvalidLimit);
        }
        let entries = fs::read_dir(self.root.as_ref()).map_err(|_| StoreError::Storage)?;
        let mut resources = Vec::new();
        for entry in entries {
            let entry = entry.map_err(|_| StoreError::Storage)?;
            if let Some(info) = discover_database(self.root.as_ref(), &entry, after)? {
                resources.push(info);
            }
        }
        resources.sort_by(|left, right| left.resource.cmp(&right.resource));
        let next_after = if resources.len() > limit {
            resources.truncate(limit);
            resources.last().map(|info| info.resource.clone())
        } else {
            None
        };
        Ok(DiscoveryPage {
            resources,
            next_after,
        })
    }

    async fn create(&self, resource: &ResourceId) -> Result<ResourceInfo, StoreError> {
        self.create_resource(resource, None)
    }

    async fn create_fenced(
        &self,
        resource: &ResourceId,
        owner: &OwnerId,
        ttl_ms: u64,
    ) -> Result<(ResourceInfo, Fence), StoreError> {
        let fence = self.initial_fence(resource, owner, ttl_ms)?;
        let info = self.create_resource(resource, Some(&fence))?;
        Ok((info, fence))
    }

    async fn open(&self, resource: &ResourceId) -> Result<ResourceInfo, StoreError> {
        let mut connection = self.connect_existing(resource)?;
        let transaction = connection.transaction().map_err(|_| StoreError::Storage)?;
        let position = Self::position(&transaction)?;
        transaction.commit().map_err(|_| StoreError::Storage)?;
        Ok(ResourceInfo {
            resource: resource.clone(),
            position,
        })
    }

    async fn acquire_fence(
        &self,
        resource: &ResourceId,
        owner: &OwnerId,
        ttl_ms: u64,
    ) -> Result<Fence, StoreError> {
        if ttl_ms == 0 {
            return Err(StoreError::FenceExpired);
        }
        let _writer = self
            .writer
            .lock()
            .expect("SQLite writer mutex must not be poisoned");
        let now = self.clock.now_ms();
        let expires_at_ms = now
            .checked_add(ttl_ms)
            .ok_or(StoreError::PositionOverflow)?;
        if expires_at_ms > i64::MAX as u64 {
            return Err(StoreError::PositionOverflow);
        }
        let mut connection = self.connect_existing(resource)?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| StoreError::Storage)?;
        let fence = acquire_fence_transaction(
            &transaction,
            FenceAcquisition {
                resource,
                owner,
                now,
                expires_at_ms,
            },
        )?;
        transaction.commit().map_err(|_| StoreError::Storage)?;
        Ok(fence)
    }

    async fn renew_fence(&self, fence: &Fence, ttl_ms: u64) -> Result<Fence, StoreError> {
        let _writer = self
            .writer
            .lock()
            .expect("SQLite writer mutex must not be poisoned");
        let expires_at_ms = fence_expiry(self.clock.now_ms(), ttl_ms)?;
        let mut connection = self.connect_existing(&fence.resource)?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| StoreError::Storage)?;
        self.check_fence_tx(&transaction, fence)?;
        transaction
            .execute(
                "UPDATE fence SET expires_at_ms = ?1 WHERE singleton = 1",
                [to_sql_i64(expires_at_ms)?],
            )
            .map_err(|_| StoreError::Storage)?;
        transaction.commit().map_err(|_| StoreError::Storage)?;
        Ok(Fence {
            expires_at_ms,
            ..fence.clone()
        })
    }

    async fn check_fence(&self, fence: &Fence) -> Result<(), StoreError> {
        let mut connection = self.connect_existing(&fence.resource)?;
        let transaction = connection.transaction().map_err(|_| StoreError::Storage)?;
        self.check_fence_tx(&transaction, fence)?;
        transaction.commit().map_err(|_| StoreError::Storage)
    }

    async fn read_prefix(
        &self,
        resource: &ResourceId,
        through: Option<Position>,
    ) -> Result<PrefixSnapshot, StoreError> {
        let mut connection = self.connect_existing(resource)?;
        let transaction = connection.transaction().map_err(|_| StoreError::Storage)?;
        let full_position = Self::position(&transaction)?;
        let position = through.unwrap_or(full_position);
        if position > full_position {
            return Err(StoreError::InvalidLimit);
        }
        let records = query_records(
            &transaction,
            resource,
            Position::ZERO,
            usize::try_from(position.get()).map_err(|_| StoreError::InvalidLimit)?,
        )?;
        let receipts = query_receipts(&transaction, Some(position))?;
        transaction.commit().map_err(|_| StoreError::Storage)?;
        Ok(PrefixSnapshot {
            position,
            records,
            receipts,
        })
    }

    async fn read_range(
        &self,
        resource: &ResourceId,
        after: Position,
        limit: usize,
    ) -> Result<Vec<StoredRecord>, StoreError> {
        if limit == 0 || limit > MAX_RANGE_RECORDS {
            return Err(StoreError::InvalidLimit);
        }
        let mut connection = self.connect_existing(resource)?;
        let transaction = connection.transaction().map_err(|_| StoreError::Storage)?;
        let position = Self::position(&transaction)?;
        if after > position {
            return Err(StoreError::PositionConflict {
                expected: after,
                actual: position,
            });
        }
        let records = query_records(&transaction, resource, after, limit)?;
        transaction.commit().map_err(|_| StoreError::Storage)?;
        Ok(records)
    }

    #[allow(clippy::too_many_arguments, reason = "frozen pre-6.7.2 trait API")]
    async fn compare_and_append(
        &self,
        resource: &ResourceId,
        fence: &Fence,
        expected: Position,
        batch: AppendBatch,
    ) -> Result<AppendOutcome, StoreError> {
        self.append(AppendRequest::new(resource, fence, expected, batch))
    }

    #[allow(clippy::too_many_arguments, reason = "frozen pre-6.7.2 trait API")]
    async fn compare_and_append_guarded(
        &self,
        resource: &ResourceId,
        fence: &Fence,
        expected: Position,
        batch: AppendBatch,
        guard: AppendGuard,
    ) -> Result<AppendOutcome, StoreError> {
        self.append(AppendRequest::new(resource, fence, expected, batch).guarded(guard))
    }

    async fn lookup_receipt(
        &self,
        resource: &ResourceId,
        key: &IdempotencyId,
    ) -> Result<Option<MutationReceipt>, StoreError> {
        let mut connection = self.connect_existing(resource)?;
        let transaction = connection.transaction().map_err(|_| StoreError::Storage)?;
        let receipt = query_receipt(&transaction, key)?;
        transaction.commit().map_err(|_| StoreError::Storage)?;
        Ok(receipt)
    }

    async fn wait_for_advance(
        &self,
        resource: &ResourceId,
        after: Position,
        deadline_ms: u64,
    ) -> Result<Position, StoreError> {
        loop {
            let notified = self.notify_for(resource).notified_owned();
            let position = self.open(resource).await?.position;
            let probe = WaitProbe {
                resource,
                position,
                after,
                now_ms: self.clock.now_ms(),
                deadline_ms,
            };
            if let Some(completed) = completed_wait_position(self, probe).await? {
                return Ok(completed);
            }
            tokio::select! {
                () = notified => {}
                () = tokio::time::sleep(Duration::from_millis(1)) => {}
            }
        }
    }

    async fn remove(
        &self,
        resource: &ResourceId,
        fence: &Fence,
        expected: Position,
    ) -> Result<(), StoreError> {
        if self.take_failpoint(FailPoint::BeforeCommit) {
            return Err(StoreError::FailureInjected(FailPoint::BeforeCommit));
        }
        let _writer = self
            .writer
            .lock()
            .expect("SQLite writer mutex must not be poisoned");
        self.remove_resource(RemovalRequest {
            resource,
            fence,
            expected,
        })?;
        if self.take_failpoint(FailPoint::AfterCommitBeforeResponse) {
            return Err(StoreError::FailureInjected(
                FailPoint::AfterCommitBeforeResponse,
            ));
        }
        Ok(())
    }
}
