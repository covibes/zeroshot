//! Pre-admission worker resolution and schema compatibility port.

use async_trait::async_trait;
use openengine_cluster_protocol::{
    GraphNode, GraphProfile, GraphSpec, PayloadType, VerifierContract, WorkerDescriptor, WorkerRef,
};
use thiserror::Error;

#[derive(Clone, Debug, Error, Eq, PartialEq)]
pub enum WorkerRegistryError {
    #[error("worker descriptor not found: {worker}")]
    NotFound { worker: WorkerRef },
    #[error("worker descriptor version is unavailable: {worker}")]
    VersionUnavailable { worker: WorkerRef },
}

#[async_trait]
pub trait WorkerRegistry: Send + Sync {
    /// Resolves one exact stable reference. Implementations must not perform latest-version lookup.
    async fn resolve(&self, worker: &WorkerRef) -> Result<WorkerDescriptor, WorkerRegistryError>;
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum WorkerCompatibilityCode {
    Registry,
    DescriptorContract,
    DescriptorIdentity,
    GraphProfile,
    Input,
    Output,
    VerifierContract,
    SignalField,
    SignalLabels,
    Diagnostic,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkerCompatibilityDiagnostic {
    pub code: WorkerCompatibilityCode,
    pub worker: WorkerRef,
    /// Deterministic root-to-node sequence of graph node names.
    pub path: Vec<String>,
    pub message: String,
}

enum WorkerNode<'a> {
    Step {
        worker: &'a WorkerRef,
        input: &'a PayloadType,
        output: &'a PayloadType,
    },
    Verifier {
        worker: &'a WorkerRef,
        input: &'a PayloadType,
        output: &'a PayloadType,
        contract: VerifierContractRef<'a>,
    },
}

struct VerifierContractRef<'a> {
    signals: &'a std::collections::BTreeMap<
        openengine_cluster_protocol::FieldName,
        openengine_cluster_protocol::NonEmptyEnumSet,
    >,
    diagnostic: &'a PayloadType,
}

struct LocatedWorker<'a> {
    path: Vec<String>,
    node: WorkerNode<'a>,
}

impl LocatedWorker<'_> {
    fn worker(&self) -> &WorkerRef {
        match &self.node {
            WorkerNode::Step { worker, .. } | WorkerNode::Verifier { worker, .. } => worker,
        }
    }
}

/// Checks every executable node in source order. This is composable with a later graph admission
/// backend and intentionally does not admit, store, or execute the graph.
pub async fn check_graph_workers<R>(
    graph: &GraphSpec,
    registry: &R,
) -> Result<(), Vec<WorkerCompatibilityDiagnostic>>
where
    R: WorkerRegistry + ?Sized,
{
    let mut nodes = Vec::new();
    collect_workers(&graph.root, &mut Vec::new(), &mut nodes);
    let mut diagnostics = Vec::new();
    for located in nodes {
        let worker = located.worker();
        match registry.resolve(worker).await {
            Ok(descriptor) => {
                check_descriptor(graph.profile, &located, &descriptor, &mut diagnostics)
            }
            Err(error) => diagnostics.push(WorkerCompatibilityDiagnostic {
                code: WorkerCompatibilityCode::Registry,
                worker: worker.clone(),
                path: located.path,
                message: error.to_string(),
            }),
        }
    }
    if diagnostics.is_empty() {
        Ok(())
    } else {
        Err(diagnostics)
    }
}

