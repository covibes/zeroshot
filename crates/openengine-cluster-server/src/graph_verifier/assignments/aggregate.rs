use super::*;

pub(super) fn aggregate_scope_dimensions(
    inputs: DimensionInputs<'_, '_>,
    scope_nodes: &BTreeMap<NodeName, Vec<SelectorKey>>,
    maximum: u64,
    shared_keys: BTreeSet<SelectorKey>,
) -> Option<Vec<Vec<Assignment>>> {
    let scope_keys = scope_nodes.values().flatten().cloned().collect::<Vec<_>>();
    let scope_key_set = scope_keys.iter().cloned().collect::<BTreeSet<_>>();
    let available_keys = scope_key_set
        .union(&shared_keys)
        .cloned()
        .collect::<BTreeSet<_>>();
    let components = aggregate_components(inputs, scope_nodes, &scope_key_set, &available_keys);
    if shared_keys.is_empty() {
        let context = AggregateScopeContext {
            inputs,
            scope_nodes,
            maximum,
            available_keys: &scope_key_set,
        };
        return component_dimensions(&context, &components, &Assignment::new());
    }

    let shared_dimensions = dimensions_for_keys(inputs.nodes, &shared_keys)?;
    if !dimension_product_is_bounded(&shared_dimensions) {
        return None;
    }
    let context = AggregateScopeContext {
        inputs,
        scope_nodes,
        maximum,
        available_keys: &available_keys,
    };
    combine_shared_dimensions(&context, &components, shared_dimensions)
}

fn aggregate_components(
    inputs: DimensionInputs<'_, '_>,
    scope_nodes: &BTreeMap<NodeName, Vec<SelectorKey>>,
    scope_keys: &BTreeSet<SelectorKey>,
    available_keys: &BTreeSet<SelectorKey>,
) -> Vec<BTreeSet<NodeName>> {
    let mut components = scope_nodes
        .keys()
        .cloned()
        .map(|name| BTreeSet::from([name]))
        .collect::<Vec<_>>();
    correlate_join_components(
        inputs.join_correlations,
        scope_keys,
        available_keys,
        &mut components,
    );
    correlate_execution_components(
        inputs.execution_correlations,
        scope_nodes,
        scope_keys,
        &mut components,
    );
    components.sort_by(|left, right| left.iter().next().cmp(&right.iter().next()));
    components
}

fn correlate_join_components(
    correlations: &BTreeMap<NodeName, ParallelJoinCorrelation>,
    scope_keys: &BTreeSet<SelectorKey>,
    available_keys: &BTreeSet<SelectorKey>,
    components: &mut Vec<BTreeSet<NodeName>>,
) {
    for (name, correlation) in correlations {
        if !correlation_is_available_to_scope(name, correlation, scope_keys, available_keys) {
            continue;
        }
        let mut correlated = BTreeSet::from([name.clone()]);
        let mut guards = Vec::new();
        correlation.collect_guards(&mut guards);
        correlated.extend(scoped_guard_names(guards, scope_keys));
        merge_assignment_components(components, correlated);
    }
}

fn correlate_execution_components(
    correlations: &BTreeMap<NodeName, MapExecutionCorrelation>,
    scope_nodes: &BTreeMap<NodeName, Vec<SelectorKey>>,
    scope_keys: &BTreeSet<SelectorKey>,
    components: &mut Vec<BTreeSet<NodeName>>,
) {
    let always_present = scope_nodes
        .keys()
        .filter(|name| {
            correlations.get(*name).is_some_and(|correlation| {
                matches!(correlation.presence, CompletionPredicate::Always)
            })
        })
        .cloned()
        .collect::<BTreeSet<_>>();
    if !always_present.is_empty() {
        merge_assignment_components(components, always_present);
    }
    for (name, correlation) in correlations {
        if !scope_nodes.contains_key(name) {
            continue;
        }
        let mut correlated = BTreeSet::from([name.clone()]);
        let mut guards = Vec::new();
        correlation.presence.collect_guards(&mut guards);
        correlated.extend(scoped_guard_names(guards, scope_keys));
        merge_assignment_components(components, correlated);
    }
}

