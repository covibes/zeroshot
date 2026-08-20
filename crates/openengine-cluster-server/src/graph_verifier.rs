//! Production semantic verifier for `openengine.graph.full/v1`.

use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet};

use async_trait::async_trait;
use openengine_cluster_protocol::{
    ChoiceNode, CompiledGraphIr, ControlSelector, ControlSource, DataSelector,
    DiagnosticPathSegment, DiagnosticSeverity, EnumLabel, FieldName, FieldPath, GraphDiagnostic,
    GraphDiagnosticCode, GraphNode, GraphProfile, GraphSpec, Guard, InputBinding, Join, LoopNode,
    MapNode, NodeName, NodeOutputChannel, NodeOutputSelector, NonEmptyVec, ParNode, PayloadType,
    PositiveInteger, SeqNode, StepNode, StructuralBounds, TerminationWitness, VerifierNode,
    WriteBinding,
};

use crate::admission::{GraphVerifier, VerificationError, VerifiedGraph};
use crate::worker_registry::{
    check_graph_workers, WorkerCompatibilityCode, WorkerCompatibilityDiagnostic, WorkerRegistry,
};

pub const FULL_V1_MAX_GRAPH_NODES: u64 = 4_096;
pub const FULL_V1_MAX_GRAPH_DEPTH: u64 = 64;
pub const FULL_V1_MAX_GUARD_NODES: u64 = 4_096;
pub const FULL_V1_MAX_GUARD_ASSIGNMENTS: u64 = 65_536;
pub const FULL_V1_MAX_LOOP_ITERATIONS: u64 = 100;
pub const FULL_V1_MAX_MAP_ITEMS: u64 = 1_024;
pub const FULL_V1_MAX_ATTEMPTS_PER_NODE: u64 = 100;
pub const FULL_V1_MAX_NODE_EXECUTIONS: u64 = 65_536;
pub const FULL_V1_MAX_LOOP_ENTRIES: u64 = 65_536;
pub const FULL_V1_MAX_PEAK_CONCURRENCY: u64 = 1_024;

/// Reusable full-v1 verifier. The registry is the verifier's only asynchronous input.
pub struct ProductionGraphVerifier<R> {
    registry: R,
}

impl<R> ProductionGraphVerifier<R> {
    #[must_use]
    pub const fn new(registry: R) -> Self {
        Self { registry }
    }

    #[must_use]
    pub fn registry(&self) -> &R {
        &self.registry
    }
}

#[async_trait]
impl<R> GraphVerifier for ProductionGraphVerifier<R>
where
    R: WorkerRegistry + 'static,
{
    async fn verify(&self, graph: &GraphSpec) -> Result<VerifiedGraph, VerificationError> {
        let mut analyzer = Analyzer::new(graph);
        let bounds = analyzer.analyze();
        if !analyzer.diagnostics.is_empty() {
            analyzer.sort_diagnostics();
            return Err(VerificationError::Rejected {
                diagnostics: analyzer.diagnostics,
            });
        }

        if let Err(worker_diagnostics) = check_graph_workers(graph, &self.registry).await {
            let mut diagnostics = worker_diagnostics
                .into_iter()
                .map(|diagnostic| analyzer.worker_diagnostic(diagnostic))
                .collect::<Vec<_>>();
            sort_diagnostics(&mut diagnostics);
            return Err(VerificationError::Rejected { diagnostics });
        }

        let bounds = bounds.ok_or_else(|| {
            VerificationError::Internal(
                "structurally valid graph did not produce structural bounds".to_owned(),
            )
        })?;
        finalize_verified(graph, bounds)
    }
}

fn finalize_verified(
    graph: &GraphSpec,
    bounds: StructuralBounds,
) -> Result<VerifiedGraph, VerificationError> {
    finalize_verified_with_invariant_probe(graph, bounds, false)
}

