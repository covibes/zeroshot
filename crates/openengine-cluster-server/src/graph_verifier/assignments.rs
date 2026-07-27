use super::*;

pub(super) fn outcome_refinement(assignments: &[&Assignment]) -> OutcomeRefinement {
    let names = assignments
        .iter()
        .flat_map(|assignment| assignment.keys())
        .filter(|key| {
            matches!(
                key.source,
                ControlSourceKey::Signal | ControlSourceKey::Error
            ) || is_parallel_group_control(key)
        })
        .map(|key| key.name.clone())
        .collect::<BTreeSet<_>>();
    let mut refinement = OutcomeRefinement::default();
    for name in names {
        if assignments
            .iter()
            .any(|assignment| assignment_has_failure(assignment, &name))
        {
            refinement.failed.insert(name);
        } else {
            refinement.success.insert(name);
        }
    }
    refinement
}

pub(super) fn assignment_has_failure(assignment: &Assignment, name: &NodeName) -> bool {
    let mut has_signal = false;
    let mut signal_occurrences = 0_u64;
    for (key, value) in assignment.iter().filter(|(key, _)| key.name == *name) {
        match key.source {
            ControlSourceKey::Error if value.counts.values().any(|count| *count > 0) => {
                return true;
            }
            ControlSourceKey::Group
                if is_parallel_group_control(key)
                    && value.counts.iter().any(|(label, count)| {
                        *count > 0
                            && matches!(label.as_str(), "quorum_unreachable" | "no_satisfier")
                    }) =>
            {
                return true;
            }
            ControlSourceKey::Signal => {
                has_signal = true;
                signal_occurrences =
                    signal_occurrences.saturating_add(value.counts.values().copied().sum::<u64>());
            }
            ControlSourceKey::Error | ControlSourceKey::Group | ControlSourceKey::Execution => {}
        }
    }
    has_signal && signal_occurrences == 0
}

fn is_parallel_group_control(key: &SelectorKey) -> bool {
    key.source == ControlSourceKey::Group
        && key
            .field
            .as_ref()
            .is_some_and(|field| matches!(field.as_str(), "joined" | "raced"))
}

#[derive(Clone, Copy)]
pub(super) struct DimensionInputs<'a, 'graph> {
    pub(super) nodes: &'a BTreeMap<NodeName, NodeInfo<'graph>>,
    pub(super) map_aggregates: &'a BTreeMap<SelectorKey, MapAggregate>,
    pub(super) join_correlations: &'a BTreeMap<NodeName, ParallelJoinCorrelation>,
    pub(super) execution_correlations: &'a BTreeMap<NodeName, MapExecutionCorrelation>,
}

pub(super) fn build_dimensions(
    selectors: &[ControlSelector],
    inputs: DimensionInputs<'_, '_>,
) -> Option<Vec<Vec<Assignment>>> {
    let mut by_node = BTreeMap::<NodeName, BTreeSet<SelectorKey>>::new();
    for selector in selectors {
        by_node
            .entry(selector.name.clone())
            .or_default()
            .insert(SelectorKey::from(selector));
    }
    let mut aggregate_scopes =
        BTreeMap::<NodeName, (u64, BTreeMap<NodeName, Vec<SelectorKey>>)>::new();
    for (name, keys) in &by_node {
        for key in keys {
            let Some(aggregate) = inputs.map_aggregates.get(key) else {
                continue;
            };
            let (maximum, scope_nodes) = aggregate_scopes
                .entry(aggregate.owner.clone())
                .or_insert_with(|| (aggregate.maximum, BTreeMap::new()));
            if *maximum != aggregate.maximum {
                return None;
            }
            scope_nodes
                .entry(name.clone())
                .or_default()
                .push(key.clone());
        }
    }
    let shared_by_scope = aggregate_scopes
        .iter()
        .map(|(owner, (_, scope_nodes))| {
            let mut shared =
                aggregate_shared_keys(scope_nodes, inputs.map_aggregates, inputs.join_correlations);
            shared.extend(aggregate_shared_execution_keys(
                scope_nodes,
                inputs.map_aggregates,
                inputs.execution_correlations,
            ));
            (owner.clone(), shared)
        })
        .collect::<BTreeMap<_, _>>();
    let shared_keys = shared_by_scope
        .values()
        .flatten()
        .cloned()
        .collect::<BTreeSet<_>>();

    let mut dimensions = Vec::new();
    for (name, keys) in &by_node {
        let Some(node) = inputs.nodes.get(name).map(|info| info.node) else {
            continue;
        };
        let standalone = keys
            .difference(&shared_keys)
            .cloned()
            .collect::<BTreeSet<_>>();
        dimensions.extend(scalar_dimensions_for_node(
            node,
            &standalone,
            inputs.map_aggregates,
        )?);
    }
    for (owner, (maximum, scope_nodes)) in aggregate_scopes {
        dimensions.extend(aggregate_scope_dimensions(
            inputs,
            &scope_nodes,
            maximum,
            shared_by_scope.get(&owner).cloned().unwrap_or_default(),
        )?);
    }
    Some(dimensions)
}

