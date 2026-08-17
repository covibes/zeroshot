use std::any::Any;
use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use async_trait::async_trait;
use openengine_cluster_protocol::{
    CompiledGraphIr, GraphSpec, IdempotencyKey, NodeName, NonEmptyVec, PositiveInteger,
    RunAttachParams, RunId, RunLogsParams, RunStatus, RunStatusParams, RunWatchParams,
    Sha256Digest, StructuralBounds, TerminationWitness, WorkerOutcome, WorkerRef,
};
use serde_json::{json, Value};
use tokio::sync::{Barrier, Notify};

use super::*;
use crate::execution::SessionScope;
use crate::full_v1_reducer::StructuralOccurrence;
use crate::native_v2_contract::{
    AdmittedRun, CodexProvider, EnvironmentVariableName, ExecutionRef, NodeInstanceId,
    NodeInvocation, NodeRuntimeBinding, RuntimePlan,
};
use crate::native_v2_runner::{
    DriverControl, DriverInvocation, LiveOutput, LiveOutputStream, NativeNodeRunner, NodeDriver,
    NodeRunRequest, NodeRunner, NodeRunnerError, NodeSession, ResolvedEnvironment, SessionFactory,
};
use crate::v2_run_ledger::fake::FakeRunLedger;
use crate::v2_run_ledger::{CreateRun, RunEvent, RunLedger, SafeLogLine};
use crate::worker_catalog::{ModelId, ReasoningEffort};

fn agent_binding() -> NodeRuntimeBinding {
    NodeRuntimeBinding::Agent {
        model: ModelId::new("gpt-5.6").unwrap(),
        effort: Some(ReasoningEffort::Max),
        session_scope: SessionScope::Execution,
        env: BTreeSet::new(),
    }
}

fn admitted_run() -> AdmittedRun {
    let graph: GraphSpec = serde_json::from_value(json!({
        "profile": "openengine.graph.full/v1",
        "initialInput": { "kind": "null" },
        "policy": { "policy": "policy.native-v2@1", "default": "deny" },
        "root": {
            "kind": "seq",
            "name": "root",
            "state": { "kind": "null" },
            "children": [
                {
                    "kind": "step",
                    "name": "worker",
                    "worker": "agent.worker@1",
                    "input": { "kind": "null" },
                    "output": { "kind": "null" },
                    "inputBindings": [],
                    "writeBindings": [],
                    "timeoutMs": 1000,
                    "attempts": 1
                },
                {
                    "kind": "verifier",
                    "name": "left",
                    "worker": "agent.left@1",
                    "input": { "kind": "null" },
                    "output": { "kind": "null" },
                    "inputBindings": [],
                    "writeBindings": [],
                    "timeoutMs": 1000,
                    "attempts": 1,
                    "signals": {},
                    "diagnostic": { "kind": "null" }
                },
                {
                    "kind": "verifier",
                    "name": "right",
                    "worker": "agent.right@1",
                    "input": { "kind": "null" },
                    "output": { "kind": "null" },
                    "inputBindings": [],
                    "writeBindings": [],
                    "timeoutMs": 1000,
                    "attempts": 1,
                    "signals": {},
                    "diagnostic": { "kind": "null" }
                },
                {
                    "kind": "succeed",
                    "name": "done",
                    "output": { "kind": "null" },
                    "bindings": []
                }
            ],
            "promotedStatePaths": []
        }
    }))
    .unwrap();
    let root_name = graph.root.name().clone();
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
                max_node_executions: PositiveInteger::new(8).unwrap(),
                peak_concurrency: PositiveInteger::new(2).unwrap(),
                attempts_per_node: BTreeMap::from([(root_name, PositiveInteger::new(1).unwrap())]),
            },
        },
        initial_input: Value::Null,
        runtime: RuntimePlan::Codex {
            provider: CodexProvider::OpenAi,
            nodes: ["worker", "left", "right"]
                .into_iter()
                .map(|name| (NodeName::new(name).unwrap(), agent_binding()))
                .collect(),
        },
        ship: false,
    }
}

