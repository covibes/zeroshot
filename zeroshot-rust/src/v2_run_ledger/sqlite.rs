//! Minimal local durable adapter for the native-v2 run ledger port.

use std::path::Path;
use std::sync::{Arc, Mutex, MutexGuard};

use async_trait::async_trait;
use openengine_cluster_protocol::{Cursor, IdempotencyKey, RunId};
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};

use super::{
    AppendResult, CreateRun, CreateRunOutcome, RunEvent, RunLedger, RunLedgerError, RunSummary,
    SnapshotAndTail, StoredRun, StoredRunEvent, apply_event, cursor_for, cursor_sequence,
    validate_create,
};

const SCHEMA: &str = "
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS v2_runs (
    run_id TEXT PRIMARY KEY NOT NULL,
    submission_key TEXT UNIQUE NOT NULL,
    submission_digest TEXT NOT NULL,
    cursor INTEGER NOT NULL,
    stored_json TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS v2_run_events (
    run_id TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    event_json TEXT NOT NULL,
    PRIMARY KEY (run_id, sequence),
    FOREIGN KEY (run_id) REFERENCES v2_runs(run_id) ON DELETE CASCADE
) STRICT;
";

#[derive(Clone)]
pub struct SqliteRunLedger {
    connection: Arc<Mutex<Connection>>,
}

impl SqliteRunLedger {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, RunLedgerError> {
        let connection = Connection::open(path).map_err(|_| RunLedgerError::Storage)?;
        Self::from_connection(connection)
    }

    pub fn open_in_memory() -> Result<Self, RunLedgerError> {
        let connection = Connection::open_in_memory().map_err(|_| RunLedgerError::Storage)?;
        Self::from_connection(connection)
    }

    fn from_connection(connection: Connection) -> Result<Self, RunLedgerError> {
        connection
            .execute_batch(SCHEMA)
            .map_err(|_| RunLedgerError::Storage)?;
        Ok(Self {
            connection: Arc::new(Mutex::new(connection)),
        })
    }

    fn connection(&self) -> MutexGuard<'_, Connection> {
        self.connection
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

#[async_trait]
impl RunLedger for SqliteRunLedger {
    async fn create_or_get(&self, request: CreateRun) -> Result<CreateRunOutcome, RunLedgerError> {
        validate_create(&request)?;
        let mut connection = self.connection();
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| RunLedgerError::Storage)?;
        let outcome = match existing_submission(&transaction, &request)? {
            Some(existing) => CreateRunOutcome::Existing(existing),
            None => CreateRunOutcome::Created(insert_new_run(&transaction, request)?),
        };
        transaction.commit().map_err(|_| RunLedgerError::Storage)?;
        Ok(outcome)
    }

    async fn get(&self, run_id: &RunId) -> Result<Option<StoredRun>, RunLedgerError> {
        load_by_id(&self.connection(), run_id)
    }

    async fn get_by_submission_key(
        &self,
        submission_key: &IdempotencyKey,
    ) -> Result<Option<StoredRun>, RunLedgerError> {
        load_by_submission(&self.connection(), submission_key.as_str())
            .map(|stored| stored.map(|(_, _, stored)| stored))
    }

    async fn list(&self) -> Result<Vec<RunSummary>, RunLedgerError> {
        let connection = self.connection();
        let mut statement = connection
            .prepare("SELECT stored_json FROM v2_runs ORDER BY rowid")
            .map_err(|_| RunLedgerError::Storage)?;
        let rows = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|_| RunLedgerError::Storage)?;
        rows.map(|row| {
            let stored: StoredRun =
                serde_json::from_str(&row.map_err(|_| RunLedgerError::Storage)?)
                    .map_err(|_| RunLedgerError::Corrupt)?;
            Ok(RunSummary::from(&stored.snapshot))
        })
        .collect()
    }

    async fn append(
        &self,
        run_id: &RunId,
        events: Vec<RunEvent>,
    ) -> Result<AppendResult, RunLedgerError> {
        let mut connection = self.connection();
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| RunLedgerError::Storage)?;
        let result = append_transaction(&transaction, run_id, events)?;
        transaction.commit().map_err(|_| RunLedgerError::Storage)?;
        Ok(result)
    }

    async fn request_force_stop(&self, run_id: &RunId) -> Result<AppendResult, RunLedgerError> {
        let mut connection = self.connection();
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| RunLedgerError::Storage)?;
        let stored = load_by_id(&transaction, run_id)?.ok_or(RunLedgerError::RunNotFound)?;
        let result = if stored.snapshot.force_stop_requested || stored.snapshot.terminal.is_some() {
            AppendResult {
                snapshot: stored.snapshot,
                events: Vec::new(),
            }
        } else {
            append_transaction(&transaction, run_id, vec![RunEvent::ForceStopRequested])?
        };
        transaction.commit().map_err(|_| RunLedgerError::Storage)?;
        Ok(result)
    }

    async fn snapshot_and_tail(
        &self,
        run_id: &RunId,
        after: Option<&Cursor>,
    ) -> Result<SnapshotAndTail, RunLedgerError> {
        // This mutex is the adapter's entire atomic snapshot/tail handoff. A cloud implementation
        // provides the equivalent transaction behind the same port.
        let connection = self.connection();
        let stored = load_by_id(&connection, run_id)?.ok_or(RunLedgerError::RunNotFound)?;
        let after = after.map_or(Ok(0), cursor_sequence)?;
        let current = cursor_sequence(&stored.snapshot.cursor)?;
        if after > current {
            return Err(RunLedgerError::CursorAhead);
        }
        let after = i64::try_from(after).map_err(|_| RunLedgerError::CursorAhead)?;
        let mut statement = connection
            .prepare(
                "SELECT sequence, event_json FROM v2_run_events
                 WHERE run_id = ?1 AND sequence > ?2 ORDER BY sequence",
            )
            .map_err(|_| RunLedgerError::Storage)?;
        let rows = statement
            .query_map(params![run_id.as_str(), after], |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|_| RunLedgerError::Storage)?;
        let events = rows
            .map(|row| {
                let (sequence, json) = row.map_err(|_| RunLedgerError::Storage)?;
                let sequence = u64::try_from(sequence).map_err(|_| RunLedgerError::Corrupt)?;
                let event = serde_json::from_str(&json).map_err(|_| RunLedgerError::Corrupt)?;
                Ok(StoredRunEvent {
                    cursor: cursor_for(sequence),
                    event,
                })
            })
            .collect::<Result<Vec<_>, _>>()?;
        Ok(SnapshotAndTail {
            snapshot: stored.snapshot,
            events,
        })
    }
}

