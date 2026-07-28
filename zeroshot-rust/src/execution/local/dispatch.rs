use std::sync::Arc;

use tokio::sync::{Mutex, oneshot, watch};

use crate::fault::{EngineFault, EvidenceClass, FaultModule};

use super::LocalExecutionRuntime;
use super::state::{LiveExecution, LiveState, fault_is_session_lost};
use crate::execution::driver::{
    DriverCancellation, DriverStartOutcome, ExecutionSiteResolution, ResolvedExecutionSite,
};
use crate::execution::types::{
    DispatchObservation, ExecutionCommand, ExecutionControl, ExecutionTargetRef, SessionScope,
};

pub(super) struct DispatchContext {
    pub live: Arc<LiveExecution>,
    pub cancel_rx: watch::Receiver<bool>,
    pub ready: ReadySignal,
}

#[derive(Clone)]
pub(super) struct ReadySignal {
    tx: Arc<Mutex<Option<oneshot::Sender<DispatchObservation>>>>,
}

impl ReadySignal {
    pub fn new(tx: oneshot::Sender<DispatchObservation>) -> Self {
        Self {
            tx: Arc::new(Mutex::new(Some(tx))),
        }
    }

    pub async fn send(&self, observation: DispatchObservation) {
        if let Some(tx) = self.tx.lock().await.take() {
            let _ = tx.send(observation);
        }
    }
}

pub(super) async fn run_dispatch(
    runtime: &LocalExecutionRuntime,
    command: ExecutionCommand,
    context: DispatchContext,
) {
    let control = command.control();
    if node_instance_scope_is_unsupported(&command) {
        reject_unsupported_scope(runtime, &command, &control, context).await;
        return;
    }

    match resolve_site(runtime, command.clone()).await {
        Ok(ExecutionSiteResolution::Resolved(resolved)) => {
            start_and_handle_resolved(runtime, control, context, *resolved).await;
        }
        Ok(ExecutionSiteResolution::DefinitelyNotStarted { fault }) => {
            let observation = resolve_not_started(&command, &fault);
            retain_terminal_state(
                runtime,
                &control,
                live_state_for_observation(&observation, fault),
            )
            .await;
            context.ready.send(observation).await;
        }
        Ok(ExecutionSiteResolution::Indeterminate { fault }) => {
            retain_terminal_state(
                runtime,
                &control,
                LiveState::Indeterminate {
                    fault: Some(fault.clone()),
                },
            )
            .await;
            context
                .ready
                .send(DispatchObservation::Indeterminate {
                    execution: command.execution(),
                    dispatch_fence: command.dispatch_fence(),
                    fault: Some(fault),
                })
                .await;
        }
        Err(fault) => {
            retain_terminal_state(
                runtime,
                &control,
                LiveState::Indeterminate {
                    fault: Some(fault.clone()),
                },
            )
            .await;
            context
                .ready
                .send(DispatchObservation::Indeterminate {
                    execution: command.execution(),
                    dispatch_fence: command.dispatch_fence(),
                    fault: Some(fault),
                })
                .await;
        }
    }
}

async fn reject_unsupported_scope(
    runtime: &LocalExecutionRuntime,
    command: &ExecutionCommand,
    control: &ExecutionControl,
    context: DispatchContext,
) {
    let fault = runtime.fault(FaultModule::Worker, EvidenceClass::InvariantViolation);
    retain_terminal_state(
        runtime,
        control,
        LiveState::DefinitelyNotStarted {
            fault: Some(fault.clone()),
        },
    )
    .await;
    context
        .ready
        .send(DispatchObservation::DefinitelyNotStarted {
            execution: command.execution(),
            dispatch_fence: command.dispatch_fence(),
            fault: Some(fault),
        })
        .await;
}

async fn start_and_handle_resolved(
    runtime: &LocalExecutionRuntime,
    control: ExecutionControl,
    context: DispatchContext,
    resolved: ResolvedExecutionSite,
) {
    match start_resolved_site(runtime, resolved, context.cancel_rx.clone()).await {
        Ok(outcome) => handle_driver_outcome(runtime, control, context, outcome).await,
        Err(fault) => {
            retain_terminal_state(
                runtime,
                &control,
                LiveState::Indeterminate {
                    fault: Some(fault.clone()),
                },
            )
            .await;
            context
                .ready
                .send(DispatchObservation::Indeterminate {
                    execution: control.execution(),
                    dispatch_fence: control.dispatch_fence(),
                    fault: Some(fault),
                })
                .await;
        }
    }
}

async fn resolve_site(
    runtime: &LocalExecutionRuntime,
    command: ExecutionCommand,
) -> Result<ExecutionSiteResolution, EngineFault> {
    let resolver = Arc::clone(&runtime.resolver);
    tokio::spawn(async move { resolver.resolve(&command).await })
        .await
        .map_err(|_| panic_fault(runtime))
}

async fn start_resolved_site(
    runtime: &LocalExecutionRuntime,
    resolved: ResolvedExecutionSite,
    cancel_rx: watch::Receiver<bool>,
) -> Result<DriverStartOutcome, EngineFault> {
    tokio::spawn(async move {
        match resolved {
            ResolvedExecutionSite::Agent { driver, request } => {
                driver
                    .start(request, DriverCancellation::new(cancel_rx))
                    .await
            }
            ResolvedExecutionSite::Builtin { driver, request } => {
                driver
                    .start(request, DriverCancellation::new(cancel_rx))
                    .await
            }
        }
    })
    .await
    .map_err(|_| panic_fault(runtime))
}

