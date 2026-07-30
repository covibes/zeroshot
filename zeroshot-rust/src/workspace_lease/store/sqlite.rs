use std::fs::{self, File, OpenOptions};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use fs2::FileExt;
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};

use super::{
    CreateLeaseOutcome, WorkspaceLeaseOperationGuard, WorkspaceLeaseStore, WorkspaceLeaseTransition,
};
use crate::workspace_lease::{
    WorkspaceLeaseError, WorkspaceLeaseErrorKind, WorkspaceLeaseId, WorkspaceLeaseRecord,
    WorkspaceLeaseState,
};

const MAX_RECORD_BYTES: usize = 65_536;
const APPLICATION_ID: i32 = 0x5a_57_4c_53;

#[cfg(target_os = "linux")]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct DatabaseIdentity {
    device: u64,
    inode: u64,
}

#[cfg(not(target_os = "linux"))]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct DatabaseIdentity;
/// Ephemeral observers for deterministic filesystem-boundary verification.
#[derive(Clone, Default)]
pub struct SqliteWorkspaceLeaseHooks {
    pub lock_contention: Option<Arc<dyn Fn() + Send + Sync>>,
    pub before_connection_open: Option<Arc<dyn Fn() + Send + Sync>>,
    pub after_connection_open: Option<Arc<dyn Fn() + Send + Sync>>,
    pub after_operation_lock: Option<Arc<dyn Fn() + Send + Sync>>,
}

pub struct SqliteWorkspaceLeaseStore {
    path: PathBuf,
    identity: DatabaseIdentity,
    writer: Mutex<()>,
    hooks: SqliteWorkspaceLeaseHooks,
}

impl SqliteWorkspaceLeaseStore {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, WorkspaceLeaseError> {
        Self::open_inner(path.as_ref(), SqliteWorkspaceLeaseHooks::default())
    }

    /// Opens a store with ephemeral filesystem-boundary observers.
    pub fn open_with_hooks(
        path: impl AsRef<Path>,
        hooks: SqliteWorkspaceLeaseHooks,
    ) -> Result<Self, WorkspaceLeaseError> {
        Self::open_inner(path.as_ref(), hooks)
    }

    fn open_inner(
        requested_path: &Path,
        hooks: SqliteWorkspaceLeaseHooks,
    ) -> Result<Self, WorkspaceLeaseError> {
        #[cfg(not(target_os = "linux"))]
        {
            let _ = (requested_path, hooks);
            Err(store_error(
                "SQLite workspace leases require Linux descriptor-backed file identity",
            ))
        }
        #[cfg(target_os = "linux")]
        {
            let requested_parent = requested_path
                .parent()
                .ok_or_else(|| store_error("lease store path has no parent"))?;
            fs::create_dir_all(requested_parent)
                .map_err(|_| store_error("lease store directory unavailable"))?;
            let path = match fs::canonicalize(requested_path) {
                Ok(path) => path,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    create_private_file(requested_path)?;
                    fs::canonicalize(requested_path)
                        .map_err(|_| store_error("lease store identity unavailable"))?
                }
                Err(_) => return Err(store_error("lease store identity unavailable")),
            };
            create_private_file(&path)?;
            let identity = database_identity(&path)?;
            let store = Self {
                path,
                identity,
                writer: Mutex::new(()),
                hooks,
            };
            let connection = store.connect()?;
            connection
                .execute_batch(&format!(
                    "PRAGMA application_id = {APPLICATION_ID};
                     PRAGMA user_version = 1;
                     PRAGMA journal_mode = WAL;
                     PRAGMA synchronous = FULL;
                     CREATE TABLE IF NOT EXISTS workspace_leases (
                         lease_id TEXT PRIMARY KEY NOT NULL,
                         owner_id TEXT NOT NULL,
                         state TEXT NOT NULL,
                         revision INTEGER NOT NULL CHECK (revision >= 0),
                         record BLOB NOT NULL
                     ) STRICT;"
                ))
                .map_err(|_| store_error("lease store schema unavailable"))?;
            Ok(store)
        }
    }

    fn connect(&self) -> Result<Connection, WorkspaceLeaseError> {
        #[cfg(not(target_os = "linux"))]
        {
            Err(store_error(
                "SQLite workspace leases require Linux descriptor-backed file identity",
            ))
        }
        #[cfg(target_os = "linux")]
        {
            validate_database_identity(&self.path, self.identity)?;
            let file = open_existing_database(&self.path)?;
            validate_file_identity(&file, self.identity)?;
            if let Some(hook) = &self.hooks.before_connection_open {
                hook();
            }
            let connection = Connection::open(descriptor_path(&file))
                .map_err(|_| store_error("lease store database unavailable"))?;
            if let Some(hook) = &self.hooks.after_connection_open {
                hook();
            }
            validate_file_identity(&file, self.identity)?;
            validate_database_identity(&self.path, self.identity)?;
            let application_id: i32 = connection
                .pragma_query_value(None, "application_id", |row| row.get(0))
                .map_err(|_| store_error("lease store identity unavailable"))?;
            if application_id != 0 && application_id != APPLICATION_ID {
                return Err(store_error("lease store identity mismatch"));
            }
            connection
                .busy_timeout(std::time::Duration::from_secs(5))
                .map_err(|_| store_error("lease store busy timeout unavailable"))?;
            Ok(connection)
        }
    }
}

