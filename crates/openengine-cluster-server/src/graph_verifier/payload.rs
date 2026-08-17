use super::*;

pub(super) fn executable_output(node: &GraphNode) -> Option<&PayloadType> {
    match node {
        GraphNode::Step(step) => Some(&step.output),
        GraphNode::Verifier(verifier) => Some(&verifier.output),
        _ => None,
    }
}

pub(super) fn node_state(node: &GraphNode) -> Option<&PayloadType> {
    match node {
        GraphNode::Seq(group) => Some(&group.state),
        GraphNode::Choice(group) => Some(&group.state),
        GraphNode::Par(group) => Some(&group.state),
        GraphNode::Loop(group) => Some(&group.state),
        GraphNode::Map(group) => Some(&group.state),
        GraphNode::Step(_)
        | GraphNode::Verifier(_)
        | GraphNode::Succeed(_)
        | GraphNode::Fail(_) => None,
    }
}

pub(super) fn required_leaf_paths(payload: &PayloadType) -> Vec<FieldPath> {
    fn collect(
        payload: &PayloadType,
        prefix: &mut Vec<FieldName>,
        required: bool,
        paths: &mut Vec<FieldPath>,
    ) -> bool {
        if !required {
            return false;
        }
        let PayloadType::Record { fields } = payload else {
            if !prefix.is_empty() {
                if let Ok(path) = FieldPath::new(prefix.clone()) {
                    paths.push(path);
                }
                return true;
            }
            return false;
        };
        let mut has_required_descendant = false;
        for (name, field) in fields {
            prefix.push(name.clone());
            has_required_descendant |= collect(&field.value_type, prefix, field.required, paths);
            prefix.pop();
        }
        if !has_required_descendant && !prefix.is_empty() {
            if let Ok(path) = FieldPath::new(prefix.clone()) {
                paths.push(path);
            }
            return true;
        }
        has_required_descendant
    }

    let mut paths = Vec::new();
    collect(payload, &mut Vec::new(), true, &mut paths);
    paths
}

pub(super) fn required_paths_with_types(payload: &PayloadType) -> BTreeMap<FieldPath, PayloadType> {
    fn collect(
        payload: &PayloadType,
        prefix: &mut Vec<FieldName>,
        paths: &mut BTreeMap<FieldPath, PayloadType>,
    ) {
        let PayloadType::Record { fields } = payload else {
            return;
        };
        for (name, field) in fields {
            if !field.required {
                continue;
            }
            prefix.push(name.clone());
            if let Ok(path) = FieldPath::new(prefix.clone()) {
                paths.insert(path, field.value_type.clone());
                collect(&field.value_type, prefix, paths);
            }
            prefix.pop();
        }
    }

    let mut paths = BTreeMap::new();
    collect(payload, &mut Vec::new(), &mut paths);
    paths
}

pub(super) fn guaranteed_write_paths(
    target: &FieldPath,
    value_type: &PayloadType,
    definitely_present: bool,
) -> BTreeMap<FieldPath, PayloadType> {
    if !definitely_present {
        return BTreeMap::new();
    }
    let mut paths = BTreeMap::from([(target.clone(), value_type.clone())]);
    let mut prefix = target.segments().to_vec();
    collect_required_descendant_paths(value_type, &mut prefix, &mut paths);
    paths
}

pub(super) fn collect_required_descendant_paths(
    payload: &PayloadType,
    prefix: &mut Vec<FieldName>,
    paths: &mut BTreeMap<FieldPath, PayloadType>,
) {
    let PayloadType::Record { fields } = payload else {
        return;
    };
    for (name, field) in fields {
        if !field.required {
            continue;
        }
        prefix.push(name.clone());
        if let Ok(path) = FieldPath::new(prefix.clone()) {
            paths.insert(path, field.value_type.clone());
            collect_required_descendant_paths(&field.value_type, prefix, paths);
        }
        prefix.pop();
    }
}

pub(super) fn display_field_path(path: &FieldPath) -> String {
    path.segments()
        .iter()
        .map(FieldName::as_str)
        .collect::<Vec<_>>()
        .join(".")
}

pub(super) fn path_type<'a>(payload: &'a PayloadType, path: &FieldPath) -> Option<&'a PayloadType> {
    let mut current = payload;
    for segment in path.segments() {
        let PayloadType::Record { fields } = current else {
            return None;
        };
        current = &fields.get(segment)?.value_type;
    }
    Some(current)
}

pub(super) fn selected_output_path(
    payload: &PayloadType,
    path: &FieldPath,
) -> Option<SelectedOutput> {
    path_type(payload, path)
        .cloned()
        .map(|value_type| SelectedOutput {
            value_type,
            definitely_present: is_required_path(payload, path),
        })
}

pub(super) fn is_subtype_with_definitions(
    source: &PayloadType,
    target: &PayloadType,
    definitions: &BTreeMap<FieldPath, PayloadType>,
) -> bool {
    fn check(
        source: &PayloadType,
        target: &PayloadType,
        definitions: &BTreeMap<FieldPath, PayloadType>,
        prefix: &mut Vec<FieldName>,
    ) -> bool {
        let (PayloadType::Record { fields: source }, PayloadType::Record { fields: target }) =
            (source, target)
        else {
            return source.is_subtype_of(target);
        };
        target.iter().all(|(name, target_field)| {
            let Some(source_field) = source.get(name) else {
                return !target_field.required;
            };
            prefix.push(name.clone());
            let path = FieldPath::new(prefix.clone()).ok();
            let refined = path.as_ref().and_then(|path| definitions.get(path));
            let present = source_field.required || refined.is_some();
            let compatible = (!target_field.required || present)
                && check(
                    refined.unwrap_or(&source_field.value_type),
                    &target_field.value_type,
                    definitions,
                    prefix,
                );
            prefix.pop();
            compatible
        })
    }

    check(source, target, definitions, &mut Vec::new())
}

pub(super) fn is_required_path(payload: &PayloadType, path: &FieldPath) -> bool {
    let mut current = payload;
    for segment in path.segments() {
        let PayloadType::Record { fields } = current else {
            return false;
        };
        let Some(field) = fields.get(segment) else {
            return false;
        };
        if !field.required {
            return false;
        }
        current = &field.value_type;
    }
    true
}

pub(super) fn is_defined(defined: &BTreeMap<FieldPath, PayloadType>, selected: &FieldPath) -> bool {
    defined.contains_key(selected)
}

pub(super) fn paths_overlap(left: &FieldPath, right: &FieldPath) -> bool {
    path_is_prefix(left, right) || path_is_prefix(right, left)
}

pub(super) fn path_is_prefix(prefix: &FieldPath, path: &FieldPath) -> bool {
    prefix.segments().len() <= path.segments().len()
        && prefix
            .segments()
            .iter()
            .zip(path.segments())
            .all(|(left, right)| left == right)
}
