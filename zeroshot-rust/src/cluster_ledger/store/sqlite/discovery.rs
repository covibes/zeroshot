use std::fs::{self, File, OpenOptions};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use fs2::FileExt;
use rusqlite::{params, Connection, OpenFlags, OptionalExtension, Transaction, TransactionBehavior};

use super::super::{Fence, Position, ResourceId, ResourceInfo, StoreError};
use super::queries::to_sql_i64;
use super::{database_path, schema, APPLICATION_ID, SCHEMA_VERSION};

static NEXT_CREATE_FILE: AtomicU64 = AtomicU64::new(1);

pub(super) fn discover_database(
    root: &Path,
    entry: &fs::DirEntry,
    after: Option<&ResourceId>,
) -> Result<Option<ResourceInfo>, StoreError> {
    let Some(path) = database_entry_path(entry)? else {
        return Ok(None);
    };
    let connection = Connection::open_with_flags(
        &path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|_| StoreError::Storage)?;
    configure_connection(&connection)?;
    validate_versions(&connection)?;
    let identity = discover_resource(&connection)?;
    let resource = identity.resource();
    if database_path(root, &resource) != path {
        return Err(StoreError::Corrupt("database filename"));
    }
    if matches!(identity, DatabaseIdentity::Removed(_)) {
        return Ok(None);
    }
    discover_live_resource(&connection, resource, after)
}

fn database_entry_path(entry: &fs::DirEntry) -> Result<Option<PathBuf>, StoreError> {
    let path = entry.path();
    if path.extension().and_then(|value| value.to_str()) != Some("sqlite3") {
        return Ok(None);
    }
    if !entry
        .file_type()
        .map_err(|_| StoreError::Storage)?
        .is_file()
    {
        return Err(StoreError::Corrupt("database entry type"));
    }
    Ok(Some(path))
}

fn discover_live_resource(
    connection: &Connection,
    resource: ResourceId,
    after: Option<&ResourceId>,
) -> Result<Option<ResourceInfo>, StoreError> {
    validate_schema(connection, &resource)?;
    let (count, maximum): (i64, Option<i64>) = connection
        .query_row("SELECT count(*), max(sequence) FROM records", [], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })
        .map_err(|_| StoreError::Storage)?;
    if count != maximum.unwrap_or(0) {
        return Err(StoreError::Corrupt("record sequence gap"));
    }
    if after.is_some_and(|after| resource <= *after) {
        return Ok(None);
    }
    Ok(Some(ResourceInfo {
        resource,
        position: Position::new(
            u64::try_from(count).map_err(|_| StoreError::Corrupt("negative record count"))?,
        )?,
    }))
}

fn initialize_database(
    path: &Path,
    resource: &ResourceId,
    initial_fence: Option<&Fence>,
) -> Result<(), StoreError> {
    let mut connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_WRITE
            | OpenFlags::SQLITE_OPEN_CREATE
            | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|_| StoreError::Storage)?;
    configure_connection(&connection)?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|_| StoreError::Storage)?;
    let table_count: i64 = transaction
        .query_row(
            "SELECT count(*) FROM sqlite_master
             WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
            [],
            |row| row.get(0),
        )
        .map_err(|_| StoreError::Storage)?;
    if table_count == 0 {
        initialize_fresh_database(&transaction, resource, initial_fence)?;
    } else {
        reinitialize_removed_database(&transaction, resource, initial_fence)?;
    }
    transaction.commit().map_err(|_| StoreError::Storage)
}

pub(super) fn create_or_reinitialize_database(
    path: &Path,
    resource: &ResourceId,
    initial_fence: Option<&Fence>,
) -> Result<(), StoreError> {
    if path.exists() {
        return initialize_database(path, resource, initial_fence);
    }
    let temporary_path = temporary_database_path(path);
    let initialized = initialize_database(&temporary_path, resource, initial_fence);
    if let Err(error) = initialized {
        let _ = remove_database_files(&temporary_path);
        return Err(error);
    }
    link_initialized_database(path, resource, initial_fence, &temporary_path)
}

