use std::any::Any;
use std::collections::{BTreeMap, BTreeSet};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex as StdMutex, MutexGuard, PoisonError};
use std::time::Duration;

use async_trait::async_trait;
use openengine_cluster_protocol::{
    GraphSpec, IdempotencyKey, NodeName, RunForceParams, RunId, RunStatus, RunStatusParams,
    TerminalResult, WorkerOutcome,
};
use serde_json::{json, Value};
use tokio::sync::watch;

use super::*;
use crate::execution::SessionScope;
use crate::native_v2_contract::{CodexProvider, NodeInvocation};
use crate::native_v2_runner::{
    DriverControl, DriverInvocation, LiveOutput, LiveOutputStream, NativeNodeRunner, NodeDriver,
    NodeRunnerError, NodeSession, ResolvedEnvironment, SessionFactory,
};
use crate::v2_run_ledger::fake::FakeRunLedger;
use crate::worker_catalog::{ModelId, ReasoningEffort};

#[derive(Clone, Copy)]
enum Behavior {
    Complete,
    Hang,
}

struct FakeDriver {
    behavior: Behavior,
    starts: AtomicUsize,
    environments: StdMutex<Vec<BTreeMap<String, String>>>,
    started: watch::Sender<bool>,
}

impl FakeDriver {
    fn new(behavior: Behavior) -> Self {
        let (started, _) = watch::channel(false);
        Self {
            behavior,
            starts: AtomicUsize::new(0),
            environments: StdMutex::new(Vec::new()),
            started,
        }
    }

    fn environments(&self) -> MutexGuard<'_, Vec<BTreeMap<String, String>>> {
        self.environments
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }

    async fn wait_started(&self) {
        let mut started = self.started.subscribe();
        if *started.borrow() {
            return;
        }
        while started.changed().await.is_ok() {
            if *started.borrow() {
                return;
            }
        }
    }
}

#[async_trait]
impl NodeDriver for FakeDriver {
    async fn run(
        &self,
        invocation: DriverInvocation,
        mut control: DriverControl,
    ) -> Result<WorkerOutcome, NodeRunnerError> {
        self.starts.fetch_add(1, Ordering::SeqCst);
        self.environments().push(
            invocation
                .environment
                .iter()
                .map(|(name, value)| (name.as_str().to_owned(), value.to_owned()))
                .collect(),
        );
        let _ = self.started.send(true);
        control.emit(LiveOutput::new(LiveOutputStream::Output, "safe output")?)?;
        match self.behavior {
            Behavior::Complete => Ok(WorkerOutcome::Verified {
                output: Value::Null,
                artifacts: Vec::new(),
            }),
            Behavior::Hang => {
                control.cancelled().await;
                Err(NodeRunnerError::Cancelled)
            }
        }
    }
}

#[derive(Default)]
struct GraphDriver {
    starts: StdMutex<Vec<String>>,
    active: AtomicUsize,
    max_active: AtomicUsize,
    loop_visits: AtomicUsize,
}

impl GraphDriver {
    fn starts(&self, node: &str) -> usize {
        self.starts
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .iter()
            .filter(|started| started.as_str() == node)
            .count()
    }
}

#[async_trait]
impl NodeDriver for GraphDriver {
    async fn run(
        &self,
        invocation: DriverInvocation,
        _control: DriverControl,
    ) -> Result<WorkerOutcome, NodeRunnerError> {
        let node = invocation.node.reference.node.as_str().to_owned();
        self.starts
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push(node.clone());
        let active = self.active.fetch_add(1, Ordering::SeqCst) + 1;
        self.max_active.fetch_max(active, Ordering::SeqCst);
        if matches!(node.as_str(), "left" | "right") {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let outcome = if node == "worker" {
            WorkerOutcome::Verified {
                output: Value::Null,
                artifacts: Vec::new(),
            }
        } else {
            let label =
                if node == "loop_check" && self.loop_visits.fetch_add(1, Ordering::SeqCst) == 0 {
                    "rejected"
                } else {
                    "accepted"
                };
            WorkerOutcome::Verifier {
                output: Value::Null,
                signals: BTreeMap::from([(
                    serde_json::from_value(json!("verdict")).expect("field name"),
                    EnumLabel::new(label).expect("enum label"),
                )]),
                diagnostic: Value::Null,
                artifacts: Vec::new(),
            }
        };
        self.active.fetch_sub(1, Ordering::SeqCst);
        Ok(outcome)
    }
}

struct FakeSession {
    live: AtomicBool,
}

#[async_trait]
impl NodeSession for FakeSession {
    fn as_any(&self) -> &dyn Any {
        self
    }

