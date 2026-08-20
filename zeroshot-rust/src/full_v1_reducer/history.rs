use openengine_cluster_protocol::{NodeName, PositiveInteger, WorkerOutcome};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;

pub use crate::native_v2_contract as identity_contract;
pub type ExecutionId = identity_contract::ExecutionId;
pub type NodeInstanceId = identity_contract::NodeInstanceId;

#[derive(Clone, Copy, Debug, Eq, Error, PartialEq)]
pub enum HistoryPositionError {
    #[error("history position is outside the supported range")]
    OutOfRange,
}

/// Ordering token for facts in the history consumed by the reducer.
///
/// Its numeric representation is deliberately local to the reduction boundary. A ledger or
/// event store may translate its own cursor into this type without becoming part of graph
/// semantics.
#[derive(Clone, Copy, Debug, Default, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(transparent)]
pub struct HistoryPosition(u64);

impl HistoryPosition {
    pub const ZERO: Self = Self(0);
    pub const MAX: Self = Self(i64::MAX as u64);

    pub fn new(value: u64) -> Result<Self, HistoryPositionError> {
        if value > Self::MAX.0 {
            return Err(HistoryPositionError::OutOfRange);
        }
        Ok(Self(value))
    }

    #[must_use]
    pub const fn get(self) -> u64 {
        self.0
    }
}

impl<'de> Deserialize<'de> for HistoryPosition {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        Self::new(u64::deserialize(deserializer)?).map_err(serde::de::Error::custom)
    }
}

#[derive(Clone, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct StructuralOccurrence {
    pub node: NodeName,
    pub map_indices: Vec<u64>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionVoidReason {
    ParallelJoin,
    MapTerminal,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub enum DurableExecutionState {
    Active,
    Settled {
        position: HistoryPosition,
        outcome: WorkerOutcome,
    },
    Voided {
        position: HistoryPosition,
        reason: ExecutionVoidReason,
    },
}

/// One normalized execution fact supplied by the supervisor.
///
/// Run ownership and storage details are outside this value: a reducer instance evaluates exactly
/// one verified graph and one run-local history.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct DurableExecution {
    pub dispatch_position: HistoryPosition,
    pub node_instance: NodeInstanceId,
    pub execution: ExecutionId,
    pub occurrence: StructuralOccurrence,
    pub attempt: PositiveInteger,
    pub input: Value,
    pub state: DurableExecutionState,
}
