use super::*;

struct AllocatorCore {
    claims: FakeClaimAuthority,
    allocations: AtomicUsize,
    driver: Arc<dyn NodeDriver>,
    sessions: Arc<FakeSessionFactory>,
    cleanup: Arc<FakeCleanup>,
    loss: StdMutex<Vec<watch::Sender<bool>>>,
}

impl AllocatorCore {
    fn new(driver: Arc<dyn NodeDriver>, cleanup: Arc<FakeCleanup>) -> Self {
        Self {
            claims: FakeClaimAuthority::default(),
            allocations: AtomicUsize::new(0),
            driver,
            sessions: Arc::new(FakeSessionFactory::default()),
            cleanup,
            loss: StdMutex::new(Vec::new()),
        }
    }

    fn allocate(
        &self,
        admitted: &AdmittedRun,
    ) -> Result<AllocatedCapsule, CapsuleAllocationUnavailable> {
        let runner = NativeNodeRunner::new(admitted, self.driver.clone(), self.sessions.clone())
            .map_err(|_| CapsuleAllocationUnavailable)?;
        let (loss, receiver) = watch::channel(false);
        self.loss
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push(loss);
        Ok(AllocatedCapsule {
            runner: Arc::new(runner),
            loss: receiver,
            cleanup: self.cleanup.clone(),
        })
    }

    fn allocation_count(&self) -> usize {
        self.allocations.load(Ordering::SeqCst)
    }

    fn lose_capsule(&self) {
        let loss = self.loss.lock().unwrap_or_else(PoisonError::into_inner);
        let sender = loss
            .last()
            .assert_value_with("allocated capsule has a loss sender");
        sender.send_replace(true);
    }
}

#[async_trait]
trait AllocationGate: Send + Sync {
    async fn enter(&self) -> Result<(), CapsuleAllocationUnavailable>;
}

pub(super) struct ImmediateAllocation;

#[async_trait]
impl AllocationGate for ImmediateAllocation {
    async fn enter(&self) -> Result<(), CapsuleAllocationUnavailable> {
        Ok(())
    }
}

pub(super) struct GatedAllocation {
    started: watch::Sender<bool>,
    released: watch::Sender<bool>,
}

impl GatedAllocation {
    fn new() -> Self {
        let (started, _) = watch::channel(false);
        let (released, _) = watch::channel(false);
        Self { started, released }
    }

    async fn wait_started(&self) {
        let mut started = self.started.subscribe();
        while !*started.borrow_and_update() {
            started
                .changed()
                .await
                .assert_value_with("allocation gate remains live");
        }
    }

    fn release(&self) {
        self.released.send_replace(true);
    }
}

#[async_trait]
impl AllocationGate for GatedAllocation {
    async fn enter(&self) -> Result<(), CapsuleAllocationUnavailable> {
        self.started.send_replace(true);
        let mut released = self.released.subscribe();
        while !*released.borrow_and_update() {
            released
                .changed()
                .await
                .map_err(|_| CapsuleAllocationUnavailable)?;
        }
        Ok(())
    }
}

pub(super) struct TestAllocator<G> {
    core: AllocatorCore,
    gate: G,
}

impl TestAllocator<ImmediateAllocation> {
    pub(super) fn new(driver: Arc<dyn NodeDriver>, cleanup: Arc<FakeCleanup>) -> Self {
        Self {
            core: AllocatorCore::new(driver, cleanup),
            gate: ImmediateAllocation,
        }
    }

    pub(super) fn lose_capsule(&self) {
        self.core.lose_capsule();
    }

    pub(super) fn sessions(&self) -> &FakeSessionFactory {
        &self.core.sessions
    }
}

impl<G> TestAllocator<G> {
    pub(super) fn allocation_count(&self) -> usize {
        self.core.allocation_count()
    }
}

impl TestAllocator<GatedAllocation> {
    pub(super) fn new(driver: Arc<dyn NodeDriver>, cleanup: Arc<FakeCleanup>) -> Self {
        Self {
            core: AllocatorCore::new(driver, cleanup),
            gate: GatedAllocation::new(),
        }
    }

    pub(super) async fn wait_started(&self) {
        self.gate.wait_started().await;
    }

    pub(super) fn release(&self) {
        self.gate.release();
    }
}

