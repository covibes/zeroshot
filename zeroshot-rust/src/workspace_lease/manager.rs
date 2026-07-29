use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use tokio::sync::Mutex as AsyncMutex;

use crate::cluster_ledger::OwnerId;

use super::resource::{WorkspaceResourceObservation, WorkspaceResourcePort};
use super::store::{CreateLeaseOutcome, WorkspaceLeaseStore, WorkspaceLeaseTransition};
use super::{
    PrepareWorkspaceRequest, WorkspaceLeaseError, WorkspaceLeaseErrorKind, WorkspaceLeaseId,
    WorkspaceLeaseRecord, WorkspaceLeaseState,
};

#[derive(Clone, Debug)]
pub struct WorkspaceLeaseOwnerRequest {
    pub id: WorkspaceLeaseId,
    pub owner: OwnerId,
}

#[derive(Clone)]
pub struct WorkspaceLeaseManager {
    store: Arc<dyn WorkspaceLeaseStore>,
    resources: Arc<dyn WorkspaceResourcePort>,
    operations: Arc<Mutex<BTreeMap<WorkspaceLeaseId, Arc<AsyncMutex<()>>>>>,
}

impl WorkspaceLeaseManager {
    #[must_use]
    pub fn new(
        store: Arc<dyn WorkspaceLeaseStore>,
        resources: Arc<dyn WorkspaceResourcePort>,
    ) -> Self {
        Self {
            store,
            resources,
            operations: Arc::new(Mutex::new(BTreeMap::new())),
        }
    }

    /// Commits stable intent and owner before any create effect.
    pub async fn prepare(
        &self,
        request: PrepareWorkspaceRequest,
    ) -> Result<WorkspaceLeaseRecord, WorkspaceLeaseError> {
        let id = WorkspaceLeaseId::derive(&request.key);
        let operation = self.operation_lock(&id);
        let _operation = operation.lock().await;
        let _store_operation = self.store.acquire_operation(&id, &request.owner).await?;
        let pending = WorkspaceLeaseRecord::pending(&request);
        let record = match self.store.create_pending(pending.clone()).await? {
            CreateLeaseOutcome::Created(record) => record,
            CreateLeaseOutcome::Existing(record) => {
                validate_same_intent(&record, &pending)?;
                record
            }
        };
        self.prepare_record(record).await
    }

    /// Restart recovery is inspect-only: it never invents absence or repeats an effect.
    pub async fn restart(
        &self,
        request: WorkspaceLeaseOwnerRequest,
    ) -> Result<WorkspaceLeaseRecord, WorkspaceLeaseError> {
        let operation = self.operation_lock(&request.id);
        let _operation = operation.lock().await;
        let _store_operation = self
            .store
            .acquire_operation(&request.id, &request.owner)
            .await?;
        self.inspect_unlocked(&request).await
    }

    /// Authoritatively reconciles durable state without performing create or cleanup.
    pub async fn inspect(
        &self,
        request: WorkspaceLeaseOwnerRequest,
    ) -> Result<WorkspaceLeaseRecord, WorkspaceLeaseError> {
        let operation = self.operation_lock(&request.id);
        let _operation = operation.lock().await;
        let _store_operation = self
            .store
            .acquire_operation(&request.id, &request.owner)
            .await?;
        self.inspect_unlocked(&request).await
    }

