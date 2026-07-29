//! Pure reduction of verifier-produced full-v1 graphs.
//!
//! This module deliberately accepts [`VerifiedGraph`], the result of
//! [`ProductionGraphVerifier`](openengine_cluster_server::graph_verifier::ProductionGraphVerifier),
//! rather than graph syntax or a directly constructed `CompiledGraphIr`. All shape, type,
//! binding, guard-domain, and bound proofs remain owned by that verifier. Reduction only applies
//! those already-proven operations to durable values in authored order.

use std::collections::{BTreeMap, BTreeSet};

use openengine_cluster_protocol::{
    ChoiceNode, ControlSelector, ControlSource, DataSelector, FieldPath, GraphNode, Guard, Join,
    MapNode, NodeName, NodeOutputChannel, ParNode, PositiveInteger, WorkerOutcome, WorkerRef,
};
use openengine_cluster_server::admission::VerifiedGraph;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use thiserror::Error;

use crate::cluster_ledger::record::{
    CanonicalDigest, ExecutionVoidReason, RecordPayload, StructuralOccurrence,
};
use crate::cluster_ledger::store::Position;
use crate::cluster_ledger::{ExecutionId, NodeInstanceId, ReplayState, RunSequence};

#[derive(Clone, Debug, PartialEq)]
pub enum DurableExecutionState {
    Active,
    Settled {
        position: Position,
        outcome: WorkerOutcome,
    },
    Voided {
        position: Position,
    },
}

#[derive(Clone, Debug, PartialEq)]
pub struct DurableExecution {
    pub dispatch_position: Position,
    pub node_instance: NodeInstanceId,
    pub execution: ExecutionId,
    pub occurrence: StructuralOccurrence,
    pub attempt: PositiveInteger,
    pub input: Value,
    pub state: DurableExecutionState,
}

