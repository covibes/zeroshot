//! Pure reduction of verifier-produced full-v1 graphs. It accepts [`VerifiedGraph`] rather than
//! graph syntax or directly constructed IR; `ProductionGraphVerifier` owns shape, type, binding,
//! guard-domain, and bound proofs while reduction applies proven operations in authored order.
//!
//! The supervisor supplies a normalized, run-local execution history. Storage cursors, replay
//! records, mutation authorization, provider processes, workspaces, and scheduling stay outside
//! this module. This makes the same graph algorithm usable by the lean native-v2 run ledger.

use std::collections::{BTreeMap, BTreeSet};

mod history;

pub use history::{
    DurableExecution, DurableExecutionState, ExecutionId, ExecutionVoidReason, HistoryPosition,
    HistoryPositionError, NodeInstanceId, StructuralOccurrence,
};

use openengine_cluster_protocol::{
    ChoiceNode, ControlSelector, ControlSource, DataSelector, FieldPath, GraphNode, Guard, Join,
    EnumLabel, MapNode, NodeName, NodeOutputChannel, ParNode, PositiveInteger, TerminalResult,
    WorkerOutcome, WorkerRef,
};
use openengine_cluster_server::admission::VerifiedGraph;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use thiserror::Error;

#[derive(Clone, Debug)]
pub struct ReductionInput<'a> {
    pub initial_input: &'a Value,
    pub executions: &'a [DurableExecution],
    pub next_node_instance: u64,
    pub next_execution: u64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct PromotedValue {
    pub path: FieldPath,
    pub value: Value,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Decision {
    Dispatch {
        node_instance: NodeInstanceId,
        execution: ExecutionId,
        occurrence: StructuralOccurrence,
        attempt: PositiveInteger,
        worker: WorkerRef,
        input: Value,
    },
    VoidLoser {
        execution: ExecutionId,
        reason: ExecutionVoidReason,
    },
    Continue {
        node: NodeName,
    },
    Promote {
        node: NodeName,
        map_indices: Vec<u64>,
        values: Vec<PromotedValue>,
    },
    Terminal {
        projection: TerminalResult,
    },
}

pub type TerminalProjection = TerminalResult;

#[derive(Clone, Debug, PartialEq)]
pub struct Reduction {
    pub decisions: Vec<Decision>,
    pub terminal: Option<TerminalResult>,
}

impl Reduction {
    pub fn canonical_decision_bytes(&self) -> Result<Vec<u8>, ReducerError> {
        serde_json::to_vec(&self.decisions).map_err(|_| ReducerError::Encoding)
    }
}

#[derive(Clone, Debug, Error, Eq, PartialEq)]
pub enum ReducerError {
    #[error("durable execution history is inconsistent")]
    InconsistentHistory,
    #[error("durable identity is outside the ledger range")]
    IdentityOutOfRange,
    #[error("a proven selector did not resolve in its durable value")]
    MissingSelectedValue,
    #[error("a proven payload operation encountered an unexpected durable value")]
    InvalidDurableValue,
    #[error("a verified choice had no selected residual route")]
    MissingChoiceRoute,
    #[error("decision encoding failed")]
    Encoding,
}

pub struct FullV1Reducer<'a> {
    graph: &'a VerifiedGraph,
    execution_mode: ExecutionMode,
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum ExecutionMode {
    LegacyAttempts,
    NativeV2NoRetry,
}

impl<'a> FullV1Reducer<'a> {
    #[must_use]
    pub const fn new(graph: &'a VerifiedGraph) -> Self {
        Self {
            graph,
            execution_mode: ExecutionMode::LegacyAttempts,
        }
    }

    /// Native-v2 execution: every structural revisit is a fresh execution with attempt one.
    #[must_use]
    pub const fn native_v2(graph: &'a VerifiedGraph) -> Self {
        Self {
            graph,
            execution_mode: ExecutionMode::NativeV2NoRetry,
        }
    }

    pub fn reduce(&self, input: ReductionInput<'_>) -> Result<Reduction, ReducerError> {
        let initial_input = input.initial_input.clone();
        let mut engine = Engine::new(input, &self.graph.compiled_ir.root, self.execution_mode)?;
        let mut context = Context::new(initial_input);
        let status = engine.eval(
            &self.graph.compiled_ir.root,
            &mut context,
            Traversal {
                map_indices: &[],
                item: None,
                mode: EvalMode::Decide,
                cutoff: HistoryPosition::MAX,
            },
        )?;
        engine.ensure_history_consumed()?;
        engine.canonicalize_void_decisions();
        let terminal = match status {
            Status::Terminal { projection, .. } => Some(projection),
            Status::Continue { .. } | Status::Pending => None,
        };
        if let Some(projection) = terminal.clone() {
            engine.decisions.push(Decision::Terminal { projection });
        }
        Ok(Reduction {
            decisions: engine.decisions,
            terminal,
        })
    }
}

fn attempts_exhausted_reason() -> Result<EnumLabel, ReducerError> {
    EnumLabel::new("attempts_exhausted").map_err(|_| ReducerError::InconsistentHistory)
}

#[derive(Clone)]
struct Channels {
    output: Value,
    signals: BTreeMap<String, String>,
    diagnostic: Option<Value>,
}

#[derive(Clone)]
struct Context {
    state: Value,
    controls: BTreeMap<ControlKey, String>,
    channels: BTreeMap<(NodeName, Vec<u64>), Channels>,
}

impl Context {
    fn new(state: Value) -> Self {
        Self {
            state,
            controls: BTreeMap::new(),
            channels: BTreeMap::new(),
        }
    }
}

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
struct ControlKey {
    node: NodeName,
    source: ControlSource,
    field: Option<String>,
    map_indices: Vec<u64>,
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum EvalMode {
    Decide,
    Probe,
}

#[derive(Clone, Copy)]
struct Traversal<'a> {
    map_indices: &'a [u64],
    item: Option<&'a Value>,
    mode: EvalMode,
    cutoff: HistoryPosition,
}

struct ExecutableSpec<'a> {
    name: &'a NodeName,
    worker: &'a WorkerRef,
    input_bindings: &'a [openengine_cluster_protocol::InputBinding],
    write_bindings: &'a [openengine_cluster_protocol::WriteBinding],
    attempt_ceiling: PositiveInteger,
    verifier: bool,
}