struct SqliteOperationGuard {
    file: File,
}

impl WorkspaceLeaseOperationGuard for SqliteOperationGuard {}

impl Drop for SqliteOperationGuard {
    fn drop(&mut self) {
        let _ = FileExt::unlock(&self.file);
    }
}

#[async_trait]
impl WorkspaceLeaseStore for SqliteWorkspaceLeaseStore {
    async fn acquire_operation(
        &self,
        _id: &WorkspaceLeaseId,
        _owner: &crate::cluster_ledger::OwnerId,
    ) -> Result<Box<dyn WorkspaceLeaseOperationGuard>, WorkspaceLeaseError> {
        validate_database_identity(&self.path, self.identity)?;
        let file = open_existing_database(&self.path)?;
        validate_file_identity(&file, self.identity)?;
        loop {
            match file.try_lock_exclusive() {
                Ok(()) => {
                    if let Some(hook) = &self.hooks.after_operation_lock {
                        hook();
                    }
                    validate_database_identity(&self.path, self.identity)?;
                    return Ok(Box::new(SqliteOperationGuard { file }));
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    if let Some(hook) = &self.hooks.lock_contention {
                        hook();
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(5)).await;
                }
                Err(_) => return Err(store_error("lease operation lock unavailable")),
            }
        }
    }

    async fn load(
        &self,
        id: &WorkspaceLeaseId,
    ) -> Result<Option<WorkspaceLeaseRecord>, WorkspaceLeaseError> {
        let connection = self.connect()?;
        load_record(&connection, id)
    }

