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

fn attempts_exhausted_reason() -> EnumLabel {
    EnumLabel::new("attempts_exhausted").expect("fixed terminal reason must be a valid enum label")
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
            self.decisions[index] = decision;
        }
    }

    fn eval(
        &mut self,
        node: &GraphNode,
        context: &mut Context,
        traversal: Traversal<'_>,
    ) -> Result<Status, ReducerError> {
        match node {
            GraphNode::Step(step) => self.eval_executable(
                ExecutableSpec {
                    name: &step.name,
                    worker: &step.worker,
                    input_bindings: &step.input_bindings,
                    write_bindings: &step.write_bindings,
                    attempt_ceiling: step.attempts,
                    verifier: false,
                },
                context,
                traversal,
            ),
            GraphNode::Verifier(verifier) => self.eval_executable(
                ExecutableSpec {
                    name: &verifier.name,
                    worker: &verifier.worker,
                    input_bindings: &verifier.input_bindings,
                    write_bindings: &verifier.write_bindings,
                    attempt_ceiling: verifier.attempts,
                    verifier: true,
                },
                context,
                traversal,
            ),
            GraphNode::Seq(group) => {
                let mut local = context.clone();
                let mut position = HistoryPosition::ZERO;
                for child in group.children.as_slice() {
                    match self.eval(child, &mut local, traversal)? {
                        Status::Continue {
                            position: child_position,
                        } => {
                            position = position.max(child_position);
                        }
                        other => return Ok(other.after(position)),
                    }
                }
                promote(PromotionRequest {
                    node: &group.name,
                    map_indices: traversal.map_indices,
                    paths: &group.promoted_state_paths,
                    local: &local,
                    parent: context,
                    mode: traversal.mode,
                    decisions: &mut self.decisions,
                })?;
                self.continue_decision(&group.name, traversal.mode);
                Ok(Status::Continue { position })
            }
            GraphNode::Choice(group) => self.eval_choice(group, context, traversal),
            GraphNode::Par(group) => self.eval_parallel(group, context, traversal),
            GraphNode::Loop(group) => {
                let mut local = context.clone();
                let mut position = HistoryPosition::ZERO;
                for _iteration in 1..=group.max_iterations.get() {
                    match self.eval(&group.body, &mut local, traversal)? {
                        Status::Continue {
                            position: body_position,
                        } => {
                            position = position.max(body_position);
                        }
                        other => return Ok(other.after(position)),
                    }
                    if self.guard(&group.until, &local, traversal.map_indices)? {
                        self.set_group_control(
                            &mut local,
                            GroupControlUpdate {
                                node: &group.name,
                                field: "terminated",
                                label: "converged",
                                map_indices: traversal.map_indices,
                            },
                        );
                        promote(PromotionRequest {
                            node: &group.name,
                            map_indices: traversal.map_indices,
                            paths: &group.promoted_state_paths,
                            local: &local,
                            parent: context,
                            mode: traversal.mode,
                            decisions: &mut self.decisions,
                        })?;
                        self.continue_decision(&group.name, traversal.mode);
                        return Ok(Status::Continue { position });
                    }
                }
                self.set_group_control(
                    &mut local,
                    GroupControlUpdate {
                        node: &group.name,
                        field: "terminated",
                        label: "exhausted",
                        map_indices: traversal.map_indices,
                    },
                );
                promote(PromotionRequest {
                    node: &group.name,
                    map_indices: traversal.map_indices,
                    paths: &group.promoted_state_paths,
                    local: &local,
                    parent: context,
                    mode: traversal.mode,
                    decisions: &mut self.decisions,
                })?;
                self.continue_decision(&group.name, traversal.mode);
                Ok(Status::Continue { position })
            }
            GraphNode::Map(group) => self.eval_map(group, context, traversal),
            GraphNode::Succeed(terminal) => {
                let output = bind_payload(&terminal.bindings, &context.state, traversal.item)?;
                Ok(Status::Terminal {
                    position: HistoryPosition::ZERO,
                    projection: TerminalProjection::Succeeded { output },
                })
            }
            GraphNode::Fail(terminal) => Ok(Status::Terminal {
                position: HistoryPosition::ZERO,
                projection: TerminalProjection::Failed {
                    reason: terminal.reason.as_label().clone(),
                },
            }),
        }
    }

    fn eval_executable(
        &mut self,
        spec: ExecutableSpec<'_>,
        context: &mut Context,
        traversal: Traversal<'_>,
    ) -> Result<Status, ReducerError> {
        let ExecutableSpec {
            name,
            worker,
            input_bindings,
            write_bindings,
            attempt_ceiling,
            verifier,
        } = spec;
        let Traversal {
            map_indices,
            item,
            mode,
            cutoff,
        } = traversal;
        let occurrence = StructuralOccurrence {
            node: name.clone(),
            map_indices: map_indices.to_vec(),
        };
        let mut matching = self
            .executions
            .iter()
            .filter(|execution| execution.occurrence == occurrence)
            .collect::<Vec<_>>();
        let visit = next_visit(name, map_indices, &context.controls);
        let (attempt, existing) = match self.execution_mode {
            ExecutionMode::LegacyAttempts => {
                matching.sort_by_key(|execution| execution.attempt);
                let attempt =
                    PositiveInteger::new(visit).map_err(|_| ReducerError::InconsistentHistory)?;
                if attempt.get() > attempt_ceiling.get() {
                    return Ok(Status::Terminal {
                        position: HistoryPosition::ZERO,
                        projection: TerminalProjection::Failed {
                            reason: attempts_exhausted_reason(),
                        },
                    });
                }
                let existing = matching
                    .iter()
                    .find(|execution| execution.attempt == attempt)
                    .copied();
                (attempt, existing)
            }
            ExecutionMode::NativeV2NoRetry => {
                matching.sort_by_key(|execution| execution.dispatch_position);
                let attempt =
                    PositiveInteger::new(1).map_err(|_| ReducerError::InconsistentHistory)?;
                let index =
                    usize::try_from(visit - 1).map_err(|_| ReducerError::IdentityOutOfRange)?;
                (attempt, matching.get(index).copied())
            }
        };
        let input = bind_payload(input_bindings, &context.state, item)?;
        if let Some(execution) = existing {
            self.consumed_executions.insert(execution.execution);
        }
        mark_visit(name, map_indices, &mut context.controls, visit);
        let Some(execution) = existing else {
            if mode == EvalMode::Probe || cutoff != HistoryPosition::MAX {
                return Ok(Status::Pending);
            }
            let node_instance = if let Some(previous) = matching.last().copied() {
                previous.node_instance
            } else {
                let allocated = NodeInstanceId::new(self.next_node_instance)
                    .map_err(|_| ReducerError::IdentityOutOfRange)?;
                self.next_node_instance = self
                    .next_node_instance
                    .checked_add(1)
                    .ok_or(ReducerError::IdentityOutOfRange)?;
                allocated
            };
            let execution = ExecutionId::new(self.next_execution)
                .map_err(|_| ReducerError::IdentityOutOfRange)?;
            self.next_execution = self
                .next_execution
                .checked_add(1)
                .ok_or(ReducerError::IdentityOutOfRange)?;
            self.decisions.push(Decision::Dispatch {
                node_instance,
                execution,
                occurrence,
                attempt,
                worker: worker.clone(),
                input,
            });
            return Ok(Status::Pending);
        };
        if execution.dispatch_position > cutoff || execution.input != input {
            return if execution.dispatch_position > cutoff {
                Ok(Status::Pending)
            } else {
                Err(ReducerError::InconsistentHistory)
            };
        }
        let DurableExecutionState::Settled { position, outcome } = &execution.state else {
            return Ok(Status::Pending);
        };
        if *position > cutoff {
            return Ok(Status::Pending);
        }
        let promoted_bindings = match outcome {
            WorkerOutcome::Error { code, .. } => {
                self.set_control(
                    context,
                    ControlUpdate {
                        node: name,
                        source: ControlSource::Error,
                        field: None,
                        label: code.as_str(),
                        map_indices,
                    },
                );
                &[]
            }
            WorkerOutcome::Verified { output, .. } if !verifier => {
                apply_writes(
                    context,
                    WriteApplication {
                        name,
                        output,
                        signals: None,
                        diagnostic: None,
                        bindings: write_bindings,
                        map_indices,
                    },
                )?;
                write_bindings
            }
            WorkerOutcome::Verifier {
                output,
                signals,
                diagnostic,
                ..
            } if verifier => {
                for (field, label) in signals {
                    self.set_control(
                        context,
                        ControlUpdate {
                            node: name,
                            source: ControlSource::Signal,
                            field: Some(field.as_str()),
                            label: label.as_str(),
                            map_indices,
                        },
                    );
                }
                apply_writes(
                    context,
                    WriteApplication {
                        name,
                        output,
                        signals: Some(signals),
                        diagnostic: Some(diagnostic),
                        bindings: write_bindings,
                        map_indices,
                    },
                )?;
                write_bindings
            }
            _ => return Err(ReducerError::InconsistentHistory),
        };
        if mode == EvalMode::Decide && !promoted_bindings.is_empty() {
            let values = promoted_bindings
                .iter()
                .map(|binding| {
                    Ok(PromotedValue {
                        path: binding.target.clone(),
                        value: select(&context.state, &binding.target)?.clone(),
                    })
                })
                .collect::<Result<Vec<_>, ReducerError>>()?;
            self.decisions.push(Decision::Promote {
                node: name.clone(),
                map_indices: map_indices.to_vec(),
                values,
            });
        }
        self.continue_decision(name, mode);
        Ok(Status::continuing(*position))
    }

    fn eval_choice(
        &mut self,
        group: &ChoiceNode,
        context: &mut Context,
        traversal: Traversal<'_>,
    ) -> Result<Status, ReducerError> {
        let mut local = context.clone();
        let selected = group
            .branches
            .as_slice()
            .iter()
            .find(|branch| {
                self.guard(&branch.when, &local, traversal.map_indices)
                    .unwrap_or(false)
            })
            .map(|branch| &branch.node)
            .or(group.otherwise.as_deref())
            .ok_or(ReducerError::MissingChoiceRoute)?;
        let status = self.eval(selected, &mut local, traversal)?;
        if let Status::Continue { position } = status {
            promote(PromotionRequest {
                node: &group.name,
                map_indices: traversal.map_indices,
                paths: &group.promoted_state_paths,
                local: &local,
                parent: context,
                mode: traversal.mode,
                decisions: &mut self.decisions,
            })?;
            merge_runtime_facts(&local, context);
            self.continue_decision(&group.name, traversal.mode);
            Ok(Status::Continue { position })
        } else {
            Ok(status)
        }
    }

    fn eval_parallel(
        &mut self,
        group: &ParNode,
        context: &mut Context,
        traversal: Traversal<'_>,
    ) -> Result<Status, ReducerError> {
        let mut probes = Vec::new();
        for branch in group.branches.as_slice() {
            let mut branch_context = context.clone();
            probes.push((
                self.eval(
                    branch,
                    &mut branch_context,
                    Traversal {
                        mode: EvalMode::Probe,
                        ..traversal
                    },
                )?,
                branch_context,
            ));
        }
        let completion_indices = probes
            .iter()
            .enumerate()
            .filter_map(|(index, (status, branch_context))| match status {
                Status::Continue { position }
                    if !matches!(group.join, Join::First { ref when } if !self.guard(when, branch_context, traversal.map_indices).unwrap_or(false)) =>
                {
                    Some((index, *position))
                }
                _ => None,
            })
            .collect::<Vec<_>>();
        let required = match group.join {
            Join::All {} => probes.len(),
            Join::Any {} | Join::First { .. } => 1,
            Join::Quorum { count } => count.get() as usize,
        };
        let mut ordered = completion_indices;
        ordered.sort_by_key(|(index, position)| (*position, *index));
        let settled = probes
            .iter()
            .all(|(status, _)| !matches!(status, Status::Pending));
        if ordered.len() < required {
            if !settled {
                if traversal.mode == EvalMode::Decide {
                    for branch in group.branches.as_slice() {
                        let mut branch_context = context.clone();
                        let _ = self.eval(branch, &mut branch_context, traversal)?;
                    }
                }
                return Ok(Status::Pending);
            }
            let field = if matches!(group.join, Join::First { .. }) {
                "raced"
            } else {
                "joined"
            };
            let label = if matches!(group.join, Join::First { .. }) {
                "no_satisfier"
            } else {
                "quorum_unreachable"
            };
            self.set_group_control(
                context,
                GroupControlUpdate {
                    node: &group.name,
                    field,
                    label,
                    map_indices: traversal.map_indices,
                },
            );
            self.continue_decision(&group.name, traversal.mode);
            return Ok(Status::Continue {
                position: probes
                    .iter()
                    .map(|(status, _)| status.position())
                    .filter(|position| *position != HistoryPosition::MAX)
                    .max()
                    .unwrap_or(HistoryPosition::ZERO),
            });
        }
        let winners = ordered.into_iter().take(required).collect::<Vec<_>>();
        let join_position = winners
            .iter()
            .map(|(_, position)| *position)
            .max()
            .unwrap_or(HistoryPosition::ZERO);
        let winner_set = winners
            .iter()
            .map(|(index, _)| *index)
            .collect::<BTreeSet<_>>();
        let mut joined = context.clone();
        for (index, _) in &winners {
            let mut branch_context = context.clone();
            let status = self.eval(
                &group.branches.as_slice()[*index],
                &mut branch_context,
                Traversal {
                    cutoff: join_position,
                    ..traversal
                },
            )?;
            if !matches!(status, Status::Continue { .. }) {
                return Err(ReducerError::InconsistentHistory);
            }
            for path in &group.promoted_state_paths {
                let value = select(&branch_context.state, path)?.clone();
                set_path(&mut joined.state, path, value)?;
            }
            merge_runtime_facts(&branch_context, &mut joined);
        }
        if traversal.mode == EvalMode::Decide && !group.promoted_state_paths.is_empty() {
            let values = group
                .promoted_state_paths
                .iter()
                .map(|path| {
                    Ok(PromotedValue {
                        path: path.clone(),
                        value: select(&joined.state, path)?.clone(),
                    })
                })
                .collect::<Result<Vec<_>, ReducerError>>()?;
            self.decisions.push(Decision::Promote {
                node: group.name.clone(),
                map_indices: traversal.map_indices.to_vec(),
                values,
            });
        }
        *context = joined;
        let (field, label) = if matches!(group.join, Join::First { .. }) {
            ("raced", "satisfied")
        } else {
            ("joined", "reached")
        };
        self.set_group_control(
            context,
            GroupControlUpdate {
                node: &group.name,
                field,
                label,
                map_indices: traversal.map_indices,
            },
        );
        if required < probes.len() {
            for (index, branch) in group.branches.as_slice().iter().enumerate() {
                if !winner_set.contains(&index) {
                    self.void_active_descendants(
                        branch,
                        VoidScope {
                            map_indices: traversal.map_indices,
                            cutoff: join_position,
                            reason: ExecutionVoidReason::ParallelJoin,
                            emit_decisions: traversal.mode == EvalMode::Decide,
                        },
                    );
                }
            }
        }
        self.continue_decision(&group.name, traversal.mode);
        Ok(Status::Continue {
            position: join_position,
        })
    }

    fn eval_map(
        &mut self,
        group: &MapNode,
        context: &mut Context,
        traversal: Traversal<'_>,
    ) -> Result<Status, ReducerError> {
        let selected = select_data(&group.over, &context.state, traversal.item)?;
        let items = selected
            .as_array()
            .ok_or(ReducerError::InvalidDurableValue)?;
        if items.len() as u64 > group.max_items.get() {
            self.set_group_control(
                context,
                GroupControlUpdate {
                    node: &group.name,
                    field: "overflow",
                    label: "overflow",
                    map_indices: traversal.map_indices,
                },
            );
            self.continue_decision(&group.name, traversal.mode);
            return Ok(Status::Continue {
                position: HistoryPosition::ZERO,
            });
        }

        let mut probe_results = Vec::with_capacity(items.len());
        for (index, item_value) in items.iter().enumerate() {
            let mut scope = traversal.map_indices.to_vec();
            scope.push(index as u64);
            let mut item_context = context.clone();
            let status = self.eval(
                &group.body,
                &mut item_context,
                Traversal {
                    map_indices: &scope,
                    item: Some(item_value),
                    mode: EvalMode::Probe,
                    ..traversal
                },
            )?;
            probe_results.push((status, item_context, scope));
        }
        if let Some((terminal_index, terminal)) = probe_results
            .iter()
            .enumerate()
            .filter_map(|(index, (status, _, _))| match status {
                Status::Terminal { position, .. } => Some((index, *position, status.clone())),
                _ => None,
            })
            .min_by_key(|(index, position, _)| (*position, *index))
            .map(|(index, _, status)| (index, status))
        {
            let terminal_scope = &probe_results[terminal_index].2;
            if traversal.mode == EvalMode::Decide {
                let mut terminal_context = context.clone();
                let terminal = self.eval(
                    &group.body,
                    &mut terminal_context,
                    Traversal {
                        map_indices: terminal_scope,
                        item: Some(&items[terminal_index]),
                        cutoff: terminal.position(),
                        ..traversal
                    },
                )?;
                self.void_map_losers(
                    &group.body,
                    MapVoidScope {
                        common: VoidScope {
                            map_indices: traversal.map_indices,
                            cutoff: terminal.position(),
                            reason: ExecutionVoidReason::MapTerminal,
                            emit_decisions: true,
                        },
                        winner_scope: terminal_scope,
                    },
                );
                return Ok(terminal);
            }
            self.void_map_losers(
                &group.body,
                MapVoidScope {
                    common: VoidScope {
                        map_indices: traversal.map_indices,
                        cutoff: terminal.position(),
                        reason: ExecutionVoidReason::MapTerminal,
                        emit_decisions: false,
                    },
                    winner_scope: terminal_scope,
                },
            );
            return Ok(terminal);
        }

        let item_results = if traversal.mode == EvalMode::Probe {
            probe_results
        } else {
            let mut decisions = Vec::with_capacity(items.len());
            for (index, item_value) in items.iter().enumerate() {
                let mut scope = traversal.map_indices.to_vec();
                scope.push(index as u64);
                let mut item_context = context.clone();
                let status = self.eval(
                    &group.body,
                    &mut item_context,
                    Traversal {
                        map_indices: &scope,
                        item: Some(item_value),
                        ..traversal
                    },
                )?;
                decisions.push((status, item_context, scope));
            }
            decisions
        };
        if item_results
            .iter()
            .any(|(status, _, _)| matches!(status, Status::Pending))
        {
            return Ok(Status::Pending);
        }
        let mut local = context.clone();
        for path in &group.promoted_state_paths {
            let mut values = Vec::with_capacity(item_results.len());
            for (_, item_context, _) in &item_results {
                values.push(select(&item_context.state, path)?.clone());
            }
            let value = Value::Array(values);
            set_path(&mut local.state, path, value.clone())?;
        }
        self.set_group_control(
            &mut local,
            GroupControlUpdate {
                node: &group.name,
                field: "overflow",
                label: "ok",
                map_indices: traversal.map_indices,
            },
        );
        promote(PromotionRequest {
            node: &group.name,
            map_indices: traversal.map_indices,
            paths: &group.promoted_state_paths,
            local: &local,
            parent: context,
            mode: traversal.mode,
            decisions: &mut self.decisions,
        })?;
        for (_, item_context, _) in &item_results {
            merge_runtime_facts(item_context, context);
        }
        self.continue_decision(&group.name, traversal.mode);
        Ok(Status::Continue {
            position: item_results
                .iter()
                .map(|(status, _, _)| status.position())
                .max()
                .unwrap_or(HistoryPosition::ZERO),
        })
    }

    fn guard(
        &self,
        guard: &Guard,
        context: &Context,
        map_indices: &[u64],
    ) -> Result<bool, ReducerError> {
        match guard {
            Guard::In { value, labels } => Ok(self
                .control_values(value, context, map_indices)
                .iter()
                .any(|actual| labels.values().iter().any(|label| label.as_str() == actual))),
            Guard::All { guards } => guards.as_slice().iter().try_fold(true, |matches, guard| {
                Ok(matches && self.guard(guard, context, map_indices)?)
            }),
            Guard::Any { guards } => guards.as_slice().iter().try_fold(false, |matches, guard| {
                Ok(matches || self.guard(guard, context, map_indices)?)
            }),
            Guard::Not { guard } => Ok(!self.guard(guard, context, map_indices)?),
            Guard::KOfN {
                count,
                values,
                labels,
            } => Ok(values
                .as_slice()
                .iter()
                .filter(|selector| {
                    self.control_values(selector, context, map_indices)
                        .iter()
                        .any(|actual| labels.values().iter().any(|label| label.as_str() == actual))
                })
                .count() as u64
                >= count.get()),
            Guard::KOfMap {
                count,
                value,
                labels,
            } => Ok(self
                .control_values(value, context, map_indices)
                .iter()
                .filter(|actual| {
                    labels
                        .values()
                        .iter()
                        .any(|label| label.as_str() == *actual)
                })
                .count() as u64
                >= count.get()),
        }
    }

    fn control_values(
        &self,
        selector: &ControlSelector,
        context: &Context,
        map_indices: &[u64],
    ) -> Vec<String> {
        let depth = self.map_depths.get(&selector.name).copied().unwrap_or(0);
        let aggregate = depth > map_indices.len();
        context
            .controls
            .iter()
            .filter(|(key, _)| {
                key.node == selector.name
                    && key.source == selector.source
                    && key.field.as_deref() == selector.field.as_ref().map(|field| field.as_str())
                    && if aggregate {
                        key.map_indices.starts_with(map_indices) && key.map_indices.len() == depth
                    } else {
                        key.map_indices == map_indices[..depth]
                    }
            })
            .map(|(_, value)| value.clone())
            .collect()
    }

    fn set_control(&self, context: &mut Context, update: ControlUpdate<'_>) {
        let depth = self.map_depths.get(update.node).copied().unwrap_or(0);
        context.controls.insert(
            ControlKey {
                node: update.node.clone(),
                source: update.source,
                field: update.field.map(str::to_owned),
                map_indices: update.map_indices[..depth].to_vec(),
            },
            update.label.to_owned(),
        );
    }

    fn set_group_control(&self, context: &mut Context, update: GroupControlUpdate<'_>) {
        self.set_control(
            context,
            ControlUpdate {
                node: update.node,
                source: ControlSource::Group,
                field: Some(update.field),
                label: update.label,
                map_indices: update.map_indices,
            },
        );
    }

    fn continue_decision(&mut self, node: &NodeName, mode: EvalMode) {
        if mode == EvalMode::Decide {
            self.decisions
                .push(Decision::Continue { node: node.clone() });
        }
    }

    fn record_void_cutoff(
        &mut self,
        execution: ExecutionId,
        position: HistoryPosition,
        reason: ExecutionVoidReason,
    ) -> ExecutionVoidReason {
        let cutoff = self
            .void_cutoffs
            .entry(execution)
            .or_insert(VoidCutoff { position, reason });
        if position < cutoff.position {
            *cutoff = VoidCutoff { position, reason };
        }
        cutoff.reason
    }

    fn void_active_descendants(&mut self, node: &GraphNode, scope: VoidScope<'_>) {
        let descendants = descendant_names(node);
        let mut losers = self
            .executions
            .iter()
            .filter(|execution| {
                self.consumed_executions.contains(&execution.execution)
                    && descendants.contains(&execution.occurrence.node)
                    && execution
                        .occurrence
                        .map_indices
                        .starts_with(scope.map_indices)
                    && !matches!(execution.state, DurableExecutionState::Settled { .. })
            })
            .map(|execution| {
                (
                    execution.dispatch_position,
                    execution.execution,
                    matches!(execution.state, DurableExecutionState::Active),
                )
            })
            .collect::<Vec<_>>();
        losers.sort_unstable();
        for (_, execution, active) in losers {
            let reason = self.record_void_cutoff(execution, scope.cutoff, scope.reason);
            if active && scope.emit_decisions {
                self.push_void_decision(execution, reason);
            }
        }
    }

    fn void_map_losers(&mut self, body: &GraphNode, scope: MapVoidScope<'_>) {
        let descendants = descendant_names(body);
        let mut losers = self
            .executions
            .iter()
            .filter(|execution| {
                self.consumed_executions.contains(&execution.execution)
                    && descendants.contains(&execution.occurrence.node)
                    && execution
                        .occurrence
                        .map_indices
                        .starts_with(scope.common.map_indices)
                    && !execution
                        .occurrence
                        .map_indices
                        .starts_with(scope.winner_scope)
                    && !matches!(execution.state, DurableExecutionState::Settled { .. })
            })
            .map(|execution| {
                (
                    execution.dispatch_position,
                    execution.execution,
                    matches!(execution.state, DurableExecutionState::Active),
                )
            })
            .collect::<Vec<_>>();
        losers.sort_unstable();
        for (_, execution, active) in losers {
            let reason =
                self.record_void_cutoff(execution, scope.common.cutoff, scope.common.reason);
            if active && scope.common.emit_decisions {
                self.push_void_decision(execution, reason);
            }
        }
    }
}