async fn handle_driver_outcome(
    runtime: &LocalExecutionRuntime,
    control: ExecutionControl,
    context: DispatchContext,
    outcome: DriverStartOutcome,
) {
    let execution = control.execution();
    let dispatch_fence = control.dispatch_fence();
    match outcome {
        DriverStartOutcome::DefinitelyNotStarted { fault } => {
            finish_not_started(runtime, &control, context, fault).await;
        }
        DriverStartOutcome::MayHaveStarted { fault, completion } => {
            set_live_state(
                &context.live,
                LiveState::MayHaveStarted {
                    fault: fault.clone(),
                },
            )
            .await;
            context
                .ready
                .send(DispatchObservation::MayHaveStarted {
                    execution,
                    dispatch_fence,
                    fault: fault.clone(),
                })
                .await;
            retain_completion(runtime, &control, completion).await;
        }
        DriverStartOutcome::Running { completion } => {
            set_live_state(&context.live, LiveState::Running).await;
            context
                .ready
                .send(DispatchObservation::Running {
                    execution,
                    dispatch_fence,
                })
                .await;
            retain_completion(runtime, &control, completion).await;
        }
        DriverStartOutcome::Completed { completion } => {
            let result = completion.result;
            retain_terminal_state(runtime, &control, LiveState::Completed(result.clone())).await;
            context
                .ready
                .send(DispatchObservation::Completed {
                    execution,
                    dispatch_fence,
                    result,
                })
                .await;
        }
        DriverStartOutcome::Indeterminate { fault } => {
            retain_terminal_state(
                runtime,
                &control,
                LiveState::Indeterminate {
                    fault: fault.clone(),
                },
            )
            .await;
            context
                .ready
                .send(DispatchObservation::Indeterminate {
                    execution,
                    dispatch_fence,
                    fault,
                })
                .await;
        }
    }
}

async fn retain_completion(
    runtime: &LocalExecutionRuntime,
    control: &ExecutionControl,
    completion: crate::execution::driver::DriverCompletionFuture,
) {
    match tokio::spawn(completion).await {
        Ok(completion) => {
            retain_terminal_state(runtime, control, LiveState::Completed(completion.result)).await;
        }
        Err(_) => {
            retain_terminal_state(
                runtime,
                control,
                LiveState::Indeterminate {
                    fault: Some(panic_fault(runtime)),
                },
            )
            .await;
        }
    }
}

fn node_instance_scope_is_unsupported(command: &ExecutionCommand) -> bool {
    matches!(command.session_scope(), SessionScope::NodeInstance)
        && matches!(
            command.target(),
            ExecutionTargetRef::Agent(binding) if !binding.supports_node_instance()
        )
}

fn resolve_not_started(
    command: &ExecutionCommand,
    fault: &crate::fault::EngineFault,
) -> DispatchObservation {
    if fault_is_session_lost(fault) {
        DispatchObservation::Indeterminate {
            execution: command.execution(),
            dispatch_fence: command.dispatch_fence(),
            fault: Some(fault.clone()),
        }
    } else {
        DispatchObservation::DefinitelyNotStarted {
            execution: command.execution(),
            dispatch_fence: command.dispatch_fence(),
            fault: Some(fault.clone()),
        }
    }
}

fn live_state_for_observation(
    observation: &DispatchObservation,
    fault: crate::fault::EngineFault,
) -> LiveState {
    match observation {
        DispatchObservation::DefinitelyNotStarted { .. } => {
            LiveState::DefinitelyNotStarted { fault: Some(fault) }
        }
        _ => LiveState::Indeterminate { fault: Some(fault) },
    }
}

async fn set_live_state(live: &Arc<LiveExecution>, next: LiveState) {
    let mut state = live.state.lock().await;
    *state = next;
}

async fn retain_terminal_state(
    runtime: &LocalExecutionRuntime,
    control: &ExecutionControl,
    next: LiveState,
) {
    runtime.retain_terminal(control, next).await;
}

async fn finish_not_started(
    runtime: &LocalExecutionRuntime,
    control: &ExecutionControl,
    context: DispatchContext,
    fault: Option<crate::fault::EngineFault>,
) {
    let execution = control.execution();
    let dispatch_fence = control.dispatch_fence();
    let original_fault = fault.clone();
    let final_fault = fault.filter(|value| !fault_is_session_lost(value));
    let observation = if final_fault.is_some() || original_fault.is_none() {
        DispatchObservation::DefinitelyNotStarted {
            execution,
            dispatch_fence,
            fault: final_fault.clone(),
        }
    } else {
        DispatchObservation::Indeterminate {
            execution,
            dispatch_fence,
            fault: original_fault,
        }
    };
    let next = match &observation {
        DispatchObservation::DefinitelyNotStarted { fault, .. } => {
            LiveState::DefinitelyNotStarted {
                fault: fault.clone(),
            }
        }
        DispatchObservation::Indeterminate { fault, .. } => LiveState::Indeterminate {
            fault: fault.clone(),
        },
        _ => unreachable!(),
    };
    retain_terminal_state(runtime, control, next).await;
    context.ready.send(observation).await;
}

fn panic_fault(runtime: &LocalExecutionRuntime) -> EngineFault {
    runtime.fault(FaultModule::Engine, EvidenceClass::InvariantViolation)
}
