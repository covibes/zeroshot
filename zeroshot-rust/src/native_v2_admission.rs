//! Pure admission compiler for the native-v2 MVP.
//!
//! Admission keeps [`GraphSpec`] unchanged. It resolves executable leaves into an exact,
//! graph-local [`WorkerRegistry`], validates the actual initial input and secret-free runtime
//! bindings, applies the deliberately small MVP execution restrictions, and only then delegates
//! the workflow-language invariants to [`ProductionGraphVerifier`]. No method in this module
//! allocates a workspace, resolves an environment value, or performs another runtime effect.

use std::collections::BTreeMap;

use async_trait::async_trait;
use openengine_cluster_protocol::{
    ArtifactResultProfile, AutonomyPolicy, CapabilityPolicy, GraphNode, GraphProfile, GraphSpec,
    MediaType, NodeName, PayloadValueError, RedactionClass, TypeId, WorkerContract,
    WorkerDescriptor, WorkerProtocolBinding, WorkerRef,
};
use openengine_cluster_server::admission::{GraphVerifier, VerificationError};
use openengine_cluster_server::graph_verifier::ProductionGraphVerifier;
use openengine_cluster_server::worker_registry::{WorkerRegistry, WorkerRegistryError};
use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::native_v2_contract::{
    AdmittedRun, NodeRuntimeBinding, RunSubmission, RunSubmissionIntent, RuntimePlan,
};
use crate::worker_catalog::ReasoningEffort;
use openengine_cluster_protocol::MAX_DECLARED_ENVIRONMENT_NAMES;

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

/// Host policy for graph-visible Git delivery.
#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DeliveryPolicy {
    /// Local execution may leave changes in the run workspace.
    #[default]
    Optional,
    /// Hosted execution requires exactly one graph-visible delivery node.
    Required,
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
    #[error("agent-backed node {node} requires authored instructions")]
    MissingAgentInstructions { node: NodeName },
    #[error("Git delivery node {node} rejects authored instructions")]
    DeliveryInstructionsForbidden { node: NodeName },
    #[error("Git delivery binding {node} must be attached to a verifier node")]
    DeliveryMustBeVerifier { node: NodeName },
    #[error("Git delivery binding {node} uses unsupported worker {worker}")]
    UnsupportedDeliveryWorker { node: NodeName, worker: WorkerRef },
    #[error(
        "graph-visible Git delivery worker {worker} at node {node} requires a Git delivery binding"
    )]
    DeliveryWorkerRequiresBinding { node: NodeName, worker: WorkerRef },
    #[error("delivery policy {policy:?} rejects {found} graph-visible Git delivery nodes")]
    DeliveryNodeCount {
        policy: DeliveryPolicy,
        found: usize,
    },
    #[error(
        "run declares {found} unique environment names; maximum is {MAX_DECLARED_ENVIRONMENT_NAMES}"
    )]
    DeclaredEnvironmentTooLarge { found: usize },
    #[error("Git delivery node {node} declares an invalid contract for worker {worker}")]
    InvalidDeliveryContract { node: NodeName, worker: WorkerRef },
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
    /// Admits with the local policy, where graph-visible delivery is optional.
    pub async fn admit(
        &self,
        submission: RunSubmission,
    ) -> Result<AdmittedRun, NativeV2AdmissionError> {
        self.admit_with_policy(submission, DeliveryPolicy::Optional)
            .await
    }

    /// Admits with an explicit host delivery policy.
    pub async fn admit_with_policy(
        &self,
        submission: RunSubmission,
        delivery_policy: DeliveryPolicy,
    ) -> Result<AdmittedRun, NativeV2AdmissionError> {
        let RunSubmission {
            title,
            graph,
            initial_input,
            runtime,
            source,
            submission_key,
        } = submission;
        let prepared = prepare_submission(
            RunSubmissionIntent {
                title,
                graph,
                initial_input,
                runtime,
                branch: None,
                submission_key,
            },
            delivery_policy,
        )?;
        let verified = verify_submission(&prepared).await?;

        Ok(AdmittedRun {
            title: prepared.title,
            graph: verified,
            initial_input: prepared.initial_input,
            runtime: prepared.runtime,
            source,
        })
    }

    /// Verifies a source-neutral intent before a host resolves environment or source state.
    pub async fn validate_intent(
        &self,
        intent: &RunSubmissionIntent,
        delivery_policy: DeliveryPolicy,
    ) -> Result<(), NativeV2AdmissionError> {
        let prepared = prepare_submission(intent.clone(), delivery_policy)?;
        verify_submission(&prepared).await.map(|_| ())
    }
}

struct PreparedSubmission {
    title: crate::native_v2_contract::RunTitle,
    graph: GraphSpec,
    initial_input: serde_json::Value,
    runtime: RuntimePlan,
    declarations: Vec<ExecutableDeclaration>,
}

fn prepare_submission(
    intent: RunSubmissionIntent,
    delivery_policy: DeliveryPolicy,
) -> Result<PreparedSubmission, NativeV2AdmissionError> {
    let RunSubmissionIntent {
        title,
        graph,
        initial_input,
        runtime,
        branch: _,
        submission_key: _,
    } = intent;
    validate_graph_input(&graph, &initial_input)?;
    let declarations = executable_declarations(&graph.root);
    validate_executable_bindings(&declarations, runtime.nodes(), delivery_policy)?;
    let runtime = normalize_runtime(runtime)?;
    validate_concurrency(&graph.root, runtime.nodes())?;

    Ok(PreparedSubmission {
        title,
        graph,
        initial_input,
        runtime,
        declarations,
    })
}

async fn verify_submission(
    prepared: &PreparedSubmission,
) -> Result<openengine_cluster_protocol::CompiledGraphIr, NativeV2AdmissionError> {
    let registry = GraphBoundWorkerRegistry::from_declarations(
        &prepared.graph,
        &prepared.declarations,
        &prepared.runtime,
    )?;
    ProductionGraphVerifier::new(registry)
        .verify(&prepared.graph)
        .await
        .map(|verified| verified.compiled_ir)
        .map_err(Into::into)
}

mod concurrency;
mod validation;
use concurrency::validate_concurrency;
pub(crate) use validation::{sole_delivery_node, writer_nodes};
use validation::{
    ExecutableDeclaration, executable_declarations, normalize_runtime,
    validate_executable_bindings, validate_graph_input,
};
pub(crate) fn executable_runtime_roles(root: &GraphNode) -> Vec<(NodeName, bool)> {
    validation::executable_runtime_roles(root)
}

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
