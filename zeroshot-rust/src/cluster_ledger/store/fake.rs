use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

mod append;
mod clock;
mod lifecycle;

use async_trait::async_trait;
use tokio::sync::Notify;

use append::{apply_append, existing_outcome, take_failpoint, validate_append, validate_fence};
pub use clock::ManualLedgerClock;
use super::{
    completed_wait_position, fence_expiry, AppendRequest, FailPoint, LedgerClock, WaitProbe,
    MAX_DISCOVERY_PAGE,
};
use super::{
    AppendBatch, AppendGuard, AppendOutcome, DiscoveryPage, Fence, IdempotencyId, LedgerStore,
    MutationReceipt, OwnerId, Position, PrefixSnapshot, ResourceId, ResourceInfo, StoreError,
};
use crate::cluster_ledger::record::{StoredRecord, MAX_RANGE_RECORDS};

#[derive(Default)]
pub(super) struct ResourceData {
    records: Vec<StoredRecord>,
    receipts: BTreeMap<IdempotencyId, MutationReceipt>,
    fence: Option<Fence>,
    last_fence_epoch: u64,
    notify: Arc<Notify>,
}

#[derive(Default)]
pub(super) struct FakeState {
    resources: BTreeMap<ResourceId, ResourceData>,
    pub(super) next_failpoint: Option<FailPoint>,
}

struct FenceRequest<'a> {
    resource: &'a ResourceId,
    owner: &'a OwnerId,
    ttl_ms: u64,
    epoch: u64,
}

#[derive(Clone)]
pub struct FakeLedgerStore {
    state: Arc<Mutex<FakeState>>,
    clock: Arc<dyn LedgerClock>,
}

impl FakeLedgerStore {
    fn fence(&self, request: FenceRequest<'_>) -> Result<Fence, StoreError> {
        let FenceRequest {
            resource,
            owner,
            ttl_ms,
            epoch,
        } = request;
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
            epoch,
            expires_at_ms,
        })
    }

    fn append(&self, request: AppendRequest<'_>) -> Result<AppendOutcome, StoreError> {
        request.batch.validate()?;
        let mut state = self
            .state
            .lock()
            .expect("fake ledger mutex must not be poisoned");
        if take_failpoint(&mut state, FailPoint::BeforeCommit) {
            return Err(StoreError::FailureInjected(FailPoint::BeforeCommit));
        }
        let outcome = self.append_locked(&mut state, request)?;
        if outcome.is_new_commit()
            && take_failpoint(&mut state, FailPoint::AfterCommitBeforeResponse)
        {
            return Err(StoreError::FailureInjected(
                FailPoint::AfterCommitBeforeResponse,
            ));
        }
        Ok(outcome)
    }

    fn append_locked(
        &self,
        state: &mut FakeState,
        request: AppendRequest<'_>,
    ) -> Result<AppendOutcome, StoreError> {
        let AppendRequest {
            resource,
            fence,
            expected,
            batch,
            guard,
        } = request;
        let data = state
            .resources
            .get_mut(resource)
            .ok_or(StoreError::ResourceNotFound)?;
        validate_fence(self.clock.as_ref(), data, fence)?;
        if let Some(outcome) = existing_outcome(data, &batch)? {
            return Ok(outcome);
        }
        validate_append(data, resource, expected, &batch)?;
        guard.check()?;
        apply_append(data, expected, batch)
    }
}

