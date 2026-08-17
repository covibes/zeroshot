//! Pure admission compiler for the native-v2 MVP.
//!
//! Admission keeps [`GraphSpec`] unchanged. It resolves executable leaves into an exact,
//! graph-local [`WorkerRegistry`], validates the actual initial input and secret-free runtime
//! bindings, applies the deliberately small MVP execution restrictions, and only then delegates
//! the workflow-language invariants to [`ProductionGraphVerifier`]. No method in this module
//! allocates a workspace, resolves an environment value, or performs another runtime effect.

use std::collections::{BTreeMap, BTreeSet};

use async_trait::async_trait;
use openengine_cluster_protocol::{
    ArtifactResultProfile, AutonomyPolicy, CapabilityPolicy, GraphNode, GraphProfile, GraphSpec,
    MediaType, NodeName, PayloadValueError, RedactionClass, TypeId, VerifierContract,
    WorkerContract, WorkerDescriptor, WorkerProtocolBinding, WorkerRef, RUNTIME_WORKER_ERRORS,
};
use openengine_cluster_server::admission::{GraphVerifier, VerificationError};
use openengine_cluster_server::graph_verifier::ProductionGraphVerifier;
use openengine_cluster_server::worker_registry::{WorkerRegistry, WorkerRegistryError};
use thiserror::Error;

use crate::native_v2_contract::{AdmittedRun, NodeRuntimeBinding, RunSubmission, RuntimePlan};
use crate::worker_catalog::ReasoningEffort;

const ALL_EFFORTS: &[ReasoningEffort] = &[
    ReasoningEffort::Low,
    ReasoningEffort::Medium,
    ReasoningEffort::High,
    ReasoningEffort::Xhigh,
    ReasoningEffort::Max,
];
const NO_EFFORTS: &[ReasoningEffort] = &[];

/// One entry in native-v2's intentionally bounded model catalog.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SupportedModel {
    pub id: &'static str,
    pub efforts: &'static [ReasoningEffort],
    pub default_effort: Option<ReasoningEffort>,
}

pub const CODEX_MODELS: &[SupportedModel] = &[
    effort_model("gpt-5.6"),
    effort_model("gpt-5.6-sol"),
    effort_model("gpt-5.6-terra"),
    effort_model("gpt-5.6-luna"),
];

pub const CLAUDE_MODELS: &[SupportedModel] = &[
    SupportedModel {
        id: "claude-haiku-4-5",
        efforts: NO_EFFORTS,
        default_effort: None,
    },
    effort_model("claude-sonnet-5"),
    effort_model("claude-opus-5"),
    effort_model("claude-fable-5"),
];

const fn effort_model(id: &'static str) -> SupportedModel {
    SupportedModel {
        id,
        efforts: ALL_EFFORTS,
        default_effort: Some(ReasoningEffort::Max),
    }
}

#[derive(Clone, Debug, Error, Eq, PartialEq)]
pub enum NativeV2AdmissionError {
    #[error("native-v2 requires graph profile openengine.graph.full/v1")]
    UnsupportedGraphProfile,
    #[error("initial input does not match GraphSpec.initialInput: {0}")]
    InitialInput(#[from] PayloadValueError),
    #[error("executable node {node} must use exactly one attempt, found {attempts}")]
    Attempts { node: NodeName, attempts: u64 },
    #[error("runtime plan has no binding for executable node {node}")]
    MissingRuntimeBinding { node: NodeName },
    #[error("runtime plan contains a binding for non-executable node {node}")]
    UnexpectedRuntimeBinding { node: NodeName },
    #[error("Git delivery binding {node} must be attached to a verifier node")]
    DeliveryMustBeVerifier { node: NodeName },
    #[error("--ship requires exactly one graph-visible Git delivery node, found {found}")]
    ShippingDeliveryCount { found: usize },
    #[error("Git delivery node {node} requires --ship")]
    DeliveryRequiresShipping { node: NodeName },
    #[error("model {model} is not supported by the selected harness at node {node}")]
    UnsupportedModel { node: NodeName, model: String },
    #[error("model {model} does not accept effort {effort:?} at node {node}")]
    UnsupportedEffort {
        node: NodeName,
        model: String,
        effort: ReasoningEffort,
    },
    #[error(
        "worker {worker} is reused with inconsistent executable declarations ({first}, {second})"
    )]
    InconsistentWorkerReuse {
        worker: WorkerRef,
        first: NodeName,
        second: NodeName,
    },
    #[error("MVP concurrency would overlap writer {writer} with executable node {other}")]
    ConcurrentWriter { writer: NodeName, other: NodeName },
    #[error("MVP map {map} may execute writer {writer} concurrently across items")]
    ConcurrentMapWriter { map: NodeName, writer: NodeName },
    #[error("graph-local worker descriptor could not be constructed: {0}")]
    WorkerDescriptor(String),
    #[error(transparent)]
    GraphVerification(#[from] VerificationError),
}

