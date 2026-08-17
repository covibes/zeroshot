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
use crate::native_v2_contract::{NodeInstanceId, RunSubmission};
use crate::native_v2_runner::{
    DriverControl, DriverInvocation, LiveOutput, LiveOutputStream, NativeNodeRunner, NodeDriver,
    NodeRole, NodeSession, SessionFactory,
};
use crate::v2_run_ledger::CreateRun;
use crate::v2_run_ledger::fake::FakeRunLedger;

#[derive(Clone)]
struct EmptyEnvironment;

#[async_trait]
impl NodeEnvironmentResolver for EmptyEnvironment {
    async fn resolve(
        &self,
        _node: &NodeName,
        binding: &NodeRuntimeBinding,
    ) -> Result<ResolvedEnvironment, EnvironmentUnavailable> {
        ResolvedEnvironment::exact(binding, BTreeMap::new()).map_err(|_| EnvironmentUnavailable)
    }
}

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
            serde_json::from_value(json!("verdict")).expect("field name"),
            serde_json::from_value(json!(label)).expect("enum label"),
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
                    "env": []
                }),
            )
        })
        .collect::<serde_json::Map<_, _>>();
    let submission: RunSubmission = serde_json::from_value(json!({
        "graph": graph,
        "initialInput": initial_input,
        "runtime": {
            "harness": "codex",
            "provider": "openai",
            "nodes": runtime_nodes
        },
        "ship": false,
        "submissionKey": "supervisor-test"
    }))
    .expect("valid submission");
    let submission_key = submission.submission_key.clone();
    let admitted = NativeV2Admission
        .admit(submission)
        .await
        .expect("graph admits");
    let run_id = RunId::new("run-supervisor-test");
    let ledger = Arc::new(FakeRunLedger::new());
    ledger
        .create_or_get(CreateRun {
            run_id: run_id.clone(),
            submission_key,
            submission_digest: Sha256Digest::new("0".repeat(64)).expect("digest"),
            admitted: admitted.clone(),
        })
        .await
        .expect("create run");
    let driver = Arc::new(driver);
    let runner = Arc::new(
        NativeNodeRunner::new(&admitted, driver.clone(), Arc::new(FakeSessionFactory))
            .expect("runner"),
    );
    Harness {
        supervisor: NativeV2Supervisor::new(
            run_id,
            ledger.clone(),
            runner,
            Arc::new(EmptyEnvironment),
        ),
        ledger,
        driver,
    }
}

async fn stored_run(ledger: &FakeRunLedger) -> StoredRun {
    ledger
        .get(&RunId::new("run-supervisor-test"))
        .await
        .expect("ledger")
        .expect("run")
}

fn executable_names(root: &GraphNode) -> BTreeSet<String> {
    fn collect(node: &GraphNode, names: &mut BTreeSet<String>) {
        match node {
            GraphNode::Step(node) => {
                names.insert(node.name.as_str().to_owned());
            }
            GraphNode::Verifier(node) => {
                names.insert(node.name.as_str().to_owned());
            }
            GraphNode::Seq(node) => node
                .children
                .as_slice()
                .iter()
                .for_each(|child| collect(child, names)),
            GraphNode::Choice(node) => {
                node.branches
                    .as_slice()
                    .iter()
                    .for_each(|branch| collect(&branch.node, names));
                if let Some(otherwise) = &node.otherwise {
                    collect(otherwise, names);
                }
            }
            GraphNode::Par(node) => node
                .branches
                .as_slice()
                .iter()
                .for_each(|branch| collect(branch, names)),
            GraphNode::Loop(node) => collect(&node.body, names),
            GraphNode::Map(node) => collect(&node.body, names),
            GraphNode::Succeed(_) | GraphNode::Fail(_) => {}
        }
    }
    let mut names = BTreeSet::new();
    collect(root, &mut names);
    names
}

fn graph(root: Value, initial_input: Value) -> GraphSpec {
    serde_json::from_value(json!({
        "profile": "openengine.graph.full/v1",
        "initialInput": initial_input,
        "policy": {"policy": "policy.native-v2@1", "default": "deny"},
        "root": root
    }))
    .expect("valid graph syntax")
}

fn null_type() -> Value {
    json!({"kind": "null"})
}

fn record_type() -> Value {
    json!({
        "kind": "record",
        "fields": {
            "items": {
                "required": true,
                "type": {"kind": "array", "items": {"kind": "string"}}
            }
        }
    })
}