struct ControlUpdate<'a> {
    node: &'a NodeName,
    source: ControlSource,
    field: Option<&'a str>,
    label: &'a str,
    map_indices: &'a [u64],
}

struct GroupControlUpdate<'a> {
    node: &'a NodeName,
    field: &'a str,
    label: &'a str,
    map_indices: &'a [u64],
}

struct MapVoidScope<'a> {
    common: VoidScope<'a>,
    winner_scope: &'a [u64],
}

struct VoidScope<'a> {
    map_indices: &'a [u64],
    cutoff: HistoryPosition,
    reason: ExecutionVoidReason,
    emit_decisions: bool,
}

struct WriteApplication<'a> {
    name: &'a NodeName,
    output: &'a Value,
    signals: Option<
        &'a BTreeMap<
            openengine_cluster_protocol::FieldName,
            openengine_cluster_protocol::EnumLabel,
        >,
    >,
    diagnostic: Option<&'a Value>,
    bindings: &'a [openengine_cluster_protocol::WriteBinding],
    map_indices: &'a [u64],
}

struct PromotionRequest<'a> {
    node: &'a NodeName,
    map_indices: &'a [u64],
    paths: &'a [FieldPath],
    local: &'a Context,
    parent: &'a mut Context,
    mode: EvalMode,
    decisions: &'a mut Vec<Decision>,
}

#[derive(Clone)]
enum Status {
    Pending,
    Continue {
        position: HistoryPosition,
    },
    Terminal {
        position: HistoryPosition,
        projection: TerminalProjection,
    },
}

impl Status {
    fn continuing(position: HistoryPosition) -> Self {
        Self::Continue { position }
    }

    fn position(&self) -> HistoryPosition {
        match self {
            Self::Pending => HistoryPosition::MAX,
            Self::Continue { position } | Self::Terminal { position, .. } => *position,
        }
    }