    async fn is_live(&self) -> bool {
        self.live.load(Ordering::SeqCst)
    }

    async fn close(&self) {
        self.live.store(false, Ordering::SeqCst);
    }
}

struct FakeSessionFactory;

#[async_trait]
impl SessionFactory for FakeSessionFactory {
    async fn open(
        &self,
        _invocation: &NodeInvocation,
        _environment: &ResolvedEnvironment,
    ) -> Result<Arc<dyn NodeSession>, NodeRunnerError> {
        Ok(Arc::new(FakeSession {
            live: AtomicBool::new(true),
        }))
    }
}

struct FakeCleanup {
    ledger: Arc<FakeRunLedger>,
    exits: StdMutex<Vec<RunRuntimeExit>>,
    terminal_seen: StdMutex<Vec<bool>>,
    failures_remaining: AtomicUsize,
}

impl FakeCleanup {
    fn new(ledger: Arc<FakeRunLedger>) -> Self {
        Self {
            ledger,
            exits: StdMutex::new(Vec::new()),
            terminal_seen: StdMutex::new(Vec::new()),
            failures_remaining: AtomicUsize::new(0),
        }
    }

    fn fail_next(&self) {
        self.failures_remaining.fetch_add(1, Ordering::SeqCst);
    }

    fn exits(&self) -> Vec<RunRuntimeExit> {
        self.exits
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    fn terminal_seen(&self) -> Vec<bool> {
        self.terminal_seen
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }
}

#[async_trait]
impl CapsuleCleanup for FakeCleanup {
    async fn destroy_or_confirm_absent(
        &self,
        exit: RunRuntimeExit,
    ) -> Result<CapsuleDestroyed, CapsuleCleanupUnavailable> {
        let terminal_seen = match self.ledger.list().await {
            Ok(runs) => {
                let Some(run) = runs.first() else {
                    return Err(CapsuleCleanupUnavailable);
                };
                self.ledger
                    .get(&run.run_id)
                    .await
                    .map_err(|_| CapsuleCleanupUnavailable)?
                    .is_some_and(|stored| stored.snapshot.terminal.is_some())
            }
            Err(_) => return Err(CapsuleCleanupUnavailable),
        };
        self.terminal_seen
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push(terminal_seen);
        self.exits
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push(exit);
        if self
            .failures_remaining
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |remaining| {
                remaining.checked_sub(1)
            })
            .is_ok()
        {
            return Err(CapsuleCleanupUnavailable);
        }
        Ok(CapsuleDestroyed::confirmed())
    }
}

#[derive(Clone, Default)]
struct FakeClaimAuthority {
    held: Arc<AtomicBool>,
}

impl FakeClaimAuthority {
    fn acquire(&self) -> Result<Arc<dyn ExclusiveControllerClaim>, ControllerClaimUnavailable> {
        if self.held.swap(true, Ordering::SeqCst) {
            return Err(ControllerClaimUnavailable);
        }
        Ok(Arc::new(FakeControllerClaim {
            held: self.held.clone(),
        }))
    }
}

struct FakeControllerClaim {
    held: Arc<AtomicBool>,
}

impl ExclusiveControllerClaim for FakeControllerClaim {}

impl Drop for FakeControllerClaim {
    fn drop(&mut self) {
        self.held.store(false, Ordering::SeqCst);
    }
}

struct FakeAllocator {
    claims: FakeClaimAuthority,
    allocations: AtomicUsize,
    driver: Arc<dyn NodeDriver>,
    cleanup: Arc<FakeCleanup>,
    loss: StdMutex<Vec<watch::Sender<bool>>>,
}

impl FakeAllocator {
    fn new(driver: Arc<dyn NodeDriver>, cleanup: Arc<FakeCleanup>) -> Self {
        Self {
            claims: FakeClaimAuthority::default(),
            allocations: AtomicUsize::new(0),
            driver,
            cleanup,
            loss: StdMutex::new(Vec::new()),
        }
    }

