use super::*;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NodeRole {
    Worker,
    Verifier,
    GitDelivery,
}

pub(super) struct ResolvedNodePlan {
    pub(super) role: NodeRole,
    pub(super) response: NodeResponseContract,
}

impl NodeRole {
    pub(super) const fn workspace_access(self) -> WorkspaceAccess {
        match self {
            Self::Verifier => WorkspaceAccess::ReadOnly,
            Self::Worker | Self::GitDelivery => WorkspaceAccess::Exclusive,
        }
    }
}

#[derive(Clone, Debug)]
struct PlannedNode {
    worker: WorkerRef,
    instructions: Option<openengine_cluster_protocol::NodeInstructions>,
    binding: NodeRuntimeBinding,
    role: NodeRole,
    response: NodeResponseContract,
}

/// Immutable authority for execution role and runtime binding, derived from admitted input.
#[derive(Clone, Debug)]
pub(super) struct NodeRolePlan {
    nodes: Arc<BTreeMap<NodeName, PlannedNode>>,
}

impl NodeRolePlan {
    pub(super) fn from_admitted(admitted: &AdmittedRun) -> Result<Self, NodeRunnerError> {
        let mut nodes = BTreeMap::new();
        collect_planned_nodes(&admitted.graph.root, admitted.runtime.nodes(), &mut nodes)?;
        if nodes.len() != admitted.runtime.nodes().len() {
            return Err(NodeRunnerError::InvalidRole);
        }
        Ok(Self {
            nodes: Arc::new(nodes),
        })
    }

    pub(super) fn resolve(
        &self,
        invocation: &NodeInvocation,
    ) -> Result<ResolvedNodePlan, NodeRunnerError> {
        let planned = self
            .nodes
            .get(&invocation.reference.node)
            .ok_or(NodeRunnerError::InvalidRole)?;
        if planned.worker != invocation.worker
            || planned.instructions != invocation.instructions
            || planned.binding != invocation.binding
        {
            return Err(NodeRunnerError::InvalidRole);
        }
        Ok(ResolvedNodePlan {
            role: planned.role,
            response: planned.response.clone(),
        })
    }
}

fn collect_planned_nodes(
    node: &GraphNode,
    bindings: &BTreeMap<NodeName, NodeRuntimeBinding>,
    nodes: &mut BTreeMap<NodeName, PlannedNode>,
) -> Result<(), NodeRunnerError> {
    if let Some((name, worker, instructions, binding, role, response)) =
        planned_executable(node, bindings)?
    {
        if nodes
            .insert(
                name.clone(),
                PlannedNode {
                    worker: worker.clone(),
                    instructions: instructions.cloned(),
                    binding: binding.clone(),
                    role,
                    response,
                },
            )
            .is_some()
        {
            return Err(NodeRunnerError::InvalidRole);
        }
    }
    for child in openengine_cluster_server::graph_verifier::graph_node_children(node) {
        collect_planned_nodes(child, bindings, nodes)?;
    }
    Ok(())
}

type PlannedExecutable<'a> = (
    &'a NodeName,
    &'a WorkerRef,
    Option<&'a openengine_cluster_protocol::NodeInstructions>,
    &'a NodeRuntimeBinding,
    NodeRole,
    NodeResponseContract,
);

fn planned_executable<'a>(
    node: &'a GraphNode,
    bindings: &'a BTreeMap<NodeName, NodeRuntimeBinding>,
) -> Result<Option<PlannedExecutable<'a>>, NodeRunnerError> {
    match node {
        GraphNode::Step(step) => planned_step(step, bindings).map(Some),
        GraphNode::Verifier(verifier) => planned_verifier(verifier, bindings).map(Some),
        _ => Ok(None),
    }
}

fn planned_step<'a>(
    step: &'a openengine_cluster_protocol::StepNode,
    bindings: &'a BTreeMap<NodeName, NodeRuntimeBinding>,
) -> Result<PlannedExecutable<'a>, NodeRunnerError> {
    let binding = bindings
        .get(&step.name)
        .ok_or(NodeRunnerError::InvalidRole)?;
    if !matches!(binding, NodeRuntimeBinding::Agent { .. }) {
        return Err(NodeRunnerError::InvalidRole);
    }
    let instructions = step
        .instructions
        .as_ref()
        .ok_or(NodeRunnerError::InvalidRole)?;
    Ok((
        &step.name,
        &step.worker,
        Some(instructions),
        binding,
        NodeRole::Worker,
        NodeResponseContract::Worker {
            output: step.output.clone(),
        },
    ))
}

fn planned_verifier<'a>(
    verifier: &'a openengine_cluster_protocol::VerifierNode,
    bindings: &'a BTreeMap<NodeName, NodeRuntimeBinding>,
) -> Result<PlannedExecutable<'a>, NodeRunnerError> {
    let binding = bindings
        .get(&verifier.name)
        .ok_or(NodeRunnerError::InvalidRole)?;
    let (role, instructions) = planned_verifier_role(verifier, binding)?;
    Ok((
        &verifier.name,
        &verifier.worker,
        instructions,
        binding,
        role,
        NodeResponseContract::Verifier {
            output: verifier.output.clone(),
            signals: verifier.signals.clone(),
            diagnostic: verifier.diagnostic.clone(),
        },
    ))
}

fn planned_verifier_role<'a>(
    verifier: &'a openengine_cluster_protocol::VerifierNode,
    binding: &NodeRuntimeBinding,
) -> Result<
    (
        NodeRole,
        Option<&'a openengine_cluster_protocol::NodeInstructions>,
    ),
    NodeRunnerError,
> {
    match binding {
        NodeRuntimeBinding::Agent { .. } => Ok((
            NodeRole::Verifier,
            Some(
                verifier
                    .instructions
                    .as_ref()
                    .ok_or(NodeRunnerError::InvalidRole)?,
            ),
        )),
        NodeRuntimeBinding::GitDelivery { .. } if verifier.instructions.is_none() => {
            Ok((NodeRole::GitDelivery, None))
        }
        NodeRuntimeBinding::GitDelivery { .. } => Err(NodeRunnerError::InvalidRole),
    }
}