fn collect_map_depths(node: &GraphNode, depth: usize, depths: &mut BTreeMap<NodeName, usize>) {
    depths.insert(node.name().clone(), depth);
    match node {
        GraphNode::Seq(group) => {
            for child in group.children.as_slice() {
                collect_map_depths(child, depth, depths);
            }
        }
        GraphNode::Choice(group) => {
            for branch in group.branches.as_slice() {
                collect_map_depths(&branch.node, depth, depths);
            }
            if let Some(otherwise) = &group.otherwise {
                collect_map_depths(otherwise, depth, depths);
            }
        }
        GraphNode::Par(group) => {
            for branch in group.branches.as_slice() {
                collect_map_depths(branch, depth, depths);
            }
        }
        GraphNode::Loop(group) => collect_map_depths(&group.body, depth, depths),
        GraphNode::Map(group) => collect_map_depths(&group.body, depth + 1, depths),
        GraphNode::Step(_)
        | GraphNode::Verifier(_)
        | GraphNode::Succeed(_)
        | GraphNode::Fail(_) => {}
    }
}

fn collect_executable_depths(
    node: &GraphNode,
    depth: usize,
    depths: &mut BTreeMap<NodeName, usize>,
) {
    match node {
        GraphNode::Step(_) | GraphNode::Verifier(_) => {
            depths.insert(node.name().clone(), depth);
        }
        GraphNode::Seq(group) => {
            for child in group.children.as_slice() {
                collect_executable_depths(child, depth, depths);
            }
        }
        GraphNode::Choice(group) => {
            for branch in group.branches.as_slice() {
                collect_executable_depths(&branch.node, depth, depths);
            }
            if let Some(otherwise) = &group.otherwise {
                collect_executable_depths(otherwise, depth, depths);
            }
        }
        GraphNode::Par(group) => {
            for branch in group.branches.as_slice() {
                collect_executable_depths(branch, depth, depths);
            }
        }
        GraphNode::Loop(group) => collect_executable_depths(&group.body, depth, depths),
        GraphNode::Map(group) => collect_executable_depths(&group.body, depth + 1, depths),
        GraphNode::Succeed(_) | GraphNode::Fail(_) => {}
    }
}