    fn allocation_count(&self) -> usize {
        self.allocations.load(Ordering::SeqCst)
    }

    fn lose_capsule(&self) {
        let loss = self.loss.lock().unwrap_or_else(PoisonError::into_inner);
        let sender = loss.last().expect("allocated capsule has a loss sender");
        sender.send_replace(true);
    }
}

#[async_trait]
impl CapsuleAllocator for FakeAllocator {
    async fn claim_controller(
        &self,
    ) -> Result<Arc<dyn ExclusiveControllerClaim>, ControllerClaimUnavailable> {
        self.claims.acquire()
    }

    async fn allocate(
        &self,
        _run_id: &RunId,
        admitted: &AdmittedRun,
    ) -> Result<AllocatedCapsule, CapsuleAllocationUnavailable> {
        self.allocations.fetch_add(1, Ordering::SeqCst);
        let runner =
            NativeNodeRunner::new(admitted, self.driver.clone(), Arc::new(FakeSessionFactory))
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

    async fn destroy_or_confirm_absent(
        &self,
        _run_id: &RunId,
        exit: RunRuntimeExit,
    ) -> Result<CapsuleDestroyed, CapsuleCleanupUnavailable> {
        self.cleanup.destroy_or_confirm_absent(exit).await
    }
}

struct GatedAllocator {
    claims: FakeClaimAuthority,
    allocations: AtomicUsize,
    driver: Arc<dyn NodeDriver>,
    cleanup: Arc<FakeCleanup>,
    allocation_started: watch::Sender<bool>,
    allocation_released: watch::Sender<bool>,
    loss: StdMutex<Vec<watch::Sender<bool>>>,
}

impl GatedAllocator {
    fn new(driver: Arc<dyn NodeDriver>, cleanup: Arc<FakeCleanup>) -> Self {
        let (allocation_started, _) = watch::channel(false);
        let (allocation_released, _) = watch::channel(false);
        Self {
            claims: FakeClaimAuthority::default(),
            allocations: AtomicUsize::new(0),
            driver,
            cleanup,
            allocation_started,
            allocation_released,
            loss: StdMutex::new(Vec::new()),
        }
    }

    async fn wait_started(&self) {
        let mut started = self.allocation_started.subscribe();
        while !*started.borrow_and_update() {
            started
                .changed()
                .await
                .expect("allocation gate remains live");
        }
    }

    fn release(&self) {
        self.allocation_released.send_replace(true);
    }
}

#[async_trait]
impl CapsuleAllocator for GatedAllocator {
    async fn claim_controller(
        &self,
    ) -> Result<Arc<dyn ExclusiveControllerClaim>, ControllerClaimUnavailable> {
        self.claims.acquire()
    }

