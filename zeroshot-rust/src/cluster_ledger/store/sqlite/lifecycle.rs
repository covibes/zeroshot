use super::{database_path, SqliteLedgerStore};
use crate::cluster_ledger::store::{FailPoint, LedgerClock, ResourceId, StoreError, SystemLedgerClock};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

impl SqliteLedgerStore {
    pub fn new(root: impl Into<PathBuf>) -> Result<Self, StoreError> {
        Self::with_clock(root, SystemLedgerClock)
    }

    pub fn with_clock(
        root: impl Into<PathBuf>,
        clock: impl LedgerClock + 'static,
    ) -> Result<Self, StoreError> {
        let root = root.into();
        fs::create_dir_all(&root).map_err(|_| StoreError::Storage)?;
        Ok(Self {
            root: Arc::new(root),
            clock: Arc::new(clock),
            writer: Arc::new(Mutex::new(())),
            notifications: Arc::new(Mutex::new(BTreeMap::new())),
            next_failpoint: Arc::new(Mutex::new(None)),
        })
    }

    #[must_use]
    pub fn root(&self) -> &Path {
        self.root.as_ref()
    }

    #[must_use]
    pub fn path_for(&self, resource: &ResourceId) -> PathBuf {
        database_path(&self.root, resource)
    }

    pub fn fail_next(&self, point: FailPoint) {
        *self
            .next_failpoint
            .lock()
            .expect("SQLite failpoint mutex must not be poisoned") = Some(point);
    }
}
