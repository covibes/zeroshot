use async_trait::async_trait;

use super::{
    AppendBatch, AppendGuard, AppendOutcome, DiscoveryPage, Fence, IdempotencyId, MutationReceipt,
    OwnerId, Position, PrefixSnapshot, ResourceId, ResourceInfo, StoreError, StoredRecord,
};

#[async_trait]
pub trait LedgerStore: Send + Sync + 'static {
    async fn discover(
        &self,
        after: Option<&ResourceId>,
        limit: usize,
    ) -> Result<DiscoveryPage, StoreError>;
    async fn create(&self, resource: &ResourceId) -> Result<ResourceInfo, StoreError>;
    async fn create_fenced(
        &self,
        resource: &ResourceId,
        owner: &OwnerId,
        ttl_ms: u64,
    ) -> Result<(ResourceInfo, Fence), StoreError>;
    async fn open(&self, resource: &ResourceId) -> Result<ResourceInfo, StoreError>;
    async fn acquire_fence(
        &self,
        resource: &ResourceId,
        owner: &OwnerId,
        ttl_ms: u64,
    ) -> Result<Fence, StoreError>;
    async fn renew_fence(&self, fence: &Fence, ttl_ms: u64) -> Result<Fence, StoreError>;
    async fn check_fence(&self, fence: &Fence) -> Result<(), StoreError>;
    async fn read_prefix(
        &self,
        resource: &ResourceId,
        through: Option<Position>,
    ) -> Result<PrefixSnapshot, StoreError>;
    async fn read_range(
        &self,
        resource: &ResourceId,
        after: Position,
        limit: usize,
    ) -> Result<Vec<StoredRecord>, StoreError>;
    #[allow(clippy::too_many_arguments, reason = "frozen pre-6.7.2 public API")]
    async fn compare_and_append(
        &self,
        resource: &ResourceId,
        fence: &Fence,
        expected: Position,
        batch: AppendBatch,
    ) -> Result<AppendOutcome, StoreError>;
    #[allow(clippy::too_many_arguments, reason = "frozen pre-6.7.2 public API")]
    async fn compare_and_append_guarded(
        &self,
        resource: &ResourceId,
        fence: &Fence,
        expected: Position,
        batch: AppendBatch,
        guard: AppendGuard,
    ) -> Result<AppendOutcome, StoreError>;
    async fn lookup_receipt(
        &self,
        resource: &ResourceId,
        key: &IdempotencyId,
    ) -> Result<Option<MutationReceipt>, StoreError>;
    async fn wait_for_advance(
        &self,
        resource: &ResourceId,
        after: Position,
        deadline_ms: u64,
    ) -> Result<Position, StoreError>;
    async fn remove(
        &self,
        resource: &ResourceId,
        fence: &Fence,
        expected: Position,
    ) -> Result<(), StoreError>;
}