    async fn create_pending(
        &self,
        record: WorkspaceLeaseRecord,
    ) -> Result<CreateLeaseOutcome, WorkspaceLeaseError> {
        validate_new_record(&record)?;
        let bytes = encode_record(&record)?;
        let _writer = self.writer.lock().expect("workspace lease writer mutex");
        let mut connection = self.connect()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| store_error("lease store transaction unavailable"))?;
        let inserted = transaction
            .execute(
                "INSERT OR IGNORE INTO workspace_leases
                 (lease_id, owner_id, state, revision, record) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    record.id.resource_id().as_str(),
                    record.owner.as_str(),
                    state_name(record.state),
                    to_sql_revision(record.revision)?,
                    bytes
                ],
            )
            .map_err(|_| store_error("lease intent could not be committed"))?;
        let outcome = if inserted == 1 {
            CreateLeaseOutcome::Created(record)
        } else {
            CreateLeaseOutcome::Existing(
                load_record(&transaction, &record.id)?
                    .ok_or_else(|| store_error("existing lease disappeared"))?,
            )
        };
        transaction
            .commit()
            .map_err(|_| store_error("lease intent commit failed"))?;
        Ok(outcome)
    }

    async fn transition(
        &self,
        request: WorkspaceLeaseTransition,
    ) -> Result<WorkspaceLeaseRecord, WorkspaceLeaseError> {
        let _writer = self.writer.lock().expect("workspace lease writer mutex");
        let mut connection = self.connect()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| store_error("lease store transaction unavailable"))?;
        let mut current = load_record(&transaction, &request.id)?.ok_or_else(|| {
            WorkspaceLeaseError::new(
                WorkspaceLeaseErrorKind::NotFound,
                "workspace lease does not exist",
            )
        })?;
        if current.owner != request.owner {
            return Err(WorkspaceLeaseError::new(
                WorkspaceLeaseErrorKind::OwnerMismatch,
                "workspace lease owner fence mismatch",
            ));
        }
        if current.revision != request.expected_revision || current.state != request.expected_state
        {
            return Err(WorkspaceLeaseError::new(
                WorkspaceLeaseErrorKind::Conflict,
                "workspace lease transition lost a compare-and-set race",
            ));
        }
        if !legal_transition(current.state, request.next_state) {
            return Err(WorkspaceLeaseError::new(
                WorkspaceLeaseErrorKind::Conflict,
                "illegal workspace lease state transition",
            ));
        }
        current.revision = current.revision.checked_add(1).ok_or_else(|| {
            WorkspaceLeaseError::new(
                WorkspaceLeaseErrorKind::Conflict,
                "workspace lease revision overflow",
            )
        })?;
        current.state = request.next_state;
        let bytes = encode_record(&current)?;
        let changed = transaction
            .execute(
                "UPDATE workspace_leases SET state = ?1, revision = ?2, record = ?3
                 WHERE lease_id = ?4 AND owner_id = ?5 AND state = ?6 AND revision = ?7",
                params![
                    state_name(current.state),
                    to_sql_revision(current.revision)?,
                    bytes,
                    current.id.resource_id().as_str(),
                    current.owner.as_str(),
                    state_name(request.expected_state),
                    to_sql_revision(request.expected_revision)?
                ],
            )
            .map_err(|_| store_error("lease transition failed"))?;
        if changed != 1 {
            return Err(WorkspaceLeaseError::new(
                WorkspaceLeaseErrorKind::Conflict,
                "workspace lease transition lost a compare-and-set race",
            ));
        }
        transaction
            .commit()
            .map_err(|_| store_error("lease transition commit failed"))?;
        Ok(current)
    }
}

fn load_record(
    connection: &Connection,
    id: &WorkspaceLeaseId,
) -> Result<Option<WorkspaceLeaseRecord>, WorkspaceLeaseError> {
    let row = connection
        .query_row(
            "SELECT owner_id, state, revision, record FROM workspace_leases WHERE lease_id = ?1",
            [id.resource_id().as_str()],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, Vec<u8>>(3)?,
                ))
            },
        )
        .optional()
        .map_err(|_| store_error("lease record unavailable"))?;
    let Some((owner, state, revision, bytes)) = row else {
        return Ok(None);
    };
    if bytes.len() > MAX_RECORD_BYTES {
        return Err(store_error("lease record exceeds its bound"));
    }
    let record: WorkspaceLeaseRecord =
        serde_json::from_slice(&bytes).map_err(|_| store_error("lease record is corrupt"))?;
    let revision = u64::try_from(revision).map_err(|_| store_error("lease revision is corrupt"))?;
    if &record.id != id
        || record.owner.as_str() != owner
        || state_name(record.state) != state
        || record.revision != revision
    {
        return Err(store_error("lease record identity is corrupt"));
    }
    Ok(Some(record))
}

fn encode_record(record: &WorkspaceLeaseRecord) -> Result<Vec<u8>, WorkspaceLeaseError> {
    let bytes =
        serde_json::to_vec(record).map_err(|_| store_error("lease record encoding failed"))?;
    if bytes.len() > MAX_RECORD_BYTES {
        return Err(store_error("lease record exceeds its bound"));
    }
    Ok(bytes)
}

fn validate_new_record(record: &WorkspaceLeaseRecord) -> Result<(), WorkspaceLeaseError> {
    if record.state != WorkspaceLeaseState::CreatePending || record.revision != 0 {
        return Err(WorkspaceLeaseError::new(
            WorkspaceLeaseErrorKind::InvalidInput,
            "new workspace lease must start at revision zero in CreatePending",
        ));
    }
    Ok(())
}