#[async_trait]
impl<G> CapsuleAllocator for TestAllocator<G>
where
    G: AllocationGate,
{
    async fn claim_controller(
        &self,
        run_id: &RunId,
    ) -> Result<Arc<dyn ExclusiveControllerClaim>, ControllerClaimUnavailable> {
        self.core.claims.acquire(run_id)
    }

    async fn allocate(
        &self,
        _run_id: &RunId,
        admitted: &AdmittedRun,
        _environment: &RunEnvironment,
    ) -> Result<AllocatedCapsule, CapsuleAllocationUnavailable> {
        self.core.allocations.fetch_add(1, Ordering::SeqCst);
        self.gate.enter().await?;
        self.core.allocate(admitted)
    }

    async fn destroy_or_confirm_absent(
        &self,
        _run_id: &RunId,
        exit: RunRuntimeExit,
    ) -> Result<CapsuleDestroyed, CapsuleCleanupUnavailable> {
        self.core.cleanup.destroy_or_confirm_absent(exit).await
    }
}

pub(super) type FakeAllocator = TestAllocator<ImmediateAllocation>;
pub(super) type GatedAllocator = TestAllocator<GatedAllocation>;

pub(super) struct Harness {
    pub(super) controller: NativeV2CloudController,
    pub(super) ledger: Arc<FakeRunLedger>,
    pub(super) driver: Arc<FakeDriver>,
    pub(super) cleanup: Arc<FakeCleanup>,
    pub(super) allocator: Arc<FakeAllocator>,
}

pub(super) struct GatedHarness {
    pub(super) controller: NativeV2CloudController,
    pub(super) ledger: Arc<FakeRunLedger>,
    pub(super) cleanup: Arc<FakeCleanup>,
    pub(super) allocator: Arc<GatedAllocator>,
}

pub(super) async fn gated_harness() -> GatedHarness {
    let ledger = Arc::new(FakeRunLedger::new());
    let driver = Arc::new(FakeDriver::new(Behavior::Hang));
    let cleanup = Arc::new(FakeCleanup::new(ledger.clone()));
    let allocator = Arc::new(GatedAllocator::new(driver, cleanup.clone()));
    let controller = NativeV2CloudController::new(ledger.clone(), allocator.clone())
        .await
        .assert_value_with("controller startup");
    GatedHarness {
        controller,
        ledger,
        cleanup,
        allocator,
    }
}

pub(super) async fn harness(behavior: Behavior) -> Harness {
    let ledger = Arc::new(FakeRunLedger::new());
    let driver = Arc::new(FakeDriver::new(behavior));
    let cleanup = Arc::new(FakeCleanup::new(ledger.clone()));
    let allocator = Arc::new(FakeAllocator::new(driver.clone(), cleanup.clone()));
    let controller = NativeV2CloudController::new(ledger.clone(), allocator.clone())
        .await
        .assert_value_with("controller startup");
    Harness {
        controller,
        ledger,
        driver,
        cleanup,
        allocator,
    }
}

pub(super) async fn started_harness(behavior: Behavior) -> (Harness, CloudRunReceipt) {
    let harness = harness(behavior).await;
    let receipt = submit_test_request(&harness.controller, request(Value::Null))
        .await
        .assert_value_with("submit");
    harness.driver.wait_started().await;
    (harness, receipt)
}

pub(super) async fn assert_failed_cleanup(
    harness: &Harness,
    run_id: &RunId,
    reason: &str,
    exit: RunRuntimeExit,
) {
    assert_eq!(
        terminal(&harness.controller, run_id).await,
        TerminalResult::Failed {
            reason: EnumLabel::new(reason).assert_value_with("label")
        }
    );
    assert_eq!(harness.cleanup.exits(), vec![exit]);
    assert_eq!(harness.cleanup.terminal_seen(), vec![false]);
}

pub(super) async fn terminal(
    controller: &NativeV2CloudController,
    run_id: &RunId,
) -> TerminalResult {
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let result = controller
                .status(RunStatusParams {
                    run_id: run_id.clone(),
                })
                .await
                .assert_value_with("status");
            if let RunStatus::Finished { terminal_result } = result.status {
                return terminal_result;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .assert_value_with("run became terminal")
}

pub(super) async fn seed_controller_reconstructed_run(
    ledger: &Arc<FakeRunLedger>,
    run_id: &str,
) -> RunId {
    let request = request(Value::Null);
    let submission = request.submission;
    let admitted = NativeV2Admission
        .admit(submission.clone())
        .await
        .assert_value_with("admitted");
    let run_id = RunId::new(run_id);
    assert!(matches!(
        ledger
            .create_or_get(CreateRun {
                run_id: run_id.clone(),
                submission_key: submission.submission_key.clone(),
                intent_digest: run_intent_digest(&RunSubmissionIntent::from(&submission))
                    .assert_value_with("intent digest"),
                submission_digest: submission_digest(&submission).assert_value_with("digest"),
                admitted,
            })
            .await
            .assert_value_with("create"),
        CreateRunOutcome::Created(_)
    ));
    run_id
}

use openengine_cluster_testkit::assertions::{AssertValue};
