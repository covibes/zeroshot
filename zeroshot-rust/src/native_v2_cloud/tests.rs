use std::any::Any;
use std::collections::{BTreeMap, BTreeSet};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex as StdMutex, MutexGuard, PoisonError};
use std::time::Duration;

use async_trait::async_trait;
use openengine_cluster_protocol::{
    DeclaredEnvironment, GraphSpec, IdempotencyKey, NodeName, NodeRuntimeBinding, RunForceParams,
    RunId, RunSize, RunStatus, RunStatusParams, RunSubmitParams, RunTitle, RuntimePlan,
    SourceBranchId, SourceRepositoryId, SourceRevisionId, ResolvedSource, TerminalResult,
    WorkerOutcome,
};
use serde_json::{json, Value};
use tokio::sync::watch;

use super::*;
use crate::execution::SessionScope;
use crate::native_v2_contract::{CodexProvider, GIT_DELIVERY_PR_WORKER_REF, NodeInvocation};
use crate::native_v2_delivery::{DELIVERY_OPENED_LABEL, DELIVERY_SIGNAL_FIELD};
use crate::native_v2_runner::{
    DriverControl, DriverInvocation, LiveOutput, LiveOutputStream, NativeNodeRunner, NodeDriver,
    NodeRunnerError, NodeSession, ResolvedEnvironment, SessionFactory,
};
use crate::v2_run_ledger::fake::FakeRunLedger;
use crate::worker_catalog::ReasoningEffort;

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

fn fake_worker_outcome(invocation: &DriverInvocation) -> WorkerOutcome {
    if invocation.node.worker.as_str() == GIT_DELIVERY_PR_WORKER_REF {
        WorkerOutcome::Verifier {
            output: json!({
                "version": "v1",
                "mode": "pr",
                "outcome": "opened",
                "repository": "owner/repo",
                "targetBranch": "main",
                "headRevision": "2222222222222222222222222222222222222222",
                "pullRequestId": "1"
            }),
            signals: BTreeMap::from([(
                serde_json::from_value(json!(DELIVERY_SIGNAL_FIELD))
                    .assert_value_with("delivery signal field"),
                EnumLabel::new(DELIVERY_OPENED_LABEL).assert_value_with("delivery signal"),
            )]),
            diagnostic: json!({"message":"opened"}),
            artifacts: Vec::new(),
        }
    } else {
        WorkerOutcome::Verified {
            output: Value::Null,
            artifacts: Vec::new(),
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
            Behavior::Complete => Ok(fake_worker_outcome(&invocation)),
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
        let outcome = if invocation.node.worker.as_str() == GIT_DELIVERY_PR_WORKER_REF
            || node == "worker"
        {
            fake_worker_outcome(&invocation)
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
                    serde_json::from_value(json!("verdict")).assert_value_with("field name"),
                    EnumLabel::new(label).assert_value_with("enum label"),
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
    live: StdMutex<bool>,
}

#[async_trait]
impl NodeSession for FakeSession {
    fn as_any(&self) -> &dyn Any {
        self
    }

    async fn is_live(&self) -> bool {
        *self.live.lock().unwrap_or_else(PoisonError::into_inner)
    }

    async fn close(&self) {
        *self.live.lock().unwrap_or_else(PoisonError::into_inner) = false;
    }
}

#[derive(Default)]
struct FakeSessionFactory {
    opened: StdMutex<Vec<(String, u64, u64)>>,
}

impl FakeSessionFactory {
    fn opens(&self, node: &str) -> usize {
        self.opened
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .iter()
            .filter(|(opened, _, _)| opened == node)
            .count()
    }
}

#[async_trait]
impl SessionFactory for FakeSessionFactory {
    async fn open(
        &self,
        invocation: &NodeInvocation,
        _environment: &ResolvedEnvironment,
    ) -> Result<Arc<dyn NodeSession>, NodeRunnerError> {
        self.opened
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push((
                invocation.reference.node.as_str().to_owned(),
                invocation.reference.node_instance.get(),
                invocation.reference.execution.get(),
            ));
        Ok(Arc::new(FakeSession {
            live: StdMutex::new(true),
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
    held: Arc<StdMutex<BTreeSet<RunId>>>,
}

impl FakeClaimAuthority {
    fn acquire(
        &self,
        run_id: &RunId,
    ) -> Result<Arc<dyn ExclusiveControllerClaim>, ControllerClaimUnavailable> {
        let mut held = self.held.lock().unwrap_or_else(PoisonError::into_inner);
        if !held.insert(run_id.clone()) {
            return Err(ControllerClaimUnavailable);
        }
        Ok(Arc::new(FakeControllerClaim {
            held: self.held.clone(),
            run_id: run_id.clone(),
        }))
    }
}

struct FakeControllerClaim {
    held: Arc<StdMutex<BTreeSet<RunId>>>,
    run_id: RunId,
}

fn exact_test_environment(request: &RunSubmitParams) -> Result<RunEnvironment, NativeV2CloudError> {
    let available = BTreeMap::from([
        (
            EnvironmentVariableName::new("NODE_TOKEN").assert_value_with("environment name"),
            "declared-secret".to_owned(),
        ),
        (
            EnvironmentVariableName::new("EXTRA_SECRET").assert_value_with("environment name"),
            "must-not-pass".to_owned(),
        ),
    ]);
    Ok(RunEnvironment::from_available(
        &request.submission.runtime,
        &available,
    )?)
}

async fn submit_test_request(
    controller: &NativeV2CloudController,
    request: RunSubmitParams,
) -> Result<CloudRunReceipt, NativeV2CloudError> {
    let environment = exact_test_environment(&request)?;
    controller
        .submit_with_exact_environment(request, environment)
        .await
}

impl ExclusiveControllerClaim for FakeControllerClaim {}

impl Drop for FakeControllerClaim {
    fn drop(&mut self) {
        self.held
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(&self.run_id);
    }
}

#[path = "tests/support_runtime.rs"]
mod support_runtime;
use support_runtime::*;
#[path = "tests/support_graph.rs"]
mod support_graph;
use support_graph::*;
#[path = "tests/cases_1.rs"]
mod cases_1;
#[path = "tests/cases_2.rs"]
mod cases_2;
#[path = "tests/cases_3.rs"]
mod cases_3;
#[path = "tests/cases_4.rs"]
mod cases_4;
#[path = "tests/cases_5.rs"]
mod cases_5;

use openengine_cluster_testkit::assertions::{AssertValue};