fn finalize_verified_with_invariant_probe(
    graph: &GraphSpec,
    bounds: StructuralBounds,
    inject_invariant_failure: bool,
) -> Result<VerifiedGraph, VerificationError> {
    if inject_invariant_failure {
        return Err(VerificationError::Internal(
            "injected post-validation invariant failure".to_owned(),
        ));
    }
    let compiled_ir = CompiledGraphIr {
        profile: graph.profile,
        initial_input: graph.initial_input.clone(),
        policy: graph.policy.clone(),
        root: graph.root.clone(),
        bounds,
    };
    compiled_ir.canonical_bytes().map_err(|error| {
        VerificationError::Internal(format!(
            "validated graph could not be canonicalized: {error}"
        ))
    })?;
    Ok(VerifiedGraph {
        compiled_ir,
        diagnostics: Vec::new(),
    })
}

#[derive(Clone)]
struct NodeInfo<'a> {
    node: &'a GraphNode,
    path: Vec<DiagnosticPathSegment>,
    ordinal: usize,
}

#[derive(Clone, Default)]
struct Flow {
    available: BTreeSet<NodeName>,
    unavailable: BTreeSet<NodeName>,
    conditional_nodes: BTreeMap<NodeName, BTreeSet<NodeName>>,
    defined: BTreeMap<FieldPath, PayloadType>,
    failed: BTreeSet<NodeName>,
    outcome_writes: OutcomeWrites,
    outcome_order: Vec<NodeName>,
    parallel_definition_effects: Vec<ParallelDefinitionEffect>,
}

#[derive(Clone, Default)]
struct Effects {
    definite_nodes: BTreeSet<NodeName>,
    unavailable_nodes: BTreeSet<NodeName>,
    conditional_nodes: BTreeMap<NodeName, BTreeSet<NodeName>>,
    definite_writes: Writes,
    possible_writes: Writes,
    possible_write_types: BTreeMap<FieldPath, Vec<PayloadType>>,
    outcome_writes: OutcomeWrites,
    outcome_order: Vec<NodeName>,
    parallel_definition_effects: Vec<ParallelDefinitionEffect>,
    exit_failed: BTreeSet<NodeName>,
    falls_through: bool,
    completion: CompletionPredicate,
}

#[derive(Clone, Default)]
enum CompletionPredicate {
    Always,
    #[default]
    Never,
    Guard(Guard),
    Not(Box<Self>),
    All(Vec<Self>),
    Any(Vec<Self>),
    AtLeast {
        count: u64,
        predicates: Vec<Self>,
    },
}

#[derive(Clone)]
enum ParallelJoinCorrelation {
    Joined {
        completion: CompletionPredicate,
    },
    First {
        satisfaction: CompletionPredicate,
        all_completions: CompletionPredicate,
    },
}

#[derive(Clone)]
struct MapExecutionCorrelation {
    owner: NodeName,
    presence: CompletionPredicate,
}

impl ParallelJoinCorrelation {
    fn collect_guards<'a>(&'a self, guards: &mut Vec<&'a Guard>) {
        match self {
            Self::Joined { completion } => completion.collect_guards(guards),
            Self::First {
                satisfaction,
                all_completions,
            } => {
                satisfaction.collect_guards(guards);
                all_completions.collect_guards(guards);
            }
        }
    }

    fn field(&self) -> &'static str {
        match self {
            Self::Joined { .. } => "joined",
            Self::First { .. } => "raced",
        }
    }
}

impl CompletionPredicate {
    fn not(predicate: Self) -> Self {
        match predicate {
            Self::Always => Self::Never,
            Self::Never => Self::Always,
            predicate => Self::Not(Box::new(predicate)),
        }
    }

    fn all(predicates: impl IntoIterator<Item = Self>) -> Self {
        let mut combined = Vec::new();
        for predicate in predicates {
            match predicate {
                Self::Never => return Self::Never,
                Self::Always => {}
                Self::All(nested) => combined.extend(nested),
                predicate => combined.push(predicate),
            }
        }
        match combined.len() {
            0 => Self::Always,
            1 => combined.pop().unwrap_or(Self::Always),
            _ => Self::All(combined),
        }
    }

