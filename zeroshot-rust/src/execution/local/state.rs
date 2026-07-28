use std::collections::{BTreeMap, VecDeque};
use std::sync::Arc;

use tokio::sync::{Mutex, watch};

use crate::cluster_ledger::ExecutionId;
use crate::fault::EngineFault;

use super::super::types::{
    CancelObservation, DispatchFence, DispatchObservation, ExecutionObservation, ExecutionResult,
    RecoveryRef,
};

pub type ExecutionKey = (ExecutionId, DispatchFence);

#[derive(Default)]
pub struct RuntimeState {
    pub live: BTreeMap<ExecutionKey, Arc<LiveExecution>>,
    pub recoveries: BTreeMap<RecoveryRef, ExecutionKey>,
    pub terminal: BTreeMap<ExecutionKey, LiveState>,
    pub terminal_order: VecDeque<ExecutionKey>,
}

pub struct LiveExecution {
    pub cancellation: watch::Sender<bool>,
    pub state: Mutex<LiveState>,
}

#[derive(Clone)]
pub enum LiveState {
    Registered,
    DefinitelyNotStarted { fault: Option<EngineFault> },
    MayHaveStarted { fault: Option<EngineFault> },
    Running,
    Completed(ExecutionResult),
    Indeterminate { fault: Option<EngineFault> },
}

impl RuntimeState {
    pub fn retain_terminal(
        &mut self,
        key: ExecutionKey,
        recovery_ref: &RecoveryRef,
        state: LiveState,
    ) {
        debug_assert!(state.is_terminal());
        self.live.remove(&key);
        self.recoveries.remove(recovery_ref);
        if !self.terminal.contains_key(&key) {
            self.terminal_order.push_back(key);
        }
        self.terminal.insert(key, state);
    }

    pub fn release_terminal(&mut self, key: ExecutionKey) -> bool {
        let released = self.terminal.remove(&key).is_some();
        if released {
            self.terminal_order.retain(|tracked| *tracked != key);
        }
        released
    }
}

impl LiveState {
    pub fn is_terminal(&self) -> bool {
        matches!(
            self,
            Self::DefinitelyNotStarted { .. } | Self::Completed(_) | Self::Indeterminate { .. }
        )
    }

    pub fn as_dispatch(
        &self,
        execution: ExecutionId,
        dispatch_fence: DispatchFence,
    ) -> DispatchObservation {
        match self {
            Self::Registered | Self::Running => DispatchObservation::Running {
                execution,
                dispatch_fence,
            },
            Self::DefinitelyNotStarted { fault } => DispatchObservation::DefinitelyNotStarted {
                execution,
                dispatch_fence,
                fault: fault.clone(),
            },
            Self::MayHaveStarted { fault } => DispatchObservation::MayHaveStarted {
                execution,
                dispatch_fence,
                fault: fault.clone(),
            },
            Self::Completed(result) => DispatchObservation::Completed {
                execution,
                dispatch_fence,
                result: result.clone(),
            },
            Self::Indeterminate { fault } => DispatchObservation::Indeterminate {
                execution,
                dispatch_fence,
                fault: fault.clone(),
            },
        }
    }

    pub fn as_inspect(
        &self,
        execution: ExecutionId,
        dispatch_fence: DispatchFence,
    ) -> ExecutionObservation {
        match self {
            Self::Registered
            | Self::MayHaveStarted { .. }
            | Self::Indeterminate { fault: None } => ExecutionObservation::Indeterminate {
                execution,
                dispatch_fence,
                fault: None,
            },
            Self::DefinitelyNotStarted { fault } | Self::Indeterminate { fault } => {
                ExecutionObservation::Indeterminate {
                    execution,
                    dispatch_fence,
                    fault: fault.clone(),
                }
            }
            Self::Running => ExecutionObservation::Running {
                execution,
                dispatch_fence,
            },
            Self::Completed(result) => ExecutionObservation::Completed {
                execution,
                dispatch_fence,
                result: result.clone(),
            },
        }
    }

    pub fn as_cancel(
        &self,
        execution: ExecutionId,
        dispatch_fence: DispatchFence,
    ) -> CancelObservation {
        match self {
            Self::DefinitelyNotStarted { .. } => CancelObservation::DefinitelyNotStarted {
                execution,
                dispatch_fence,
            },
            Self::Completed(result) => CancelObservation::Completed {
                execution,
                dispatch_fence,
                result: result.clone(),
            },
            Self::Registered | Self::Running | Self::MayHaveStarted { .. } => {
                CancelObservation::MayHaveStarted {
                    execution,
                    dispatch_fence,
                    fault: None,
                }
            }
            Self::Indeterminate { fault } => CancelObservation::Indeterminate {
                execution,
                dispatch_fence,
                fault: fault.clone(),
            },
        }
    }
}

pub fn fault_is_session_lost(fault: &EngineFault) -> bool {
    fault
        .sources()
        .first()
        .is_some_and(|source| source.evidence_class() == crate::fault::EvidenceClass::SessionLost)
}