fn step(name: &str, timeout_ms: u64) -> Value {
    json!({
        "kind": "step",
        "name": name,
        "worker": format!("worker.{name}@1"),
        "input": null_type(),
        "output": null_type(),
        "inputBindings": [],
        "writeBindings": [],
        "timeoutMs": timeout_ms,
        "attempts": 1
    })
}

fn verifier(name: &str, timeout_ms: u64) -> Value {
    json!({
        "kind": "verifier",
        "name": name,
        "worker": format!("worker.{name}@1"),
        "input": null_type(),
        "output": null_type(),
        "inputBindings": [],
        "writeBindings": [],
        "timeoutMs": timeout_ms,
        "attempts": 1,
        "signals": {"verdict": ["accepted", "rejected"]},
        "diagnostic": null_type()
    })
}

fn succeed(name: &str) -> Value {
    json!({"kind": "succeed", "name": name, "output": null_type(), "bindings": []})
}

fn signal_guard(node: &str, label: &str) -> Value {
    json!({
        "kind": "in",
        "value": {"name": node, "source": "signal", "field": "verdict"},
        "labels": [label]
    })
}

fn sequence(children: Vec<Value>, state: Value) -> Value {
    json!({
        "kind": "seq",
        "name": "root",
        "state": state,
        "children": children,
        "promotedStatePaths": []
    })
}

fn parallel(join: Value, branches: Vec<Value>) -> GraphSpec {
    graph(
        sequence(
            vec![
                json!({
                    "kind": "par",
                    "name": "parallel",
                    "state": null_type(),
                    "branches": branches,
                    "join": join,
                    "promotedStatePaths": []
                }),
                succeed("done"),
            ],
            null_type(),
        ),
        null_type(),
    )
}

fn all_constructs_graph() -> GraphSpec {
    let state = record_type();
    let root = sequence(
        vec![
            step("worker", 1_000),
            verifier("choose_gate", 1_000),
            json!({
                "kind": "choice",
                "name": "choice",
                "state": state,
                "branches": [{
                    "when": signal_guard("choose_gate", "accepted"),
                    "node": verifier("choice_work", 1_000)
                }],
                "otherwise": verifier("choice_other", 1_000),
                "promotedStatePaths": []
            }),
            json!({
                "kind": "par",
                "name": "all",
                "state": state,
                "branches": [verifier("left", 1_000), verifier("right", 1_000)],
                "join": {"kind": "all"},
                "promotedStatePaths": []
            }),
            json!({
                "kind": "loop",
                "name": "loop",
                "state": state,
                "body": verifier("loop_check", 1_000),
                "until": signal_guard("loop_check", "accepted"),
                "maxIterations": 3,
                "promotedStatePaths": []
            }),
            json!({
                "kind": "map",
                "name": "map",
                "state": state,
                "body": verifier("map_check", 1_000),
                "over": {"source": "state", "path": ["items"]},
                "maxItems": 4,
                "promotedStatePaths": []
            }),
            succeed("done"),
        ],
        state.clone(),
    );
    graph(root, state)
}

fn all_constructs_driver() -> FakeDriver {
    FakeDriver::scripted([
        (
            "loop_check",
            vec![
                Behavior::Complete {
                    delay: Duration::ZERO,
                    outcome: verifier_outcome("rejected"),
                },
                Behavior::Complete {
                    delay: Duration::ZERO,
                    outcome: verifier_outcome("accepted"),
                },
            ],
        ),
        (
            "left",
            vec![Behavior::Complete {
                delay: Duration::from_millis(20),
                outcome: verifier_outcome("accepted"),
            }],
        ),
        (
            "right",
            vec![Behavior::Complete {
                delay: Duration::from_millis(5),
                outcome: verifier_outcome("accepted"),
            }],
        ),
    ])
}

