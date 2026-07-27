use super::super::{Fence, OwnerId, Position, ResourceId, ResourceInfo, StoreError};
use super::discovery::{create_or_reinitialize_database, lock_resource_file};
use super::SqliteLedgerStore;

impl SqliteLedgerStore {
    pub(super) fn initial_fence(
        &self,
        resource: &ResourceId,
        owner: &OwnerId,
        ttl_ms: u64,
    ) -> Result<Fence, StoreError> {
        let expires_at_ms = self
            .clock
            .now_ms()
            .checked_add(ttl_ms)
            .filter(|expires| ttl_ms != 0 && *expires <= i64::MAX as u64)
            .ok_or(if ttl_ms == 0 {
                StoreError::FenceExpired
            } else {
                StoreError::PositionOverflow
            })?;
        Ok(Fence {
            resource: resource.clone(),
            owner: owner.clone(),
            epoch: 1,
            expires_at_ms,
        })
    }

    pub(super) fn create_resource(
        &self,
        resource: &ResourceId,
        initial_fence: Option<&Fence>,
    ) -> Result<ResourceInfo, StoreError> {
        let _writer = self
            .writer
            .lock()
            .expect("SQLite writer mutex must not be poisoned");
        let path = self.path_for(resource);
        let _resource_lock = lock_resource_file(&path)?;
        create_or_reinitialize_database(&path, resource, initial_fence)?;
        Ok(ResourceInfo {
            resource: resource.clone(),
            position: Position::ZERO,
        })
    }
}
