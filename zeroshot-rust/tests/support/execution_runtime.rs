use std::collections::{BTreeMap, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use tokio::sync::Notify;
use zeroshot_engine::execution::driver::{
    CredentialCapability, DriverCancellation, DriverCompletion, DriverRequest, DriverStartOutcome,
    ExecutionSiteResolution, ExecutionSiteResolver, ProviderCapability, ResolvedExecutionSite,
    SessionCapability, WorkerDriver, WorkspaceCapability,
};
use zeroshot_engine::execution::local::LocalExecutionRuntime;
use zeroshot_engine::execution::{
    CompletionEvidence, ExecutionCandidate, ExecutionCommand, ExecutionInput, ExecutionResult,
    InlineExecutionInput,
};
use zeroshot_engine::fault::{
    EngineFault, EvidenceClass, FaultContext, FaultFactory, FaultModule, ModuleEvidence,
};
use zeroshot_engine::observability::NoopObservationSink;

pub use super::execution_contract::CommandSpec;
use super::execution_contract::command_with_input as build_command_with_input;

pub fn fault(class: EvidenceClass) -> EngineFault {
    static SINK: NoopObservationSink = NoopObservationSink;
    FaultFactory::new(&SINK).create(ModuleEvidence::new(
        FaultModule::Worker,
        FaultContext::Execution,
        class,
    ))
}

pub fn result(label: &str) -> ExecutionResult {
    ExecutionResult::new(
        ExecutionCandidate::new(label).unwrap(),
        CompletionEvidence::Success,
        None,
    )
    .unwrap()
}

pub fn command(spec: CommandSpec<'_>) -> ExecutionCommand {
    build_command_with_input(
        spec,
        ExecutionInput::Inline(InlineExecutionInput::new("{\"ok\":true}").unwrap()),
    )
}

pub enum Scenario {
    DefinitelyNotStarted(Option<EngineFault>),
    Completed(ExecutionResult),
    MayHaveStarted {
        fault: Option<EngineFault>,
        result: ExecutionResult,
    },
    PanicAfterLaunchBeforeReturn {
        launched: Arc<AtomicBool>,
    },
    Running {
        completion: Arc<Notify>,
        result: ExecutionResult,
    },
    WaitStartThenRun {
        start: Arc<Notify>,
        waiting: Arc<AtomicBool>,
        completion: Arc<Notify>,
        result: ExecutionResult,
    },
    CancelAware {
        completion: Arc<Notify>,
        cancelled_result: ExecutionResult,
        completed_result: ExecutionResult,
        hits: Arc<AtomicUsize>,
    },
}

pub async fn runtime_for(scenarios: Vec<Scenario>) -> LocalExecutionRuntime {
    let runtime_slot = Arc::new(tokio::sync::Mutex::new(None));
    let recovery_checked = Arc::new(AtomicBool::new(false));
    let resolver = Arc::new(FakeResolver {
        driver: Arc::new(FakeWorkerDriver::new(scenarios)),
        runtime_slot: Arc::clone(&runtime_slot),
        recovery_checked,
        outcome: ResolverOutcome::Agent,
    });
    let runtime = LocalExecutionRuntime::new(resolver);
    *runtime_slot.lock().await = Some(runtime.clone());
    runtime
}

pub fn empty_driver() -> Arc<dyn WorkerDriver> {
    Arc::new(FakeWorkerDriver::new(Vec::new()))
}

pub struct FakeResolver {
    pub driver: Arc<dyn WorkerDriver>,
    pub runtime_slot: Arc<tokio::sync::Mutex<Option<LocalExecutionRuntime>>>,
    pub recovery_checked: Arc<AtomicBool>,
    pub outcome: ResolverOutcome,
}

pub enum ResolverOutcome {
    Agent,
    DefinitelyNotStarted(EngineFault),
    Indeterminate(EngineFault),
}

#[async_trait]
impl ExecutionSiteResolver for FakeResolver {
    async fn resolve(&self, command: &ExecutionCommand) -> ExecutionSiteResolution {
        if let Some(runtime) = self.runtime_slot.lock().await.clone() {
            if runtime.is_recovery_registered(command.recovery_ref()).await {
                self.recovery_checked.store(true, Ordering::SeqCst);
            }
        }
        match &self.outcome {
            ResolverOutcome::DefinitelyNotStarted(fault) => {
                ExecutionSiteResolution::DefinitelyNotStarted {
                    fault: fault.clone(),
                }
            }
            ResolverOutcome::Indeterminate(fault) => ExecutionSiteResolution::Indeterminate {
                fault: fault.clone(),
            },
            ResolverOutcome::Agent => {
                ExecutionSiteResolution::Resolved(Box::new(ResolvedExecutionSite::Agent {
                    driver: Arc::clone(&self.driver),
                    request: driver_request(command),
                }))
            }
        }
    }
}

struct FakeWorkerDriver {
    scenarios: Mutex<VecDeque<Scenario>>,
}

impl FakeWorkerDriver {
    fn new(scenarios: Vec<Scenario>) -> Self {
        Self {
            scenarios: Mutex::new(VecDeque::from(scenarios)),
        }
    }
}

#[async_trait]
impl WorkerDriver for FakeWorkerDriver {
    async fn start(
        &self,
        _request: DriverRequest,
        mut cancellation: DriverCancellation,
    ) -> DriverStartOutcome {
        let scenario = self
            .scenarios
            .lock()
            .expect("scenario mutex must not be poisoned")
            .pop_front()
            .expect("driver scenario must exist");
        match scenario {
            Scenario::DefinitelyNotStarted(fault) => {
                DriverStartOutcome::DefinitelyNotStarted { fault }
            }
            Scenario::Completed(result) => DriverStartOutcome::Completed {
                completion: DriverCompletion::success(result),
            },
            Scenario::MayHaveStarted { fault, result } => DriverStartOutcome::MayHaveStarted {
                fault,
                completion: Box::pin(async move { DriverCompletion::success(result) }),
            },
            Scenario::PanicAfterLaunchBeforeReturn { launched } => {
                launched.store(true, Ordering::SeqCst);
                panic!("simulated post-launch panic before returning start evidence");
            }
            Scenario::Running { completion, result } => DriverStartOutcome::Running {
                completion: Box::pin(async move {
                    completion.notified().await;
                    DriverCompletion::success(result)
                }),
            },
            Scenario::WaitStartThenRun {
                start,
                waiting,
                completion,
                result,
            } => {
                waiting.store(true, Ordering::SeqCst);
                start.notified().await;
                DriverStartOutcome::Running {
                    completion: Box::pin(async move {
                        completion.notified().await;
                        DriverCompletion::success(result)
                    }),
                }
            }
            Scenario::CancelAware {
                completion,
                cancelled_result,
                completed_result,
                hits,
            } => DriverStartOutcome::Running {
                completion: Box::pin(async move {
                    tokio::select! {
                        _ = cancellation.cancelled() => {
                            hits.fetch_add(1, Ordering::SeqCst);
                            DriverCompletion::success(cancelled_result)
                        }
                        _ = completion.notified() => DriverCompletion::success(completed_result),
                    }
                }),
            },
        }
    }
}

fn driver_request(command: &ExecutionCommand) -> DriverRequest {
    DriverRequest {
        control: command.control(),
        input: command.input().clone(),
        workspace: WorkspaceCapability {
            current_dir: "/tmp/zeroshot-runtime".into(),
            mode: command.workspace().mode(),
        },
        credentials: vec![CredentialCapability {
            handle_id: "credential-1".to_owned(),
        }],
        provider: Some(ProviderCapability {
            lane: "lane.alpha".to_owned(),
            driver_family: "gateway".to_owned(),
        }),
        session: SessionCapability {
            reuse_key: Some("node-instance-6".to_owned()),
        },
        environment: BTreeMap::new(),
    }
}