async fn ledger_run(run: &str) -> (Arc<FakeRunLedger>, RunId) {
    let ledger = Arc::new(FakeRunLedger::new());
    let run_id = RunId::new(run);
    ledger
        .create_or_get(CreateRun {
            run_id: run_id.clone(),
            submission_key: IdempotencyKey::new(format!("submission-{run}")).unwrap(),
            submission_digest: Sha256Digest::new("a".repeat(64)).unwrap(),
            admitted: admitted_run(),
        })
        .await
        .unwrap();
    (ledger, run_id)
}

fn reference(run_id: &RunId, node: &str, execution: u64) -> ExecutionRef {
    ExecutionRef {
        run_id: run_id.clone(),
        node: NodeName::new(node).unwrap(),
        node_instance: NodeInstanceId::new(execution).unwrap(),
        execution: ExecutionId::new(execution).unwrap(),
    }
}

fn started(reference: &ExecutionRef) -> RunEvent {
    RunEvent::NodeStarted {
        reference: reference.clone(),
        occurrence: StructuralOccurrence {
            node: reference.node.clone(),
            map_indices: Vec::new(),
        },
        attempt: PositiveInteger::new(1).unwrap(),
        input: Value::Null,
    }
}

#[tokio::test]
async fn status_lists_every_parallel_execution_with_opaque_selectors() {
    let (ledger, run_id) = ledger_run("parallel-status").await;
    let left = reference(&run_id, "left", 1);
    let right = reference(&run_id, "right", 2);
    ledger
        .append(
            &run_id,
            vec![RunEvent::RunStarted, started(&left), started(&right)],
        )
        .await
        .unwrap();
    let service = NativeV2Observability::new(ledger);

    let status = service
        .status(RunStatusParams {
            run_id: run_id.clone(),
        })
        .await
        .unwrap();
    let RunStatus::Running { active_executions } = status.status else {
        panic!("run must be running");
    };
    assert_eq!(active_executions.len(), 2);
    assert_eq!(active_executions[0].node.as_str(), "left");
    assert_eq!(active_executions[1].node.as_str(), "right");
    assert_ne!(
        active_executions[0].execution,
        active_executions[1].execution
    );
    let encoded = serde_json::to_string(&active_executions).unwrap();
    assert!(!encoded.contains("nodeInstance"));
    assert!(!encoded.contains("executionId"));
    assert!(!encoded.contains(run_id.as_str()));
}

async fn cursor_fixture() -> (
    Arc<FakeRunLedger>,
    RunId,
    ExecutionRef,
    ExecutionRef,
    NativeV2Observability,
) {
    let (ledger, run_id) = ledger_run("cursor-resume").await;
    let left = reference(&run_id, "left", 1);
    let right = reference(&run_id, "right", 2);
    ledger
        .append(
            &run_id,
            vec![
                RunEvent::RunStarted,
                started(&left),
                started(&right),
                RunEvent::SafeLog {
                    execution: Some(left.execution),
                    stream: SafeLogStream::Output,
                    line: SafeLogLine::new("first").unwrap(),
                },
                RunEvent::NodeCompleted {
                    completion: crate::native_v2_contract::NodeCompletion {
                        reference: left.clone(),
                        outcome: WorkerOutcome::Verified {
                            output: Value::Null,
                            artifacts: Vec::new(),
                        },
                    },
                },
                RunEvent::SafeLog {
                    execution: Some(left.execution),
                    stream: SafeLogStream::Output,
                    line: SafeLogLine::new("second").unwrap(),
                },
            ],
        )
        .await
        .unwrap();
    let service = NativeV2Observability::new(ledger.clone());
    (ledger, run_id, left, right, service)
}