    async fn inspect_unlocked(
        &self,
        request: &WorkspaceLeaseOwnerRequest,
    ) -> Result<WorkspaceLeaseRecord, WorkspaceLeaseError> {
        let record = self.load_owned(request).await?;
        if record.state == WorkspaceLeaseState::Cleaned {
            return Ok(record);
        }
        if matches!(record.mode, super::WorkspaceMode::Borrowed(_)) {
            return self.inspect_borrowed(record).await;
        }
        let observation = self.resources.inspect(&record).await?;
        match (record.state, observation) {
            (WorkspaceLeaseState::CreatePending, WorkspaceResourceObservation::Matching) => {
                self.transition(&record, WorkspaceLeaseState::Ready).await
            }
            (WorkspaceLeaseState::CreatePending, WorkspaceResourceObservation::CleanupRequired) => {
                self.transition(&record, WorkspaceLeaseState::CleanupRequired)
                    .await
            }
            (WorkspaceLeaseState::Ready, WorkspaceResourceObservation::CleanupRequired) => {
                Err(WorkspaceLeaseError::new(
                    WorkspaceLeaseErrorKind::ResourceUnavailable,
                    "ready workspace has only partial owned scaffolding",
                ))
            }
            (WorkspaceLeaseState::CleanupRequired, WorkspaceResourceObservation::Absent) => {
                self.transition(&record, WorkspaceLeaseState::Cleaned).await
            }
            (WorkspaceLeaseState::Ready, WorkspaceResourceObservation::Absent) => {
                Err(WorkspaceLeaseError::new(
                    WorkspaceLeaseErrorKind::ResourceUnavailable,
                    "ready workspace resource is absent",
                ))
            }
            (_, WorkspaceResourceObservation::CleanupRequired) => Ok(record),
            (_, WorkspaceResourceObservation::Mismatch) => Err(resource_mismatch()),
            _ => Ok(record),
        }
    }

    /// Cleanup is owner-fenced. Borrowed cleanup is a durable no-op and never calls delete.
    pub async fn cleanup(
        &self,
        request: WorkspaceLeaseOwnerRequest,
    ) -> Result<WorkspaceLeaseRecord, WorkspaceLeaseError> {
        let operation = self.operation_lock(&request.id);
        let _operation = operation.lock().await;
        let _store_operation = self
            .store
            .acquire_operation(&request.id, &request.owner)
            .await?;
        let mut record = self.load_owned(&request).await?;
        if record.state == WorkspaceLeaseState::Cleaned {
            return self.reconcile_cleaned(record).await;
        }
        if matches!(record.mode, super::WorkspaceMode::Borrowed(_)) {
            return self.transition(&record, WorkspaceLeaseState::Cleaned).await;
        }

        if record.state != WorkspaceLeaseState::CleanupRequired {
            let observation = self.resources.inspect(&record).await?;
            match observation {
                WorkspaceResourceObservation::Mismatch => return Err(resource_mismatch()),
                WorkspaceResourceObservation::Absent => {
                    return self.transition(&record, WorkspaceLeaseState::Cleaned).await;
                }
                WorkspaceResourceObservation::Matching
                | WorkspaceResourceObservation::CleanupRequired => {
                    record = self
                        .transition(&record, WorkspaceLeaseState::CleanupRequired)
                        .await?;
                }
            }
        }
        self.cleanup_owned(record).await
    }

    async fn prepare_record(
        &self,
        record: WorkspaceLeaseRecord,
    ) -> Result<WorkspaceLeaseRecord, WorkspaceLeaseError> {
        match record.state {
            WorkspaceLeaseState::Cleaned => Err(WorkspaceLeaseError::new(
                WorkspaceLeaseErrorKind::Conflict,
                "cleaned workspace lease cannot be prepared again",
            )),
            WorkspaceLeaseState::CleanupRequired => Err(WorkspaceLeaseError::new(
                WorkspaceLeaseErrorKind::Conflict,
                "workspace cleanup is already required",
            )),
            WorkspaceLeaseState::Ready => match self.resources.inspect(&record).await? {
                WorkspaceResourceObservation::Matching => Ok(record),
                WorkspaceResourceObservation::Absent => Err(WorkspaceLeaseError::new(
                    WorkspaceLeaseErrorKind::ResourceUnavailable,
                    "ready workspace resource is absent",
                )),
                WorkspaceResourceObservation::CleanupRequired => Err(WorkspaceLeaseError::new(
                    WorkspaceLeaseErrorKind::ResourceUnavailable,
                    "ready workspace has only partial owned scaffolding",
                )),
                WorkspaceResourceObservation::Mismatch => Err(resource_mismatch()),
            },
            WorkspaceLeaseState::CreatePending => self.prepare_pending(record).await,
        }
    }

