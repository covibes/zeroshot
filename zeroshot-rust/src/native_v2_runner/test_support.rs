use std::collections::{BTreeMap, BTreeSet};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use openengine_cluster_protocol::{
    CompiledGraphIr, GraphSpec, NodeName, NonEmptyVec, PositiveInteger, RunId, StructuralBounds,
    TerminationWitness, WorkerRef,
};
use serde_json::{json, Value};
use tokio::sync::watch;

use super::*;
use crate::native_v2_contract::{CodexProvider, RuntimePlan};
use crate::worker_catalog::{ModelId, ReasoningEffort};

pub(super) fn binding(scope: SessionScope) -> NodeRuntimeBinding {
    NodeRuntimeBinding::Agent {
        model: ModelId::new("gpt-5.6").unwrap(),
        effort: Some(ReasoningEffort::Max),
        session_scope: scope,
        env: BTreeSet::new(),
    }
}

fn executable(name: &str, verifier: bool) -> Value {
    if verifier {
        json!({
            "kind": "verifier",
            "name": name,
            "worker": format!("agent.{name}@1"),
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
            "input": { "kind": "null" },
            "output": { "kind": "null" },
            "inputBindings": [],
            "writeBindings": [],
            "timeoutMs": 1000,
            "attempts": 1
        })
    }
}

pub(super) fn admitted() -> AdmittedRun {
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
    let graph: GraphSpec = serde_json::from_value(json!({
        "profile": "openengine.graph.full/v1",
        "initialInput": { "kind": "null" },
        "policy": { "policy": "policy.native-v2@1", "default": "deny" },
        "root": {
            "kind": "seq",
            "name": "root",
            "state": { "kind": "null" },
            "children": children,
            "promotedStatePaths": []
        }
    }))
    .unwrap();
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
            (NodeName::new(*name).unwrap(), binding(scope))
        })
        .collect();
    AdmittedRun {
        graph: CompiledGraphIr {
            profile: graph.profile,
            initial_input: graph.initial_input,
            policy: graph.policy,
            root: graph.root,
            bounds: StructuralBounds {
                termination: TerminationWitness::Acyclic {
                    order: NonEmptyVec::new(vec![root_name.clone()]).unwrap(),
                },
                max_node_executions: PositiveInteger::new(100).unwrap(),
                peak_concurrency: PositiveInteger::new(5).unwrap(),
                attempts_per_node: BTreeMap::from([(root_name, PositiveInteger::new(1).unwrap())]),
            },
        },
        initial_input: Value::Null,
        runtime: RuntimePlan::Codex {
            provider: CodexProvider::OpenAi,
            nodes: runtime_nodes,
        },
        ship: false,
    }
}

pub(super) fn request(run: &str, node: &str, identity: (u64, u64)) -> NodeRunRequest {
    let (node_instance, execution) = identity;
    let admitted = admitted();
    let binding = admitted
        .runtime
        .nodes()
        .get(&NodeName::new(node).unwrap())
        .unwrap()
        .clone();
    NodeRunRequest {
        invocation: NodeInvocation {
            reference: ExecutionRef {
                run_id: RunId::new(run),
                node: NodeName::new(node).unwrap(),
                node_instance: NodeInstanceId::new(node_instance).unwrap(),
                execution: ExecutionId::new(execution).unwrap(),
            },
            worker: WorkerRef::new(format!("agent.{node}@1")).unwrap(),
            input: Value::Null,
            binding: binding.clone(),
        },
        environment: ResolvedEnvironment::exact(&binding, BTreeMap::new()).unwrap(),
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
        self.sessions.lock().unwrap().push(session.clone());
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
        control.emit(LiveOutput::new(LiveOutputStream::Output, "working").unwrap())?;
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
        NativeNodeRunner::new(&admitted, driver.clone(), factory.clone()).unwrap(),
        driver,
        factory,
    )
}