    fn any(predicates: impl IntoIterator<Item = Self>) -> Self {
        let mut combined = Vec::new();
        for predicate in predicates {
            match predicate {
                Self::Always => return Self::Always,
                Self::Never => {}
                Self::Any(nested) => combined.extend(nested),
                predicate => combined.push(predicate),
            }
        }
        match combined.len() {
            0 => Self::Never,
            1 => combined.pop().unwrap_or(Self::Never),
            _ => Self::Any(combined),
        }
    }

    fn at_least(count: u64, predicates: Vec<Self>) -> Self {
        if count == 0 {
            Self::Always
        } else if count > predicates.len() as u64 {
            Self::Never
        } else if count == predicates.len() as u64 {
            Self::all(predicates)
        } else {
            Self::AtLeast { count, predicates }
        }
    }

    fn evaluate(&self, assignment: &Assignment) -> bool {
        match self {
            Self::Always => true,
            Self::Never => false,
            Self::Guard(guard) => evaluate_guard(guard, assignment),
            Self::Not(predicate) => !predicate.evaluate(assignment),
            Self::All(predicates) => predicates
                .iter()
                .all(|predicate| predicate.evaluate(assignment)),
            Self::Any(predicates) => predicates
                .iter()
                .any(|predicate| predicate.evaluate(assignment)),
            Self::AtLeast { count, predicates } => {
                predicates
                    .iter()
                    .filter(|predicate| predicate.evaluate(assignment))
                    .count() as u64
                    >= *count
            }
        }
    }

    fn collect_guards<'a>(&'a self, guards: &mut Vec<&'a Guard>) {
        match self {
            Self::Guard(guard) => guards.push(guard),
            Self::Not(predicate) => predicate.collect_guards(guards),
            Self::All(predicates) | Self::Any(predicates) | Self::AtLeast { predicates, .. } => {
                for predicate in predicates {
                    predicate.collect_guards(guards);
                }
            }
            Self::Always | Self::Never => {}
        }
    }
}

#[derive(Clone)]
struct WriteFact {
    value_type: PayloadType,
    guaranteed_paths: BTreeMap<FieldPath, PayloadType>,
}

struct SelectedOutput {
    value_type: PayloadType,
    definitely_present: bool,
}

type Writes = BTreeMap<FieldPath, WriteFact>;
type OutcomeWrites = BTreeMap<NodeName, Writes>;

#[derive(Clone, PartialEq, Eq)]
struct DefinitionTransition {
    before: Option<PayloadType>,
    after: Option<PayloadType>,
}

#[derive(Clone, PartialEq, Eq)]
struct ParallelDefinitionEffect {
    name: NodeName,
    targets: BTreeSet<FieldPath>,
    transitions: BTreeMap<FieldPath, DefinitionTransition>,
}

impl Flow {
    fn apply_effects(&mut self, effects: &Effects) {
        self.available.extend(effects.definite_nodes.clone());
        self.unavailable.extend(effects.unavailable_nodes.clone());
        merge_conditional_nodes(&mut self.conditional_nodes, &effects.conditional_nodes);
        retain_parallel_definition_effects(
            &mut self.parallel_definition_effects,
            &effects.definite_writes,
            &effects.parallel_definition_effects,
        );
        apply_write_facts(&mut self.defined, &effects.definite_writes);
        self.parallel_definition_effects
            .extend(effects.parallel_definition_effects.clone());
        merge_outcome_writes(
            &mut self.outcome_writes,
            &mut self.outcome_order,
            &effects.outcome_writes,
            &effects.outcome_order,
        );
        self.failed = effects.exit_failed.clone();
        self.reconcile_parallel_definitions();
        self.resolve_successful_writes();
    }

    fn resolve_successful_writes(&mut self) {
        let successful = self
            .outcome_order
            .iter()
            .filter(|name| !self.failed.contains(*name))
            .cloned()
            .collect::<Vec<_>>();
        for name in successful {
            if let Some(writes) = self.outcome_writes.remove(&name) {
                retain_parallel_definition_effects(
                    &mut self.parallel_definition_effects,
                    &writes,
                    &[],
                );
                apply_write_facts(&mut self.defined, &writes);
            }
        }
        self.outcome_order
            .retain(|name| self.outcome_writes.contains_key(name));
    }

