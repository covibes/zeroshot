mod dispatch;
mod state;

use std::sync::Arc;

use async_trait::async_trait;
use tokio::sync::{Mutex, oneshot, watch};

use crate::fault::{
    EngineFault, EvidenceClass, FaultContext, FaultFactory, FaultModule, ModuleEvidence,
};
use crate::observability::{NoopObservationSink, ObservationSink};

use super::ExecutionRuntime;
use super::driver::ExecutionSiteResolver;
use super::types::{
    CancelObservation, DispatchObservation, ExecutionCommand, ExecutionControl,
    ExecutionObservation, RecoveryRef,
};
use dispatch::{DispatchContext, ReadySignal, run_dispatch};
use state::{ExecutionKey, LiveExecution, LiveState, RuntimeState};

#[derive(Clone)]
pub struct LocalExecutionRuntime {
    resolver: Arc<dyn ExecutionSiteResolver>,
    observation_sink: Arc<dyn ObservationSink>,
    state: Arc<Mutex<RuntimeState>>,
}

impl LocalExecutionRuntime {
    #[must_use]
    pub fn new(resolver: Arc<dyn ExecutionSiteResolver>) -> Self {
        Self::with_observation_sink(resolver, Arc::new(NoopObservationSink))
    }

    #[must_use]
    pub fn with_observation_sink(
        resolver: Arc<dyn ExecutionSiteResolver>,
        observation_sink: Arc<dyn ObservationSink>,
    ) -> Self {
        Self {
            resolver,
            observation_sink,
            state: Arc::new(Mutex::new(RuntimeState::default())),
        }
    }

    pub async fn is_recovery_registered(&self, recovery_ref: &RecoveryRef) -> bool {
        self.state
            .lock()
            .await
            .recoveries
            .contains_key(recovery_ref)
    }

    fn fault(&self, module: FaultModule, class: EvidenceClass) -> EngineFault {
        FaultFactory::new(self.observation_sink.as_ref()).create(ModuleEvidence::new(
            module,
            FaultContext::Execution,
            class,
        ))
    }

    async fn get_live(&self, key: ExecutionKey) -> Option<Arc<LiveExecution>> {
        self.state.lock().await.live.get(&key).cloned()
    }

    async fn get_terminal(&self, key: ExecutionKey) -> Option<LiveState> {
        self.state.lock().await.terminal.get(&key).cloned()
    }

    pub(super) async fn retain_terminal(&self, control: &ExecutionControl, state: LiveState) {
        debug_assert!(state.is_terminal());
        self.state.lock().await.retain_terminal(
            (control.execution(), control.dispatch_fence()),
            control.recovery_ref(),
            state,
        );
    }

    pub async fn release_terminal(&self, control: &ExecutionControl) -> bool {
        self.state
            .lock()
            .await
            .release_terminal((control.execution(), control.dispatch_fence()))
    }

    pub async fn tracked_counts(&self) -> (usize, usize, usize) {
        let state = self.state.lock().await;
        (
            state.live.len(),
            state.recoveries.len(),
            state.terminal.len(),
        )
    }

    async fn retain_dispatch_task_failure(
        &self,
        control: &ExecutionControl,
    ) -> DispatchObservation {
        let fault = self.fault(FaultModule::Engine, EvidenceClass::InvariantViolation);
        let next = LiveState::Indeterminate {
            fault: Some(fault.clone()),
        };
        let should_retain = {
            let state = self.state.lock().await;
            !state
                .terminal
                .contains_key(&(control.execution(), control.dispatch_fence()))
        };
        if should_retain {
            self.retain_terminal(control, next).await;
        }
        DispatchObservation::Indeterminate {
            execution: control.execution(),
            dispatch_fence: control.dispatch_fence(),
            fault: Some(fault),
        }
    }
}

#[async_trait]
impl ExecutionRuntime for LocalExecutionRuntime {
    async fn dispatch(&self, command: ExecutionCommand) -> DispatchObservation {
        let control = command.control();
        let key = (control.execution(), control.dispatch_fence());
        if let Some(existing) = self.get_live(key).await {
            return existing
                .state
                .lock()
                .await
                .as_dispatch(control.execution(), control.dispatch_fence());
        }
        if let Some(terminal) = self.get_terminal(key).await {
            return terminal.as_dispatch(control.execution(), control.dispatch_fence());
        }

        let (cancel_tx, cancel_rx) = watch::channel(false);
        let live = Arc::new(LiveExecution {
            cancellation: cancel_tx,
            state: Mutex::new(LiveState::Registered),
        });
        {
            let mut state = self.state.lock().await;
            state.live.insert(key, Arc::clone(&live));
            state.recoveries.insert(control.recovery_ref().clone(), key);
        }

        let (ready_tx, ready_rx) = oneshot::channel();
        let ready = ReadySignal::new(ready_tx);
        let runtime = self.clone();
        let supervised_control = control.clone();
        tokio::spawn(async move {
            let ready_for_dispatch = ready.clone();
            let runtime_for_dispatch = runtime.clone();
            let join = tokio::spawn(async move {
                run_dispatch(
                    &runtime_for_dispatch,
                    command,
                    DispatchContext {
                        live,
                        cancel_rx,
                        ready: ready_for_dispatch,
                    },
                )
                .await;
            })
            .await;
            if join.is_err() {
                let observation = runtime
                    .retain_dispatch_task_failure(&supervised_control)
                    .await;
                ready.send(observation).await;
            }
        });

        match ready_rx.await {
            Ok(observation) => observation,
            Err(_) => self.retain_dispatch_task_failure(&control).await,
        }
    }

    async fn inspect(&self, control: ExecutionControl) -> ExecutionObservation {
        let key = (control.execution(), control.dispatch_fence());
        let Some(live) = self.get_live(key).await else {
            if let Some(terminal) = self.get_terminal(key).await {
                return terminal.as_inspect(control.execution(), control.dispatch_fence());
            }
            return ExecutionObservation::Indeterminate {
                execution: control.execution(),
                dispatch_fence: control.dispatch_fence(),
                fault: None,
            };
        };
        live.state
            .lock()
            .await
            .as_inspect(control.execution(), control.dispatch_fence())
    }

    async fn cancel(&self, control: ExecutionControl) -> CancelObservation {
        let key = (control.execution(), control.dispatch_fence());
        let Some(live) = self.get_live(key).await else {
            if let Some(terminal) = self.get_terminal(key).await {
                return terminal.as_cancel(control.execution(), control.dispatch_fence());
            }
            return CancelObservation::Indeterminate {
                execution: control.execution(),
                dispatch_fence: control.dispatch_fence(),
                fault: None,
            };
        };
        let snapshot = {
            let state = live.state.lock().await;
            state.as_cancel(control.execution(), control.dispatch_fence())
        };
        if !matches!(
            snapshot,
            CancelObservation::Completed { .. } | CancelObservation::DefinitelyNotStarted { .. }
        ) {
            let _ = live.cancellation.send(true);
        }
        snapshot
    }
}