fn validate_history_for_mode(
    executions: &[DurableExecution],
    execution_mode: ExecutionMode,
) -> Result<(), ReducerError> {
    let mut visit_identities = HistoryVisitIdentities::default();
    let mut instances = BTreeMap::new();
    let mut inverse_instances = BTreeMap::new();
    for execution in executions {
        visit_identities.validate(execution, execution_mode)?;
        validate_instance_lineage(execution, &mut instances, &mut inverse_instances)?;
    }
    if execution_mode == ExecutionMode::LegacyAttempts {
        for occurrence in instances.keys() {
            let mut values = executions
                .iter()
                .filter(|execution| &execution.occurrence == occurrence)
                .map(|execution| execution.attempt.get())
                .collect::<Vec<_>>();
            values.sort_unstable();
            if values.iter().copied().ne(1..=values.len() as u64) {
                return Err(ReducerError::InconsistentHistory);
            }
        }
    }
    Ok(())
}

#[derive(Default)]
struct HistoryVisitIdentities {
    ids: BTreeSet<ExecutionId>,
    attempts: BTreeSet<(StructuralOccurrence, PositiveInteger)>,
    visits: BTreeSet<(StructuralOccurrence, HistoryPosition)>,
}

impl HistoryVisitIdentities {
    fn validate(
        &mut self,
        execution: &DurableExecution,
        execution_mode: ExecutionMode,
    ) -> Result<(), ReducerError> {
        let valid_visit = match execution_mode {
            ExecutionMode::LegacyAttempts => self
                .attempts
                .insert((execution.occurrence.clone(), execution.attempt)),
            ExecutionMode::NativeV2NoRetry => {
                execution.attempt.get() == 1
                    && self
                        .visits
                        .insert((execution.occurrence.clone(), execution.dispatch_position))
            }
        };
        if self.ids.insert(execution.execution) && valid_visit {
            Ok(())
        } else {
            Err(ReducerError::InconsistentHistory)
        }
    }
}

