use super::*;

pub(super) fn collect_descendant_names(branches: &NonEmptyVec<GraphNode>) -> BTreeSet<NodeName> {
    let mut names = BTreeSet::new();
    for branch in branches.as_slice() {
        collect_names(branch, &mut names);
    }
    names
}

pub(super) fn collect_names(node: &GraphNode, names: &mut BTreeSet<NodeName>) {
    names.insert(node.name().clone());
    for child in child_nodes(node) {
        collect_names(child, names);
    }
}

/// Returns the graph-visible children of `node` in authored order.
#[must_use]
pub fn child_nodes(node: &GraphNode) -> Vec<&GraphNode> {
    match node {
        GraphNode::Seq(group) => group.children.as_slice().iter().collect(),
        GraphNode::Choice(group) => group
            .branches
            .as_slice()
            .iter()
            .map(|branch| &branch.node)
            .chain(group.otherwise.iter().map(Box::as_ref))
            .collect(),
        GraphNode::Par(group) => group.branches.as_slice().iter().collect(),
        GraphNode::Loop(group) => vec![&group.body],
        GraphNode::Map(group) => vec![&group.body],
        GraphNode::Step(_)
        | GraphNode::Verifier(_)
        | GraphNode::Succeed(_)
        | GraphNode::Fail(_) => Vec::new(),
    }
}

pub(super) fn find_map_owner<'a>(
    node: &'a GraphNode,
    target: &NodeName,
    owner: Option<&'a NodeName>,
) -> Option<&'a NodeName> {
    if node.name() == target {
        return owner;
    }
    match node {
        GraphNode::Seq(group) => group
            .children
            .as_slice()
            .iter()
            .find_map(|child| find_map_owner(child, target, owner)),
        GraphNode::Choice(group) => group
            .branches
            .as_slice()
            .iter()
            .find_map(|branch| find_map_owner(&branch.node, target, owner))
            .or_else(|| {
                group
                    .otherwise
                    .as_ref()
                    .and_then(|node| find_map_owner(node, target, owner))
            }),
        GraphNode::Par(group) => group
            .branches
            .as_slice()
            .iter()
            .find_map(|branch| find_map_owner(branch, target, owner)),
        GraphNode::Loop(group) => find_map_owner(&group.body, target, owner),
        GraphNode::Map(group) => find_map_owner(&group.body, target, Some(&group.name)),
        GraphNode::Step(_)
        | GraphNode::Verifier(_)
        | GraphNode::Succeed(_)
        | GraphNode::Fail(_) => None,
    }
}