#[tokio::test]
async fn durable_watch_resumes_exclusively_without_gaps_or_duplicates() {
    let (ledger, run_id, _left, right, service) = cursor_fixture().await;

    let (_, mut watch) = service
        .watch(RunWatchParams {
            run_id: run_id.clone(),
            from_cursor: Some(Cursor::new("v2:1")),
        })
        .await
        .unwrap();
    let transitions = watch.read_available().await.unwrap();
    assert_eq!(
        transitions
            .iter()
            .map(|event| event.cursor.as_str())
            .collect::<Vec<_>>(),
        ["v2:2", "v2:3", "v2:5"]
    );
    let saved_watch_cursor = transitions[1].cursor.clone();
    drop(watch);
    let (_, mut resumed_watch) = service
        .watch(RunWatchParams {
            run_id: run_id.clone(),
            from_cursor: Some(saved_watch_cursor),
        })
        .await
        .unwrap();
    assert_eq!(
        resumed_watch
            .read_available()
            .await
            .unwrap()
            .iter()
            .map(|event| event.cursor.as_str())
            .collect::<Vec<_>>(),
        ["v2:5"]
    );

    // Disconnecting a watcher cannot mutate or cancel an active execution.
    assert!(
        ledger
            .get(&run_id)
            .await
            .unwrap()
            .unwrap()
            .snapshot
            .executions[&right.execution]
            .state
            .eq(&NodeState::Active)
    );
}

#[tokio::test]
async fn durable_logs_resume_exclusively_without_gaps_or_duplicates() {
    let (_ledger, run_id, left, _right, service) = cursor_fixture().await;
    let public_left = opaque_execution(&left);
    let (_, mut logs) = service
        .logs(RunLogsParams {
            run_id: run_id.clone(),
            from_cursor: Some(Cursor::new("v2:3")),
            execution: Some(public_left.clone()),
        })
        .await
        .unwrap();
    let records = logs.read_available().await.unwrap();
    assert_eq!(
        records
            .iter()
            .map(|event| event.cursor.as_str())
            .collect::<Vec<_>>(),
        ["v2:4", "v2:6"]
    );
    assert_eq!(records[0].record.message.as_str(), "first");
    let saved_log_cursor = records[0].cursor.clone();
    drop(logs);
    let (_, mut resumed_logs) = service
        .logs(RunLogsParams {
            run_id: run_id.clone(),
            from_cursor: Some(saved_log_cursor),
            execution: Some(public_left),
        })
        .await
        .unwrap();
    let resumed = resumed_logs.read_available().await.unwrap();
    assert_eq!(resumed.len(), 1);
    assert_eq!(resumed[0].cursor.as_str(), "v2:6");
}

#[derive(Default)]
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

#[derive(Default)]
struct FakeSessions;

#[async_trait]
impl SessionFactory for FakeSessions {
    async fn open(
        &self,
        _invocation: &NodeInvocation,
        _environment: &ResolvedEnvironment,
    ) -> Result<Arc<dyn NodeSession>, NodeRunnerError> {
        Ok(Arc::new(FakeSession))
    }
}

struct ControlledDriver {
    first_emitted: Arc<Notify>,
    release: Arc<Notify>,
}

struct ParallelVerifierDriver {
    release: Arc<Barrier>,
}

#[async_trait]
impl NodeDriver for ParallelVerifierDriver {
    async fn run(
        &self,
        invocation: DriverInvocation,
        control: DriverControl,
    ) -> Result<WorkerOutcome, NodeRunnerError> {
        self.release.wait().await;
        control.emit(LiveOutput::new(
            LiveOutputStream::Output,
            invocation.node.reference.node.as_str(),
        )?)?;
        Ok(WorkerOutcome::Verifier {
            output: Value::Null,
            signals: BTreeMap::new(),
            diagnostic: Value::Null,
            artifacts: Vec::new(),
        })
    }
}

#[async_trait]
impl NodeDriver for ControlledDriver {
    async fn run(
        &self,
        _invocation: DriverInvocation,
        control: DriverControl,
    ) -> Result<WorkerOutcome, NodeRunnerError> {
        control.emit(LiveOutput::new(LiveOutputStream::Output, "before attach")?)?;
        self.first_emitted.notify_one();
        self.release.notified().await;
        control.emit(LiveOutput::new(LiveOutputStream::Output, "after attach")?)?;
        Ok(WorkerOutcome::Verified {
            output: Value::Null,
            artifacts: Vec::new(),
        })
    }
}