fn validate_instance_lineage(
    execution: &DurableExecution,
    instances: &mut BTreeMap<StructuralOccurrence, NodeInstanceId>,
    inverse_instances: &mut BTreeMap<NodeInstanceId, StructuralOccurrence>,
) -> Result<(), ReducerError> {
    if instances
        .insert(execution.occurrence.clone(), execution.node_instance)
        .is_some_and(|existing| existing != execution.node_instance)
        || inverse_instances
            .insert(execution.node_instance, execution.occurrence.clone())
            .is_some_and(|existing| existing != execution.occurrence)
    {
        return Err(ReducerError::InconsistentHistory);
    }
    Ok(())
}

fn visit_key(name: &NodeName, map_indices: &[u64]) -> ControlKey {
    ControlKey {
        node: name.clone(),
        source: ControlSource::Group,
        field: Some("__reducer_visit".to_owned()),
        map_indices: map_indices.to_vec(),
    }
}

fn next_visit(
    name: &NodeName,
    map_indices: &[u64],
    controls: &BTreeMap<ControlKey, String>,
) -> u64 {
    controls
        .get(&visit_key(name, map_indices))
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(0)
        + 1
}

fn mark_visit(
    name: &NodeName,
    map_indices: &[u64],
    controls: &mut BTreeMap<ControlKey, String>,
    visit: u64,
) {
    controls.insert(visit_key(name, map_indices), visit.to_string());
}