    fn after(self, prior: HistoryPosition) -> Self {
        match self {
            Self::Terminal {
                position,
                projection,
            } => Self::Terminal {
                position: position.max(prior),
                projection,
            },
            other => other,
        }
    }
}

#[derive(Clone, Copy)]
struct VoidCutoff {
    position: HistoryPosition,
    reason: ExecutionVoidReason,
}

struct Engine<'a> {
    executions: &'a [DurableExecution],
    next_node_instance: u64,
    next_execution: u64,
    decisions: Vec<Decision>,
    map_depths: BTreeMap<NodeName, usize>,
    consumed_executions: BTreeSet<ExecutionId>,
    void_cutoffs: BTreeMap<ExecutionId, VoidCutoff>,
    execution_mode: ExecutionMode,
}

impl<'a> Engine<'a> {
    fn new(
        input: ReductionInput<'a>,
        root: &GraphNode,
        execution_mode: ExecutionMode,
    ) -> Result<Self, ReducerError> {
        validate_history_for_mode(input.executions, execution_mode)?;
        let mut map_depths = BTreeMap::new();
        collect_map_depths(root, 0, &mut map_depths);
        let mut executable_depths = BTreeMap::new();
        collect_executable_depths(root, 0, &mut executable_depths);
        if input.executions.iter().any(|execution| {
            execution.execution.get() >= input.next_execution
                || execution.node_instance.get() >= input.next_node_instance
                || executable_depths
                    .get(&execution.occurrence.node)
                    .is_none_or(|depth| *depth != execution.occurrence.map_indices.len())
        }) {
            return Err(ReducerError::InconsistentHistory);
        }
        Ok(Self {
            executions: input.executions,
            next_node_instance: input.next_node_instance,
            next_execution: input.next_execution,
            decisions: Vec::new(),
            map_depths,
            consumed_executions: BTreeSet::new(),
            void_cutoffs: BTreeMap::new(),
            execution_mode,
        })
    }

    fn ensure_history_consumed(&self) -> Result<(), ReducerError> {
        if self.executions.iter().all(|execution| {
            self.consumed_executions.contains(&execution.execution)
                && match &execution.state {
                    DurableExecutionState::Voided { position, reason } => self
                        .void_cutoffs
                        .get(&execution.execution)
                        .is_some_and(|cutoff| {
                            *position > cutoff.position && *reason == cutoff.reason
                        }),
                    DurableExecutionState::Active | DurableExecutionState::Settled { .. } => true,
                }
        }) {
            Ok(())
        } else {
            Err(ReducerError::InconsistentHistory)
        }
    }

    fn push_void_decision(&mut self, execution: ExecutionId, reason: ExecutionVoidReason) {
        if !self.decisions.iter().any(|decision| {
            matches!(
                decision,
                Decision::VoidLoser {
                    execution: existing,
                    ..
                } if *existing == execution
            )
        }) {
            self.decisions
                .push(Decision::VoidLoser { execution, reason });
        }
    }

    fn canonicalize_void_decisions(&mut self) {
        let mut unique_voids = BTreeSet::new();
        self.decisions.retain(|decision| match decision {
            Decision::VoidLoser { execution, .. } => unique_voids.insert(*execution),
            _ => true,
        });
        let mut slots = Vec::new();
        let mut voids = Vec::new();
        for (index, decision) in self.decisions.iter().enumerate() {
            if let Decision::VoidLoser { execution, .. } = decision {
                let position = self
                    .executions
                    .iter()
                    .find(|candidate| candidate.execution == *execution)
                    .map_or(HistoryPosition::MAX, |candidate| {
                        candidate.dispatch_position
                    });
                slots.push(index);
                voids.push((position, *execution, decision.clone()));
            }
        }
        voids.sort_by_key(|(position, execution, _)| (*position, *execution));
        for (index, (_, _, decision)) in slots.into_iter().zip(voids) {
            let Some(slot) = self.decisions.get_mut(index) else {
                continue;
            };
            *slot = decision;
        }
    }

    // Executable evaluation lives in the evaluation companion module.
}

mod control;
mod evaluation;
mod groups;
mod values;
use values::*;
