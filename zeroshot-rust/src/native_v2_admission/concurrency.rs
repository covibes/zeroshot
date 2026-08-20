use super::*;

#[derive(Clone, Debug, Default)]
pub(super) struct PossibleExecutions {
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

pub(super) fn validate_concurrency(
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
    for (left_index, left) in branches.iter().enumerate() {
        for right in branches.iter().skip(left_index + 1) {
            reject_writer_pair(left, right)?;
            reject_writer_pair(right, left)?;
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