fn append_transaction(
    transaction: &Transaction<'_>,
    run_id: &RunId,
    events: Vec<RunEvent>,
) -> Result<AppendResult, RunLedgerError> {
    require_events(&events)?;
    let stored = load_by_id(transaction, run_id)?.ok_or(RunLedgerError::RunNotFound)?;
    let sequence = cursor_sequence(&stored.snapshot.cursor)?;
    let mut append = PendingAppend {
        transaction,
        run_id,
        stored,
        sequence,
    };
    let appended = append.events(events)?;
    update_stored_run(transaction, run_id, append.sequence, &append.stored)?;
    Ok(AppendResult {
        snapshot: append.stored.snapshot,
        events: appended,
    })
}

fn require_events(events: &[RunEvent]) -> Result<(), RunLedgerError> {
    if events.is_empty() {
        Err(RunLedgerError::InvalidEvent("event batch is empty"))
    } else {
        Ok(())
    }
}

struct PendingAppend<'a, 'connection> {
    transaction: &'a Transaction<'connection>,
    run_id: &'a RunId,
    stored: StoredRun,
    sequence: u64,
}

impl PendingAppend<'_, '_> {
    fn events(&mut self, events: Vec<RunEvent>) -> Result<Vec<StoredRunEvent>, RunLedgerError> {
        let mut appended = Vec::with_capacity(events.len());
        for event in events {
            appended.push(self.one_event(event)?);
        }
        Ok(appended)
    }

    fn one_event(&mut self, event: RunEvent) -> Result<StoredRunEvent, RunLedgerError> {
        self.sequence = next_sequence(self.sequence)?;
        apply_event(&mut self.stored.snapshot, &event, self.sequence)?;
        insert_event(self.transaction, self.run_id, self.sequence, &event)?;
        Ok(StoredRunEvent {
            cursor: cursor_for(self.sequence),
            event,
        })
    }
}

fn next_sequence(current: u64) -> Result<u64, RunLedgerError> {
    let next = current.checked_add(1).ok_or(RunLedgerError::Storage)?;
    i64::try_from(next).map_err(|_| RunLedgerError::Storage)?;
    Ok(next)
}

fn insert_event(
    transaction: &Transaction<'_>,
    run_id: &RunId,
    sequence: u64,
    event: &RunEvent,
) -> Result<(), RunLedgerError> {
    let event_json = serde_json::to_string(event).map_err(|_| RunLedgerError::Storage)?;
    transaction
        .execute(
            "INSERT INTO v2_run_events (run_id, sequence, event_json) VALUES (?1, ?2, ?3)",
            params![run_id.as_str(), sequence as i64, event_json],
        )
        .map_err(|_| RunLedgerError::Storage)?;
    Ok(())
}