fn scoped_guard_names<'a>(
    guards: Vec<&'a Guard>,
    scope_keys: &'a BTreeSet<SelectorKey>,
) -> impl Iterator<Item = NodeName> + 'a {
    guards
        .into_iter()
        .flat_map(guard_selectors)
        .filter(|selector| scope_keys.contains(&SelectorKey::from(*selector)))
        .map(|selector| selector.name.clone())
}

struct AggregateScopeContext<'a, 'graph> {
    inputs: DimensionInputs<'a, 'graph>,
    scope_nodes: &'a BTreeMap<NodeName, Vec<SelectorKey>>,
    maximum: u64,
    available_keys: &'a BTreeSet<SelectorKey>,
}

fn component_dimensions(
    context: &AggregateScopeContext<'_, '_>,
    components: &[BTreeSet<NodeName>],
    shared_assignment: &Assignment,
) -> Option<Vec<Vec<Assignment>>> {
    components
        .iter()
        .map(|component| {
            aggregate_component_dimension(
                &AggregateComponentContext {
                    nodes: context.inputs.nodes,
                    scope_nodes: context.scope_nodes,
                    maximum: context.maximum,
                    join_correlations: context.inputs.join_correlations,
                    execution_correlations: context.inputs.execution_correlations,
                    shared_assignment,
                    available_keys: context.available_keys,
                },
                component,
            )
        })
        .collect()
}

fn combine_shared_dimensions(
    context: &AggregateScopeContext<'_, '_>,
    components: &[BTreeSet<NodeName>],
    shared_dimensions: Vec<Vec<Assignment>>,
) -> Option<Vec<Vec<Assignment>>> {
    let mut combined = Vec::new();
    for shared in enumerate_assignments(shared_dimensions) {
        let local_dimensions = component_dimensions(context, components, &shared)?;
        if !dimension_product_is_bounded(&local_dimensions) {
            return None;
        }
        for local in enumerate_assignments(local_dimensions) {
            if combined.len() as u64 >= FULL_V1_MAX_GUARD_ASSIGNMENTS {
                return None;
            }
            let mut assignment = shared.clone();
            assignment.extend(local);
            combined.push(assignment);
        }
    }
    Some(vec![combined])
}

pub(super) fn merge_assignment_components(
    components: &mut Vec<BTreeSet<NodeName>>,
    mut correlated: BTreeSet<NodeName>,
) {
    let mut independent = Vec::new();
    for component in components.drain(..) {
        if component.is_disjoint(&correlated) {
            independent.push(component);
        } else {
            correlated.extend(component);
        }
    }
    independent.push(correlated);
    *components = independent;
}

pub(super) struct AggregateComponentContext<'a, 'graph> {
    pub(super) nodes: &'a BTreeMap<NodeName, NodeInfo<'graph>>,
    pub(super) scope_nodes: &'a BTreeMap<NodeName, Vec<SelectorKey>>,
    pub(super) maximum: u64,
    pub(super) join_correlations: &'a BTreeMap<NodeName, ParallelJoinCorrelation>,
    pub(super) execution_correlations: &'a BTreeMap<NodeName, MapExecutionCorrelation>,
    pub(super) shared_assignment: &'a Assignment,
    pub(super) available_keys: &'a BTreeSet<SelectorKey>,
}

