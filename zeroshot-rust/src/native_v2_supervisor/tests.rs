use std::any::Any;
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::sync::{Arc, Mutex as StdMutex, MutexGuard};
use std::time::Duration;

use async_trait::async_trait;
use openengine_cluster_protocol::{
    GraphNode, GraphSpec, NodeName, RunId, Sha256Digest, TerminalResult, WorkerErrorCode,
    WorkerOutcome,
};
use serde_json::{Value, json};

use super::*;
use crate::native_v2_admission::NativeV2Admission;
use crate::native_v2_contract::RunSubmission;
use crate::native_v2_runner::{
    DriverControl, DriverInvocation, LiveOutput, LiveOutputStream, NativeNodeRunner, NodeDriver,
    NodeRole, NodeSession, SessionFactory,
};
use crate::v2_run_ledger::CreateRun;
use crate::v2_run_ledger::fake::FakeRunLedger;

struct FakeSession;

#[async_trait]
impl NodeSession for FakeSession {
    fn as_any(&self) -> &dyn Any {
        self
    }

    async fn is_live(&self) -> bool {
        true
    }

    async fn close(&self) {}
}

#[derive(Clone, Default)]
struct FakeSessionFactory;

#[async_trait]
impl SessionFactory for FakeSessionFactory {
    async fn open(
        &self,
        _invocation: &NodeInvocation,
        _environment: &ResolvedEnvironment,
    ) -> Result<Arc<dyn NodeSession>, NodeRunnerError> {
        Ok(Arc::new(FakeSession))
    }
}

#[derive(Clone)]
enum Behavior {
    Complete {
        delay: Duration,
        outcome: WorkerOutcome,
    },
    Hang,
}

#[derive(Default)]
struct DriverState {
    scripts: BTreeMap<String, VecDeque<Behavior>>,
    starts: Vec<String>,
    emissions: Vec<String>,
    cancellations: Vec<String>,
    active: usize,
    max_active: usize,
}

#[derive(Clone, Default)]
struct FakeDriver {
    state: Arc<StdMutex<DriverState>>,
}

impl FakeDriver {
    fn scripted(scripts: impl IntoIterator<Item = (&'static str, Vec<Behavior>)>) -> Self {
        let state = DriverState {
            scripts: scripts
                .into_iter()
                .map(|(node, values)| (node.to_owned(), values.into()))
                .collect(),
            ..DriverState::default()
        };
        Self {
            state: Arc::new(StdMutex::new(state)),
        }
    }

    fn state(&self) -> MutexGuard<'_, DriverState> {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn starts(&self, node: &str) -> usize {
        self.state()
            .starts
            .iter()
            .filter(|started| started.as_str() == node)
            .count()
    }

    fn cancellations(&self, node: &str) -> usize {
        self.state()
            .cancellations
            .iter()
            .filter(|cancelled| cancelled.as_str() == node)
            .count()
    }

    fn emissions(&self, node: &str) -> usize {
        self.state()
            .emissions
            .iter()
            .filter(|emitted| emitted.as_str() == node)
            .count()
    }

    fn max_active(&self) -> usize {
        self.state().max_active
    }
}

#[async_trait]
impl NodeDriver for FakeDriver {
    async fn run(
        &self,
        invocation: DriverInvocation,
        mut control: DriverControl,
    ) -> Result<WorkerOutcome, NodeRunnerError> {
        let node = invocation.node.reference.node.as_str().to_owned();
        let behavior = {
            let mut state = self.state();
            state.starts.push(node.clone());
            state.active += 1;
            state.max_active = state.max_active.max(state.active);
            state
                .scripts
                .get_mut(&node)
                .and_then(VecDeque::pop_front)
                .unwrap_or_else(|| Behavior::Complete {
                    delay: Duration::ZERO,
                    outcome: success_for(invocation.role),
                })
        };
        control.emit(LiveOutput::new(LiveOutputStream::Output, node.clone())?)?;
        self.state().emissions.push(node.clone());
        let result = match behavior {
            Behavior::Complete { delay, outcome } => {
                tokio::select! {
                    _ = tokio::time::sleep(delay) => Ok(outcome),
                    _ = control.cancelled() => {
                        self.state().cancellations.push(node.clone());
                        Err(NodeRunnerError::Cancelled)
                    }
                }
            }
            Behavior::Hang => {
                control.cancelled().await;
                self.state().cancellations.push(node.clone());
                Err(NodeRunnerError::Cancelled)
            }
        };
        self.state().active -= 1;
        result
    }
}

