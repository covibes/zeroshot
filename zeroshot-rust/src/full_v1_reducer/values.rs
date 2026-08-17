use super::*;

pub(super) fn collect_map_depths(
    node: &GraphNode,
    depth: usize,
    depths: &mut BTreeMap<NodeName, usize>,
) {
    depths.insert(node.name().clone(), depth);
    let child_depth = depth + usize::from(matches!(node, GraphNode::Map(_)));
    for child in openengine_cluster_server::graph_verifier::graph_node_children(node) {
        collect_map_depths(child, child_depth, depths);
    }
}

pub(super) fn collect_executable_depths(
    node: &GraphNode,
    depth: usize,
    depths: &mut BTreeMap<NodeName, usize>,
) {
    if matches!(node, GraphNode::Step(_) | GraphNode::Verifier(_)) {
        depths.insert(node.name().clone(), depth);
    }
    let child_depth = depth + usize::from(matches!(node, GraphNode::Map(_)));
    for child in openengine_cluster_server::graph_verifier::graph_node_children(node) {
        collect_executable_depths(child, child_depth, depths);
    }
}

pub(super) fn validate_history_for_mode(
    executions: &[DurableExecution],
    execution_mode: ExecutionMode,
) -> Result<(), ReducerError> {
    let mut visit_identities = HistoryVisitIdentities::default();
    let mut instances = BTreeMap::new();
    let mut inverse_instances = BTreeMap::new();
    for execution in executions {
        visit_identities.validate(execution, execution_mode)?;
        validate_instance_lineage(execution, &mut instances, &mut inverse_instances)?;
    }
    if execution_mode == ExecutionMode::LegacyAttempts {
        for occurrence in instances.keys() {
            let mut values = executions
                .iter()
                .filter(|execution| &execution.occurrence == occurrence)
                .map(|execution| execution.attempt.get())
                .collect::<Vec<_>>();
            values.sort_unstable();
            if values.iter().copied().ne(1..=values.len() as u64) {
                return Err(ReducerError::InconsistentHistory);
            }
        }
    }
    Ok(())
}

#[derive(Default)]
pub(super) struct HistoryVisitIdentities {
    ids: BTreeSet<ExecutionId>,
    attempts: BTreeSet<(StructuralOccurrence, PositiveInteger)>,
    visits: BTreeSet<(StructuralOccurrence, HistoryPosition)>,
}

impl HistoryVisitIdentities {
    fn validate(
        &mut self,
        execution: &DurableExecution,
        execution_mode: ExecutionMode,
    ) -> Result<(), ReducerError> {
        let valid_visit = match execution_mode {
            ExecutionMode::LegacyAttempts => self
                .attempts
                .insert((execution.occurrence.clone(), execution.attempt)),
            ExecutionMode::NativeV2NoRetry => {
                execution.attempt.get() == 1
                    && self
                        .visits
                        .insert((execution.occurrence.clone(), execution.dispatch_position))
            }
        };
        if self.ids.insert(execution.execution) && valid_visit {
            Ok(())
        } else {
            Err(ReducerError::InconsistentHistory)
        }
    }
}

pub(super) fn validate_instance_lineage(
    execution: &DurableExecution,
    instances: &mut BTreeMap<StructuralOccurrence, NodeInstanceId>,
    inverse_instances: &mut BTreeMap<NodeInstanceId, StructuralOccurrence>,
) -> Result<(), ReducerError> {
    if instances
        .insert(execution.occurrence.clone(), execution.node_instance)
        .is_some_and(|existing| existing != execution.node_instance)
        || inverse_instances
            .insert(execution.node_instance, execution.occurrence.clone())
            .is_some_and(|existing| existing != execution.occurrence)
    {
        return Err(ReducerError::InconsistentHistory);
    }
    Ok(())
}

pub(super) fn visit_key(name: &NodeName, map_indices: &[u64]) -> ControlKey {
    ControlKey {
        node: name.clone(),
        source: ControlSource::Group,
        field: Some("__reducer_visit".to_owned()),
        map_indices: map_indices.to_vec(),
    }
}

pub(super) fn next_visit(
    name: &NodeName,
    map_indices: &[u64],
    controls: &BTreeMap<ControlKey, String>,
) -> u64 {
    controls
        .get(&visit_key(name, map_indices))
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(0)
        + 1
}

pub(super) fn mark_visit(
    name: &NodeName,
    map_indices: &[u64],
    controls: &mut BTreeMap<ControlKey, String>,
    visit: u64,
) {
    controls.insert(visit_key(name, map_indices), visit.to_string());
}