fn check_descriptor(
    graph_profile: GraphProfile,
    located: &LocatedWorker<'_>,
    descriptor: &WorkerDescriptor,
    diagnostics: &mut Vec<WorkerCompatibilityDiagnostic>,
) {
    let (worker, input, output) = match &located.node {
        WorkerNode::Step {
            worker,
            input,
            output,
        }
        | WorkerNode::Verifier {
            worker,
            input,
            output,
            ..
        } => (*worker, *input, *output),
    };
    let mut report = |code, message: String| {
        diagnostics.push(WorkerCompatibilityDiagnostic {
            code,
            worker: worker.clone(),
            path: located.path.clone(),
            message,
        });
    };

    if let Err(error) = descriptor.validate() {
        report(
            WorkerCompatibilityCode::DescriptorContract,
            format!("invalid resolved descriptor: {error}"),
        );
        return;
    }

    if descriptor.worker != *worker {
        report(
            WorkerCompatibilityCode::DescriptorIdentity,
            format!(
                "registry returned descriptor {} for requested {worker}",
                descriptor.worker
            ),
        );
    }
    if !descriptor.graph_profiles.contains(&graph_profile) {
        report(
            WorkerCompatibilityCode::GraphProfile,
            format!("descriptor does not allow graph profile {graph_profile}"),
        );
    }
    if !input.is_subtype_of(&descriptor.contract.input) {
        report(
            WorkerCompatibilityCode::Input,
            "graph input is not a subtype of descriptor input".to_owned(),
        );
    }
    if !descriptor.contract.output.is_subtype_of(output) {
        report(
            WorkerCompatibilityCode::Output,
            "descriptor output is not a subtype of graph output".to_owned(),
        );
    }

    match &located.node {
        WorkerNode::Step { .. } => {
            if descriptor.contract.verifier.is_some() {
                report(
                    WorkerCompatibilityCode::VerifierContract,
                    "step node resolved to a verifier-only descriptor".to_owned(),
                );
            }
        }
        WorkerNode::Verifier { contract, .. } => match &descriptor.contract.verifier {
            Some(descriptor_verifier) => {
                check_verifier(located, contract, descriptor_verifier, diagnostics);
            }
            None => report(
                WorkerCompatibilityCode::VerifierContract,
                "verifier node resolved to a non-verifier descriptor".to_owned(),
            ),
        },
    }
}

fn check_verifier(
    located: &LocatedWorker<'_>,
    graph: &VerifierContractRef<'_>,
    descriptor: &VerifierContract,
    diagnostics: &mut Vec<WorkerCompatibilityDiagnostic>,
) {
    let worker = located.worker();
    for (field, labels) in &descriptor.signals {
        match graph.signals.get(field) {
            None => diagnostics.push(WorkerCompatibilityDiagnostic {
                code: WorkerCompatibilityCode::SignalField,
                worker: worker.clone(),
                path: located.path.clone(),
                message: format!("descriptor signal {field} is absent from graph declaration"),
            }),
            Some(graph_labels) if !labels.is_subset(graph_labels) => {
                diagnostics.push(WorkerCompatibilityDiagnostic {
                    code: WorkerCompatibilityCode::SignalLabels,
                    worker: worker.clone(),
                    path: located.path.clone(),
                    message: format!("descriptor labels for signal {field} exceed graph labels"),
                });
            }
            Some(_) => {}
        }
    }
    if !descriptor.diagnostic.is_subtype_of(graph.diagnostic) {
        diagnostics.push(WorkerCompatibilityDiagnostic {
            code: WorkerCompatibilityCode::Diagnostic,
            worker: worker.clone(),
            path: located.path.clone(),
            message: "descriptor diagnostic is not a subtype of graph diagnostic".to_owned(),
        });
    }
}

fn collect_workers<'a>(
    node: &'a GraphNode,
    parent: &mut Vec<String>,
    workers: &mut Vec<LocatedWorker<'a>>,
) {
    parent.push(node.name().as_str().to_owned());
    if let Some(worker) = worker_node(node) {
        workers.push(LocatedWorker {
            path: parent.clone(),
            node: worker,
        });
    }
    for child in crate::graph_verifier::graph_node_children(node) {
        collect_workers(child, parent, workers);
    }
    parent.pop();
}

fn worker_node(node: &GraphNode) -> Option<WorkerNode<'_>> {
    match node {
        GraphNode::Step(node) => Some(WorkerNode::Step {
            worker: &node.worker,
            input: &node.input,
            output: &node.output,
        }),
        GraphNode::Verifier(node) => Some(WorkerNode::Verifier {
            worker: &node.worker,
            input: &node.input,
            output: &node.output,
            contract: VerifierContractRef {
                signals: &node.signals,
                diagnostic: &node.diagnostic,
            },
        }),
        _ => None,
    }
}