#[async_trait]
impl LedgerStore for FakeLedgerStore {
    async fn discover(
        &self,
        after: Option<&ResourceId>,
        limit: usize,
    ) -> Result<DiscoveryPage, StoreError> {
        if limit == 0 || limit > MAX_DISCOVERY_PAGE {
            return Err(StoreError::InvalidLimit);
        }
        let state = self
            .state
            .lock()
            .expect("fake ledger mutex must not be poisoned");
        let mut resources = state
            .resources
            .iter()
            .filter(|(resource, _)| after.is_none_or(|after| *resource > after))
            .take(limit + 1)
            .map(|(resource, data)| {
                Ok(ResourceInfo {
                    resource: resource.clone(),
                    position: Position::new(
                        u64::try_from(data.records.len())
                            .map_err(|_| StoreError::PositionOverflow)?,
                    )?,
                })
            })
            .collect::<Result<Vec<_>, StoreError>>()?;
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
        let mut state = self
            .state
            .lock()
            .expect("fake ledger mutex must not be poisoned");
        if state.resources.contains_key(resource) {
            return Err(StoreError::ResourceExists);
        }
        state
            .resources
            .insert(resource.clone(), ResourceData::default());
        Ok(ResourceInfo {
            resource: resource.clone(),
            position: Position::ZERO,
        })
    }

    async fn create_fenced(
        &self,
        resource: &ResourceId,
        owner: &OwnerId,
        ttl_ms: u64,
    ) -> Result<(ResourceInfo, Fence), StoreError> {
        let fence = self.fence(FenceRequest {
            resource,
            owner,
            ttl_ms,
            epoch: 1,
        })?;
        let mut state = self
            .state
            .lock()
            .expect("fake ledger mutex must not be poisoned");
        if state.resources.contains_key(resource) {
            return Err(StoreError::ResourceExists);
        }
        let data = ResourceData {
            fence: Some(fence.clone()),
            last_fence_epoch: 1,
            ..ResourceData::default()
        };
        state.resources.insert(resource.clone(), data);
        Ok((
            ResourceInfo {
                resource: resource.clone(),
                position: Position::ZERO,
            },
            fence,
        ))
    }