fn bind_payload(
    bindings: &[openengine_cluster_protocol::InputBinding],
    state: &Value,
    item: Option<&Value>,
) -> Result<Value, ReducerError> {
    if bindings.is_empty() {
        return Ok(Value::Null);
    }
    let mut value = Value::Object(Map::new());
    for binding in bindings {
        let selected = select_data(&binding.value, state, item)?.clone();
        set_path(&mut value, &binding.target, selected)?;
    }
    Ok(value)
}

fn select_data<'a>(
    selector: &DataSelector,
    state: &'a Value,
    item: Option<&'a Value>,
) -> Result<&'a Value, ReducerError> {
    match selector {
        DataSelector::State { path } => select(state, path),
        DataSelector::Item { path } => {
            select(item.ok_or(ReducerError::MissingSelectedValue)?, path)
        }
    }
}

fn select<'a>(value: &'a Value, path: &FieldPath) -> Result<&'a Value, ReducerError> {
    path.segments().iter().try_fold(value, |current, segment| {
        current
            .as_object()
            .and_then(|object| object.get(segment.as_str()))
            .ok_or(ReducerError::MissingSelectedValue)
    })
}

fn set_path(value: &mut Value, path: &FieldPath, selected: Value) -> Result<(), ReducerError> {
    let (last, parents) = path
        .segments()
        .split_last()
        .ok_or(ReducerError::MissingSelectedValue)?;
    let mut current = value;
    for segment in parents {
        let object = current
            .as_object_mut()
            .ok_or(ReducerError::InvalidDurableValue)?;
        current = object
            .entry(segment.as_str())
            .or_insert_with(|| Value::Object(Map::new()));
    }
    current
        .as_object_mut()
        .ok_or(ReducerError::InvalidDurableValue)?
        .insert(last.as_str().to_owned(), selected);
    Ok(())
}