fn update_stored_run(
    transaction: &Transaction<'_>,
    run_id: &RunId,
    sequence: u64,
    stored: &StoredRun,
) -> Result<(), RunLedgerError> {
    let stored_json = serde_json::to_string(&stored).map_err(|_| RunLedgerError::Storage)?;
    let changed = transaction
        .execute(
            "UPDATE v2_runs SET cursor = ?2, stored_json = ?3 WHERE run_id = ?1",
            params![run_id.as_str(), sequence as i64, stored_json],
        )
        .map_err(|_| RunLedgerError::Storage)?;
    if changed != 1 {
        return Err(RunLedgerError::Corrupt);
    }
    Ok(())
}

fn existing_submission(
    transaction: &Transaction<'_>,
    request: &CreateRun,
) -> Result<Option<StoredRun>, RunLedgerError> {
    let Some((existing_id, digest, existing)) =
        load_by_submission(transaction, request.submission_key.as_str())?
    else {
        require_unused_run_id(transaction, &request.run_id)?;
        return Ok(None);
    };
    if digest == request.submission_digest.as_str() && existing.admitted == request.admitted {
        Ok(Some(existing))
    } else {
        Err(RunLedgerError::SubmissionConflict {
            existing_run_id: RunId::new(existing_id),
        })
    }
}

fn require_unused_run_id(
    transaction: &Transaction<'_>,
    run_id: &RunId,
) -> Result<(), RunLedgerError> {
    if load_by_id(transaction, run_id)?.is_some() {
        Err(RunLedgerError::RunIdConflict)
    } else {
        Ok(())
    }
}

fn insert_new_run(
    transaction: &Transaction<'_>,
    request: CreateRun,
) -> Result<StoredRun, RunLedgerError> {
    let snapshot = super::RunSnapshot::admitted(request.run_id.clone(), &request.admitted);
    let stored = StoredRun {
        submission_key: request.submission_key,
        submission_digest: request.submission_digest,
        admitted: request.admitted,
        snapshot,
    };
    let stored_json = serde_json::to_string(&stored).map_err(|_| RunLedgerError::Storage)?;
    transaction
        .execute(
            "INSERT INTO v2_runs
             (run_id, submission_key, submission_digest, cursor, stored_json)
             VALUES (?1, ?2, ?3, 0, ?4)",
            params![
                request.run_id.as_str(),
                stored.submission_key.as_str(),
                stored.submission_digest.as_str(),
                stored_json,
            ],
        )
        .map_err(|_| RunLedgerError::Storage)?;
    Ok(stored)
}

fn load_by_id(
    connection: &Connection,
    run_id: &RunId,
) -> Result<Option<StoredRun>, RunLedgerError> {
    let row = connection
        .query_row(
            "SELECT cursor, stored_json FROM v2_runs WHERE run_id = ?1",
            [run_id.as_str()],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()
        .map_err(|_| RunLedgerError::Storage)?;
    row.map(|(cursor, json)| decode_stored(run_id, cursor, &json))
        .transpose()
}

fn load_by_submission(
    connection: &Connection,
    submission_key: &str,
) -> Result<Option<(String, String, StoredRun)>, RunLedgerError> {
    let row = connection
        .query_row(
            "SELECT run_id, submission_digest, cursor, stored_json
             FROM v2_runs WHERE submission_key = ?1",
            [submission_key],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, String>(3)?,
                ))
            },
        )
        .optional()
        .map_err(|_| RunLedgerError::Storage)?;
    row.map(|(run_id, digest, cursor, json)| {
        let stored = decode_stored(&RunId::new(run_id.clone()), cursor, &json)?;
        Ok((run_id, digest, stored))
    })
    .transpose()
}

fn decode_stored(
    expected_run_id: &RunId,
    cursor: i64,
    json: &str,
) -> Result<StoredRun, RunLedgerError> {
    let stored: StoredRun = serde_json::from_str(json).map_err(|_| RunLedgerError::Corrupt)?;
    let cursor = u64::try_from(cursor).map_err(|_| RunLedgerError::Corrupt)?;
    if stored.snapshot.run_id != *expected_run_id
        || cursor_sequence(&stored.snapshot.cursor)? != cursor
    {
        return Err(RunLedgerError::Corrupt);
    }
    Ok(stored)
}