pub fn durable_executions_from_replay(
    state: &ReplayState,
) -> Result<Vec<DurableExecution>, ReducerError> {
    let mut executions = Vec::with_capacity(state.execution_contexts.len());
    for context in state.execution_contexts.values() {
        let input: Value = serde_json::from_slice(&context.canonical_input)
            .map_err(|_| ReducerError::InconsistentHistory)?;
        let execution_state = if let Some(voided) = state.execution_voids.get(&context.execution) {
            DurableExecutionState::Voided {
                position: voided.position,
            }
        } else if state.settlements.contains_key(&context.execution) {
            let output = state
                .verified_outputs
                .get(&context.execution)
                .ok_or(ReducerError::InconsistentHistory)?;
            let outcome: WorkerOutcome = serde_json::from_slice(&output.canonical_bytes)
                .map_err(|_| ReducerError::InconsistentHistory)?;
            DurableExecutionState::Settled {
                position: output.position,
                outcome,
            }
        } else if state.active_dispatches.contains_key(&context.execution) {
            DurableExecutionState::Active
        } else {
            return Err(ReducerError::InconsistentHistory);
        };
        executions.push(DurableExecution {
            dispatch_position: context.position,
            node_instance: context.node_instance,
            execution: context.execution,
            occurrence: context.occurrence.clone(),
            attempt: context.attempt,
            input,
            state: execution_state,
        });
    }
    executions.sort_by_key(|execution| execution.dispatch_position);
    validate_history(&executions)?;
    Ok(executions)
}
#[derive(Clone, Debug)]
pub struct ReductionInput<'a> {
    pub run: RunSequence,
    pub initial_input: &'a Value,
    pub executions: &'a [DurableExecution],
    pub next_node_instance: u64,
    pub next_execution: u64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Decision {
    Dispatch {
        run: RunSequence,
        node_instance: NodeInstanceId,
        execution: ExecutionId,
        occurrence: StructuralOccurrence,
        attempt: PositiveInteger,
        worker: WorkerRef,
        input: Value,
    },
    VoidLoser {
        run: RunSequence,
        execution: ExecutionId,
        reason: ExecutionVoidReason,
    },
    Continue {
        node: NodeName,
    },
    Promote {
        node: NodeName,
        path: FieldPath,
        value: Value,
    },
    Terminal {
        projection: TerminalProjection,
    },
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum TerminalProjection {
    Succeeded { output: Value },
    Failed { reason: String },
}

#[derive(Clone, Debug, PartialEq)]
pub struct Reduction {
    pub run: RunSequence,
    pub decisions: Vec<Decision>,
    pub terminal: Option<TerminalProjection>,
}

impl Reduction {
    pub fn canonical_decision_bytes(&self) -> Result<Vec<u8>, ReducerError> {
        serde_json::to_vec(&self.decisions).map_err(|_| ReducerError::Encoding)
    }

    pub fn control_records(&self) -> Result<Vec<RecordPayload>, ReducerError> {
        let mut records = Vec::new();
        for decision in &self.decisions {
            match decision {
                Decision::Dispatch {
                    run,
                    node_instance,
                    execution,
                    occurrence,
                    attempt,
                    input,
                    ..
                } => {
                    let canonical_input =
                        serde_json::to_vec(input).map_err(|_| ReducerError::Encoding)?;
                    records.push(RecordPayload::Dispatch {
                        run: *run,
                        node_instance: *node_instance,
                        execution: *execution,
                    });
                    records.push(RecordPayload::ExecutionContext {
                        run: *run,
                        node_instance: *node_instance,
                        execution: *execution,
                        occurrence: occurrence.clone(),
                        attempt: *attempt,
                        canonical_input,
                    });
                }
                Decision::VoidLoser {
                    run,
                    execution,
                    reason,
                } => records.push(RecordPayload::ExecutionVoid {
                    run: *run,
                    execution: *execution,
                    reason: *reason,
                }),
                Decision::Continue { .. }
                | Decision::Promote { .. }
                | Decision::Terminal { .. } => {}
            }
        }
        if let Some(terminal) = &self.terminal {
            let bytes = serde_json::to_vec(terminal).map_err(|_| ReducerError::Encoding)?;
            records.push(RecordPayload::Terminal {
                run: self.run,
                outcome_digest: CanonicalDigest::of(&bytes),
            });
        }
        Ok(records)
    }

    pub fn canonical_control_record_bytes(&self) -> Result<Vec<u8>, ReducerError> {
        serde_json::to_vec(&self.control_records()?).map_err(|_| ReducerError::Encoding)
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
}

impl<'a> FullV1Reducer<'a> {
    #[must_use]
    pub const fn new(graph: &'a VerifiedGraph) -> Self {
        Self { graph }
    }

    pub fn reduce(&self, input: ReductionInput<'_>) -> Result<Reduction, ReducerError> {
        let initial_input = input.initial_input.clone();
        let mut engine = Engine::new(input, &self.graph.compiled_ir.root)?;
        let mut context = Context::new(initial_input);
        let status = engine.eval(
            &self.graph.compiled_ir.root,
            &mut context,
            &[],
            None,
            EvalMode::Decide,
            Position::MAX,
        )?;
        let terminal = match status {
            Status::Terminal { projection, .. } => Some(projection),
            Status::Continue { .. } | Status::Pending => None,
        };
        if let Some(projection) = terminal.clone() {
            engine.decisions.push(Decision::Terminal { projection });
        }
        Ok(Reduction {
            run: engine.run,
            decisions: engine.decisions,
            terminal,
        })
    }
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

#[derive(Clone)]
enum Status {
    Pending,
    Continue {
        position: Position,
    },
    Terminal {
        position: Position,
        projection: TerminalProjection,
    },
}

impl Status {
    fn position(&self) -> Position {
        match self {
            Self::Pending => Position::MAX,
            Self::Continue { position } | Self::Terminal { position, .. } => *position,
        }
    }

    fn after(self, prior: Position) -> Self {
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

struct Engine<'a> {
    run: RunSequence,
    executions: &'a [DurableExecution],
    next_node_instance: u64,
    next_execution: u64,
    decisions: Vec<Decision>,
    map_depths: BTreeMap<NodeName, usize>,
}

impl<'a> Engine<'a> {
    fn new(input: ReductionInput<'a>, root: &GraphNode) -> Result<Self, ReducerError> {
        validate_history(input.executions)?;
        let mut map_depths = BTreeMap::new();
        collect_map_depths(root, 0, &mut map_depths);
        if input.executions.iter().any(|execution| {
            execution.execution.get() >= input.next_execution
                || execution.node_instance.get() >= input.next_node_instance
                || map_depths
                    .get(&execution.occurrence.node)
                    .is_none_or(|depth| *depth != execution.occurrence.map_indices.len())
        }) {
            return Err(ReducerError::InconsistentHistory);
        }
        Ok(Self {
            run: input.run,
            executions: input.executions,
            next_node_instance: input.next_node_instance,
            next_execution: input.next_execution,
            decisions: Vec::new(),
            map_depths,
        })
    }

    fn eval(
        &mut self,
        node: &GraphNode,
        context: &mut Context,
        map_indices: &[u64],
        item: Option<&Value>,
        mode: EvalMode,
        cutoff: Position,
    ) -> Result<Status, ReducerError> {
        match node {
            GraphNode::Step(step) => self.eval_executable(
                &step.name,
                &step.worker,
                &step.input_bindings,
                &step.write_bindings,
                step.attempts,
                false,
                context,
                map_indices,
                item,
                mode,
                cutoff,
            ),
            GraphNode::Verifier(verifier) => self.eval_executable(
                &verifier.name,
                &verifier.worker,
                &verifier.input_bindings,
                &verifier.write_bindings,
                verifier.attempts,
                true,
                context,
                map_indices,
                item,
                mode,
                cutoff,
            ),
            GraphNode::Seq(group) => {
                let mut local = context.clone();
                let mut position = Position::ZERO;
                for child in group.children.as_slice() {
                    match self.eval(child, &mut local, map_indices, item, mode, cutoff)? {
                        Status::Continue {
                            position: child_position,
                        } => {
                            position = position.max(child_position);
                        }
                        other => return Ok(other.after(position)),
                    }
                }
                promote(
                    &group.name,
                    &group.promoted_state_paths,
                    &local,
                    context,
                    mode,
                    &mut self.decisions,
                )?;
                self.continue_decision(&group.name, mode);
                Ok(Status::Continue { position })
            }
            GraphNode::Choice(group) => {
                self.eval_choice(group, context, map_indices, item, mode, cutoff)
            }
            GraphNode::Par(group) => {
                self.eval_parallel(group, context, map_indices, item, mode, cutoff)
            }
            GraphNode::Loop(group) => {
                let mut local = context.clone();
                let mut position = Position::ZERO;
                for _iteration in 1..=group.max_iterations.get() {
                    match self.eval(&group.body, &mut local, map_indices, item, mode, cutoff)? {
                        Status::Continue {
                            position: body_position,
                        } => {
                            position = position.max(body_position);
                        }
                        other => return Ok(other.after(position)),
                    }
                    if self.guard(&group.until, &local, map_indices)? {
                        self.set_group_control(
                            &group.name,
                            "terminated",
                            "converged",
                            &mut local,
                            map_indices,
                        );
                        promote(
                            &group.name,
                            &group.promoted_state_paths,
                            &local,
                            context,
                            mode,
                            &mut self.decisions,
                        )?;
                        self.continue_decision(&group.name, mode);
                        return Ok(Status::Continue { position });
                    }
                }
                self.set_group_control(
                    &group.name,
                    "terminated",
                    "exhausted",
                    &mut local,
                    map_indices,
                );
                promote(
                    &group.name,
                    &group.promoted_state_paths,
                    &local,
                    context,
                    mode,
                    &mut self.decisions,
                )?;
                self.continue_decision(&group.name, mode);
                Ok(Status::Continue { position })
            }
            GraphNode::Map(group) => self.eval_map(group, context, map_indices, item, mode, cutoff),
            GraphNode::Succeed(terminal) => {
                let output = bind_payload(&terminal.bindings, &context.state, item)?;
                Ok(Status::Terminal {
                    position: Position::ZERO,
                    projection: TerminalProjection::Succeeded { output },
                })
            }
            GraphNode::Fail(terminal) => Ok(Status::Terminal {
                position: Position::ZERO,
                projection: TerminalProjection::Failed {
                    reason: terminal.reason.as_label().as_str().to_owned(),
                },
            }),
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn eval_executable(
        &mut self,
        name: &NodeName,
        worker: &WorkerRef,
        input_bindings: &[openengine_cluster_protocol::InputBinding],
        write_bindings: &[openengine_cluster_protocol::WriteBinding],
        attempt_ceiling: PositiveInteger,
        verifier: bool,
        context: &mut Context,
        map_indices: &[u64],
        item: Option<&Value>,
        mode: EvalMode,
        cutoff: Position,
    ) -> Result<Status, ReducerError> {
        let occurrence = StructuralOccurrence {
            node: name.clone(),
            map_indices: map_indices.to_vec(),
        };
        let mut matching = self
            .executions
            .iter()
            .filter(|execution| execution.occurrence == occurrence)
            .collect::<Vec<_>>();
        matching.sort_by_key(|execution| execution.attempt);
        let visit = next_visit(name, map_indices, &context.controls);
        let attempt = PositiveInteger::new(visit).map_err(|_| ReducerError::InconsistentHistory)?;
        if attempt.get() > attempt_ceiling.get() {
            return Ok(Status::Terminal {
                position: Position::ZERO,
                projection: TerminalProjection::Failed {
                    reason: "attempts_exhausted".to_owned(),
                },
            });
        }
        let input = bind_payload(input_bindings, &context.state, item)?;
        let existing = matching
            .iter()
            .find(|execution| execution.attempt == attempt)
            .copied();
        mark_visit(name, map_indices, &mut context.controls, visit);
        let Some(execution) = existing else {
            if mode == EvalMode::Probe || cutoff != Position::MAX {
                return Ok(Status::Pending);
            }
            let previous = matching.last().copied();
            let node_instance = if let Some(previous) = previous {
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
                run: self.run,
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
        match outcome {
            WorkerOutcome::Error { code, .. } => {
                self.set_control(
                    name,
                    ControlSource::Error,
                    None,
                    code.as_str(),
                    context,
                    map_indices,
                );
            }
            WorkerOutcome::Verified { output, .. } if !verifier => {
                apply_writes(
                    name,
                    output,
                    None,
                    None,
                    write_bindings,
                    context,
                    map_indices,
                )?;
            }
            WorkerOutcome::Verifier {
                output,
                signals,
                diagnostic,
                ..
            } if verifier => {
                for (field, label) in signals {
                    self.set_control(
                        name,
                        ControlSource::Signal,
                        Some(field.as_str()),
                        label.as_str(),
                        context,
                        map_indices,
                    );
                }
                apply_writes(
                    name,
                    output,
                    Some(signals),
                    Some(diagnostic),
                    write_bindings,
                    context,
                    map_indices,
                )?;
            }
            _ => return Err(ReducerError::InconsistentHistory),
        }
        self.continue_decision(name, mode);
        Ok(Status::Continue {
            position: *position,
        })
    }

    fn eval_choice(
        &mut self,
        group: &ChoiceNode,
        context: &mut Context,
        map_indices: &[u64],
        item: Option<&Value>,
        mode: EvalMode,
        cutoff: Position,
    ) -> Result<Status, ReducerError> {
        let mut local = context.clone();
        let selected = group
            .branches
            .as_slice()
            .iter()
            .find(|branch| {
                self.guard(&branch.when, &local, map_indices)
                    .unwrap_or(false)
            })
            .map(|branch| &branch.node)
            .or(group.otherwise.as_deref())
            .ok_or(ReducerError::MissingChoiceRoute)?;
        let status = self.eval(selected, &mut local, map_indices, item, mode, cutoff)?;
        if let Status::Continue { position } = status {
            promote(
                &group.name,
                &group.promoted_state_paths,
                &local,
                context,
                mode,
                &mut self.decisions,
            )?;
            merge_runtime_facts(&local, context);
            self.continue_decision(&group.name, mode);
            Ok(Status::Continue { position })
        } else {
            Ok(status)
        }
    }

    fn eval_parallel(
        &mut self,
        group: &ParNode,
        context: &mut Context,
        map_indices: &[u64],
        item: Option<&Value>,
        mode: EvalMode,
        cutoff: Position,
    ) -> Result<Status, ReducerError> {
        let mut probes = Vec::new();
        for branch in group.branches.as_slice() {
            let mut branch_context = context.clone();
            probes.push((
                self.eval(
                    branch,
                    &mut branch_context,
                    map_indices,
                    item,
                    EvalMode::Probe,
                    cutoff,
                )?,
                branch_context,
            ));
        }
        let completion_indices = probes
            .iter()
            .enumerate()
            .filter_map(|(index, (status, branch_context))| match status {
                Status::Continue { position }
                    if !matches!(group.join, Join::First { ref when } if !self.guard(when, branch_context, map_indices).unwrap_or(false)) =>
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
                if mode == EvalMode::Decide {
                    for branch in group.branches.as_slice() {
                        let mut branch_context = context.clone();
                        let _ = self.eval(
                            branch,
                            &mut branch_context,
                            map_indices,
                            item,
                            mode,
                            cutoff,
                        )?;
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
            self.set_group_control(&group.name, field, label, context, map_indices);
            self.continue_decision(&group.name, mode);
            return Ok(Status::Continue {
                position: probes
                    .iter()
                    .map(|(status, _)| status.position())
                    .filter(|position| *position != Position::MAX)
                    .max()
                    .unwrap_or(Position::ZERO),
            });
        }
        let winners = ordered.into_iter().take(required).collect::<Vec<_>>();
        let join_position = winners
            .iter()
            .map(|(_, position)| *position)
            .max()
            .unwrap_or(Position::ZERO);
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
                map_indices,
                item,
                mode,
                join_position,
            )?;
            if !matches!(status, Status::Continue { .. }) {
                return Err(ReducerError::InconsistentHistory);
            }
            for path in &group.promoted_state_paths {
                let value = select(&branch_context.state, path)?.clone();
                set_path(&mut joined.state, path, value.clone())?;
                if mode == EvalMode::Decide {
                    self.decisions.push(Decision::Promote {
                        node: group.name.clone(),
                        path: path.clone(),
                        value,
                    });
                }
            }
            merge_runtime_facts(&branch_context, &mut joined);
        }
        *context = joined;
        let (field, label) = if matches!(group.join, Join::First { .. }) {
            ("raced", "satisfied")
        } else {
            ("joined", "reached")
        };
        self.set_group_control(&group.name, field, label, context, map_indices);
        if mode == EvalMode::Decide && required < probes.len() {
            for (index, branch) in group.branches.as_slice().iter().enumerate() {
                if !winner_set.contains(&index) {
                    self.void_active_descendants(
                        branch,
                        map_indices,
                        join_position,
                        ExecutionVoidReason::ParallelJoin,
                    );
                }
            }
        }
        self.continue_decision(&group.name, mode);
        Ok(Status::Continue {
            position: join_position,
        })
    }

    fn eval_map(
        &mut self,
        group: &MapNode,
        context: &mut Context,
        map_indices: &[u64],
        item: Option<&Value>,
        mode: EvalMode,
        cutoff: Position,
    ) -> Result<Status, ReducerError> {
        let selected = select_data(&group.over, &context.state, item)?;
        let items = selected
            .as_array()
            .ok_or(ReducerError::InvalidDurableValue)?;
        if items.len() as u64 > group.max_items.get() {
            self.set_group_control(&group.name, "overflow", "overflow", context, map_indices);
            self.continue_decision(&group.name, mode);
            return Ok(Status::Continue {
                position: Position::ZERO,
            });
        }
        let mut local = context.clone();
        let mut item_results = Vec::with_capacity(items.len());
        for (index, item_value) in items.iter().enumerate() {
            let mut scope = map_indices.to_vec();
            scope.push(index as u64);
            let mut item_context = context.clone();
            let status = self.eval(
                &group.body,
                &mut item_context,
                &scope,
                Some(item_value),
                mode,
                cutoff,
            )?;
            item_results.push((status, item_context, scope));
        }
        if let Some((_, terminal, terminal_scope)) = item_results
            .iter()
            .filter_map(|(status, _, scope)| match status {
                Status::Terminal { position, .. } => Some((*position, status.clone(), scope)),
                _ => None,
            })
            .min_by_key(|(position, _, scope)| (*position, (*scope).clone()))
        {
            if mode == EvalMode::Decide {
                self.void_map_losers(
                    &group.body,
                    map_indices,
                    terminal_scope,
                    terminal.position(),
                );
            }
            return Ok(terminal);
        }
        if item_results
            .iter()
            .any(|(status, _, _)| matches!(status, Status::Pending))
        {
            return Ok(Status::Pending);
        }
        for path in &group.promoted_state_paths {
            let mut values = Vec::with_capacity(item_results.len());
            for (_, item_context, _) in &item_results {
                values.push(select(&item_context.state, path)?.clone());
            }
            let value = Value::Array(values);
            set_path(&mut local.state, path, value.clone())?;
        }
        self.set_group_control(&group.name, "overflow", "ok", &mut local, map_indices);
        promote(
            &group.name,
            &group.promoted_state_paths,
            &local,
            context,
            mode,
            &mut self.decisions,
        )?;
        for (_, item_context, _) in &item_results {
            merge_runtime_facts(item_context, context);
        }
        self.continue_decision(&group.name, mode);
        Ok(Status::Continue {
            position: item_results
                .iter()
                .map(|(status, _, _)| status.position())
                .max()
                .unwrap_or(Position::ZERO),
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

    fn set_control(
        &self,
        node: &NodeName,
        source: ControlSource,
        field: Option<&str>,
        label: &str,
        context: &mut Context,
        map_indices: &[u64],
    ) {
        let depth = self.map_depths.get(node).copied().unwrap_or(0);
        context.controls.insert(
            ControlKey {
                node: node.clone(),
                source,
                field: field.map(str::to_owned),
                map_indices: map_indices[..depth].to_vec(),
            },
            label.to_owned(),
        );
    }

    fn set_group_control(
        &self,
        node: &NodeName,
        field: &str,
        label: &str,
        context: &mut Context,
        map_indices: &[u64],
    ) {
        self.set_control(
            node,
            ControlSource::Group,
            Some(field),
            label,
            context,
            map_indices,
        );
    }

    fn continue_decision(&mut self, node: &NodeName, mode: EvalMode) {
        if mode == EvalMode::Decide {
            self.decisions
                .push(Decision::Continue { node: node.clone() });
        }
    }

    fn void_active_descendants(
        &mut self,
        node: &GraphNode,
        map_indices: &[u64],
        cutoff: Position,
        reason: ExecutionVoidReason,
    ) {
        let descendants = descendant_names(node);
        for execution in self.executions {
            if descendants.contains(&execution.occurrence.node)
                && execution.occurrence.map_indices.starts_with(map_indices)
                && execution.dispatch_position <= cutoff
                && matches!(execution.state, DurableExecutionState::Active)
            {
                self.decisions.push(Decision::VoidLoser {
                    run: self.run,
                    execution: execution.execution,
                    reason,
                });
            }
        }
    }

    fn void_map_losers(
        &mut self,
        body: &GraphNode,
        map_indices: &[u64],
        winner_scope: &[u64],
        cutoff: Position,
    ) {
        let descendants = descendant_names(body);
        for execution in self.executions {
            if descendants.contains(&execution.occurrence.node)
                && execution.occurrence.map_indices.starts_with(map_indices)
                && execution.occurrence.map_indices != winner_scope
                && execution.dispatch_position <= cutoff
                && matches!(execution.state, DurableExecutionState::Active)
            {
                self.decisions.push(Decision::VoidLoser {
                    run: self.run,
                    execution: execution.execution,
                    reason: ExecutionVoidReason::MapTerminal,
                });
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

fn validate_history(executions: &[DurableExecution]) -> Result<(), ReducerError> {
    let mut ids = BTreeSet::new();
    let mut attempts = BTreeSet::new();
    let mut instances = BTreeMap::new();
    for execution in executions {
        if !ids.insert(execution.execution)
            || !attempts.insert((execution.occurrence.clone(), execution.attempt))
        {
            return Err(ReducerError::InconsistentHistory);
        }
        match instances.entry(execution.occurrence.clone()) {
            std::collections::btree_map::Entry::Vacant(entry) => {
                entry.insert(execution.node_instance);
            }
            std::collections::btree_map::Entry::Occupied(entry)
                if *entry.get() != execution.node_instance =>
            {
                return Err(ReducerError::InconsistentHistory);
            }
            std::collections::btree_map::Entry::Occupied(_) => {}
        }
    }
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
    name: &NodeName,
    output: &Value,
    signals: Option<
        &BTreeMap<openengine_cluster_protocol::FieldName, openengine_cluster_protocol::EnumLabel>,
    >,
    diagnostic: Option<&Value>,
    bindings: &[openengine_cluster_protocol::WriteBinding],
    context: &mut Context,
    map_indices: &[u64],
) -> Result<(), ReducerError> {
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

fn promote(
    node: &NodeName,
    paths: &[FieldPath],
    local: &Context,
    parent: &mut Context,
    mode: EvalMode,
    decisions: &mut Vec<Decision>,
) -> Result<(), ReducerError> {
    for path in paths {
        let value = select(&local.state, path)?.clone();
        set_path(&mut parent.state, path, value.clone())?;
        if mode == EvalMode::Decide {
            decisions.push(Decision::Promote {
                node: node.clone(),
                path: path.clone(),
                value,
            });
        }
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
