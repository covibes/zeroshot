use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use openengine_cluster_protocol::{
    CompiledGraphIr, DeclaredEnvironment, NodeName, NonEmptyVec, PositiveInteger, RunId, RunSize,
    RunTitle, ResolvedSource, StructuralBounds, TerminationWitness, WorkerRef,
};
use serde_json::{json, Value};
use tokio::sync::watch;

use super::*;
use crate::native_v2_candidate::test_support::full_graph;
use crate::native_v2_contract::{CodexProvider, RuntimePlan};
use crate::worker_catalog::ReasoningEffort;

impl DurableOutput {
    pub(crate) async fn recv_output(&mut self) -> Result<LiveOutput, AttachReceiveError> {
        loop {
            match self.recv().await? {
                DurableNodeEvent::Output(output) => return Ok(output),
                DurableNodeEvent::TokenUsage(_) => {}
            }
        }
    }

    pub(crate) async fn recv_usage(
        &mut self,
    ) -> Result<Option<TokenUsageDelta>, AttachReceiveError> {
        loop {
            match self.recv().await? {
                DurableNodeEvent::Output(_) => {}
                DurableNodeEvent::TokenUsage(usage) => return Ok(usage),
            }
        }
    }
}

pub(crate) fn binding(scope: SessionScope) -> NodeRuntimeBinding {
    NodeRuntimeBinding::Agent {
        model: crate::worker_catalog::ModelId::new("gpt-5.6").assert_value(),
        effort: Some(ReasoningEffort::Max),
        session_scope: scope,
        env: DeclaredEnvironment::empty(),
    }
}

fn executable(name: &str, verifier: bool) -> Value {
    if verifier {
        json!({
            "kind": "verifier",
            "name": name,
            "worker": format!("agent.{name}@1"),
            "instructions": format!("Verify the {name} node."),
            "input": { "kind": "null" },
            "output": { "kind": "null" },
            "inputBindings": [],
            "writeBindings": [],
            "timeoutMs": 1000,
            "attempts": 1,
            "signals": {},
            "diagnostic": { "kind": "null" }
        })
    } else {
        json!({
            "kind": "step",
            "name": name,
            "worker": format!("agent.{name}@1"),
            "instructions": format!("Implement the {name} node."),
            "input": { "kind": "null" },
            "output": { "kind": "null" },
            "inputBindings": [],
            "writeBindings": [],
            "timeoutMs": 1000,
            "attempts": 1
        })
    }
}

fn source() -> ResolvedSource {
    serde_json::from_value(json!({
        "repository": "open-engine/zeroshot",
        "branch": "main",
        "revision": "0123456789abcdef0123456789abcdef01234567"
    }))
    .assert_value()
}

pub(crate) fn admitted() -> AdmittedRun {
    let verifier_names = ["left", "right", "verify", "slow_reuse", "fast_reuse"];
    let worker_names = ["worker1", "worker2", "looped", "fresh", "worker"];
    let mut children = verifier_names
        .iter()
        .map(|name| executable(name, true))
        .chain(worker_names.iter().map(|name| executable(name, false)))
        .collect::<Vec<_>>();
    children.push(json!({
        "kind": "succeed",
        "name": "done",
        "output": { "kind": "null" },
        "bindings": []
    }));
    let graph = full_graph(children);
    let root_name = graph.root.name().clone();
    let runtime_nodes = verifier_names
        .iter()
        .chain(worker_names.iter())
        .map(|name| {
            let scope = if matches!(*name, "looped" | "slow_reuse" | "fast_reuse") {
                SessionScope::NodeInstance
            } else {
                SessionScope::Execution
            };
            (NodeName::new(*name).assert_value(), binding(scope))
        })
        .collect();
    AdmittedRun {
        title: RunTitle::new("Runner test run").assert_value(),
        graph: CompiledGraphIr {
            profile: graph.profile,
            initial_input: graph.initial_input,
            policy: graph.policy,
            root: graph.root,
            bounds: StructuralBounds {
                termination: TerminationWitness::Acyclic {
                    order: NonEmptyVec::new(vec![root_name.clone()]).assert_value(),
                },
                max_node_executions: PositiveInteger::new(100).assert_value(),
                peak_concurrency: PositiveInteger::new(5).assert_value(),
                attempts_per_node: BTreeMap::from([(
                    root_name,
                    PositiveInteger::new(1).assert_value(),
                )]),
            },
        },
        initial_input: Value::Null,
        runtime: RuntimePlan::Codex {
            provider: CodexProvider::OpenAi,
            size: RunSize::Standard,
            nodes: runtime_nodes,
        },
        source: source(),
    }
}

pub(crate) fn request(run: &str, node: &str, identity: (u64, u64)) -> NodeRunRequest {
    let (node_instance, execution) = identity;
    let admitted = admitted();
    let binding = admitted
        .runtime
        .nodes()
        .get(&NodeName::new(node).assert_value())
        .assert_value()
        .clone();
    NodeRunRequest {
        invocation: NodeInvocation {
            reference: ExecutionRef {
                run_id: RunId::new(run),
                node: NodeName::new(node).assert_value(),
                node_instance: NodeInstanceId::new(node_instance).assert_value(),
                execution: ExecutionId::new(execution).assert_value(),
            },
            worker: WorkerRef::new(format!("agent.{node}@1")).assert_value(),
            instructions: Some(
                openengine_cluster_protocol::NodeInstructions::new(format!(
                    "{} the {node} node.",
                    if ["left", "right", "verify", "slow_reuse", "fast_reuse"].contains(&node) {
                        "Verify"
                    } else {
                        "Implement"
                    }
                ))
                .assert_value(),
            ),
            input: Value::Null,
            binding: binding.clone(),
        },
        environment: ResolvedEnvironment::exact(&binding, BTreeMap::new()).assert_value(),
    }
}

