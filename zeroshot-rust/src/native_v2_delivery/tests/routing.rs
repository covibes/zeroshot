use super::*;
use openengine_cluster_protocol::GraphSpec;

struct RepairSession;

#[async_trait]
impl NodeSession for RepairSession {
    fn as_any(&self) -> &dyn Any {
        self
    }

    async fn is_live(&self) -> bool {
        true
    }

    async fn close(&self) {}
}

struct DeliveryLoopLane {
    delivery: Arc<NativeV2DeliveryAdapter>,
    workspace: PathBuf,
    repairs: AtomicUsize,
}

#[async_trait]
impl SessionFactory for DeliveryLoopLane {
    async fn open(
        &self,
        invocation: &NodeInvocation,
        environment: &ResolvedEnvironment,
    ) -> Result<Arc<dyn NodeSession>, NodeRunnerError> {
        match &invocation.binding {
            NodeRuntimeBinding::GitDelivery { .. } => {
                SessionFactory::open(self.delivery.as_ref(), invocation, environment).await
            }
            NodeRuntimeBinding::Agent { .. } => Ok(Arc::new(RepairSession)),
        }
    }
}

#[async_trait]
impl NodeDriver for DeliveryLoopLane {
    async fn run(
        &self,
        invocation: DriverInvocation,
        control: DriverControl,
    ) -> Result<WorkerOutcome, NodeRunnerError> {
        if matches!(
            &invocation.node.binding,
            NodeRuntimeBinding::GitDelivery { .. }
        ) {
            return NodeDriver::run(self.delivery.as_ref(), invocation, control).await;
        }
        assert_eq!(invocation.node.reference.node.as_str(), "repair");
        let repair = self.repairs.fetch_add(1, Ordering::SeqCst) + 1;
        fs::write(
            self.workspace.join("repair.txt"),
            format!("repair {repair}\n"),
        )
        .map_err(|_| NodeRunnerError::Driver)?;
        Ok(WorkerOutcome::Verified {
            output: Value::Null,
            artifacts: Vec::new(),
        })
    }
}

async fn create_delivery_run(
    admitted: crate::native_v2_contract::AdmittedRun,
) -> (RunId, Arc<FakeRunLedger>, Arc<RunEnvironment>) {
    let run_id = RunId::new("delivery-supervisor-run");
    let ledger = Arc::new(FakeRunLedger::new());
    let environments = Arc::new(
        RunEnvironment::exact(
            &admitted.runtime,
            BTreeMap::from([(
                EnvironmentVariableName::new(GITHUB_TOKEN_ENV).assert_value(),
                "test-token".to_owned(),
            )]),
        )
        .assert_value_with("resolve delivery run environment"),
    );
    ledger
        .create_or_get(CreateRun {
            run_id: run_id.clone(),
            submission_key: IdempotencyKey::new("delivery-supervisor").assert_value(),
            submission_digest: Sha256Digest::new("d".repeat(64)).assert_value(),
            admitted,
        })
        .await
        .assert_value_with("create delivery run");
    (run_id, ledger, environments)
}

#[tokio::test]
async fn ci_failure_repairs_then_authoritatively_merges_in_one_supervised_run() {
    let repo = TempRepo::delivery();
    let authority = Arc::new(FakeGitHub::new(
        repo.remote.clone(),
        Script::CiFailsThenMerges,
    ));
    let admitted = admitted_routing_graph(&repo.base).await;
    let delivery = Arc::new(NativeV2DeliveryAdapter::new(
        NativeV2DeliveryConfig {
            workspace: repo.workspace.clone(),
            git_program: PathBuf::from("/usr/bin/git"),
            target: DeliveryTarget::new("acme/project", "main", repo.base.clone()).assert_value(),
            poll: DeliveryPollPolicy::new(3, Duration::ZERO).assert_value(),
        },
        authority.clone(),
    ));
    let lane = Arc::new(DeliveryLoopLane {
        delivery,
        workspace: repo.workspace.clone(),
        repairs: AtomicUsize::new(0),
    });
    let runner = Arc::new(
        NativeNodeRunner::new(&admitted, lane.clone(), lane.clone())
            .assert_value_with("delivery loop runner"),
    );
    let (run_id, ledger, environments) = create_delivery_run(admitted).await;
    let terminal = NativeV2Supervisor::new(run_id.clone(), ledger.clone(), runner, environments)
        .drive()
        .await
        .assert_value_with("drive delivery loop");

    assert_eq!(
        terminal,
        TerminalResult::Succeeded {
            output: Value::Null
        }
    );
    assert_eq!(lane.repairs.load(Ordering::SeqCst), 1);
    assert_eq!(authority.merge_requests.load(Ordering::SeqCst), 1);
    assert_eq!(authority.inspections.load(Ordering::SeqCst), 3);
    let stored = ledger.get(&run_id).await.assert_value().assert_value();
    let execution_nodes = stored
        .snapshot
        .executions
        .values()
        .map(|execution| execution.reference.node.as_str())
        .collect::<Vec<_>>();
    assert_eq!(
        execution_nodes
            .iter()
            .filter(|node| **node == "deliver")
            .count(),
        2
    );
    assert_eq!(
        execution_nodes
            .iter()
            .filter(|node| **node == "repair")
            .count(),
        1
    );
}

