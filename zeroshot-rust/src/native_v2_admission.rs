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

#[derive(Clone, Debug, Default)]
struct PossibleExecutions {
    readers: Vec<NodeName>,
    writers: Vec<NodeName>,
}

impl PossibleExecutions {
    fn append(&mut self, mut other: Self) {
        self.readers.append(&mut other.readers);
        self.writers.append(&mut other.writers);
    }

    fn any(&self) -> Option<&NodeName> {
        self.writers.first().or_else(|| self.readers.first())
    }
}

fn validate_concurrency(
    node: &GraphNode,
    bindings: &BTreeMap<NodeName, NodeRuntimeBinding>,
) -> Result<PossibleExecutions, NativeV2AdmissionError> {
    match node {
        GraphNode::Step(step) => Ok(writer(step.name.clone())),
        GraphNode::Verifier(verifier) => Ok(verifier_execution(&verifier.name, bindings)),
        GraphNode::Seq(group) => fold_sequential(
            group
                .children
                .as_slice()
                .iter()
                .map(|child| validate_concurrency(child, bindings)),
        ),
        GraphNode::Choice(group) => validate_choice_concurrency(group, bindings),
        GraphNode::Par(group) => validate_parallel_concurrency(group, bindings),
        GraphNode::Loop(group) => validate_concurrency(&group.body, bindings),
        GraphNode::Map(group) => validate_map_concurrency(group, bindings),
        GraphNode::Succeed(_) | GraphNode::Fail(_) => Ok(PossibleExecutions::default()),
    }
}

fn writer(name: NodeName) -> PossibleExecutions {
    PossibleExecutions {
        writers: vec![name],
        ..PossibleExecutions::default()
    }
}

fn verifier_execution(
    name: &NodeName,
    bindings: &BTreeMap<NodeName, NodeRuntimeBinding>,
) -> PossibleExecutions {
    if matches!(
        bindings.get(name),
        Some(NodeRuntimeBinding::GitDelivery { .. })
    ) {
        writer(name.clone())
    } else {
        PossibleExecutions {
            readers: vec![name.clone()],
            ..PossibleExecutions::default()
        }
    }
}

fn validate_choice_concurrency(
    group: &openengine_cluster_protocol::ChoiceNode,
    bindings: &BTreeMap<NodeName, NodeRuntimeBinding>,
) -> Result<PossibleExecutions, NativeV2AdmissionError> {
    let branches = group
        .branches
        .as_slice()
        .iter()
        .map(|branch| validate_concurrency(&branch.node, bindings));
    let otherwise = group
        .otherwise
        .iter()
        .map(|node| validate_concurrency(node, bindings));
    fold_sequential(branches.chain(otherwise))
}

fn validate_parallel_concurrency(
    group: &openengine_cluster_protocol::ParNode,
    bindings: &BTreeMap<NodeName, NodeRuntimeBinding>,
) -> Result<PossibleExecutions, NativeV2AdmissionError> {
    let branches = group
        .branches
        .as_slice()
        .iter()
        .map(|branch| validate_concurrency(branch, bindings))
        .collect::<Result<Vec<_>, _>>()?;
    reject_parallel_writers(&branches)?;
    Ok(fold_collected(branches))
}

fn reject_parallel_writers(branches: &[PossibleExecutions]) -> Result<(), NativeV2AdmissionError> {
    for left_index in 0..branches.len() {
        for right_index in (left_index + 1)..branches.len() {
            reject_writer_pair(&branches[left_index], &branches[right_index])?;
            reject_writer_pair(&branches[right_index], &branches[left_index])?;
        }
    }
    Ok(())
}

fn validate_map_concurrency(
    group: &openengine_cluster_protocol::MapNode,
    bindings: &BTreeMap<NodeName, NodeRuntimeBinding>,
) -> Result<PossibleExecutions, NativeV2AdmissionError> {
    let body = validate_concurrency(&group.body, bindings)?;
    if let Some(writer) = concurrent_map_writer(group.max_items.get(), &body) {
        return Err(NativeV2AdmissionError::ConcurrentMapWriter {
            map: group.name.clone(),
            writer: writer.clone(),
        });
    }
    Ok(body)
}

fn concurrent_map_writer(max_items: u64, body: &PossibleExecutions) -> Option<&NodeName> {
    (max_items > 1).then(|| body.writers.first()).flatten()
}

fn reject_writer_pair(
    possible_writer: &PossibleExecutions,
    other: &PossibleExecutions,
) -> Result<(), NativeV2AdmissionError> {
    if let (Some(writer), Some(other)) = (possible_writer.writers.first(), other.any()) {
        return Err(NativeV2AdmissionError::ConcurrentWriter {
            writer: writer.clone(),
            other: other.clone(),
        });
    }
    Ok(())
}