    async fn open(&self, resource: &ResourceId) -> Result<ResourceInfo, StoreError> {
        let state = self
            .state
            .lock()
            .expect("fake ledger mutex must not be poisoned");
        let data = state
            .resources
            .get(resource)
            .ok_or(StoreError::ResourceNotFound)?;
        Ok(ResourceInfo {
            resource: resource.clone(),
            position: Position::new(
                u64::try_from(data.records.len()).map_err(|_| StoreError::PositionOverflow)?,
            )?,
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
        let now = self.clock.now_ms();
        let expires_at_ms = now
            .checked_add(ttl_ms)
            .ok_or(StoreError::PositionOverflow)?;
        if expires_at_ms > i64::MAX as u64 {
            return Err(StoreError::PositionOverflow);
        }
        let mut state = self
            .state
            .lock()
            .expect("fake ledger mutex must not be poisoned");
        let data = state
            .resources
            .get_mut(resource)
            .ok_or(StoreError::ResourceNotFound)?;
        if data
            .fence
            .as_ref()
            .is_some_and(|fence| fence.expires_at_ms > now)
        {
            return Err(StoreError::FenceHeld);
        }
        data.last_fence_epoch = data
            .last_fence_epoch
            .checked_add(1)
            .ok_or(StoreError::PositionOverflow)?;
        let fence = Fence {
            resource: resource.clone(),
            owner: owner.clone(),
            epoch: data.last_fence_epoch,
            expires_at_ms,
        };
        data.fence = Some(fence.clone());
        Ok(fence)
    }

    async fn renew_fence(&self, fence: &Fence, ttl_ms: u64) -> Result<Fence, StoreError> {
        let now = self.clock.now_ms();
        let expires_at_ms = fence_expiry(now, ttl_ms)?;
        let mut state = self
            .state
            .lock()
            .expect("fake ledger mutex must not be poisoned");
        let data = state
            .resources
            .get_mut(&fence.resource)
            .ok_or(StoreError::ResourceNotFound)?;
        validate_fence(self.clock.as_ref(), data, fence)?;
        let renewed = Fence {
            expires_at_ms,
            ..fence.clone()
        };
        data.fence = Some(renewed.clone());
        Ok(renewed)
    }

    async fn check_fence(&self, fence: &Fence) -> Result<(), StoreError> {
        let state = self
            .state
            .lock()
            .expect("fake ledger mutex must not be poisoned");
        let data = state
            .resources
            .get(&fence.resource)
            .ok_or(StoreError::ResourceNotFound)?;
        validate_fence(self.clock.as_ref(), data, fence)
    }

    async fn read_prefix(
        &self,
        resource: &ResourceId,
        through: Option<Position>,
    ) -> Result<PrefixSnapshot, StoreError> {
        let state = self
            .state
            .lock()
            .expect("fake ledger mutex must not be poisoned");
        let data = state
            .resources
            .get(resource)
            .ok_or(StoreError::ResourceNotFound)?;
        let full_position = Position::new(
            u64::try_from(data.records.len()).map_err(|_| StoreError::PositionOverflow)?,
        )?;
        let position = through.unwrap_or(full_position);
        if position > full_position {
            return Err(StoreError::InvalidLimit);
        }
        let length = usize::try_from(position.get()).map_err(|_| StoreError::InvalidLimit)?;
        let records = data.records[..length].to_vec();
        let receipts = data
            .receipts
            .values()
            .filter(|receipt| receipt.committed_position <= position)
            .cloned()
            .collect();
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
        let state = self
            .state
            .lock()
            .expect("fake ledger mutex must not be poisoned");
        let data = state
            .resources
            .get(resource)
            .ok_or(StoreError::ResourceNotFound)?;
        let start = usize::try_from(after.get()).map_err(|_| StoreError::InvalidLimit)?;
        if start > data.records.len() {
            return Err(StoreError::PositionConflict {
                expected: after,
                actual: Position::new(
                    u64::try_from(data.records.len()).map_err(|_| StoreError::PositionOverflow)?,
                )?,
            });
        }
        Ok(data.records[start..].iter().take(limit).cloned().collect())
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
        let state = self
            .state
            .lock()
            .expect("fake ledger mutex must not be poisoned");
        let data = state
            .resources
            .get(resource)
            .ok_or(StoreError::ResourceNotFound)?;
        Ok(data.receipts.get(key).cloned())
    }

    async fn wait_for_advance(
        &self,
        resource: &ResourceId,
        after: Position,
        deadline_ms: u64,
    ) -> Result<Position, StoreError> {
        loop {
            let (position, notified) = {
                let state = self
                    .state
                    .lock()
                    .expect("fake ledger mutex must not be poisoned");
                let data = state
                    .resources
                    .get(resource)
                    .ok_or(StoreError::ResourceNotFound)?;
                let notified = data.notify.clone().notified_owned();
                let position = Position::new(
                    u64::try_from(data.records.len()).map_err(|_| StoreError::PositionOverflow)?,
                )?;
                (position, notified)
            };
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
                () = tokio::time::sleep(std::time::Duration::from_millis(1)) => {}
            }
        }
    }

    async fn remove(
        &self,
        resource: &ResourceId,
        fence: &Fence,
        expected: Position,
    ) -> Result<(), StoreError> {
        let mut state = self
            .state
            .lock()
            .expect("fake ledger mutex must not be poisoned");
        if take_failpoint(&mut state, FailPoint::BeforeCommit) {
            return Err(StoreError::FailureInjected(FailPoint::BeforeCommit));
        }
        let data = state
            .resources
            .get(resource)
            .ok_or(StoreError::ResourceNotFound)?;
        validate_fence(self.clock.as_ref(), data, fence)?;
        let actual = Position::new(
            u64::try_from(data.records.len()).map_err(|_| StoreError::PositionOverflow)?,
        )?;
        if actual != expected {
            return Err(StoreError::PositionConflict { expected, actual });
        }
        state.resources.remove(resource);
        if take_failpoint(&mut state, FailPoint::AfterCommitBeforeResponse) {
            return Err(StoreError::FailureInjected(
                FailPoint::AfterCommitBeforeResponse,
            ));
        }
        Ok(())
    }
}