#[tokio::test]
async fn drives_every_full_v1_construct_through_the_real_reducer() {
    let harness = harness(
        all_constructs_graph(),
        json!({"items": ["one", "two"]}),
        all_constructs_driver(),
    )
    .await;

    assert_eq!(
        harness.supervisor.drive().await.expect("terminal"),
        TerminalResult::Succeeded {
            output: Value::Null
        }
    );
    assert_eq!(harness.driver.starts("worker"), 1);
    assert_eq!(harness.driver.starts("choice_work"), 1);
    assert_eq!(harness.driver.starts("choice_other"), 0);
    assert_eq!(harness.driver.starts("loop_check"), 2);
    assert_eq!(harness.driver.starts("map_check"), 2);
    assert!(harness.driver.max_active() >= 2);
    let stored = stored_run(&harness.ledger).await;
    let loop_visits = stored
        .snapshot
        .executions
        .values()
        .filter(|execution| execution.reference.node.as_str() == "loop_check")
        .collect::<Vec<_>>();
    assert_eq!(loop_visits.len(), 2);
    assert_eq!(
        loop_visits[0].reference.node_instance,
        loop_visits[1].reference.node_instance
    );
    assert_ne!(
        loop_visits[0].reference.execution,
        loop_visits[1].reference.execution
    );
    assert!(loop_visits.iter().all(|visit| visit.attempt.get() == 1));
}

#[tokio::test]
async fn fail_terminal_is_reduced_without_dispatch() {
    let harness = harness(
        graph(
            json!({"kind": "fail", "name": "failed", "reason": "rejected"}),
            null_type(),
        ),
        Value::Null,
        FakeDriver::default(),
    )
    .await;
    assert_eq!(
        harness.supervisor.drive().await.expect("terminal"),
        TerminalResult::Failed {
            reason: EnumLabel::new("rejected").expect("label")
        }
    );
    assert_eq!(harness.driver.state().starts.len(), 0);
}

async fn assert_cancelling_parallel_join(case: &str, join: Value, branches: Vec<Value>) {
    let driver = FakeDriver::scripted([
        (
            "fast",
            vec![Behavior::Complete {
                delay: Duration::from_millis(5),
                outcome: verifier_outcome("accepted"),
            }],
        ),
        (
            "second",
            vec![Behavior::Complete {
                delay: Duration::from_millis(10),
                outcome: verifier_outcome("accepted"),
            }],
        ),
        ("slow", vec![Behavior::Hang]),
    ]);
    let harness = harness(parallel(join, branches), Value::Null, driver).await;
    assert!(matches!(
        harness.supervisor.drive().await.expect(case),
        TerminalResult::Succeeded { .. }
    ));
    assert!(harness.driver.max_active() >= 2, "{case}");
    assert_eq!(harness.driver.cancellations("slow"), 1, "{case}");
    let stored = stored_run(&harness.ledger).await;
    let slow = stored
        .snapshot
        .executions
        .values()
        .find(|execution| execution.reference.node.as_str() == "slow")
        .expect("slow execution");
    assert!(matches!(slow.state, NodeState::Voided { .. }));
    let execution = slow.reference.execution;
    let tail = harness
        .ledger
        .snapshot_and_tail(&RunId::new("run-supervisor-test"), None)
        .await
        .expect("tail");
    let log = tail
        .events
        .iter()
        .position(|event| {
            matches!(
                event.event,
                RunEvent::SafeLog {
                    execution: Some(observed),
                    ..
                } if observed == execution
            )
        })
        .expect("loser log");
    let voided = tail
        .events
        .iter()
        .position(|event| {
            matches!(
                &event.event,
                RunEvent::ExecutionVoided { reference, .. }
                    if reference.execution == execution
            )
        })
        .expect("void settlement");
    let terminal = tail
        .events
        .iter()
        .position(|event| matches!(event.event, RunEvent::Terminal { .. }))
        .expect("terminal event");
    assert!(log < voided && voided < terminal, "{case}");
}

#[tokio::test]
async fn every_parallel_join_observes_completion_order_and_cancels_losers() {
    for (case, join, branches) in [
        (
            "any",
            json!({"kind": "any"}),
            vec![verifier("fast", 1_000), verifier("slow", 1_000)],
        ),
        (
            "quorum",
            json!({"kind": "quorum", "count": 2}),
            vec![
                verifier("fast", 1_000),
                verifier("second", 1_000),
                verifier("slow", 1_000),
            ],
        ),
        (
            "first",
            json!({"kind": "first", "when": signal_guard("fast", "accepted")}),
            vec![verifier("fast", 1_000), verifier("slow", 1_000)],
        ),
    ] {
        assert_cancelling_parallel_join(case, join, branches).await;
    }

    let all = harness(
        parallel(
            json!({"kind": "all"}),
            vec![verifier("fast", 1_000), verifier("slow", 1_000)],
        ),
        Value::Null,
        FakeDriver::scripted([
            (
                "fast",
                vec![Behavior::Complete {
                    delay: Duration::from_millis(5),
                    outcome: verifier_outcome("accepted"),
                }],
            ),
            (
                "slow",
                vec![Behavior::Complete {
                    delay: Duration::from_millis(15),
                    outcome: verifier_outcome("accepted"),
                }],
            ),
        ]),
    )
    .await;
    assert!(matches!(
        all.supervisor.drive().await.expect("all"),
        TerminalResult::Succeeded { .. }
    ));
    assert_eq!(all.driver.cancellations("slow"), 0);
}