pub(super) fn bind_payload(
    bindings: &[openengine_cluster_protocol::InputBinding],
    state: &Value,
    item: Option<&Value>,
) -> Result<Value, ReducerError> {
    if bindings.is_empty() {
        return Ok(Value::Null);
    }
    let mut value = Value::Object(Map::new());
    for binding in bindings {
        let selected = select_data(&binding.value, state, item)?.clone();
        set_path(&mut value, &binding.target, selected)?;
    }
    Ok(value)
}

pub(super) fn select_data<'a>(
    selector: &DataSelector,
    state: &'a Value,
    item: Option<&'a Value>,
) -> Result<&'a Value, ReducerError> {
    match selector {
        DataSelector::State { path } => select(state, path),
        DataSelector::Item { path } => {
            select(item.ok_or(ReducerError::MissingSelectedValue)?, path)
        }
    }
}

pub(super) fn select<'a>(value: &'a Value, path: &FieldPath) -> Result<&'a Value, ReducerError> {
    path.segments().iter().try_fold(value, |current, segment| {
        current
            .as_object()
            .and_then(|object| object.get(segment.as_str()))
            .ok_or(ReducerError::MissingSelectedValue)
    })
}

pub(super) fn set_path(
    value: &mut Value,
    path: &FieldPath,
    selected: Value,
) -> Result<(), ReducerError> {
    let (last, parents) = path
        .segments()
        .split_last()
        .ok_or(ReducerError::MissingSelectedValue)?;
    let mut current = value;
    for segment in parents {
        let object = current
            .as_object_mut()
            .ok_or(ReducerError::InvalidDurableValue)?;
        current = object
            .entry(segment.as_str())
            .or_insert_with(|| Value::Object(Map::new()));
    }
    current
        .as_object_mut()
        .ok_or(ReducerError::InvalidDurableValue)?
        .insert(last.as_str().to_owned(), selected);
    Ok(())
}

pub(super) fn apply_writes(
    context: &mut Context,
    application: WriteApplication<'_>,
) -> Result<(), ReducerError> {
    let WriteApplication {
        name,
        output,
        signals,
        diagnostic,
        bindings,
        map_indices,
    } = application;
    let channel = Channels {
        output: output.clone(),
        signals: signals
            .map(|values| {
                values
                    .iter()
                    .map(|(field, label)| (field.as_str().to_owned(), label.as_str().to_owned()))
                    .collect()
            })
            .unwrap_or_default(),
        diagnostic: diagnostic.cloned(),
    };
    context
        .channels
        .insert((name.clone(), map_indices.to_vec()), channel);
    for binding in bindings {
        let value = bound_channel_value(context, binding, map_indices)?;
        set_path(&mut context.state, &binding.target, value)?;
    }
    Ok(())
}

fn bound_channel_value(
    context: &Context,
    binding: &openengine_cluster_protocol::WriteBinding,
    map_indices: &[u64],
) -> Result<Value, ReducerError> {
    let channels = context
        .channels
        .get(&(binding.value.node.clone(), map_indices.to_vec()))
        .ok_or(ReducerError::MissingSelectedValue)?;
    match binding.value.channel {
        NodeOutputChannel::Out => Ok(select(&channels.output, &binding.value.path)?.clone()),
        NodeOutputChannel::Diagnostic => {
            let diagnostic = channels
                .diagnostic
                .as_ref()
                .ok_or(ReducerError::MissingSelectedValue)?;
            Ok(select(diagnostic, &binding.value.path)?.clone())
        }
        NodeOutputChannel::Signal => {
            let field = binding
                .value
                .path
                .segments()
                .first()
                .ok_or(ReducerError::MissingSelectedValue)?;
            let label = channels
                .signals
                .get(field.as_str())
                .ok_or(ReducerError::MissingSelectedValue)?;
            Ok(Value::String(label.clone()))
        }
    }
}

pub(super) fn promote(request: PromotionRequest<'_>) -> Result<(), ReducerError> {
    let PromotionRequest {
        node,
        map_indices,
        paths,
        local,
        parent,
        mode,
        decisions,
    } = request;
    let mut values = Vec::with_capacity(paths.len());
    for path in paths {
        let value = select(&local.state, path)?.clone();
        set_path(&mut parent.state, path, value.clone())?;
        values.push(PromotedValue {
            path: path.clone(),
            value,
        });
    }
    if mode == EvalMode::Decide && !values.is_empty() {
        decisions.push(Decision::Promote {
            node: node.clone(),
            map_indices: map_indices.to_vec(),
            values,
        });
    }
    merge_runtime_facts(local, parent);
    Ok(())
}

pub(super) fn merge_runtime_facts(source: &Context, target: &mut Context) {
    target.controls.extend(source.controls.clone());
    target.channels.extend(source.channels.clone());
}

pub(super) fn descendant_names(node: &GraphNode) -> BTreeSet<NodeName> {
    let mut depths = BTreeMap::new();
    collect_map_depths(node, 0, &mut depths);
    depths.into_keys().collect()
}