    fn reconcile_parallel_definitions(&mut self) {
        let effects = self
            .parallel_definition_effects
            .iter()
            .filter(|effect| self.available.contains(&effect.name))
            .collect::<Vec<_>>();
        let mut definitions = BTreeMap::<FieldPath, Option<PayloadType>>::new();
        for effect in &effects {
            for (path, transition) in &effect.transitions {
                definitions
                    .entry(path.clone())
                    .or_insert_with(|| transition.before.clone());
            }
        }
        for effect in effects {
            if self.failed.contains(&effect.name) {
                continue;
            }
            for target in &effect.targets {
                for (path, definition) in &mut definitions {
                    if paths_overlap(target, path) {
                        *definition = None;
                    }
                }
            }
            for (path, transition) in &effect.transitions {
                definitions.insert(path.clone(), transition.after.clone());
            }
        }
        for (path, definition) in definitions {
            match definition {
                Some(definition) => {
                    self.defined.insert(path, definition);
                }
                None => {
                    self.defined.remove(&path);
                }
            }
        }
    }
}

impl Effects {
    fn resolve_successful_writes(&mut self, failed: &BTreeSet<NodeName>) {
        let successful = self
            .outcome_order
            .iter()
            .filter(|name| !failed.contains(*name))
            .cloned()
            .collect::<Vec<_>>();
        for name in successful {
            if let Some(writes) = self.outcome_writes.remove(&name) {
                retain_parallel_definition_effects(
                    &mut self.parallel_definition_effects,
                    &writes,
                    &[],
                );
                compose_writes(&mut self.definite_writes, &writes);
            }
        }
        self.outcome_order
            .retain(|name| self.outcome_writes.contains_key(name));
    }
}

#[derive(Clone, Copy, Default)]
struct Fold {
    executions: u64,
    concurrency: u64,
    loop_entries: u64,
}

struct Analyzer<'a> {
    graph: &'a GraphSpec,
    nodes: BTreeMap<NodeName, NodeInfo<'a>>,
    authored: Vec<NodeName>,
    dependencies: BTreeMap<NodeName, BTreeSet<NodeName>>,
    loops: Vec<NodeName>,
    attempts: BTreeMap<NodeName, PositiveInteger>,
    diagnostics: Vec<GraphDiagnostic>,
    guard_nodes: u64,
    exhaustive_choices: BTreeSet<NodeName>,
    choice_reachability: BTreeMap<NodeName, ChoiceReachability>,
    parallel_join_correlations: BTreeMap<NodeName, ParallelJoinCorrelation>,
    map_execution_correlations: BTreeMap<NodeName, MapExecutionCorrelation>,
    node_completion: BTreeMap<NodeName, CompletionPredicate>,
    node_fallthrough: BTreeMap<usize, bool>,
}

macro_rules! emit_diagnostic {
    ($analyzer:expr, $code:expr, $message:expr, $path:expr, $related_nodes:expr $(,)?) => {
        $analyzer.emit(DiagnosticDetails {
            code: $code,
            message: $message.into(),
            path: $path,
            related_nodes: $related_nodes,
        })
    };
}

mod analyzer_assignments;
mod analyzer_bindings;
mod analyzer_bounds;
mod analyzer_guards;
mod analyzer_index;
mod analyzer_maps;
mod analyzer_nodes;
mod analyzer_parallel;
mod analyzer_parallel_flow;
mod analyzer_terminal;
mod assignments;
mod choice;
mod contexts;
mod diagnostics;
mod effects;
mod effects_tree;
mod effects_writes;
mod payload;
#[cfg(test)]
mod tests;

use assignments::*;
use choice::*;
use contexts::*;
use diagnostics::*;
use effects::*;
use effects_tree::*;
pub use effects_tree::child_nodes as graph_node_children;
use effects_writes::*;
use payload::*;
