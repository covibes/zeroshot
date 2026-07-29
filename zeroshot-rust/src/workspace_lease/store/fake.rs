use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use tokio::sync::{Mutex as AsyncMutex, OwnedMutexGuard};

use super::{
    CreateLeaseOutcome, WorkspaceLeaseOperationGuard, WorkspaceLeaseStore, WorkspaceLeaseTransition,
};
use crate::workspace_lease::{
    WorkspaceLeaseError, WorkspaceLeaseErrorKind, WorkspaceLeaseId, WorkspaceLeaseRecord,
    WorkspaceLeaseState,
};
#[derive(Default)]
pub struct FakeWorkspaceLeaseStore {
    records: Mutex<BTreeMap<WorkspaceLeaseId, WorkspaceLeaseRecord>>,
    fail_next: Mutex<bool>,
    operations: Mutex<BTreeMap<WorkspaceLeaseId, Arc<AsyncMutex<()>>>>,
}

impl FakeWorkspaceLeaseStore {
    pub fn fail_next(&self) {
        *self.fail_next.lock().expect("fake store mutex") = true;
    }

    #[must_use]
    pub fn record(&self, id: &WorkspaceLeaseId) -> Option<WorkspaceLeaseRecord> {
        self.records
            .lock()
            .expect("fake store mutex")
            .get(id)
            .cloned()
    }

    fn check_failure(&self) -> Result<(), WorkspaceLeaseError> {
        let mut fail = self.fail_next.lock().expect("fake store mutex");
        if std::mem::take(&mut *fail) {
            return Err(WorkspaceLeaseError::new(
                WorkspaceLeaseErrorKind::StoreUnavailable,
                "workspace lease store unavailable",
            ));
        }
        Ok(())
    }
}

struct FakeOperationGuard {
    _guard: OwnedMutexGuard<()>,
}

impl WorkspaceLeaseOperationGuard for FakeOperationGuard {}

#[async_trait]
impl WorkspaceLeaseStore for FakeWorkspaceLeaseStore {
    async fn acquire_operation(
        &self,
        id: &WorkspaceLeaseId,
        _owner: &crate::cluster_ledger::OwnerId,
    ) -> Result<Box<dyn WorkspaceLeaseOperationGuard>, WorkspaceLeaseError> {
        let operation = self
            .operations
            .lock()
            .expect("fake store operation mutex")
            .entry(id.clone())
            .or_insert_with(|| Arc::new(AsyncMutex::new(())))
            .clone();
        Ok(Box::new(FakeOperationGuard {
            _guard: operation.lock_owned().await,
        }))
    }

    async fn load(
        &self,
        id: &WorkspaceLeaseId,
    ) -> Result<Option<WorkspaceLeaseRecord>, WorkspaceLeaseError> {
        self.check_failure()?;
        Ok(self
            .records
            .lock()
            .expect("fake store mutex")
            .get(id)
            .cloned())
    }

    async fn create_pending(
        &self,
        record: WorkspaceLeaseRecord,
    ) -> Result<CreateLeaseOutcome, WorkspaceLeaseError> {
        self.check_failure()?;
        if record.state != WorkspaceLeaseState::CreatePending || record.revision != 0 {
            return Err(WorkspaceLeaseError::new(
                WorkspaceLeaseErrorKind::InvalidInput,
                "new workspace lease must start at revision zero in CreatePending",
            ));
        }
        let mut records = self.records.lock().expect("fake store mutex");
        if let Some(existing) = records.get(&record.id) {
            return Ok(CreateLeaseOutcome::Existing(existing.clone()));
        }
        records.insert(record.id.clone(), record.clone());
        Ok(CreateLeaseOutcome::Created(record))
    }

    async fn transition(
        &self,
        request: WorkspaceLeaseTransition,
    ) -> Result<WorkspaceLeaseRecord, WorkspaceLeaseError> {
        self.check_failure()?;
        let mut records = self.records.lock().expect("fake store mutex");
        let current = records.get_mut(&request.id).ok_or_else(|| {
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
        let legal = matches!(
            (current.state, request.next_state),
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
        );
        if !legal {
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
        Ok(current.clone())
    }
}
