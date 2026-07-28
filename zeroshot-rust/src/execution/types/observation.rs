use serde::{Deserialize, Deserializer, Serialize};

use crate::cluster_ledger::ExecutionId;
use crate::fault::EngineFault;

use super::common::{DispatchFence, decode_optional_fault_value};
use super::result::ExecutionResult;

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DispatchObservation {
    DefinitelyNotStarted {
        execution: ExecutionId,
        dispatch_fence: DispatchFence,
        fault: Option<EngineFault>,
    },
    MayHaveStarted {
        execution: ExecutionId,
        dispatch_fence: DispatchFence,
        fault: Option<EngineFault>,
    },
    Running {
        execution: ExecutionId,
        dispatch_fence: DispatchFence,
    },
    Completed {
        execution: ExecutionId,
        dispatch_fence: DispatchFence,
        result: ExecutionResult,
    },
    Indeterminate {
        execution: ExecutionId,
        dispatch_fence: DispatchFence,
        fault: Option<EngineFault>,
    },
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum EncodedDispatchObservation {
    DefinitelyNotStarted {
        execution: ExecutionId,
        dispatch_fence: DispatchFence,
        fault: Option<serde_json::Value>,
    },
    MayHaveStarted {
        execution: ExecutionId,
        dispatch_fence: DispatchFence,
        fault: Option<serde_json::Value>,
    },
    Running {
        execution: ExecutionId,
        dispatch_fence: DispatchFence,
    },
    Completed {
        execution: ExecutionId,
        dispatch_fence: DispatchFence,
        result: ExecutionResult,
    },
    Indeterminate {
        execution: ExecutionId,
        dispatch_fence: DispatchFence,
        fault: Option<serde_json::Value>,
    },
}

impl DispatchObservation {
    #[must_use]
    pub const fn execution(&self) -> ExecutionId {
        match self {
            Self::DefinitelyNotStarted { execution, .. }
            | Self::MayHaveStarted { execution, .. }
            | Self::Running { execution, .. }
            | Self::Completed { execution, .. }
            | Self::Indeterminate { execution, .. } => *execution,
        }
    }
}

impl<'de> Deserialize<'de> for DispatchObservation {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        match EncodedDispatchObservation::deserialize(deserializer)? {
            EncodedDispatchObservation::DefinitelyNotStarted {
                execution,
                dispatch_fence,
                fault,
            } => Ok(Self::DefinitelyNotStarted {
                execution,
                dispatch_fence,
                fault: decode_optional_fault_value(fault, "dispatch observation fault")
                    .map_err(serde::de::Error::custom)?,
            }),
            EncodedDispatchObservation::MayHaveStarted {
                execution,
                dispatch_fence,
                fault,
            } => Ok(Self::MayHaveStarted {
                execution,
                dispatch_fence,
                fault: decode_optional_fault_value(fault, "dispatch observation fault")
                    .map_err(serde::de::Error::custom)?,
            }),
            EncodedDispatchObservation::Running {
                execution,
                dispatch_fence,
            } => Ok(Self::Running {
                execution,
                dispatch_fence,
            }),
            EncodedDispatchObservation::Completed {
                execution,
                dispatch_fence,
                result,
            } => Ok(Self::Completed {
                execution,
                dispatch_fence,
                result,
            }),
            EncodedDispatchObservation::Indeterminate {
                execution,
                dispatch_fence,
                fault,
            } => Ok(Self::Indeterminate {
                execution,
                dispatch_fence,
                fault: decode_optional_fault_value(fault, "dispatch observation fault")
                    .map_err(serde::de::Error::custom)?,
            }),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ExecutionObservation {
    Running {
        execution: ExecutionId,
        dispatch_fence: DispatchFence,
    },
    Completed {
        execution: ExecutionId,
        dispatch_fence: DispatchFence,
        result: ExecutionResult,
    },
    Indeterminate {
        execution: ExecutionId,
        dispatch_fence: DispatchFence,
        fault: Option<EngineFault>,
    },
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum EncodedExecutionObservation {
    Running {
        execution: ExecutionId,
        dispatch_fence: DispatchFence,
    },
    Completed {
        execution: ExecutionId,
        dispatch_fence: DispatchFence,
        result: ExecutionResult,
    },
    Indeterminate {
        execution: ExecutionId,
        dispatch_fence: DispatchFence,
        fault: Option<serde_json::Value>,
    },
}

impl<'de> Deserialize<'de> for ExecutionObservation {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        match EncodedExecutionObservation::deserialize(deserializer)? {
            EncodedExecutionObservation::Running {
                execution,
                dispatch_fence,
            } => Ok(Self::Running {
                execution,
                dispatch_fence,
            }),
            EncodedExecutionObservation::Completed {
                execution,
                dispatch_fence,
                result,
            } => Ok(Self::Completed {
                execution,
                dispatch_fence,
                result,
            }),
            EncodedExecutionObservation::Indeterminate {
                execution,
                dispatch_fence,
                fault,
            } => Ok(Self::Indeterminate {
                execution,
                dispatch_fence,
                fault: decode_optional_fault_value(fault, "execution observation fault")
                    .map_err(serde::de::Error::custom)?,
            }),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum CancelObservation {
    DefinitelyNotStarted {
        execution: ExecutionId,
        dispatch_fence: DispatchFence,
    },
    MayHaveStarted {
        execution: ExecutionId,
        dispatch_fence: DispatchFence,
        fault: Option<EngineFault>,
    },
    Completed {
        execution: ExecutionId,
        dispatch_fence: DispatchFence,
        result: ExecutionResult,
    },
    Indeterminate {
        execution: ExecutionId,
        dispatch_fence: DispatchFence,
        fault: Option<EngineFault>,
    },
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum EncodedCancelObservation {
    DefinitelyNotStarted {
        execution: ExecutionId,
        dispatch_fence: DispatchFence,
    },
    MayHaveStarted {
        execution: ExecutionId,
        dispatch_fence: DispatchFence,
        fault: Option<serde_json::Value>,
    },
    Completed {
        execution: ExecutionId,
        dispatch_fence: DispatchFence,
        result: ExecutionResult,
    },
    Indeterminate {
        execution: ExecutionId,
        dispatch_fence: DispatchFence,
        fault: Option<serde_json::Value>,
    },
}

impl<'de> Deserialize<'de> for CancelObservation {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        match EncodedCancelObservation::deserialize(deserializer)? {
            EncodedCancelObservation::DefinitelyNotStarted {
                execution,
                dispatch_fence,
            } => Ok(Self::DefinitelyNotStarted {
                execution,
                dispatch_fence,
            }),
            EncodedCancelObservation::MayHaveStarted {
                execution,
                dispatch_fence,
                fault,
            } => Ok(Self::MayHaveStarted {
                execution,
                dispatch_fence,
                fault: decode_optional_fault_value(fault, "cancel observation fault")
                    .map_err(serde::de::Error::custom)?,
            }),
            EncodedCancelObservation::Completed {
                execution,
                dispatch_fence,
                result,
            } => Ok(Self::Completed {
                execution,
                dispatch_fence,
                result,
            }),
            EncodedCancelObservation::Indeterminate {
                execution,
                dispatch_fence,
                fault,
            } => Ok(Self::Indeterminate {
                execution,
                dispatch_fence,
                fault: decode_optional_fault_value(fault, "cancel observation fault")
                    .map_err(serde::de::Error::custom)?,
            }),
        }
    }
}