pub(super) async fn assert_ci_failure_routes_an_authored_worker_loop(
    base_revision: &str,
    outcome: WorkerOutcome,
) {
    let admitted = admitted_routing_graph(base_revision).await;
    let verified = VerifiedGraph {
        compiled_ir: admitted.graph,
        diagnostics: Vec::new(),
    };
    let delivery = settled_execution((1, 1), "deliver", (0, 1), outcome);
    let after_failure = FullV1Reducer::native_v2(&verified)
        .reduce(ReductionInput {
            initial_input: &Value::Null,
            executions: std::slice::from_ref(&delivery),
            next_node_instance: 2,
            next_execution: 2,
        })
        .assert_value();
    assert!(after_failure.decisions.iter().any(|decision| matches!(
        decision,
        Decision::Dispatch { occurrence, .. } if occurrence.node.as_str() == "repair"
    )));

    let repair = settled_execution(
        (2, 2),
        "repair",
        (2, 3),
        WorkerOutcome::Verified {
            output: Value::Null,
            artifacts: Vec::new(),
        },
    );
    let next_iteration = FullV1Reducer::native_v2(&verified)
        .reduce(ReductionInput {
            initial_input: &Value::Null,
            executions: &[delivery, repair],
            next_node_instance: 3,
            next_execution: 3,
        })
        .assert_value();
    assert!(next_iteration.decisions.iter().any(|decision| matches!(
        decision,
        Decision::Dispatch { occurrence, node_instance, execution, .. }
            if occurrence.node.as_str() == "deliver"
                && node_instance.get() == 1
                && execution.get() == 3
    )));
}

async fn admitted_routing_graph(base_revision: &str) -> crate::native_v2_contract::AdmittedRun {
    let graph = routing_graph();
    let delivery = NodeRuntimeBinding::GitDelivery {
        env: DeclaredEnvironment::new([
            EnvironmentVariableName::new(GITHUB_TOKEN_ENV).assert_value()
        ])
        .assert_value(),
    };
    let repair = NodeRuntimeBinding::Agent {
        model: crate::worker_catalog::ModelId::new("gpt-5.6").assert_value(),
        effort: Some(crate::worker_catalog::ReasoningEffort::Max),
        session_scope: crate::execution::SessionScope::Execution,
        env: DeclaredEnvironment::empty(),
    };
    NativeV2Admission
        .admit(RunSubmission {
            title: RunTitle::new("Delivery routing test").assert_value(),
            graph,
            initial_input: Value::Null,
            runtime: RuntimePlan::Codex {
                provider: crate::native_v2_contract::CodexProvider::OpenAi,
                size: RunSize::Medium,
                nodes: BTreeMap::from([
                    (NodeName::new("deliver").assert_value(), delivery),
                    (NodeName::new("repair").assert_value(), repair),
                ]),
            },
            source: ResolvedSource {
                repository: SourceRepositoryId::new("acme/project").assert_value(),
                branch: SourceBranchId::new("main").assert_value(),
                revision: SourceRevisionId::new(base_revision).assert_value(),
            },
            submission_key: IdempotencyKey::new("delivery-routing").assert_value(),
        })
        .await
        .assert_value()
}

fn routing_graph() -> GraphSpec {
    let delivery = delivery_node(DeliveryMode::Merge);
    full_graph(vec![
        json!({
            "kind":"loop","name":"delivery_loop","state":{"kind":"null"},
                    "body":{
                        "kind":"seq","name":"delivery_attempt","state":{"kind":"null"},
                        "children":[
                            delivery,
                            {
                                "kind":"choice","name":"delivery_route","state":{"kind":"null"},
                                "branches":[{
                                    "when":{
                                        "kind":"in",
                                        "value":{"name":"deliver","source":"signal","field":"delivery"},
                                        "labels":["ci_failed"]
                                    },
                                    "node":{
                                        "kind":"step","name":"repair","worker":"agent.repair@1",
                                        "instructions":"Repair the failed delivery.",
                                        "input":{"kind":"null"},"output":{"kind":"null"},
                                        "inputBindings":Value::Array(Vec::new()),
                                        "writeBindings":Value::Array(Vec::new()),
                                        "timeoutMs":1000,"attempts":1
                                    }
                                }],
                                "otherwise":{
                                    "kind":"succeed","name":"merged",
                                    "output":{"kind":"null"},"bindings":[]
                                },
                                "promotedStatePaths":[]
                            }
                        ],
                        "promotedStatePaths":[]
                    },
                    "until":{
                        "kind":"in",
                        "value":{"name":"deliver","source":"signal","field":"delivery"},
                        "labels":["merged"]
                    },
            "maxIterations":3,"promotedStatePaths":[]
        }),
        success_node(),
    ])
}

fn settled_execution(
    identity: (u64, u64),
    node: &str,
    positions: (u64, u64),
    outcome: WorkerOutcome,
) -> DurableExecution {
    let (execution, node_instance) = identity;
    let (dispatch_position, settle_position) = positions;
    DurableExecution {
        dispatch_position: HistoryPosition::new(dispatch_position).assert_value(),
        node_instance: native_v2_contract::NodeInstanceId::new(node_instance).assert_value(),
        execution: native_v2_contract::ExecutionId::new(execution).assert_value(),
        occurrence: StructuralOccurrence {
            node: NodeName::new(node).assert_value(),
            map_indices: Vec::new(),
        },
        attempt: PositiveInteger::new(1).assert_value(),
        input: Value::Null,
        state: DurableExecutionState::Settled {
            position: HistoryPosition::new(settle_position).assert_value(),
            outcome,
        },
    }
}

use openengine_cluster_testkit::assertions::{AssertValue};