/// Pure native-v2 admission entry point.
#[derive(Clone, Copy, Debug, Default)]
pub struct NativeV2Admission;

impl NativeV2Admission {
    pub async fn admit(
        &self,
        submission: RunSubmission,
    ) -> Result<AdmittedRun, NativeV2AdmissionError> {
        let prepared = prepare_submission(submission)?;

        let registry = GraphBoundWorkerRegistry::from_declarations(
            &prepared.graph,
            &prepared.declarations,
            &prepared.runtime,
        )?;
        let verified = ProductionGraphVerifier::new(registry)
            .verify(&prepared.graph)
            .await?;

        Ok(AdmittedRun {
            graph: verified.compiled_ir,
            initial_input: prepared.initial_input,
            runtime: prepared.runtime,
            ship: prepared.ship,
        })
    }
}

struct PreparedSubmission {
    graph: GraphSpec,
    initial_input: serde_json::Value,
    runtime: RuntimePlan,
    ship: bool,
    declarations: Vec<ExecutableDeclaration>,
}

fn prepare_submission(
    submission: RunSubmission,
) -> Result<PreparedSubmission, NativeV2AdmissionError> {
    let RunSubmission {
        graph,
        initial_input,
        runtime,
        ship,
        submission_key: _,
    } = submission;

    validate_graph_input(&graph, &initial_input)?;
    let declarations = executable_declarations(&graph.root);
    validate_executable_bindings(&declarations, runtime.nodes(), ship)?;
    let runtime = normalize_runtime(runtime)?;
    validate_concurrency(&graph.root, runtime.nodes())?;

    Ok(PreparedSubmission {
        graph,
        initial_input,
        runtime,
        ship,
        declarations,
    })
}

fn validate_graph_input(
    graph: &GraphSpec,
    initial_input: &serde_json::Value,
) -> Result<(), NativeV2AdmissionError> {
    if graph.profile != GraphProfile::Full {
        return Err(NativeV2AdmissionError::UnsupportedGraphProfile);
    }
    graph.initial_input.validate_value(initial_input)?;
    Ok(())
}