    async fn prepare_pending(
        &self,
        record: WorkspaceLeaseRecord,
    ) -> Result<WorkspaceLeaseRecord, WorkspaceLeaseError> {
        match self.resources.inspect(&record).await? {
            WorkspaceResourceObservation::Matching => {
                self.transition(&record, WorkspaceLeaseState::Ready).await
            }
            WorkspaceResourceObservation::CleanupRequired => {
                self.transition(&record, WorkspaceLeaseState::CleanupRequired)
                    .await
            }
            WorkspaceResourceObservation::Mismatch => Err(resource_mismatch()),
            WorkspaceResourceObservation::Absent => {
                if matches!(record.mode, super::WorkspaceMode::Borrowed(_)) {
                    return Err(WorkspaceLeaseError::new(
                        WorkspaceLeaseErrorKind::NotFound,
                        "borrowed workspace root is absent",
                    ));
                }
                self.resources.create(&record).await?;
                match self.resources.inspect(&record).await? {
                    WorkspaceResourceObservation::Matching => {
                        self.transition(&record, WorkspaceLeaseState::Ready).await
                    }
                    WorkspaceResourceObservation::Absent => Err(WorkspaceLeaseError::new(
                        WorkspaceLeaseErrorKind::ResourceUnavailable,
                        "workspace create completed without an authoritative resource",
                    )),
                    WorkspaceResourceObservation::CleanupRequired => Err(WorkspaceLeaseError::new(
                        WorkspaceLeaseErrorKind::ResourceUnavailable,
                        "workspace create left partial owned scaffolding",
                    )),
                    WorkspaceResourceObservation::Mismatch => Err(resource_mismatch()),
                }
            }
        }
    }

    async fn inspect_borrowed(
        &self,
        record: WorkspaceLeaseRecord,
    ) -> Result<WorkspaceLeaseRecord, WorkspaceLeaseError> {
        match self.resources.inspect(&record).await? {
            WorkspaceResourceObservation::Matching => {
                if record.state == WorkspaceLeaseState::CreatePending {
                    self.transition(&record, WorkspaceLeaseState::Ready).await
                } else {
                    Ok(record)
                }
            }
            WorkspaceResourceObservation::Absent => Err(WorkspaceLeaseError::new(
                WorkspaceLeaseErrorKind::NotFound,
                "borrowed workspace root is absent",
            )),
            WorkspaceResourceObservation::CleanupRequired => Err(resource_mismatch()),
            WorkspaceResourceObservation::Mismatch => Err(resource_mismatch()),
        }
    }

    async fn cleanup_owned(
        &self,
        record: WorkspaceLeaseRecord,
    ) -> Result<WorkspaceLeaseRecord, WorkspaceLeaseError> {
        match self.resources.inspect(&record).await? {
            WorkspaceResourceObservation::Absent => {
                self.transition(&record, WorkspaceLeaseState::Cleaned).await
            }
            WorkspaceResourceObservation::Mismatch => Err(resource_mismatch()),
            WorkspaceResourceObservation::Matching
            | WorkspaceResourceObservation::CleanupRequired => {
                self.resources.cleanup(&record).await?;
                match self.resources.inspect(&record).await? {
                    WorkspaceResourceObservation::Absent => {
                        self.transition(&record, WorkspaceLeaseState::Cleaned).await
                    }
                    WorkspaceResourceObservation::Matching => Err(WorkspaceLeaseError::new(
                        WorkspaceLeaseErrorKind::ResourceUnavailable,
                        "workspace cleanup did not remove the resource",
                    )),
                    WorkspaceResourceObservation::CleanupRequired => Err(WorkspaceLeaseError::new(
                        WorkspaceLeaseErrorKind::ResourceUnavailable,
                        "workspace cleanup left partial owned scaffolding",
                    )),
                    WorkspaceResourceObservation::Mismatch => Err(resource_mismatch()),
                }
            }
        }
    }