fn legal_transition(current: WorkspaceLeaseState, next: WorkspaceLeaseState) -> bool {
    matches!(
        (current, next),
        (
            WorkspaceLeaseState::CreatePending,
            WorkspaceLeaseState::Ready
        ) | (
            WorkspaceLeaseState::CreatePending,
            WorkspaceLeaseState::CleanupRequired
        ) | (
            WorkspaceLeaseState::CreatePending,
            WorkspaceLeaseState::Cleaned
        ) | (
            WorkspaceLeaseState::Ready,
            WorkspaceLeaseState::CleanupRequired
        ) | (WorkspaceLeaseState::Ready, WorkspaceLeaseState::Cleaned)
            | (
                WorkspaceLeaseState::CleanupRequired,
                WorkspaceLeaseState::Cleaned
            )
    )
}

fn state_name(state: WorkspaceLeaseState) -> &'static str {
    match state {
        WorkspaceLeaseState::CreatePending => "create_pending",
        WorkspaceLeaseState::Ready => "ready",
        WorkspaceLeaseState::CleanupRequired => "cleanup_required",
        WorkspaceLeaseState::Cleaned => "cleaned",
    }
}

fn to_sql_revision(revision: u64) -> Result<i64, WorkspaceLeaseError> {
    i64::try_from(revision).map_err(|_| store_error("lease revision exceeds SQLite range"))
}

#[cfg(target_os = "linux")]
fn database_identity(path: &Path) -> Result<DatabaseIdentity, WorkspaceLeaseError> {
    identity_from_metadata(
        fs::metadata(path).map_err(|_| store_error("lease store identity unavailable"))?,
    )
}

#[cfg(target_os = "linux")]
fn identity_from_metadata(metadata: fs::Metadata) -> Result<DatabaseIdentity, WorkspaceLeaseError> {
    use std::os::unix::fs::MetadataExt;

    if metadata.nlink() != 1 {
        return Err(store_error(
            "lease store database must have exactly one filesystem link",
        ));
    }
    Ok(DatabaseIdentity {
        device: metadata.dev(),
        inode: metadata.ino(),
    })
}

#[cfg(not(target_os = "linux"))]
fn database_identity(path: &Path) -> Result<DatabaseIdentity, WorkspaceLeaseError> {
    fs::metadata(path).map_err(|_| store_error("lease store identity unavailable"))?;
    Ok(DatabaseIdentity)
}

#[cfg(target_os = "linux")]
fn validate_file_identity(
    file: &File,
    expected: DatabaseIdentity,
) -> Result<(), WorkspaceLeaseError> {
    let current = identity_from_metadata(
        file.metadata()
            .map_err(|_| store_error("lease store identity unavailable"))?,
    )?;
    if current != expected {
        return Err(store_error("lease store database identity changed"));
    }
    Ok(())
}

#[cfg(not(target_os = "linux"))]
fn validate_file_identity(
    file: &File,
    _expected: DatabaseIdentity,
) -> Result<(), WorkspaceLeaseError> {
    file.metadata()
        .map_err(|_| store_error("lease store identity unavailable"))?;
    Ok(())
}

fn validate_database_identity(
    path: &Path,
    expected: DatabaseIdentity,
) -> Result<(), WorkspaceLeaseError> {
    if database_identity(path)? != expected {
        return Err(store_error("lease store database identity changed"));
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn descriptor_path(file: &File) -> PathBuf {
    use std::os::fd::AsRawFd;

    PathBuf::from(format!("/proc/self/fd/{}", file.as_raw_fd()))
}

fn store_error(message: &'static str) -> WorkspaceLeaseError {
    WorkspaceLeaseError::new(WorkspaceLeaseErrorKind::StoreUnavailable, message)
}

fn create_private_file(path: &Path) -> Result<(), WorkspaceLeaseError> {
    open_private_file(path).map(|_| ())
}

fn open_private_file(path: &Path) -> Result<File, WorkspaceLeaseError> {
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true);
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
    }
    options
        .open(path)
        .map_err(|_| store_error("lease store file unavailable"))
}

fn open_existing_database(path: &Path) -> Result<File, WorkspaceLeaseError> {
    let mut options = OpenOptions::new();
    options.read(true).write(true);
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
    }
    options
        .open(path)
        .map_err(|_| store_error("lease store file unavailable"))
}