#[tokio::test]
async fn timeout_cancels_then_acknowledges_cleanup_before_settlement() {
    let harness = harness(
        graph(
            sequence(vec![step("worker", 20), succeed("done")], null_type()),
            null_type(),
        ),
        Value::Null,
        FakeDriver::scripted([("worker", vec![Behavior::Hang])]),
    )
    .await;
    assert!(matches!(
        harness.supervisor.drive().await.expect("terminal"),
        TerminalResult::Succeeded { .. }
    ));
    assert_eq!(harness.driver.cancellations("worker"), 1);
    assert_eq!(harness.driver.state().active, 0);
    let stored = stored_run(&harness.ledger).await;
    assert!(
        stored
            .snapshot
            .executions
            .values()
            .any(|execution| matches!(
                execution.outcome(),
                Some(WorkerOutcome::Error {
                    code: WorkerErrorCode::Timeout,
                    ..
                })
            ))
    );
    let tail = harness
        .ledger
        .snapshot_and_tail(&RunId::new("run-supervisor-test"), None)
        .await
        .expect("tail");
    assert!(tail.events.iter().any(|event| matches!(
        &event.event,
        RunEvent::SafeLog { line, .. } if line.as_str() == "worker"
    )));
}

#[tokio::test]
async fn live_registration_failure_still_durably_drains_before_settlement() {
    let harness = harness(
        graph(
            sequence(vec![step("worker", 1_000), succeed("done")], null_type()),
            null_type(),
        ),
        Value::Null,
        FakeDriver::scripted([(
            "worker",
            vec![Behavior::Complete {
                delay: Duration::from_secs(1),
                outcome: success_for(NodeRole::Worker),
            }],
        )]),
    )
    .await;
    let supervisor = harness
        .supervisor
        .clone()
        .with_live_output(Arc::new(RejectLiveRegistrar {
            driver: harness.driver.clone(),
        }));

    assert!(matches!(
        supervisor.drive().await.expect("terminal"),
        TerminalResult::Succeeded { .. }
    ));
    let tail = harness
        .ledger
        .snapshot_and_tail(&RunId::new("run-supervisor-test"), None)
        .await
        .expect("tail");
    let log = tail
        .events
        .iter()
        .position(|event| {
            matches!(
                &event.event,
                RunEvent::SafeLog { line, .. } if line.as_str() == "worker"
            )
        })
        .expect("durable worker output");
    let completed = tail
        .events
        .iter()
        .position(|event| {
            matches!(
                &event.event,
                RunEvent::NodeCompleted { completion }
                    if completion.reference.node.as_str() == "worker"
                        && matches!(completion.outcome, WorkerOutcome::Error {
                            code: WorkerErrorCode::Crash,
                            ..
                        })
            )
        })
        .expect("crash settlement");
    let terminal = tail
        .events
        .iter()
        .position(|event| matches!(event.event, RunEvent::Terminal { .. }))
        .expect("terminal event");
    assert!(log < completed && completed < terminal);
}