#[tokio::test]
async fn attach_is_live_only_read_only_and_disconnect_does_not_cancel() {
    let (ledger, run_id) = ledger_run("live-attach").await;
    let reference = reference(&run_id, "worker", 1);
    ledger
        .append(&run_id, vec![RunEvent::RunStarted, started(&reference)])
        .await
        .unwrap();
    let first_emitted = Arc::new(Notify::new());
    let release = Arc::new(Notify::new());
    let admitted = admitted_run();
    let runner = NativeNodeRunner::new(
        &admitted,
        Arc::new(ControlledDriver {
            first_emitted: first_emitted.clone(),
            release: release.clone(),
        }),
        Arc::new(FakeSessions),
    )
    .unwrap();
    let binding = agent_binding();
    let mut handle = runner
        .start(NodeRunRequest {
            invocation: NodeInvocation {
                reference: reference.clone(),
                worker: WorkerRef::new("agent.worker@1").unwrap(),
                input: Value::Null,
                binding: binding.clone(),
            },
            environment: ResolvedEnvironment::exact(
                &binding,
                BTreeMap::<EnvironmentVariableName, String>::new(),
            )
            .unwrap(),
        })
        .await
        .unwrap();
    let service = NativeV2Observability::new(ledger.clone());
    let mut durable = handle.take_initial_output().unwrap();
    let registration = service
        .register_live_execution(&reference, handle.live_output_source().unwrap())
        .await
        .unwrap();
    first_emitted.notified().await;
    persist_output(
        ledger.as_ref(),
        &run_id,
        reference.execution,
        durable.recv().await.unwrap(),
    )
    .await;

    let (_, mut historical) = service
        .logs(RunLogsParams {
            run_id: run_id.clone(),
            from_cursor: Some(Cursor::new("v2:2")),
            execution: Some(registration.public_execution().clone()),
        })
        .await
        .unwrap();
    let first_log = historical.recv().await.unwrap().unwrap();
    assert_eq!(first_log.record.message.as_str(), "before attach");

    let attach_params = RunAttachParams {
        run_id: run_id.clone(),
        execution: registration.public_execution().clone(),
    };
    let (_, mut attached) = service.attach(attach_params.clone()).await.unwrap();
    let (_, disconnected) = service.attach(attach_params).await.unwrap();
    drop(disconnected);
    assert!(matches!(
        attached.recv().await.unwrap().event,
        AgentAttachEvent::Working {}
    ));

    release.notify_one();
    let event = attached.recv().await.unwrap();
    let AgentAttachEvent::Output { text } = event.event else {
        panic!("the post-attach output must be live");
    };
    assert_eq!(text.as_str(), "after attach");
    persist_output(
        ledger.as_ref(),
        &run_id,
        reference.execution,
        durable.recv().await.unwrap(),
    )
    .await;
    let completion = handle.completion().await.unwrap();
    assert!(matches!(completion.outcome, WorkerOutcome::Verified { .. }));
    registration.close().await;
    assert!(matches!(
        attached.recv().await.unwrap().event,
        AgentAttachEvent::Settled {}
    ));

    let retained = historical.recv().await.unwrap().unwrap();
    assert_eq!(retained.record.message.as_str(), "after attach");
    assert!(historical.read_available().await.unwrap().is_empty());
}

#[tokio::test]
async fn dropping_live_registration_revokes_attach_authority_and_settles_viewers() {
    let (ledger, run_id) = ledger_run("dropped-live-registration").await;
    let reference = reference(&run_id, "worker", 1);
    ledger
        .append(&run_id, vec![RunEvent::RunStarted, started(&reference)])
        .await
        .unwrap();
    let first_emitted = Arc::new(Notify::new());
    let release = Arc::new(Notify::new());
    let admitted = admitted_run();
    let runner = NativeNodeRunner::new(
        &admitted,
        Arc::new(ControlledDriver {
            first_emitted: first_emitted.clone(),
            release: release.clone(),
        }),
        Arc::new(FakeSessions),
    )
    .unwrap();
    let binding = agent_binding();
    let mut handle = runner
        .start(NodeRunRequest {
            invocation: NodeInvocation {
                reference: reference.clone(),
                worker: WorkerRef::new("agent.worker@1").unwrap(),
                input: Value::Null,
                binding: binding.clone(),
            },
            environment: ResolvedEnvironment::exact(
                &binding,
                BTreeMap::<EnvironmentVariableName, String>::new(),
            )
            .unwrap(),
        })
        .await
        .unwrap();
    let _durable = handle.take_initial_output().unwrap();
    let service = NativeV2Observability::new(ledger);
    let registration = service
        .register_live_execution(&reference, handle.live_output_source().unwrap())
        .await
        .unwrap();
    first_emitted.notified().await;
    let params = RunAttachParams {
        run_id,
        execution: registration.public_execution().clone(),
    };
    let (_, mut attached) = service.attach(params.clone()).await.unwrap();
    assert!(matches!(
        attached.recv().await.unwrap().event,
        AgentAttachEvent::Working {}
    ));

    drop(registration);
    assert!(matches!(
        service.attach(params).await,
        Err(NativeV2ObservationError::ExecutionNotLive)
    ));
    release.notify_one();
    assert_eq!(attach_text(&mut attached).await, "after attach");
    handle.completion().await.unwrap();
    assert!(matches!(
        attached.recv().await.unwrap().event,
        AgentAttachEvent::Settled {}
    ));
}