#[derive(Default)]
pub(super) struct FakeSession {
    pub(super) live: AtomicBool,
    pub(super) closed: AtomicUsize,
}

impl FakeSession {
    fn live() -> Self {
        Self {
            live: AtomicBool::new(true),
            closed: AtomicUsize::new(0),
        }
    }
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
        self.closed.fetch_add(1, Ordering::SeqCst);
        self.live.store(false, Ordering::SeqCst);
    }
}

#[derive(Default)]
pub(super) struct FakeFactory {
    pub(super) opened: AtomicUsize,
    pub(super) sessions: Mutex<Vec<Arc<FakeSession>>>,
}

#[async_trait]
impl SessionFactory for FakeFactory {
    async fn open(
        &self,
        _invocation: &NodeInvocation,
        _environment: &ResolvedEnvironment,
    ) -> Result<Arc<dyn NodeSession>, NodeRunnerError> {
        self.opened.fetch_add(1, Ordering::SeqCst);
        let session = Arc::new(FakeSession::live());
        self.sessions.lock().assert_value().push(session.clone());
        Ok(session)
    }
}

pub(super) struct SelectiveBlockingFactory {
    pub(super) opened: AtomicUsize,
    pub(super) started: watch::Sender<bool>,
}

#[async_trait]
impl SessionFactory for SelectiveBlockingFactory {
    async fn open(
        &self,
        invocation: &NodeInvocation,
        _environment: &ResolvedEnvironment,
    ) -> Result<Arc<dyn NodeSession>, NodeRunnerError> {
        self.opened.fetch_add(1, Ordering::SeqCst);
        if invocation.reference.node.as_str() == "slow_reuse" {
            let _ = self.started.send(true);
            std::future::pending::<()>().await;
        }
        Ok(Arc::new(FakeSession::live()))
    }
}

#[derive(Default)]
pub(super) struct Concurrency {
    readers: AtomicUsize,
    writers: AtomicUsize,
    pub(super) max_readers: AtomicUsize,
    pub(super) overlap: AtomicBool,
}

struct Active<'a> {
    concurrency: &'a Concurrency,
    reader: bool,
}

impl Drop for Active<'_> {
    fn drop(&mut self) {
        let counter = if self.reader {
            &self.concurrency.readers
        } else {
            &self.concurrency.writers
        };
        counter.fetch_sub(1, Ordering::SeqCst);
    }
}

#[derive(Default)]
pub(super) struct FakeDriver {
    pub(super) concurrency: Concurrency,
}

pub(super) struct BurstDriver;

#[async_trait]
impl NodeDriver for BurstDriver {
    async fn run(
        &self,
        _invocation: DriverInvocation,
        control: DriverControl,
    ) -> Result<WorkerOutcome, NodeRunnerError> {
        for index in 0..(LIVE_OUTPUT_CAPACITY + 44) {
            control.emit(LiveOutput::new(
                LiveOutputStream::Output,
                index.to_string(),
            )?)?;
        }
        Ok(WorkerOutcome::Verified {
            output: Value::Null,
            artifacts: Vec::new(),
        })
    }
}

#[async_trait]
impl NodeDriver for FakeDriver {
    async fn run(
        &self,
        invocation: DriverInvocation,
        control: DriverControl,
    ) -> Result<WorkerOutcome, NodeRunnerError> {
        assert!(invocation.session.as_any().is::<FakeSession>());
        let reader = invocation.role == NodeRole::Verifier;
        let counter = if reader {
            &self.concurrency.readers
        } else {
            &self.concurrency.writers
        };
        let active = counter.fetch_add(1, Ordering::SeqCst) + 1;
        if reader {
            self.concurrency
                .max_readers
                .fetch_max(active, Ordering::SeqCst);
        }
        if (reader && self.concurrency.writers.load(Ordering::SeqCst) > 0)
            || (!reader && self.concurrency.readers.load(Ordering::SeqCst) > 0)
            || (!reader && active > 1)
        {
            self.concurrency.overlap.store(true, Ordering::SeqCst);
        }
        let _active = Active {
            concurrency: &self.concurrency,
            reader,
        };
        control.emit(LiveOutput::new(LiveOutputStream::Output, "working").assert_value())?;
        let mut cancellation = control.cancellation();
        tokio::select! {
            _ = cancellation.cancelled() => Err(NodeRunnerError::Cancelled),
            _ = tokio::time::sleep(Duration::from_millis(40)) => {
                Ok(match invocation.role {
                    NodeRole::Verifier => WorkerOutcome::Verifier {
                        output: Value::Null,
                        signals: BTreeMap::new(),
                        diagnostic: Value::Null,
                        artifacts: Vec::new(),
                    },
                    NodeRole::Worker | NodeRole::GitDelivery => WorkerOutcome::Verified {
                        output: Value::Null,
                        artifacts: Vec::new(),
                    },
                })
            }
        }
    }
}

pub(super) fn runner() -> (NativeNodeRunner, Arc<FakeDriver>, Arc<FakeFactory>) {
    let driver = Arc::new(FakeDriver::default());
    let factory = Arc::new(FakeFactory::default());
    let admitted = admitted();
    (
        NativeNodeRunner::new(&admitted, driver.clone(), factory.clone()).assert_value(),
        driver,
        factory,
    )
}

use openengine_cluster_testkit::assertions::{AssertValue};