#[tokio::test]
async fn force_stop_closes_active_work_and_never_dispatches_again() {
    let harness = harness(
        graph(
            sequence(
                vec![step("first", 10_000), step("never", 1_000), succeed("done")],
                null_type(),
            ),
            null_type(),
        ),
        Value::Null,
        FakeDriver::scripted([("first", vec![Behavior::Hang])]),
    )
    .await;
    let supervisor = harness.supervisor.clone();
    let drive = tokio::spawn(async move { supervisor.drive().await });
    tokio::time::timeout(Duration::from_secs(1), async {
        while harness.driver.starts("first") == 0 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("first dispatch");
    harness.supervisor.force_stop().await.expect("force stop");
    assert_eq!(
        drive.await.expect("drive task").expect("terminal"),
        TerminalResult::Failed {
            reason: EnumLabel::new("force_stopped").expect("label")
        }
    );
    assert_eq!(harness.driver.cancellations("first"), 1);
    assert_eq!(harness.driver.starts("never"), 0);
    assert!(
        stored_run(&harness.ledger)
            .await
            .snapshot
            .active_executions()
            .next()
            .is_none()
    );
    let tail = harness
        .ledger
        .snapshot_and_tail(&RunId::new("run-supervisor-test"), None)
        .await
        .expect("tail");
    let log = tail
        .events
        .iter()
        .position(|event| {
            matches!(
                &event.event,
                RunEvent::SafeLog { line, .. } if line.as_str() == "first"
            )
        })
        .expect("durable output");
    let completed = tail
        .events
        .iter()
        .position(|event| {
            matches!(
                &event.event,
                RunEvent::NodeCompleted { completion }
                    if completion.reference.node.as_str() == "first"
            )
        })
        .expect("force settlement");
    let terminal = tail
        .events
        .iter()
        .position(|event| matches!(event.event, RunEvent::Terminal { .. }))
        .expect("terminal event");
    assert!(log < completed && completed < terminal);
}

#[tokio::test]
async fn active_history_after_runtime_loss_is_terminalized_without_redispatch() {
    let harness = harness(
        graph(
            sequence(vec![step("worker", 1_000), succeed("done")], null_type()),
            null_type(),
        ),
        Value::Null,
        FakeDriver::default(),
    )
    .await;
    let run_id = RunId::new("run-supervisor-test");
    let reference = ExecutionRef {
        run_id: run_id.clone(),
        node: NodeName::new("worker").expect("node name"),
        node_instance: NodeInstanceId::new(1).expect("node instance"),
        execution: ExecutionId::new(1).expect("execution"),
    };
    harness
        .ledger
        .append(
            &run_id,
            vec![
                RunEvent::RunStarted,
                RunEvent::NodeStarted {
                    reference: reference.clone(),
                    occurrence: crate::full_v1_reducer::StructuralOccurrence {
                        node: reference.node.clone(),
                        map_indices: Vec::new(),
                    },
                    attempt: openengine_cluster_protocol::PositiveInteger::new(1).expect("attempt"),
                    input: Value::Null,
                },
            ],
        )
        .await
        .expect("seed active execution");

    let expected = TerminalResult::Failed {
        reason: EnumLabel::new("runtime_lost").expect("label"),
    };
    assert_eq!(
        harness.supervisor.drive().await.expect("terminal"),
        expected
    );
    assert_eq!(
        harness.supervisor.drive().await.expect("idempotent"),
        expected
    );
    assert!(harness.driver.state().starts.is_empty());
    let tail = harness
        .ledger
        .snapshot_and_tail(&run_id, None)
        .await
        .expect("tail");
    assert!(tail.snapshot.active_executions().next().is_none());
    assert_eq!(
        tail.events
            .iter()
            .filter(|event| matches!(event.event, RunEvent::Terminal { .. }))
            .count(),
        1
    );
    assert!(matches!(
        tail.snapshot.executions[&reference.execution].outcome(),
        Some(WorkerOutcome::Error {
            code: WorkerErrorCode::Crash,
            ..
        })
    ));
}

#[tokio::test]
async fn terminal_run_is_idempotently_observed_without_dispatch() {
    let harness = harness(
        graph(succeed("done"), null_type()),
        Value::Null,
        FakeDriver::default(),
    )
    .await;
    let expected = TerminalResult::Succeeded {
        output: Value::Null,
    };
    assert_eq!(harness.supervisor.drive().await.expect("first"), expected);
    assert_eq!(harness.supervisor.drive().await.expect("second"), expected);
    assert!(harness.driver.state().starts.is_empty());
    let tail = harness
        .ledger
        .snapshot_and_tail(&RunId::new("run-supervisor-test"), None)
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
async fn live_output_registration_is_closed_after_durable_drain() {
    let harness = harness(
        graph(
            sequence(vec![step("worker", 1_000), succeed("done")], null_type()),
            null_type(),
        ),
        Value::Null,
        FakeDriver::default(),
    )
    .await;
    let live = Arc::new(FakeLiveRegistrar::default());
    let supervisor = harness.supervisor.clone().with_live_output(live.clone());
    assert!(matches!(
        supervisor.drive().await.expect("terminal"),
        TerminalResult::Succeeded { .. }
    ));
    assert_eq!(
        live.registered
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .len(),
        1
    );
    assert_eq!(
        *live
            .closed
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner),
        1
    );
}