fn link_initialized_database(
    path: &Path,
    resource: &ResourceId,
    initial_fence: Option<&Fence>,
    temporary_path: &Path,
) -> Result<(), StoreError> {
    match fs::hard_link(temporary_path, path) {
        Ok(()) => {
            remove_database_files(temporary_path)?;
            Ok(())
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            remove_database_files(temporary_path)?;
            initialize_database(path, resource, initial_fence)
        }
        Err(_) => {
            let _ = remove_database_files(temporary_path);
            Err(StoreError::Storage)
        }
    }
}

pub(super) fn lock_resource_file(path: &Path) -> Result<File, StoreError> {
    let lock_path = PathBuf::from(format!("{}.lock", path.display()));
    let file = OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .truncate(false)
        .open(lock_path)
        .map_err(|_| StoreError::Storage)?;
    FileExt::lock_exclusive(&file).map_err(|_| StoreError::Storage)?;
    Ok(file)
}

fn temporary_database_path(path: &Path) -> PathBuf {
    let sequence = NEXT_CREATE_FILE.fetch_add(1, Ordering::Relaxed);
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |duration| duration.as_nanos());
    PathBuf::from(format!(
        "{}.creating-{}-{timestamp}-{sequence}",
        path.display(),
        std::process::id()
    ))
}

fn initialize_fresh_database(
    transaction: &Transaction<'_>,
    resource: &ResourceId,
    initial_fence: Option<&Fence>,
) -> Result<(), StoreError> {
    transaction
        .pragma_update(None, "application_id", APPLICATION_ID)
        .map_err(|_| StoreError::Storage)?;
    transaction
        .pragma_update(None, "user_version", SCHEMA_VERSION)
        .map_err(|_| StoreError::Storage)?;
    transaction
        .execute_batch(schema::CREATE_SCHEMA)
        .map_err(|_| StoreError::Storage)?;
    insert_resource_identity(transaction, resource, initial_fence)
}

fn reinitialize_removed_database(
    transaction: &Transaction<'_>,
    resource: &ResourceId,
    initial_fence: Option<&Fence>,
) -> Result<(), StoreError> {
    validate_versions(transaction)?;
    match discover_resource(transaction)? {
        DatabaseIdentity::Live(stored) if stored == *resource => {
            return Err(StoreError::ResourceExists);
        }
        DatabaseIdentity::Removed(stored) if stored == *resource => {}
        DatabaseIdentity::Live(_) | DatabaseIdentity::Removed(_) => {
            return Err(StoreError::Corrupt("resource identity"));
        }
    }
    transaction
        .execute("DELETE FROM removal_tombstone", [])
        .map_err(|_| StoreError::Storage)?;
    insert_resource_identity(transaction, resource, initial_fence)
}

fn insert_resource_identity(
    transaction: &Transaction<'_>,
    resource: &ResourceId,
    initial_fence: Option<&Fence>,
) -> Result<(), StoreError> {
    transaction
        .execute(
            "INSERT INTO metadata(singleton, resource_id) VALUES (1, ?1)",
            [resource.as_str()],
        )
        .map_err(|_| StoreError::Storage)?;
    if let Some(fence) = initial_fence {
        insert_initial_fence(transaction, fence)?;
    }
    Ok(())
}

fn insert_initial_fence(transaction: &Transaction<'_>, fence: &Fence) -> Result<(), StoreError> {
    transaction
        .execute(
            "INSERT INTO fence(singleton, owner_id, epoch, expires_at_ms)
             VALUES (1, ?1, ?2, ?3)",
            params![
                fence.owner.as_str(),
                to_sql_i64(fence.epoch)?,
                to_sql_i64(fence.expires_at_ms)?
            ],
        )
        .map_err(|_| StoreError::Storage)?;
    Ok(())
}

pub(super) fn remove_database_files(path: &Path) -> Result<(), StoreError> {
    for candidate in [
        path.to_path_buf(),
        PathBuf::from(format!("{}-wal", path.display())),
        PathBuf::from(format!("{}-shm", path.display())),
    ] {
        match fs::remove_file(candidate) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err(StoreError::Storage),
        }
    }
    Ok(())
}

