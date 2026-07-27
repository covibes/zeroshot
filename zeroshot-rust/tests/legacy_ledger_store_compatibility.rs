use async_trait::async_trait;
use zeroshot_engine::cluster_ledger::record::{CanonicalDigest, RecordPayload, StoredRecord};
use zeroshot_engine::cluster_ledger::store::fake::{FakeLedgerStore, ManualLedgerClock};
use zeroshot_engine::cluster_ledger::store::{
    AppendBatch, AppendGuard, AppendOutcome, DiscoveryPage, Fence, IdempotencyId, LedgerStore,
    MutationReceipt, OwnerId, Position, PrefixSnapshot, ResourceId, ResourceInfo, StoreError,
};

struct LegacyStore {
    inner: FakeLedgerStore,
}

impl LegacyStore {
    fn new() -> Self {
        Self {
            inner: FakeLedgerStore::new(ManualLedgerClock::new(1_000)),
        }
    }
}

#[async_trait]
impl LedgerStore for LegacyStore {
    async fn discover(
        &self,
        after: Option<&ResourceId>,
        limit: usize,
    ) -> Result<DiscoveryPage, StoreError> {
        LedgerStore::discover(&self.inner, after, limit).await
    }

    async fn create(&self, resource: &ResourceId) -> Result<ResourceInfo, StoreError> {
        LedgerStore::create(&self.inner, resource).await
    }

    async fn create_fenced(
        &self,
        resource: &ResourceId,
        owner: &OwnerId,
        ttl_ms: u64,
    ) -> Result<(ResourceInfo, Fence), StoreError> {
        LedgerStore::create_fenced(&self.inner, resource, owner, ttl_ms).await
    }

    async fn open(&self, resource: &ResourceId) -> Result<ResourceInfo, StoreError> {
        LedgerStore::open(&self.inner, resource).await
    }

    async fn acquire_fence(
        &self,
        resource: &ResourceId,
        owner: &OwnerId,
        ttl_ms: u64,
    ) -> Result<Fence, StoreError> {
        LedgerStore::acquire_fence(&self.inner, resource, owner, ttl_ms).await
    }

    async fn renew_fence(&self, fence: &Fence, ttl_ms: u64) -> Result<Fence, StoreError> {
        LedgerStore::renew_fence(&self.inner, fence, ttl_ms).await
    }

    async fn check_fence(&self, fence: &Fence) -> Result<(), StoreError> {
        LedgerStore::check_fence(&self.inner, fence).await
    }

    async fn read_prefix(
        &self,
        resource: &ResourceId,
        through: Option<Position>,
    ) -> Result<PrefixSnapshot, StoreError> {
        LedgerStore::read_prefix(&self.inner, resource, through).await
    }

    async fn read_range(
        &self,
        resource: &ResourceId,
        after: Position,
        limit: usize,
    ) -> Result<Vec<StoredRecord>, StoreError> {
        LedgerStore::read_range(&self.inner, resource, after, limit).await
    }

    #[allow(clippy::too_many_arguments, reason = "frozen pre-6.7.2 trait API")]
    async fn compare_and_append(
        &self,
        resource: &ResourceId,
        fence: &Fence,
        expected: Position,
        batch: AppendBatch,
    ) -> Result<AppendOutcome, StoreError> {
        LedgerStore::compare_and_append(&self.inner, resource, fence, expected, batch).await
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
        LedgerStore::compare_and_append_guarded(
            &self.inner,
            resource,
            fence,
            expected,
            batch,
            guard,
        )
        .await
    }

    async fn lookup_receipt(
        &self,
        resource: &ResourceId,
        key: &IdempotencyId,
    ) -> Result<Option<MutationReceipt>, StoreError> {
        LedgerStore::lookup_receipt(&self.inner, resource, key).await
    }

    async fn wait_for_advance(
        &self,
        resource: &ResourceId,
        after: Position,
        deadline_ms: u64,
    ) -> Result<Position, StoreError> {
        LedgerStore::wait_for_advance(&self.inner, resource, after, deadline_ms).await
    }

    async fn remove(
        &self,
        resource: &ResourceId,
        fence: &Fence,
        expected: Position,
    ) -> Result<(), StoreError> {
        LedgerStore::remove(&self.inner, resource, fence, expected).await
    }
}

const LEGACY_KIND: zeroshot_engine::cluster_ledger::record::RecordKind =
    RecordPayload::CleanupReceipt {
        cleanup_digest: CanonicalDigest::new([0; 32]),
    }
    .kind();

fn receiptless_batch(
    resource: &ResourceId,
    sequence: u64,
    previous_hash: [u8; 32],
) -> (AppendBatch, [u8; 32]) {
    let payload = RecordPayload::CleanupReceipt {
        cleanup_digest: CanonicalDigest::of(&sequence.to_le_bytes()),
    };
    let record = StoredRecord::build(
        resource.clone(),
        Position::new(sequence).unwrap(),
        &payload,
        previous_hash,
    )
    .unwrap();
    let record_hash = record.record_hash;
    (AppendBatch::new(vec![record], None).unwrap(), record_hash)
}

#[tokio::test]
async fn downstream_legacy_store_is_complete_and_usable() {
    assert_eq!(
        LEGACY_KIND,
        RecordPayload::CleanupReceipt {
            cleanup_digest: CanonicalDigest::new([0; 32]),
        }
        .kind()
    );

    let store = LegacyStore::new();
    let resource = ResourceId::new("external-legacy-store").unwrap();
    let owner = OwnerId::new("external-owner").unwrap();
    let (_, fence) = store.create_fenced(&resource, &owner, 100).await.unwrap();

    let (first, first_hash) = receiptless_batch(&resource, 1, [0; 32]);
    let outcome = store
        .compare_and_append(&resource, &fence, Position::ZERO, first)
        .await
        .unwrap();
    assert_eq!(
        outcome,
        AppendOutcome::CommittedWithoutReceipt(Position::new(1).unwrap())
    );

    let (second, _) = receiptless_batch(&resource, 2, first_hash);
    let cancelled = store
        .compare_and_append_guarded(
            &resource,
            &fence,
            Position::new(1).unwrap(),
            second,
            AppendGuard::cancelled_when(|| true),
        )
        .await;
    assert_eq!(cancelled, Err(StoreError::AppendCancelled));

    let snapshot = store.read_prefix(&resource, None).await.unwrap();
    assert_eq!(snapshot.position, Position::new(1).unwrap());
    assert_eq!(snapshot.records.len(), 1);
}