fn fold_sequential(
    values: impl IntoIterator<Item = Result<PossibleExecutions, NativeV2AdmissionError>>,
) -> Result<PossibleExecutions, NativeV2AdmissionError> {
    let values = values.into_iter().collect::<Result<Vec<_>, _>>()?;
    Ok(fold_collected(values))
}

fn fold_collected(values: Vec<PossibleExecutions>) -> PossibleExecutions {
    values
        .into_iter()
        .fold(PossibleExecutions::default(), |mut combined, item| {
            combined.append(item);
            combined
        })
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
mod tests {
    use super::*;
    use crate::execution::SessionScope;
    use crate::native_v2_contract::{CodexProvider, ClaudeProvider};
    use crate::worker_catalog::ModelId;
    use openengine_cluster_protocol::IdempotencyKey;
    use serde_json::{json, Value};

    fn null_verifier(name: &str, worker: &str) -> Value {
        json!({
            "kind":"verifier", "name":name, "worker":worker,
            "input":{"kind":"null"}, "output":{"kind":"null"},
            "inputBindings":[], "writeBindings":[], "timeoutMs":1000, "attempts":1,
            "signals":{"verdict":["accepted","rejected"]}, "diagnostic":{"kind":"null"}
        })
    }

    fn null_step(name: &str, worker: &str) -> Value {
        json!({
            "kind":"step", "name":name, "worker":worker,
            "input":{"kind":"null"}, "output":{"kind":"null"},
            "inputBindings":[], "writeBindings":[], "timeoutMs":1000, "attempts":1
        })
    }

    fn succeed(name: &str) -> Value {
        json!({"kind":"succeed","name":name,"output":{"kind":"null"},"bindings":[]})
    }

    fn graph(children: Vec<Value>) -> GraphSpec {
        serde_json::from_value(json!({
            "profile":"openengine.graph.full/v1",
            "initialInput":{"kind":"record","fields":{
                "items":{"type":{"kind":"array","items":{"kind":"null"}},"required":true}
            }},
            "policy":{"policy":"policy.native-v2@1","default":"deny"},
            "root":{"kind":"seq","name":"root","state":{"kind":"record","fields":{
                "items":{"type":{"kind":"array","items":{"kind":"null"}},"required":true}
            }},"children":children,"promotedStatePaths":[]}
        }))
        .unwrap()
    }

    fn binding(model: &str, effort: Option<ReasoningEffort>) -> NodeRuntimeBinding {
        NodeRuntimeBinding::Agent {
            model: ModelId::new(model).unwrap(),
            effort,
            session_scope: SessionScope::Execution,
            env: BTreeSet::new(),
        }
    }

    fn submission(
        graph: GraphSpec,
        nodes: BTreeMap<NodeName, NodeRuntimeBinding>,
    ) -> RunSubmission {
        RunSubmission {
            graph,
            initial_input: json!({"items":[null]}),
            runtime: RuntimePlan::Claude {
                provider: ClaudeProvider::Anthropic,
                nodes,
            },
            ship: false,
            submission_key: IdempotencyKey::new("admission-test").unwrap(),
        }
    }

    fn named(name: &str) -> NodeName {
        NodeName::new(name).unwrap()
    }

    #[tokio::test]
    async fn admits_authored_loop_and_parallel_verifiers_and_defaults_effort_to_max() {
        let graph = graph(vec![
            json!({
                "kind":"loop","name":"retry","state":{"kind":"record","fields":{
                    "items":{"type":{"kind":"array","items":{"kind":"null"}},"required":true}
                }},
                "body":null_verifier("loopVerify", "verify.same@1"),
                "until":{
                    "kind":"in",
                    "value":{"name":"loopVerify","source":"signal","field":"verdict"},
                    "labels":["accepted"]
                },
                "maxIterations":2,"promotedStatePaths":[]
            }),
            json!({
                "kind":"par","name":"checks","state":{"kind":"record","fields":{
                    "items":{"type":{"kind":"array","items":{"kind":"null"}},"required":true}
                }},
                "branches":[
                    null_verifier("left", "verify.same@1"),
                    null_verifier("right", "verify.same@1")
                ],
                "promotedStatePaths":[],"join":{"kind":"all"}
            }),
            succeed("done"),
        ]);
        let nodes = ["loopVerify", "left", "right"]
            .map(|name| (named(name), binding("claude-sonnet-5", None)))
            .into_iter()
            .collect();

        let admitted = NativeV2Admission
            .admit(submission(graph, nodes))
            .await
            .unwrap();

        for binding in admitted.runtime.nodes().values() {
            let NodeRuntimeBinding::Agent { effort, .. } = binding else {
                panic!("fixture has only agent bindings")
            };
            assert_eq!(*effort, Some(ReasoningEffort::Max));
        }
    }

    #[tokio::test]
    async fn rejects_non_full_profile_and_invalid_actual_input() {
        let base = graph(vec![succeed("done")]);
        let mut wrong_profile = base.clone();
        wrong_profile.profile = GraphProfile::SingleWorker;
        assert_eq!(
            NativeV2Admission
                .admit(submission(wrong_profile, BTreeMap::new()))
                .await,
            Err(NativeV2AdmissionError::UnsupportedGraphProfile)
        );

        let mut invalid = submission(base, BTreeMap::new());
        invalid.initial_input = json!({"items":"not-an-array"});
        assert!(matches!(
            NativeV2Admission.admit(invalid).await,
            Err(NativeV2AdmissionError::InitialInput(_))
        ));
    }

    #[tokio::test]
    async fn rejects_non_single_attempts_and_runtime_coverage_errors() {
        let mut value = null_step("work", "agent.work@1");
        value["attempts"] = json!(2);
        let attempts_graph = graph(vec![value, succeed("done")]);
        let nodes = BTreeMap::from([(named("work"), binding("claude-sonnet-5", None))]);
        assert!(matches!(
            NativeV2Admission
                .admit(submission(attempts_graph, nodes))
                .await,
            Err(NativeV2AdmissionError::Attempts { .. })
        ));

        let graph = graph(vec![null_step("work", "agent.work@1"), succeed("done")]);
        assert!(matches!(
            NativeV2Admission
                .admit(submission(graph.clone(), BTreeMap::new()))
                .await,
            Err(NativeV2AdmissionError::MissingRuntimeBinding { .. })
        ));
        let nodes = BTreeMap::from([
            (named("work"), binding("claude-sonnet-5", None)),
            (named("ghost"), binding("claude-sonnet-5", None)),
        ]);
        assert!(matches!(
            NativeV2Admission.admit(submission(graph, nodes)).await,
            Err(NativeV2AdmissionError::UnexpectedRuntimeBinding { .. })
        ));
    }

    #[tokio::test]
    async fn rejects_inconsistent_worker_reuse() {
        let graph = graph(vec![
            null_step("first", "agent.shared@1"),
            null_verifier("second", "agent.shared@1"),
            succeed("done"),
        ]);
        let nodes = BTreeMap::from([
            (named("first"), binding("claude-sonnet-5", None)),
            (named("second"), binding("claude-sonnet-5", None)),
        ]);
        assert!(matches!(
            NativeV2Admission.admit(submission(graph, nodes)).await,
            Err(NativeV2AdmissionError::InconsistentWorkerReuse { .. })
        ));
    }

    #[tokio::test]
    async fn enforces_delivery_shape_and_ship_authorization() {
        let step_graph = graph(vec![
            null_step("deliver", "git.delivery@1"),
            succeed("done"),
        ]);
        let mut request = submission(
            step_graph,
            BTreeMap::from([(
                named("deliver"),
                NodeRuntimeBinding::GitDelivery {
                    env: BTreeSet::new(),
                },
            )]),
        );
        request.ship = true;
        assert!(matches!(
            NativeV2Admission.admit(request).await,
            Err(NativeV2AdmissionError::DeliveryMustBeVerifier { .. })
        ));

        let delivery_graph = graph(vec![
            null_verifier("deliver", "git.delivery@1"),
            succeed("done"),
        ]);
        let delivery = BTreeMap::from([(
            named("deliver"),
            NodeRuntimeBinding::GitDelivery {
                env: BTreeSet::new(),
            },
        )]);
        assert!(matches!(
            NativeV2Admission
                .admit(submission(delivery_graph, delivery))
                .await,
            Err(NativeV2AdmissionError::DeliveryRequiresShipping { .. })
        ));

        let mut no_delivery = submission(graph(vec![succeed("done")]), BTreeMap::new());
        no_delivery.ship = true;
        assert_eq!(
            NativeV2Admission.admit(no_delivery).await,
            Err(NativeV2AdmissionError::ShippingDeliveryCount { found: 0 })
        );
    }

    #[tokio::test]
    async fn enforces_harness_model_and_effort_catalog() {
        let graph = graph(vec![null_step("work", "agent.work@1"), succeed("done")]);
        let codex_wrong_model = RunSubmission {
            graph: graph.clone(),
            initial_input: json!({"items":[null]}),
            runtime: RuntimePlan::Codex {
                provider: CodexProvider::OpenAi,
                nodes: BTreeMap::from([(
                    named("work"),
                    binding("claude-sonnet-5", Some(ReasoningEffort::Max)),
                )]),
            },
            ship: false,
            submission_key: IdempotencyKey::new("codex-model").unwrap(),
        };
        assert!(matches!(
            NativeV2Admission.admit(codex_wrong_model).await,
            Err(NativeV2AdmissionError::UnsupportedModel { .. })
        ));

        let haiku_effort = submission(
            graph,
            BTreeMap::from([(
                named("work"),
                binding("claude-haiku-4-5", Some(ReasoningEffort::Low)),
            )]),
        );
        assert!(matches!(
            NativeV2Admission.admit(haiku_effort).await,
            Err(NativeV2AdmissionError::UnsupportedEffort { .. })
        ));
    }

    #[tokio::test]
    async fn rejects_parallel_writers_mixed_parallelism_and_writer_maps() {
        let par = |left, right| {
            graph(vec![
                json!({
                    "kind":"par","name":"parallel","state":{"kind":"record","fields":{
                        "items":{"type":{"kind":"array","items":{"kind":"null"}},"required":true}
                    }},"branches":[left,right],"promotedStatePaths":[],"join":{"kind":"all"}
                }),
                succeed("done"),
            ])
        };
        let workers = par(
            null_step("left", "agent.left@1"),
            null_step("right", "agent.right@1"),
        );
        let nodes = BTreeMap::from([
            (named("left"), binding("claude-sonnet-5", None)),
            (named("right"), binding("claude-sonnet-5", None)),
        ]);
        assert!(matches!(
            NativeV2Admission.admit(submission(workers, nodes)).await,
            Err(NativeV2AdmissionError::ConcurrentWriter { .. })
        ));

        let mixed = par(
            null_step("writer", "agent.writer@1"),
            null_verifier("reader", "verify.reader@1"),
        );
        let nodes = BTreeMap::from([
            (named("writer"), binding("claude-sonnet-5", None)),
            (named("reader"), binding("claude-sonnet-5", None)),
        ]);
        assert!(matches!(
            NativeV2Admission.admit(submission(mixed, nodes)).await,
            Err(NativeV2AdmissionError::ConcurrentWriter { .. })
        ));

        let delivery_parallel = par(
            null_verifier("deliver", "git.delivery@1"),
            null_verifier("reader", "verify.reader@1"),
        );
        let mut delivery_request = submission(
            delivery_parallel,
            BTreeMap::from([
                (
                    named("deliver"),
                    NodeRuntimeBinding::GitDelivery {
                        env: BTreeSet::new(),
                    },
                ),
                (named("reader"), binding("claude-sonnet-5", None)),
            ]),
        );
        delivery_request.ship = true;
        assert!(matches!(
            NativeV2Admission.admit(delivery_request).await,
            Err(NativeV2AdmissionError::ConcurrentWriter { .. })
        ));

        let mapped = graph(vec![
            json!({
                "kind":"map","name":"each","state":{"kind":"record","fields":{
                    "items":{"type":{"kind":"array","items":{"kind":"null"}},"required":true}
                }},"body":null_step("mapped", "agent.mapped@1"),
                "over":{"source":"state","path":["items"]},"maxItems":2,"promotedStatePaths":[]
            }),
            succeed("done"),
        ]);
        let nodes = BTreeMap::from([(named("mapped"), binding("claude-sonnet-5", None))]);
        assert!(matches!(
            NativeV2Admission.admit(submission(mapped, nodes)).await,
            Err(NativeV2AdmissionError::ConcurrentMapWriter { .. })
        ));
    }

    #[tokio::test]
    async fn delegates_remaining_graph_language_errors_to_production_verifier() {
        let graph = graph(vec![
            json!({
                "kind":"loop","name":"never","state":{"kind":"record","fields":{
                    "items":{"type":{"kind":"array","items":{"kind":"null"}},"required":true}
                }},"body":null_verifier("verify", "verify.loop@1"),
                "until":{"kind":"all","guards":[
                    {"kind":"in","value":{"name":"verify","source":"signal","field":"verdict"},"labels":["accepted"]},
                    {"kind":"not","guard":{
                        "kind":"in",
                        "value":{"name":"verify","source":"signal","field":"verdict"},
                        "labels":["accepted"]
                    }}
                ]},"maxIterations":2,"promotedStatePaths":[]
            }),
            succeed("done"),
        ]);
        let nodes = BTreeMap::from([(named("verify"), binding("claude-sonnet-5", None))]);
        assert!(matches!(
            NativeV2Admission.admit(submission(graph, nodes)).await,
            Err(NativeV2AdmissionError::GraphVerification(
                VerificationError::Rejected { .. }
            ))
        ));
    }
}