pub(super) fn configure_connection(connection: &Connection) -> Result<(), StoreError> {
    connection
        .busy_timeout(Duration::from_millis(5_000))
        .map_err(|_| StoreError::Storage)?;
    connection
        .pragma_update(None, "journal_mode", "WAL")
        .map_err(|_| StoreError::Storage)?;
    connection
        .pragma_update(None, "synchronous", "FULL")
        .map_err(|_| StoreError::Storage)?;
    connection
        .pragma_update(None, "foreign_keys", "ON")
        .map_err(|_| StoreError::Storage)?;
    Ok(())
}

pub(super) fn validate_schema(
    connection: &Connection,
    resource: &ResourceId,
) -> Result<(), StoreError> {
    validate_versions(connection)?;
    let stored: Option<String> = connection
        .query_row(
            "SELECT resource_id FROM metadata WHERE singleton = 1",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|_| StoreError::Storage)?;
    match stored {
        Some(stored) if stored == resource.as_str() => {
            if removal_tombstone(connection)?.is_some() {
                Err(StoreError::Corrupt("live resource has removal tombstone"))
            } else {
                Ok(())
            }
        }
        Some(_) => Err(StoreError::Corrupt("resource identity")),
        None => {
            verify_removed_database(connection, resource)?;
            Err(StoreError::ResourceNotFound)
        }
    }
}

fn validate_versions(connection: &Connection) -> Result<(), StoreError> {
    let application_id: i64 = connection
        .pragma_query_value(None, "application_id", |row| row.get(0))
        .map_err(|_| StoreError::Storage)?;
    let schema_version: i64 = connection
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(|_| StoreError::Storage)?;
    if application_id != i64::from(APPLICATION_ID) {
        return Err(StoreError::Corrupt("application version"));
    }
    if schema_version != SCHEMA_VERSION {
        return Err(StoreError::Corrupt("schema version"));
    }
    Ok(())
}

enum DatabaseIdentity {
    Live(ResourceId),
    Removed(ResourceId),
}

impl DatabaseIdentity {
    fn resource(&self) -> ResourceId {
        match self {
            Self::Live(resource) | Self::Removed(resource) => resource.clone(),
        }
    }
}

fn discover_resource(connection: &Connection) -> Result<DatabaseIdentity, StoreError> {
    let stored: Option<String> = connection
        .query_row(
            "SELECT resource_id FROM metadata WHERE singleton = 1",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|_| StoreError::Storage)?;
    if let Some(stored) = stored {
        if removal_tombstone(connection)?.is_some() {
            return Err(StoreError::Corrupt("live resource has removal tombstone"));
        }
        return ResourceId::new(stored)
            .map(DatabaseIdentity::Live)
            .map_err(|_| StoreError::Corrupt("resource identifier"));
    }
    let Some((resource, _)) = removal_tombstone(connection)? else {
        return Err(StoreError::Corrupt("missing resource identity"));
    };
    verify_removed_database(connection, &resource)?;
    Ok(DatabaseIdentity::Removed(resource))
}

fn removal_tombstone(
    connection: &Connection,
) -> Result<Option<(ResourceId, Position)>, StoreError> {
    connection
        .query_row(
            "SELECT resource_id, removed_position
             FROM removal_tombstone WHERE singleton = 1",
            [],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
        )
        .optional()
        .map_err(|_| StoreError::Storage)?
        .map(|(resource, position)| {
            Ok((
                ResourceId::new(resource)
                    .map_err(|_| StoreError::Corrupt("removed resource identifier"))?,
                Position::new(
                    u64::try_from(position).map_err(|_| StoreError::Corrupt("removed position"))?,
                )?,
            ))
        })
        .transpose()
}

fn verify_removed_database(
    connection: &Connection,
    resource: &ResourceId,
) -> Result<(), StoreError> {
    let tombstone =
        removal_tombstone(connection)?.ok_or(StoreError::Corrupt("missing resource identity"))?;
    if tombstone.0 != *resource {
        return Err(StoreError::Corrupt("removed resource identity"));
    }
    for table in ["records", "receipts", "fence", "metadata"] {
        let query = format!("SELECT count(*) FROM {table}");
        let count: i64 = connection
            .query_row(&query, [], |row| row.get(0))
            .map_err(|_| StoreError::Storage)?;
        if count != 0 {
            return Err(StoreError::Corrupt("nonempty removed resource"));
        }
    }
    Ok(())
}