fn apply_writes(
    context: &mut Context,
    application: WriteApplication<'_>,
) -> Result<(), ReducerError> {
    let WriteApplication {
        name,
        output,
        signals,
        diagnostic,
        bindings,
        map_indices,
    } = application;
    let channel = Channels {
        output: output.clone(),
        signals: signals
            .map(|values| {
                values
                    .iter()
                    .map(|(field, label)| (field.as_str().to_owned(), label.as_str().to_owned()))
                    .collect()
            })
            .unwrap_or_default(),
        diagnostic: diagnostic.cloned(),
    };
    context
        .channels
        .insert((name.clone(), map_indices.to_vec()), channel);
    for binding in bindings {
        let source_scope = map_indices.to_vec();
        let channels = context
            .channels
            .get(&(binding.value.node.clone(), source_scope))
            .ok_or(ReducerError::MissingSelectedValue)?;
        let source = match binding.value.channel {
            NodeOutputChannel::Out => &channels.output,
            NodeOutputChannel::Signal => {
                let first = binding
                    .value
                    .path
                    .segments()
                    .first()
                    .ok_or(ReducerError::MissingSelectedValue)?;
                let label = channels
                    .signals
                    .get(first.as_str())
                    .ok_or(ReducerError::MissingSelectedValue)?;
                set_path(
                    &mut context.state,
                    &binding.target,
                    Value::String(label.clone()),
                )?;
                continue;
            }
            NodeOutputChannel::Diagnostic => channels
                .diagnostic
                .as_ref()
                .ok_or(ReducerError::MissingSelectedValue)?,
        };
        let selected = select(source, &binding.value.path)?.clone();
        set_path(&mut context.state, &binding.target, selected)?;
    }
    Ok(())
}

fn promote(request: PromotionRequest<'_>) -> Result<(), ReducerError> {
    let PromotionRequest {
        node,
        map_indices,
        paths,
        local,
        parent,
        mode,
        decisions,
    } = request;
    let mut values = Vec::with_capacity(paths.len());
    for path in paths {
        let value = select(&local.state, path)?.clone();
        set_path(&mut parent.state, path, value.clone())?;
        values.push(PromotedValue {
            path: path.clone(),
            value,
        });
    }
    if mode == EvalMode::Decide && !values.is_empty() {
        decisions.push(Decision::Promote {
            node: node.clone(),
            map_indices: map_indices.to_vec(),
            values,
        });
    }
    merge_runtime_facts(local, parent);
    Ok(())
}

fn merge_runtime_facts(source: &Context, target: &mut Context) {
    target.controls.extend(source.controls.clone());
    target.channels.extend(source.channels.clone());
}

fn descendant_names(node: &GraphNode) -> BTreeSet<NodeName> {
    let mut depths = BTreeMap::new();
    collect_map_depths(node, 0, &mut depths);
    depths.into_keys().collect()
}