pub(super) fn enumerate_assignments(dimensions: Vec<Vec<Assignment>>) -> Vec<Assignment> {
    let mut assignments = vec![Assignment::new()];
    for dimension in dimensions {
        let capacity = assignments
            .len()
            .saturating_mul(dimension.len())
            .min(FULL_V1_MAX_GUARD_ASSIGNMENTS as usize);
        let mut next = Vec::with_capacity(capacity);
        for prefix in &assignments {
            for choice in &dimension {
                if !assignments_are_compatible(prefix, choice) {
                    continue;
                }
                let mut assignment = prefix.clone();
                assignment.extend(choice.clone());
                next.push(assignment);
            }
        }
        assignments = next;
    }
    assignments
}

pub(super) fn compatible_assignment_count_is_bounded(
    dimensions: &[Vec<Assignment>],
    maximum: u64,
) -> bool {
    let mut assignments = vec![Assignment::new()];
    for dimension in dimensions {
        let mut next = Vec::new();
        for prefix in &assignments {
            for choice in dimension {
                if !assignments_are_compatible(prefix, choice) {
                    continue;
                }
                if next.len() as u64 >= maximum {
                    return false;
                }
                let mut assignment = prefix.clone();
                assignment.extend(choice.clone());
                next.push(assignment);
            }
        }
        assignments = next;
    }
    true
}

fn assignments_are_compatible(left: &Assignment, right: &Assignment) -> bool {
    right
        .iter()
        .all(|(key, value)| left.get(key).is_none_or(|existing| existing == value))
}

pub(super) fn scalar_dimensions_for_node(
    node: &GraphNode,
    keys: &BTreeSet<SelectorKey>,
    map_aggregates: &BTreeMap<SelectorKey, MapAggregate>,
) -> Option<Vec<Vec<Assignment>>> {
    let mut dimensions = Vec::new();
    let scalar = keys
        .iter()
        .filter(|key| !map_aggregates.contains_key(*key))
        .cloned()
        .collect::<Vec<_>>();
    dimensions.extend(group_control_dimensions(node, &scalar));
    let outcomes = scalar
        .into_iter()
        .filter(|key| key.source != ControlSourceKey::Group)
        .collect::<Vec<_>>();
    if !outcomes.is_empty() {
        dimensions.push(single_outcome_dimension(node, &outcomes)?);
    }
    Some(dimensions)
}

fn dimensions_for_keys(
    nodes: &BTreeMap<NodeName, NodeInfo<'_>>,
    keys: &BTreeSet<SelectorKey>,
) -> Option<Vec<Vec<Assignment>>> {
    let mut by_node = BTreeMap::<NodeName, BTreeSet<SelectorKey>>::new();
    for key in keys {
        by_node
            .entry(key.name.clone())
            .or_default()
            .insert(key.clone());
    }
    let no_aggregates = BTreeMap::new();
    by_node
        .into_iter()
        .try_fold(Vec::new(), |mut dimensions, (name, keys)| {
            let node = nodes.get(&name)?.node;
            dimensions.extend(scalar_dimensions_for_node(node, &keys, &no_aggregates)?);
            Some(dimensions)
        })
}

fn aggregate_shared_keys(
    scope_nodes: &BTreeMap<NodeName, Vec<SelectorKey>>,
    map_aggregates: &BTreeMap<SelectorKey, MapAggregate>,
    join_correlations: &BTreeMap<NodeName, ParallelJoinCorrelation>,
) -> BTreeSet<SelectorKey> {
    let scope_keys = scope_nodes
        .values()
        .flatten()
        .cloned()
        .collect::<BTreeSet<_>>();
    let mut available = scope_keys.clone();
    let mut shared = BTreeSet::new();
    loop {
        let mut discovered = false;
        for (name, correlation) in join_correlations {
            if !correlation_control_is_present(name, correlation, &available) {
                continue;
            }
            let mut guards = Vec::new();
            correlation.collect_guards(&mut guards);
            for dependency in guards
                .into_iter()
                .flat_map(guard_selectors)
                .map(SelectorKey::from)
                .filter(|key| !map_aggregates.contains_key(key))
            {
                discovered |= shared.insert(dependency.clone());
                available.insert(dependency);
            }
        }
        if !discovered {
            break;
        }
    }
    shared
}

fn aggregate_shared_execution_keys(
    scope_nodes: &BTreeMap<NodeName, Vec<SelectorKey>>,
    map_aggregates: &BTreeMap<SelectorKey, MapAggregate>,
    execution_correlations: &BTreeMap<NodeName, MapExecutionCorrelation>,
) -> BTreeSet<SelectorKey> {
    scope_nodes
        .keys()
        .filter_map(|name| execution_correlations.get(name))
        .flat_map(|correlation| {
            let mut guards = Vec::new();
            correlation.presence.collect_guards(&mut guards);
            guards
        })
        .flat_map(guard_selectors)
        .map(SelectorKey::from)
        .filter(|key| !map_aggregates.contains_key(key))
        .collect()
}

mod aggregate;
mod outcomes;

use aggregate::*;
pub(super) use outcomes::*;