fn validate_executable_bindings(
    declarations: &[ExecutableDeclaration],
    bindings: &BTreeMap<NodeName, NodeRuntimeBinding>,
    ship: bool,
) -> Result<(), NativeV2AdmissionError> {
    validate_attempts(declarations)?;
    validate_binding_coverage(declarations, bindings)?;
    validate_binding_kinds(declarations, bindings)?;
    validate_shipping(ship, declarations, bindings)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum LeafKind {
    Step,
    Verifier,
}

#[derive(Clone, Debug)]
struct ExecutableDeclaration {
    name: NodeName,
    worker: WorkerRef,
    contract: WorkerContract,
    attempts: u64,
    kind: LeafKind,
}

fn executable_declarations(root: &GraphNode) -> Vec<ExecutableDeclaration> {
    let mut declarations = Vec::new();
    collect_declarations(root, &mut declarations);
    declarations
}

fn collect_declarations(node: &GraphNode, declarations: &mut Vec<ExecutableDeclaration>) {
    match node {
        GraphNode::Step(step) => declarations.push(ExecutableDeclaration {
            name: step.name.clone(),
            worker: step.worker.clone(),
            contract: WorkerContract {
                input: step.input.clone(),
                output: step.output.clone(),
                verifier: None,
                errors: RUNTIME_WORKER_ERRORS.to_vec(),
            },
            attempts: step.attempts.get(),
            kind: LeafKind::Step,
        }),
        GraphNode::Verifier(verifier) => declarations.push(ExecutableDeclaration {
            name: verifier.name.clone(),
            worker: verifier.worker.clone(),
            contract: WorkerContract {
                input: verifier.input.clone(),
                output: verifier.output.clone(),
                verifier: Some(VerifierContract {
                    signals: verifier.signals.clone(),
                    diagnostic: verifier.diagnostic.clone(),
                }),
                errors: RUNTIME_WORKER_ERRORS.to_vec(),
            },
            attempts: verifier.attempts.get(),
            kind: LeafKind::Verifier,
        }),
        GraphNode::Seq(group) => group
            .children
            .as_slice()
            .iter()
            .for_each(|child| collect_declarations(child, declarations)),
        GraphNode::Choice(group) => {
            group
                .branches
                .as_slice()
                .iter()
                .for_each(|branch| collect_declarations(&branch.node, declarations));
            if let Some(otherwise) = &group.otherwise {
                collect_declarations(otherwise, declarations);
            }
        }
        GraphNode::Par(group) => group
            .branches
            .as_slice()
            .iter()
            .for_each(|branch| collect_declarations(branch, declarations)),
        GraphNode::Loop(group) => collect_declarations(&group.body, declarations),
        GraphNode::Map(group) => collect_declarations(&group.body, declarations),
        GraphNode::Succeed(_) | GraphNode::Fail(_) => {}
    }
}

fn validate_attempts(declarations: &[ExecutableDeclaration]) -> Result<(), NativeV2AdmissionError> {
    if let Some(declaration) = declarations.iter().find(|item| item.attempts != 1) {
        return Err(NativeV2AdmissionError::Attempts {
            node: declaration.name.clone(),
            attempts: declaration.attempts,
        });
    }
    Ok(())
}

fn validate_binding_coverage(
    declarations: &[ExecutableDeclaration],
    bindings: &BTreeMap<NodeName, NodeRuntimeBinding>,
) -> Result<(), NativeV2AdmissionError> {
    let executable = declarations
        .iter()
        .map(|declaration| declaration.name.clone())
        .collect::<BTreeSet<_>>();
    let bound = bindings.keys().cloned().collect::<BTreeSet<_>>();
    if let Some(node) = executable.difference(&bound).next() {
        return Err(NativeV2AdmissionError::MissingRuntimeBinding { node: node.clone() });
    }
    if let Some(node) = bindings.keys().find(|node| !executable.contains(*node)) {
        return Err(NativeV2AdmissionError::UnexpectedRuntimeBinding { node: node.clone() });
    }
    Ok(())
}

fn validate_binding_kinds(
    declarations: &[ExecutableDeclaration],
    bindings: &BTreeMap<NodeName, NodeRuntimeBinding>,
) -> Result<(), NativeV2AdmissionError> {
    for declaration in declarations {
        if declaration.kind == LeafKind::Step
            && matches!(
                bindings.get(&declaration.name),
                Some(NodeRuntimeBinding::GitDelivery { .. })
            )
        {
            return Err(NativeV2AdmissionError::DeliveryMustBeVerifier {
                node: declaration.name.clone(),
            });
        }
    }
    Ok(())
}

fn validate_shipping(
    ship: bool,
    declarations: &[ExecutableDeclaration],
    bindings: &BTreeMap<NodeName, NodeRuntimeBinding>,
) -> Result<(), NativeV2AdmissionError> {
    let delivery_nodes = declarations
        .iter()
        .filter(|declaration| {
            matches!(
                bindings.get(&declaration.name),
                Some(NodeRuntimeBinding::GitDelivery { .. })
            )
        })
        .collect::<Vec<_>>();
    if ship && delivery_nodes.len() != 1 {
        return Err(NativeV2AdmissionError::ShippingDeliveryCount {
            found: delivery_nodes.len(),
        });
    }
    if !ship {
        if let Some(delivery) = delivery_nodes.first() {
            return Err(NativeV2AdmissionError::DeliveryRequiresShipping {
                node: delivery.name.clone(),
            });
        }
    }
    Ok(())
}

fn normalize_runtime(mut runtime: RuntimePlan) -> Result<RuntimePlan, NativeV2AdmissionError> {
    let (catalog, nodes) = match &mut runtime {
        RuntimePlan::Codex { nodes, .. } => (CODEX_MODELS, nodes),
        RuntimePlan::Claude { nodes, .. } => (CLAUDE_MODELS, nodes),
    };
    for (node, binding) in nodes {
        let NodeRuntimeBinding::Agent { model, effort, .. } = binding else {
            continue;
        };
        let Some(supported) = catalog
            .iter()
            .find(|supported| supported.id == model.as_str())
        else {
            return Err(NativeV2AdmissionError::UnsupportedModel {
                node: node.clone(),
                model: model.as_str().to_owned(),
            });
        };
        match *effort {
            Some(value) if !supported.efforts.contains(&value) => {
                return Err(NativeV2AdmissionError::UnsupportedEffort {
                    node: node.clone(),
                    model: model.as_str().to_owned(),
                    effort: value,
                });
            }
            None => *effort = supported.default_effort,
            Some(_) => {}
        }
    }
    Ok(runtime)
}

mod concurrency;
use concurrency::validate_concurrency;
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum RuntimeRole {
    Agent,
    GitDelivery,
}

#[derive(Clone, Debug)]
struct ResolvedDeclaration {
    first_node: NodeName,
    contract: WorkerContract,
    role: RuntimeRole,
}

/// Exact registry synthesized solely from executable declarations in one submitted graph.
#[derive(Clone, Debug)]
pub struct GraphBoundWorkerRegistry {
    descriptors: BTreeMap<WorkerRef, WorkerDescriptor>,
}

impl GraphBoundWorkerRegistry {
    fn from_declarations(
        graph: &GraphSpec,
        declarations: &[ExecutableDeclaration],
        runtime: &RuntimePlan,
    ) -> Result<Self, NativeV2AdmissionError> {
        let mut resolved = BTreeMap::<WorkerRef, ResolvedDeclaration>::new();
        for declaration in declarations {
            let role = match runtime.nodes().get(&declaration.name) {
                Some(NodeRuntimeBinding::Agent { .. }) => RuntimeRole::Agent,
                Some(NodeRuntimeBinding::GitDelivery { .. }) => RuntimeRole::GitDelivery,
                None => continue,
            };
            if let Some(first) = resolved.get(&declaration.worker) {
                if first.contract != declaration.contract || first.role != role {
                    return Err(NativeV2AdmissionError::InconsistentWorkerReuse {
                        worker: declaration.worker.clone(),
                        first: first.first_node.clone(),
                        second: declaration.name.clone(),
                    });
                }
                continue;
            }
            resolved.insert(
                declaration.worker.clone(),
                ResolvedDeclaration {
                    first_node: declaration.name.clone(),
                    contract: declaration.contract.clone(),
                    role,
                },
            );
        }

        let descriptors = resolved
            .into_iter()
            .map(|(worker, declaration)| {
                descriptor(graph, worker.clone(), declaration.contract).map(|value| (worker, value))
            })
            .collect::<Result<_, _>>()?;
        Ok(Self { descriptors })
    }
}

fn descriptor(
    graph: &GraphSpec,
    worker: WorkerRef,
    contract: WorkerContract,
) -> Result<WorkerDescriptor, NativeV2AdmissionError> {
    let descriptor =
        WorkerDescriptor {
            worker,
            graph_profiles: vec![GraphProfile::Full],
            binding: WorkerProtocolBinding::builtin_v1(),
            contract,
            capability_policy: CapabilityPolicy {
                autonomy: AutonomyPolicy::Strict,
                permission_policy: graph.policy.policy.clone(),
            },
            artifact_profile: ArtifactResultProfile {
                allowed_type_ids: vec![TypeId::new("openengine.result@1").map_err(|error| {
                    NativeV2AdmissionError::WorkerDescriptor(error.to_string())
                })?],
                allowed_media_types: vec![MediaType::new("application/json").map_err(|error| {
                    NativeV2AdmissionError::WorkerDescriptor(error.to_string())
                })?],
                minimum_redaction: RedactionClass::Internal,
            },
            credential_requirements: Vec::new(),
        };
    descriptor
        .validate()
        .map_err(|error| NativeV2AdmissionError::WorkerDescriptor(error.to_string()))?;
    Ok(descriptor)
}

#[async_trait]
impl WorkerRegistry for GraphBoundWorkerRegistry {
    async fn resolve(&self, worker: &WorkerRef) -> Result<WorkerDescriptor, WorkerRegistryError> {
        self.descriptors
            .get(worker)
            .cloned()
            .ok_or_else(|| WorkerRegistryError::NotFound {
                worker: worker.clone(),
            })
    }
}

#[cfg(test)]
#[path = "native_v2_admission/tests.rs"]
mod tests;