pub(super) fn aggregate_component_dimension(
    context: &AggregateComponentContext<'_, '_>,
    component: &BTreeSet<NodeName>,
) -> Option<Vec<Assignment>> {
    let keys = component
        .iter()
        .flat_map(|name| context.scope_nodes.get(name).into_iter().flatten())
        .cloned()
        .collect::<Vec<_>>();
    let key_set = keys.iter().cloned().collect::<BTreeSet<_>>();
    let mut item_dimensions = Vec::new();
    for name in component {
        let node_keys = context.scope_nodes.get(name)?;
        let node = context.nodes.get(name)?.node;
        let mut outcome_keys = node_keys.clone();
        if context.execution_correlations.contains_key(name) {
            outcome_keys.push(execution_key(name));
        }
        let mut outcomes = per_execution_outcomes(node, &outcome_keys)?;
        outcomes.push(empty_outcome(&outcome_keys));
        item_dimensions.push(outcomes);
    }
    if !dimension_product_is_bounded(&item_dimensions) {
        return None;
    }
    let mut item_outcomes = enumerate_assignments(item_dimensions);
    item_outcomes.retain(|assignment| {
        if assignment_is_empty(assignment) {
            return false;
        }
        let mut correlated = context.shared_assignment.clone();
        correlated.extend(assignment.clone());
        context.join_correlations.iter().all(|(name, correlation)| {
            !correlation_is_available_to_scope(name, correlation, &key_set, context.available_keys)
                || assignment_matches_parallel_join_correlation(&correlated, name, correlation)
        }) && component.iter().all(|name| {
            context
                .execution_correlations
                .get(name)
                .is_none_or(|correlation| {
                    assignment_matches_map_execution_correlation(&correlated, name, correlation)
                })
        })
    });
    for assignment in &mut item_outcomes {
        assignment.retain(|key, _| key.source != ControlSourceKey::Execution);
    }
    item_outcomes.retain(|assignment| !assignment_is_empty(assignment));
    item_outcomes = item_outcomes
        .into_iter()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    aggregate_assignments_from_outcomes(&keys, &item_outcomes, context.maximum)
}

fn assignment_matches_map_execution_correlation(
    assignment: &Assignment,
    name: &NodeName,
    correlation: &MapExecutionCorrelation,
) -> bool {
    let executed = assignment
        .get(&execution_key(name))
        .is_some_and(|control| control.counts.values().any(|count| *count > 0));
    executed == correlation.presence.evaluate(assignment)
}

fn execution_key(name: &NodeName) -> SelectorKey {
    SelectorKey {
        name: name.clone(),
        source: ControlSourceKey::Execution,
        field: None,
    }
}

fn empty_outcome(keys: &[SelectorKey]) -> Assignment {
    keys.iter()
        .cloned()
        .map(|key| (key, assigned_control(None, 0)))
        .collect()
}

fn assignment_is_empty(assignment: &Assignment) -> bool {
    assignment
        .values()
        .all(|control| control.counts.values().all(|count| *count == 0))
}

pub(super) fn dimension_product_is_bounded(dimensions: &[Vec<Assignment>]) -> bool {
    dimensions
        .iter()
        .try_fold(1_u64, |product, dimension| {
            product
                .checked_mul(u64::try_from(dimension.len()).ok()?)
                .filter(|product| *product <= FULL_V1_MAX_GUARD_ASSIGNMENTS)
        })
        .is_some()
}

pub(super) fn correlation_control_is_present(
    name: &NodeName,
    correlation: &ParallelJoinCorrelation,
    keys: &BTreeSet<SelectorKey>,
) -> bool {
    keys.iter().any(|key| {
        key.name == *name
            && key.source == ControlSourceKey::Group
            && key
                .field
                .as_ref()
                .is_some_and(|field| field.as_str() == correlation.field())
    })
}

pub(super) fn correlation_is_available_to_scope(
    name: &NodeName,
    correlation: &ParallelJoinCorrelation,
    control_keys: &BTreeSet<SelectorKey>,
    available_keys: &BTreeSet<SelectorKey>,
) -> bool {
    if !correlation_control_is_present(name, correlation, control_keys) {
        return false;
    }
    let mut guards = Vec::new();
    correlation.collect_guards(&mut guards);
    guards
        .into_iter()
        .flat_map(guard_selectors)
        .map(SelectorKey::from)
        .all(|key| available_keys.contains(&key))
}