#[tokio::test]
async fn opaque_selectors_disambiguate_parallel_verifier_attachments() {
    let (ledger, run_id) = ledger_run("parallel-attach").await;
    let left = reference(&run_id, "left", 1);
    let right = reference(&run_id, "right", 2);
    ledger
        .append(
            &run_id,
            vec![RunEvent::RunStarted, started(&left), started(&right)],
        )
        .await
        .unwrap();
    let barrier = Arc::new(Barrier::new(3));
    let admitted = admitted_run();
    let runner = NativeNodeRunner::new(
        &admitted,
        Arc::new(ParallelVerifierDriver {
            release: barrier.clone(),
        }),
        Arc::new(FakeSessions),
    )
    .unwrap();
    let mut left_handle = runner.start(node_request(&left)).await.unwrap();
    let mut right_handle = runner.start(node_request(&right)).await.unwrap();
    let service = NativeV2Observability::new(ledger);
    let left_registration = service
        .register_live_execution(&left, left_handle.live_output_source().unwrap())
        .await
        .unwrap();
    let right_registration = service
        .register_live_execution(&right, right_handle.live_output_source().unwrap())
        .await
        .unwrap();
    let (_, mut left_attach) = service
        .attach(RunAttachParams {
            run_id: run_id.clone(),
            execution: left_registration.public_execution().clone(),
        })
        .await
        .unwrap();
    let (_, mut right_attach) = service
        .attach(RunAttachParams {
            run_id,
            execution: right_registration.public_execution().clone(),
        })
        .await
        .unwrap();
    left_attach.recv().await.unwrap();
    right_attach.recv().await.unwrap();
    barrier.wait().await;

    assert_eq!(attach_text(&mut left_attach).await, "left");
    assert_eq!(attach_text(&mut right_attach).await, "right");
    left_handle.completion().await.unwrap();
    right_handle.completion().await.unwrap();
    left_registration.close().await;
    right_registration.close().await;
}

fn node_request(reference: &ExecutionRef) -> NodeRunRequest {
    let binding = agent_binding();
    NodeRunRequest {
        invocation: NodeInvocation {
            reference: reference.clone(),
            worker: WorkerRef::new(format!("agent.{}@1", reference.node.as_str())).unwrap(),
            input: Value::Null,
            binding: binding.clone(),
        },
        environment: ResolvedEnvironment::exact(&binding, BTreeMap::new()).unwrap(),
    }
}

async fn attach_text(subscription: &mut RunAttachSubscription) -> String {
    let AgentAttachEvent::Output { text } = subscription.recv().await.unwrap().event else {
        panic!("expected live verifier output");
    };
    text.as_str().to_owned()
}

async fn persist_output(
    ledger: &dyn RunLedger,
    run_id: &RunId,
    execution: ExecutionId,
    output: LiveOutput,
) {
    let stream = match output.stream {
        LiveOutputStream::Output => SafeLogStream::Output,
        LiveOutputStream::Error => SafeLogStream::Error,
        LiveOutputStream::System => SafeLogStream::System,
    };
    ledger
        .append(
            run_id,
            vec![RunEvent::SafeLog {
                execution: Some(execution),
                stream,
                line: SafeLogLine::new(output.text).unwrap(),
            }],
        )
        .await
        .unwrap();
}
