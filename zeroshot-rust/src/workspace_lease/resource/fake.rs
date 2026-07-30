use std::collections::BTreeMap;
use std::sync::Mutex;

use async_trait::async_trait;

use super::{WorkspaceResourceObservation, WorkspaceResourcePort};
use crate::workspace_lease::{
    WorkspaceLeaseError, WorkspaceLeaseErrorKind, WorkspaceLeaseId, WorkspaceLeaseRecord,
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FakeEffectFailure {
    BeforeEffect,
    AfterEffect,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FakeResourceAction {
    Inspect,
    Create,
    Cleanup,
}

#[derive(Default)]
pub struct FakeWorkspaceResourcePort {
    resources: Mutex<BTreeMap<WorkspaceLeaseId, WorkspaceLeaseRecord>>,
    actions: Mutex<Vec<(WorkspaceLeaseId, FakeResourceAction)>>,
    create_failure: Mutex<Option<FakeEffectFailure>>,
    cleanup_failure: Mutex<Option<FakeEffectFailure>>,
    inspect_failure: Mutex<bool>,
}

impl FakeWorkspaceResourcePort {
    pub fn seed(&self, lease: WorkspaceLeaseRecord) {
        self.resources
            .lock()
            .expect("fake resource mutex")
            .insert(lease.id.clone(), lease);
    }

    pub fn remove(&self, id: &WorkspaceLeaseId) {
        self.resources
            .lock()
            .expect("fake resource mutex")
            .remove(id);
    }

    pub fn fail_next_create(&self, failure: FakeEffectFailure) {
        *self.create_failure.lock().expect("fake resource mutex") = Some(failure);
    }

    pub fn fail_next_cleanup(&self, failure: FakeEffectFailure) {
        *self.cleanup_failure.lock().expect("fake resource mutex") = Some(failure);
    }

    pub fn fail_next_inspect(&self) {
        *self.inspect_failure.lock().expect("fake resource mutex") = true;
    }

    #[must_use]
    pub fn actions(&self) -> Vec<(WorkspaceLeaseId, FakeResourceAction)> {
        self.actions.lock().expect("fake resource mutex").clone()
    }

    #[must_use]
    pub fn contains(&self, id: &WorkspaceLeaseId) -> bool {
        self.resources
            .lock()
            .expect("fake resource mutex")
            .contains_key(id)
    }

    fn record(&self, id: &WorkspaceLeaseId, action: FakeResourceAction) {
        self.actions
            .lock()
            .expect("fake resource mutex")
            .push((id.clone(), action));
    }

    fn effect_error(operation: &'static str) -> WorkspaceLeaseError {
        WorkspaceLeaseError::new(
            WorkspaceLeaseErrorKind::ResourceUnavailable,
            format!("workspace {operation} outcome is uncertain"),
        )
    }
}

#[async_trait]
impl WorkspaceResourcePort for FakeWorkspaceResourcePort {
    async fn inspect(
        &self,
        lease: &WorkspaceLeaseRecord,
    ) -> Result<WorkspaceResourceObservation, WorkspaceLeaseError> {
        self.record(&lease.id, FakeResourceAction::Inspect);
        if std::mem::take(&mut *self.inspect_failure.lock().expect("fake resource mutex")) {
            return Err(Self::effect_error("inspection"));
        }
        Ok(
            match self
                .resources
                .lock()
                .expect("fake resource mutex")
                .get(&lease.id)
            {
                None => WorkspaceResourceObservation::Absent,
                Some(found)
                    if found.owner == lease.owner
                        && found.mode == lease.mode
                        && found.access_mode == lease.access_mode =>
                {
                    WorkspaceResourceObservation::Matching
                }
                Some(_) => WorkspaceResourceObservation::Mismatch,
            },
        )
    }

    async fn create(&self, lease: &WorkspaceLeaseRecord) -> Result<(), WorkspaceLeaseError> {
        self.record(&lease.id, FakeResourceAction::Create);
        let failure = self
            .create_failure
            .lock()
            .expect("fake resource mutex")
            .take();
        if failure == Some(FakeEffectFailure::BeforeEffect) {
            return Err(Self::effect_error("create"));
        }
        let mut resources = self.resources.lock().expect("fake resource mutex");
        if resources.contains_key(&lease.id) {
            return Err(WorkspaceLeaseError::new(
                WorkspaceLeaseErrorKind::ResourceMismatch,
                "workspace create found an existing resource",
            ));
        }
        resources.insert(lease.id.clone(), lease.clone());
        drop(resources);
        if failure == Some(FakeEffectFailure::AfterEffect) {
            return Err(Self::effect_error("create"));
        }
        Ok(())
    }

    async fn cleanup(&self, lease: &WorkspaceLeaseRecord) -> Result<(), WorkspaceLeaseError> {
        self.record(&lease.id, FakeResourceAction::Cleanup);
        let failure = self
            .cleanup_failure
            .lock()
            .expect("fake resource mutex")
            .take();
        if failure == Some(FakeEffectFailure::BeforeEffect) {
            return Err(Self::effect_error("cleanup"));
        }
        self.resources
            .lock()
            .expect("fake resource mutex")
            .remove(&lease.id);
        if failure == Some(FakeEffectFailure::AfterEffect) {
            return Err(Self::effect_error("cleanup"));
        }
        Ok(())
    }
}
