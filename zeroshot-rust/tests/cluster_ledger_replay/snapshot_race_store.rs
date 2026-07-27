use super::*;

#[derive(Clone)]
pub(super) struct SnapshotRaceStore {
    inner: Arc<dyn LedgerStore>,
    gated_reads: Arc<AtomicUsize>,
    barrier: Arc<Barrier>,
    cancel_before_append: Arc<Mutex<Option<CancellationSignal>>>,
}

impl SnapshotRaceStore {
    pub(super) fn new(inner: Arc<dyn LedgerStore>) -> Self {
        Self {
            inner,
            gated_reads: Arc::new(AtomicUsize::new(0)),
            barrier: Arc::new(Barrier::new(2)),
            cancel_before_append: Arc::new(Mutex::new(None)),
        }
    }

    pub(super) fn arm(&self) {
        self.gated_reads.store(2, Ordering::Release);
    }

    pub(super) fn cancel_before_next_append(&self, cancellation: CancellationSignal) {
        *self
            .cancel_before_append
            .lock()
            .expect("cancellation mutex must not be poisoned") = Some(cancellation);
    }
}

#[async_trait]
impl LedgerStore for SnapshotRaceStore {
    async fn discover(
        &self,
        after: Option<&ResourceId>,
        limit: usize,
    ) -> Result<DiscoveryPage, StoreError> {
        self.inner.discover(after, limit).await
    }

    async fn create(&self, resource: &ResourceId) -> Result<ResourceInfo, StoreError> {
        self.inner.create(resource).await
    }

    async fn create_fenced(
        &self,
        resource: &ResourceId,
        owner: &OwnerId,
        ttl_ms: u64,
    ) -> Result<(ResourceInfo, Fence), StoreError> {
        self.inner.create_fenced(resource, owner, ttl_ms).await
    }

    async fn open(&self, resource: &ResourceId) -> Result<ResourceInfo, StoreError> {
        self.inner.open(resource).await
    }

    async fn acquire_fence(
        &self,
        resource: &ResourceId,
        owner: &OwnerId,
        ttl_ms: u64,
    ) -> Result<Fence, StoreError> {
        self.inner.acquire_fence(resource, owner, ttl_ms).await
    }

    async fn renew_fence(&self, fence: &Fence, ttl_ms: u64) -> Result<Fence, StoreError> {
        self.inner.renew_fence(fence, ttl_ms).await
    }

    async fn check_fence(&self, fence: &Fence) -> Result<(), StoreError> {
        self.inner.check_fence(fence).await
    }

    async fn read_prefix(
        &self,
        resource: &ResourceId,
        through: Option<Position>,
    ) -> Result<PrefixSnapshot, StoreError> {
        let snapshot = self.inner.read_prefix(resource, through).await?;
        if self
            .gated_reads
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |remaining| {
                remaining.checked_sub(1)
            })
            .is_ok()
        {
            self.barrier.wait().await;
        }
        Ok(snapshot)
    }

    async fn read_range(
        &self,
        resource: &ResourceId,
        after: Position,
        limit: usize,
    ) -> Result<Vec<StoredRecord>, StoreError> {
        self.inner.read_range(resource, after, limit).await
    }

    #[allow(clippy::too_many_arguments, reason = "frozen pre-6.7.2 trait API")]
    async fn compare_and_append(
        &self,
        resource: &ResourceId,
        fence: &Fence,
        expected: Position,
        batch: AppendBatch,
    ) -> Result<AppendOutcome, StoreError> {
        self.inner
            .compare_and_append(resource, fence, expected, batch)
            .await
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
        if let Some(cancellation) = self
            .cancel_before_append
            .lock()
            .expect("cancellation mutex must not be poisoned")
            .take()
        {
            cancellation.cancel();
        }
        self.inner
            .compare_and_append_guarded(resource, fence, expected, batch, guard)
            .await
    }

    async fn lookup_receipt(
        &self,
        resource: &ResourceId,
        key: &IdempotencyId,
    ) -> Result<Option<MutationReceipt>, StoreError> {
        self.inner.lookup_receipt(resource, key).await
    }

    async fn wait_for_advance(
        &self,
        resource: &ResourceId,
        after: Position,
        deadline_ms: u64,
    ) -> Result<Position, StoreError> {
        self.inner
            .wait_for_advance(resource, after, deadline_ms)
            .await
    }

    async fn remove(
        &self,
        resource: &ResourceId,
        fence: &Fence,
        expected: Position,
    ) -> Result<(), StoreError> {
        self.inner.remove(resource, fence, expected).await
    }
}

pub(super) async fn race_ledger(label: &str) -> (SnapshotRaceStore, ClusterLedger) {
    let inner: Arc<dyn LedgerStore> = Arc::new(FakeLedgerStore::new(ManualLedgerClock::new(1_000)));
    let race_store = SnapshotRaceStore::new(inner);
    let store: Arc<dyn LedgerStore> = Arc::new(race_store.clone());
    let ledger = ClusterLedger::create(store, resource(label), owner("race-owner"), 10_000)
        .await
        .unwrap();
    (race_store, ledger)
}