    async fn load_owned(
        &self,
        request: &WorkspaceLeaseOwnerRequest,
    ) -> Result<WorkspaceLeaseRecord, WorkspaceLeaseError> {
        let record = self.store.load(&request.id).await?.ok_or_else(|| {
            WorkspaceLeaseError::new(
                WorkspaceLeaseErrorKind::NotFound,
                "workspace lease does not exist",
            )
        })?;
        if record.owner != request.owner {
            return Err(WorkspaceLeaseError::new(
                WorkspaceLeaseErrorKind::OwnerMismatch,
                "workspace lease owner fence mismatch",
            ));
        }
        Ok(record)
    }

    async fn transition(
        &self,
        current: &WorkspaceLeaseRecord,
        next_state: WorkspaceLeaseState,
    ) -> Result<WorkspaceLeaseRecord, WorkspaceLeaseError> {
        self.store
            .transition(WorkspaceLeaseTransition {
                id: current.id.clone(),
                owner: current.owner.clone(),
                expected_revision: current.revision,
                expected_state: current.state,
                next_state,
            })
            .await
    }
    async fn reconcile_cleaned(
        &self,
        record: WorkspaceLeaseRecord,
    ) -> Result<WorkspaceLeaseRecord, WorkspaceLeaseError> {
        if matches!(record.mode, super::WorkspaceMode::Borrowed(_)) {
            return Ok(record);
        }
        match self.resources.inspect(&record).await? {
            WorkspaceResourceObservation::Absent => Ok(record),
            WorkspaceResourceObservation::Mismatch => Err(resource_mismatch()),
            WorkspaceResourceObservation::Matching
            | WorkspaceResourceObservation::CleanupRequired => {
                self.resources.cleanup(&record).await?;
                match self.resources.inspect(&record).await? {
                    WorkspaceResourceObservation::Absent => Ok(record),
                    WorkspaceResourceObservation::Matching => Err(WorkspaceLeaseError::new(
                        WorkspaceLeaseErrorKind::ResourceUnavailable,
                        "cleaned workspace orphan cleanup did not remove the resource",
                    )),
                    WorkspaceResourceObservation::CleanupRequired => Err(WorkspaceLeaseError::new(
                        WorkspaceLeaseErrorKind::ResourceUnavailable,
                        "cleaned workspace orphan cleanup left partial owned scaffolding",
                    )),
                    WorkspaceResourceObservation::Mismatch => Err(resource_mismatch()),
                }
            }
        }
    }

    fn operation_lock(&self, id: &WorkspaceLeaseId) -> Arc<AsyncMutex<()>> {
        self.operations
            .lock()
            .expect("workspace operation map mutex")
            .entry(id.clone())
            .or_insert_with(|| Arc::new(AsyncMutex::new(())))
            .clone()
    }
}

fn validate_same_intent(
    existing: &WorkspaceLeaseRecord,
    requested: &WorkspaceLeaseRecord,
) -> Result<(), WorkspaceLeaseError> {
    if existing.owner != requested.owner {
        return Err(WorkspaceLeaseError::new(
            WorkspaceLeaseErrorKind::OwnerMismatch,
            "workspace lease owner fence mismatch",
        ));
    }
    if existing.id != requested.id
        || existing.mode != requested.mode
        || existing.access_mode != requested.access_mode
    {
        return Err(resource_mismatch());
    }
    Ok(())
}

fn resource_mismatch() -> WorkspaceLeaseError {
    WorkspaceLeaseError::new(
        WorkspaceLeaseErrorKind::ResourceMismatch,
        "workspace resource identity or owner does not match durable intent",
    )
}