    async fn allocate(
        &self,
        _run_id: &RunId,
        admitted: &AdmittedRun,
    ) -> Result<AllocatedCapsule, CapsuleAllocationUnavailable> {
        self.allocations.fetch_add(1, Ordering::SeqCst);
        self.allocation_started.send_replace(true);
        let mut released = self.allocation_released.subscribe();
        while !*released.borrow_and_update() {
            released
                .changed()
                .await
                .map_err(|_| CapsuleAllocationUnavailable)?;
        }
        let runner =
            NativeNodeRunner::new(admitted, self.driver.clone(), Arc::new(FakeSessionFactory))
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

    async fn destroy_or_confirm_absent(
        &self,
        _run_id: &RunId,
        exit: RunRuntimeExit,
    ) -> Result<CapsuleDestroyed, CapsuleCleanupUnavailable> {
        self.cleanup.destroy_or_confirm_absent(exit).await
    }
}

struct Harness {
    controller: NativeV2CloudController,
    ledger: Arc<FakeRunLedger>,
    driver: Arc<FakeDriver>,
    cleanup: Arc<FakeCleanup>,
    allocator: Arc<FakeAllocator>,
}

async fn harness(behavior: Behavior) -> Harness {
    let ledger = Arc::new(FakeRunLedger::new());
    let driver = Arc::new(FakeDriver::new(behavior));
    let cleanup = Arc::new(FakeCleanup::new(ledger.clone()));
    let allocator = Arc::new(FakeAllocator::new(driver.clone(), cleanup.clone()));
    let token = EnvironmentVariableName::new("NODE_TOKEN").expect("environment name");
    let extra = EnvironmentVariableName::new("EXTRA_SECRET").expect("environment name");
    let environment = ControllerEnvironment::new(BTreeMap::from([
        (token, "declared-secret".to_owned()),
        (extra, "must-not-pass".to_owned()),
    ]));
    let controller =
        NativeV2CloudController::new(ledger.clone(), runtime(), environment, allocator.clone())
            .await
            .expect("controller startup");
    Harness {
        controller,
        ledger,
        driver,
        cleanup,
        allocator,
    }
}

fn runtime() -> RuntimePlan {
    RuntimePlan::Codex {
        provider: CodexProvider::OpenAi,
        nodes: BTreeMap::from([(
            NodeName::new("worker").expect("node"),
            NodeRuntimeBinding::Agent {
                model: ModelId::new("gpt-5.6").expect("model"),
                effort: Some(ReasoningEffort::Max),
                session_scope: SessionScope::Execution,
                env: BTreeSet::from([
                    EnvironmentVariableName::new("NODE_TOKEN").expect("environment name")
                ]),
            },
        )]),
    }
}

fn request(input: Value) -> CloudRunSubmission {
    CloudRunSubmission {
        graph: graph(),
        initial_input: input,
        ship: false,
        submission_key: IdempotencyKey::new("cloud-test").expect("submission key"),
    }
}

fn graph() -> GraphSpec {
    serde_json::from_value(json!({
        "profile": "openengine.graph.full/v1",
        "initialInput": {"kind": "null"},
        "policy": {"policy": "policy.native-v2@1", "default": "deny"},
        "root": {
            "kind": "seq",
            "name": "root",
            "state": {"kind": "null"},
            "children": [
                {
                    "kind": "step",
                    "name": "worker",
                    "worker": "agent.worker@1",
                    "input": {"kind": "null"},
                    "output": {"kind": "null"},
                    "inputBindings": [],
                    "writeBindings": [],
                    "timeoutMs": 10000,
                    "attempts": 1
                },
                {
                    "kind": "succeed",
                    "name": "done",
                    "output": {"kind": "null"},
                    "bindings": []
                }
            ],
            "promotedStatePaths": []
        }
    }))
    .expect("graph")
}

fn complex_runtime() -> RuntimePlan {
    let binding = || NodeRuntimeBinding::Agent {
        model: ModelId::new("gpt-5.6").expect("model"),
        effort: Some(ReasoningEffort::Max),
        session_scope: SessionScope::Execution,
        env: BTreeSet::new(),
    };
    RuntimePlan::Codex {
        provider: CodexProvider::OpenAi,
        nodes: ["worker", "left", "right", "loop_check"]
            .into_iter()
            .map(|name| (NodeName::new(name).expect("node"), binding()))
            .collect(),
    }
}

fn complex_request() -> CloudRunSubmission {
    let verifier = |name: &str| {
        json!({
            "kind": "verifier",
            "name": name,
            "worker": format!("agent.{name}@1"),
            "input": {"kind": "null"},
            "output": {"kind": "null"},
            "inputBindings": [],
            "writeBindings": [],
            "timeoutMs": 10000,
            "attempts": 1,
            "signals": {"verdict": ["accepted", "rejected"]},
            "diagnostic": {"kind": "null"}
        })
    };
    let graph = serde_json::from_value(json!({
        "profile": "openengine.graph.full/v1",
        "initialInput": {"kind": "null"},
        "policy": {"policy": "policy.native-v2@1", "default": "deny"},
        "root": {
            "kind": "seq",
            "name": "root",
            "state": {"kind": "null"},
            "children": [
                {
                    "kind": "step",
                    "name": "worker",
                    "worker": "agent.worker@1",
                    "input": {"kind": "null"},
                    "output": {"kind": "null"},
                    "inputBindings": [],
                    "writeBindings": [],
                    "timeoutMs": 10000,
                    "attempts": 1
                },
                {
                    "kind": "par",
                    "name": "parallel_verifiers",
                    "state": {"kind": "null"},
                    "branches": [verifier("left"), verifier("right")],
                    "join": {"kind": "all"},
                    "promotedStatePaths": []
                },
                {
                    "kind": "loop",
                    "name": "review_loop",
                    "state": {"kind": "null"},
                    "body": verifier("loop_check"),
                    "until": {
                        "kind": "in",
                        "value": {"name": "loop_check", "source": "signal", "field": "verdict"},
                        "labels": ["accepted"]
                    },
                    "maxIterations": 3,
                    "promotedStatePaths": []
                },
                {"kind": "succeed", "name": "done", "output": {"kind": "null"}, "bindings": []}
            ],
            "promotedStatePaths": []
        }
    }))
    .expect("complex graph");
    CloudRunSubmission {
        graph,
        initial_input: Value::Null,
        ship: false,
        submission_key: IdempotencyKey::new("cloud-complex").expect("submission key"),
    }
}

async fn terminal(controller: &NativeV2CloudController, run_id: &RunId) -> TerminalResult {
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let result = controller
                .status(RunStatusParams {
                    run_id: run_id.clone(),
                })
                .await
                .expect("status");
            if let RunStatus::Finished { terminal_result } = result.status {
                return terminal_result;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("run became terminal")
}

async fn seed_controller_reconstructed_run(ledger: &Arc<FakeRunLedger>, run_id: &str) -> RunId {
    let request = request(Value::Null);
    let submission = RunSubmission {
        graph: request.graph,
        initial_input: request.initial_input,
        runtime: runtime(),
        ship: request.ship,
        submission_key: request.submission_key,
    };
    let admitted = NativeV2Admission
        .admit(submission.clone())
        .await
        .expect("admitted");
    let run_id = RunId::new(run_id);
    assert!(matches!(
        ledger
            .create_or_get(CreateRun {
                run_id: run_id.clone(),
                submission_key: submission.submission_key.clone(),
                submission_digest: submission_digest(&submission).expect("digest"),
                admitted,
            })
            .await
            .expect("create"),
        CreateRunOutcome::Created(_)
    ));
    run_id
}

#[tokio::test]
async fn invalid_submission_has_no_durable_or_allocation_effect() {
    let harness = harness(Behavior::Complete).await;
    assert!(matches!(
        harness.controller.submit(request(json!({}))).await,
        Err(NativeV2CloudError::Admission(_))
    ));
    assert_eq!(harness.allocator.allocation_count(), 0);
    assert!(harness.controller.list().await.expect("list").is_empty());
}

#[tokio::test]
async fn startup_reconciles_every_persisted_nonterminal_before_status_is_visible() {
    let ledger = Arc::new(FakeRunLedger::new());
    let run_id = seed_controller_reconstructed_run(&ledger, "run-restart").await;
    let driver = Arc::new(FakeDriver::new(Behavior::Complete));
    let cleanup = Arc::new(FakeCleanup::new(ledger.clone()));
    let allocator = Arc::new(FakeAllocator::new(driver, cleanup.clone()));
    let controller = NativeV2CloudController::new(
        ledger,
        runtime(),
        ControllerEnvironment::default(),
        allocator.clone(),
    )
    .await
    .expect("reconciled startup");

    let status = controller
        .status(RunStatusParams {
            run_id: run_id.clone(),
        })
        .await
        .expect("status after startup");
    assert_eq!(
        status.status,
        RunStatus::Finished {
            terminal_result: TerminalResult::Failed {
                reason: EnumLabel::new("runtime_lost").expect("label")
            }
        }
    );
    assert_eq!(controller.list().await.expect("list").len(), 1);
    assert_eq!(allocator.allocation_count(), 0);
    assert_eq!(cleanup.exits(), vec![RunRuntimeExit::RuntimeLost]);
    assert_eq!(cleanup.terminal_seen(), vec![false]);
}

#[tokio::test]
async fn allocator_rejects_a_second_live_controller_for_the_same_target() {
    let ledger = Arc::new(FakeRunLedger::new());
    let driver = Arc::new(FakeDriver::new(Behavior::Complete));
    let cleanup = Arc::new(FakeCleanup::new(ledger.clone()));
    let allocator = Arc::new(FakeAllocator::new(driver, cleanup));
    let first = NativeV2CloudController::new(
        ledger.clone(),
        runtime(),
        ControllerEnvironment::default(),
        allocator.clone(),
    )
    .await
    .expect("first controller");
    assert!(matches!(
        NativeV2CloudController::new(
            ledger.clone(),
            runtime(),
            ControllerEnvironment::default(),
            allocator.clone(),
        )
        .await,
        Err(NativeV2CloudError::ControllerClaim(_))
    ));
    drop(first);
    NativeV2CloudController::new(
        ledger,
        runtime(),
        ControllerEnvironment::default(),
        allocator,
    )
    .await
    .expect("claim released with controller lifetime");
}

#[tokio::test]
async fn oecp_backend_submits_and_lists_the_same_public_run_identity() {
    let harness = harness(Behavior::Complete).await;
    let request = request(Value::Null);
    let submitted = ClusterBackend::run_submit(
        &harness.controller,
        &ConnectionContext::default(),
        RunSubmitParams {
            graph: request.graph,
            initial_input: request.initial_input,
            ship: request.ship,
            submission_key: request.submission_key,
        },
    )
    .await
    .expect("OECP submit");
    terminal(&harness.controller, &submitted.run_id).await;
    let listed = ClusterBackend::run_list(
        &harness.controller,
        &ConnectionContext::default(),
        RunListParams::default(),
    )
    .await
    .expect("OECP list");
    assert_eq!(listed.runs.len(), 1);
    assert_eq!(listed.runs[0].run_id, submitted.run_id);
}

#[tokio::test]
async fn one_capsule_drives_worker_parallel_verifiers_and_loop() {
    let ledger = Arc::new(FakeRunLedger::new());
    let driver = Arc::new(GraphDriver::default());
    let cleanup = Arc::new(FakeCleanup::new(ledger.clone()));
    let allocator = Arc::new(FakeAllocator::new(driver.clone(), cleanup.clone()));
    let controller = NativeV2CloudController::new(
        ledger,
        complex_runtime(),
        ControllerEnvironment::default(),
        allocator.clone(),
    )
    .await
    .expect("controller startup");
    let receipt = controller
        .submit(complex_request())
        .await
        .expect("submit complex graph");
    assert!(matches!(
        terminal(&controller, &receipt.run_id).await,
        TerminalResult::Succeeded { .. }
    ));
    assert_eq!(allocator.allocation_count(), 1);
    assert_eq!(driver.starts("worker"), 1);
    assert_eq!(driver.starts("left"), 1);
    assert_eq!(driver.starts("right"), 1);
    assert_eq!(driver.starts("loop_check"), 2);
    assert!(driver.max_active.load(Ordering::SeqCst) >= 2);
    assert_eq!(cleanup.exits(), vec![RunRuntimeExit::Completed]);
}

#[tokio::test]
async fn valid_run_injects_only_declared_environment_and_dedupes() {
    let harness = harness(Behavior::Complete).await;
    let first = harness
        .controller
        .submit(request(Value::Null))
        .await
        .expect("submit");
    assert!(!first.deduped);
    assert!(matches!(
        terminal(&harness.controller, &first.run_id).await,
        TerminalResult::Succeeded { .. }
    ));
    let second = harness
        .controller
        .submit(request(Value::Null))
        .await
        .expect("dedupe");
    assert!(second.deduped);
    assert_eq!(second.run_id, first.run_id);
    assert_eq!(harness.allocator.allocation_count(), 1);
    assert_eq!(
        harness.driver.environments().as_slice(),
        &[BTreeMap::from([(
            "NODE_TOKEN".to_owned(),
            "declared-secret".to_owned()
        )])]
    );
    assert_eq!(harness.cleanup.exits(), vec![RunRuntimeExit::Completed]);
    assert_eq!(harness.cleanup.terminal_seen(), vec![false]);
    let stored = harness
        .ledger
        .get(&first.run_id)
        .await
        .expect("ledger")
        .expect("stored");
    assert!(
        !serde_json::to_string(&stored)
            .expect("stored JSON")
            .contains("declared-secret")
    );
}

#[tokio::test]
async fn force_destroys_live_capsule_before_one_terminal_result() {
    let harness = harness(Behavior::Hang).await;
    let receipt = harness
        .controller
        .submit(request(Value::Null))
        .await
        .expect("submit");
    harness.driver.wait_started().await;
    harness
        .controller
        .force(RunForceParams {
            run_id: receipt.run_id.clone(),
        })
        .await
        .expect("force");
    assert_eq!(
        terminal(&harness.controller, &receipt.run_id).await,
        TerminalResult::Failed {
            reason: EnumLabel::new("force_stopped").expect("label")
        }
    );
    assert_eq!(harness.cleanup.exits(), vec![RunRuntimeExit::ForceStopped]);
    assert_eq!(harness.cleanup.terminal_seen(), vec![false]);
    let tail = harness
        .ledger
        .snapshot_and_tail(&receipt.run_id, None)
        .await
        .expect("tail");
    assert_eq!(
        tail.events
            .iter()
            .filter(|event| matches!(event.event, RunEvent::Terminal { .. }))
            .count(),
        1
    );
}

#[tokio::test]
async fn force_waits_for_in_flight_allocation_then_destroys_without_a_post_force_leak() {
    let ledger = Arc::new(FakeRunLedger::new());
    let driver = Arc::new(FakeDriver::new(Behavior::Hang));
    let cleanup = Arc::new(FakeCleanup::new(ledger.clone()));
    let allocator = Arc::new(GatedAllocator::new(driver, cleanup.clone()));
    let controller = NativeV2CloudController::new(
        ledger.clone(),
        runtime(),
        ControllerEnvironment::default(),
        allocator.clone(),
    )
    .await
    .expect("controller startup");

    let submit_controller = controller.clone();
    let submit = tokio::spawn(async move {
        submit_controller
            .submit(request(Value::Null))
            .await
            .expect("submit")
    });
    allocator.wait_started().await;
    let run_id = ledger
        .list()
        .await
        .expect("list")
        .into_iter()
        .next()
        .expect("durable run")
        .run_id;
    let force_controller = controller.clone();
    let force_run_id = run_id.clone();
    let mut force = tokio::spawn(async move {
        force_controller
            .force(RunForceParams {
                run_id: force_run_id,
            })
            .await
            .expect("force")
    });

    assert!(
        tokio::time::timeout(Duration::from_millis(25), &mut force)
            .await
            .is_err()
    );
    assert_eq!(allocator.allocations.load(Ordering::SeqCst), 1);
    assert!(cleanup.exits().is_empty());

    allocator.release();
    assert_eq!(submit.await.expect("submit task").run_id, run_id);
    let forced = tokio::time::timeout(Duration::from_secs(2), force)
        .await
        .expect("force completed")
        .expect("force task");
    assert!(matches!(forced.status, RunStatus::Finished { .. }));
    assert_eq!(allocator.allocations.load(Ordering::SeqCst), 1);
    assert_eq!(cleanup.exits().len(), 1);
    assert_eq!(cleanup.terminal_seen(), vec![false]);
}

#[tokio::test]
async fn capsule_loss_confirms_absence_then_terminalizes_without_replacement() {
    let harness = harness(Behavior::Hang).await;
    let receipt = harness
        .controller
        .submit(request(Value::Null))
        .await
        .expect("submit");
    harness.driver.wait_started().await;
    harness.allocator.lose_capsule();
    assert_eq!(
        terminal(&harness.controller, &receipt.run_id).await,
        TerminalResult::Failed {
            reason: EnumLabel::new("runtime_lost").expect("label")
        }
    );
    assert_eq!(harness.cleanup.exits(), vec![RunRuntimeExit::RuntimeLost]);
    assert_eq!(harness.cleanup.terminal_seen(), vec![false]);
    let replay = harness
        .controller
        .submit(request(Value::Null))
        .await
        .expect("resubmit");
    assert!(replay.deduped);
    assert_eq!(replay.run_id, receipt.run_id);
    assert_eq!(harness.allocator.allocation_count(), 1);
}

#[tokio::test]
async fn exact_resubmit_of_controller_reconstructed_run_confirms_absence_without_allocation() {
    let harness = harness(Behavior::Complete).await;
    let run_id = seed_controller_reconstructed_run(&harness.ledger, "run-orphaned").await;
    let replay = harness
        .controller
        .submit(request(Value::Null))
        .await
        .expect("resubmit");
    assert!(replay.deduped);
    assert_eq!(replay.run_id, run_id);
    assert_eq!(harness.allocator.allocation_count(), 0);
    assert_eq!(
        terminal(&harness.controller, &run_id).await,
        TerminalResult::Failed {
            reason: EnumLabel::new("runtime_lost").expect("label")
        }
    );
    assert_eq!(harness.cleanup.exits(), vec![RunRuntimeExit::RuntimeLost]);
    assert_eq!(harness.cleanup.terminal_seen(), vec![false]);
}

#[tokio::test]
async fn force_of_controller_reconstructed_run_confirms_absence_and_finishes() {
    let harness = harness(Behavior::Complete).await;
    let run_id = seed_controller_reconstructed_run(&harness.ledger, "run-force-orphaned").await;
    let forced = harness
        .controller
        .force(RunForceParams {
            run_id: run_id.clone(),
        })
        .await
        .expect("force");
    assert!(matches!(forced.status, RunStatus::Finished { .. }));
    assert_eq!(harness.allocator.allocation_count(), 0);
    assert_eq!(harness.cleanup.exits(), vec![RunRuntimeExit::ForceStopped]);
    assert_eq!(harness.cleanup.terminal_seen(), vec![false]);
}

#[tokio::test]
async fn concurrent_force_of_reconstructed_run_cleans_up_and_terminalizes_once() {
    let harness = harness(Behavior::Complete).await;
    let run_id = seed_controller_reconstructed_run(&harness.ledger, "run-concurrent-force").await;
    let left_controller = harness.controller.clone();
    let left_id = run_id.clone();
    let left = tokio::spawn(async move {
        left_controller
            .force(RunForceParams { run_id: left_id })
            .await
    });
    let right_controller = harness.controller.clone();
    let right_id = run_id.clone();
    let right = tokio::spawn(async move {
        right_controller
            .force(RunForceParams { run_id: right_id })
            .await
    });
    let (left, right) = tokio::join!(left, right);
    assert!(matches!(
        left.expect("left task").expect("left force").status,
        RunStatus::Finished { .. }
    ));
    assert!(matches!(
        right.expect("right task").expect("right force").status,
        RunStatus::Finished { .. }
    ));
    assert_eq!(harness.cleanup.exits(), vec![RunRuntimeExit::ForceStopped]);
    let tail = harness
        .ledger
        .snapshot_and_tail(&run_id, None)
        .await
        .expect("tail");
    assert_eq!(
        tail.events
            .iter()
            .filter(|event| matches!(event.event, RunEvent::Terminal { .. }))
            .count(),
        1
    );
}

#[tokio::test]
async fn force_retries_cleanup_after_a_drive_cleanup_failure() {
    let harness = harness(Behavior::Complete).await;
    harness.cleanup.fail_next();
    let receipt = harness
        .controller
        .submit(request(Value::Null))
        .await
        .expect("submit");
    tokio::time::timeout(Duration::from_secs(2), async {
        while harness.cleanup.exits().is_empty() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("first cleanup attempted");
    assert!(
        harness
            .ledger
            .get(&receipt.run_id)
            .await
            .expect("ledger")
            .expect("stored")
            .snapshot
            .terminal
            .is_none()
    );

    harness
        .controller
        .force(RunForceParams {
            run_id: receipt.run_id.clone(),
        })
        .await
        .expect("force retries cleanup");
    assert_eq!(
        terminal(&harness.controller, &receipt.run_id).await,
        TerminalResult::Failed {
            reason: EnumLabel::new("force_stopped").expect("label")
        }
    );
    assert_eq!(
        harness.cleanup.exits(),
        vec![RunRuntimeExit::Completed, RunRuntimeExit::ForceStopped]
    );
    assert_eq!(harness.cleanup.terminal_seen(), vec![false, false]);
}