fn success_for(role: NodeRole) -> WorkerOutcome {
    match role {
        NodeRole::Worker | NodeRole::GitDelivery => WorkerOutcome::Verified {
            output: Value::Null,
            artifacts: Vec::new(),
        },
        NodeRole::Verifier => verifier_outcome("accepted"),
    }
}

fn verifier_outcome(label: &str) -> WorkerOutcome {
    WorkerOutcome::Verifier {
        output: Value::Null,
        signals: BTreeMap::from([(
            serde_json::from_value(json!("verdict")).assert_value_with("field name"),
            serde_json::from_value(json!(label)).assert_value_with("enum label"),
        )]),
        diagnostic: Value::Null,
        artifacts: Vec::new(),
    }
}

struct Harness {
    supervisor: NativeV2Supervisor,
    ledger: Arc<FakeRunLedger>,
    driver: Arc<FakeDriver>,
}

#[derive(Clone, Default)]
struct FakeLiveRegistrar {
    registered: Arc<StdMutex<Vec<ExecutionRef>>>,
    closed: Arc<StdMutex<usize>>,
}

struct FakeLiveRegistration {
    closed: Arc<StdMutex<usize>>,
}

#[derive(Clone)]
struct RejectLiveRegistrar {
    driver: Arc<FakeDriver>,
}

#[async_trait]
impl LiveOutputRegistrar for FakeLiveRegistrar {
    async fn register(
        &self,
        reference: &ExecutionRef,
        _source: LiveOutputSource,
    ) -> Result<Box<dyn LiveOutputRegistration>, LiveOutputUnavailable> {
        self.registered
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push(reference.clone());
        Ok(Box::new(FakeLiveRegistration {
            closed: self.closed.clone(),
        }))
    }
}

#[async_trait]
impl LiveOutputRegistration for FakeLiveRegistration {
    async fn close(self: Box<Self>) {
        *self
            .closed
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) += 1;
    }
}

#[async_trait]
impl LiveOutputRegistrar for RejectLiveRegistrar {
    async fn register(
        &self,
        _reference: &ExecutionRef,
        _source: LiveOutputSource,
    ) -> Result<Box<dyn LiveOutputRegistration>, LiveOutputUnavailable> {
        while self.driver.emissions("worker") == 0 {
            tokio::task::yield_now().await;
        }
        Err(LiveOutputUnavailable)
    }
}

async fn harness(graph: GraphSpec, initial_input: Value, driver: FakeDriver) -> Harness {
    let runtime_nodes = executable_names(&graph.root)
        .into_iter()
        .map(|name| {
            (
                name,
                json!({
                    "kind": "agent",
                    "model": "gpt-5.6",
                    "effort": "max",
                    "connections": {}
                }),
            )
        })
        .collect::<serde_json::Map<_, _>>();
    let submission: RunSubmission = serde_json::from_value(json!({
        "title": "Supervisor test",
        "graph": graph,
        "initialInput": initial_input,
        "runtime": {
            "harness": "codex",
            "provider": "openai",
            "size": "medium",
            "nodes": runtime_nodes
        },
        "source": {
            "repository": "open-engine/zeroshot",
            "branch": "main",
            "revision": "0123456789abcdef0123456789abcdef01234567"
        },
        "submissionKey": "supervisor-test"
    }))
    .assert_value_with("valid submission");
    let submission_key = submission.submission_key.clone();
    let admitted = NativeV2Admission
        .admit(submission)
        .await
        .assert_value_with("graph admits");
    let run_id = RunId::new("run-supervisor-test");
    let ledger = Arc::new(FakeRunLedger::new());
    ledger
        .create_or_get(CreateRun {
            run_id: run_id.clone(),
            submission_key,
            submission_digest: Sha256Digest::new("0".repeat(64)).assert_value_with("digest"),
            admitted: admitted.clone(),
        })
        .await
        .assert_value_with("create run");
    let driver = Arc::new(driver);
    let runner = Arc::new(
        NativeNodeRunner::new(&admitted, driver.clone(), Arc::new(FakeSessionFactory))
            .assert_value_with("runner"),
    );
    let environment = RunEnvironment::exact(&admitted.runtime, BTreeMap::new())
        .assert_value_with("empty run environment");
    Harness {
        supervisor: NativeV2Supervisor::new(run_id, ledger.clone(), runner, Arc::new(environment)),
        ledger,
        driver,
    }
}

#[path = "tests/support_graph.rs"]
mod support_graph;
use support_graph::*;
#[path = "tests/cases_1.rs"]
mod cases_1;
#[path = "tests/cases_2.rs"]
mod cases_2;
#[path = "tests/cases_3.rs"]
mod cases_3;
#[path = "tests/delivery_gate.rs"]
mod delivery_gate;

use openengine_cluster_testkit::assertions::{AssertValue};
