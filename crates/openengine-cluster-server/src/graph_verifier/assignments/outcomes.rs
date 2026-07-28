use super::*;

pub(in crate::graph_verifier) fn group_control_dimensions(
    node: &GraphNode,
    keys: &[SelectorKey],
) -> Vec<Vec<Assignment>> {
    keys.iter()
        .filter(|key| key.source == ControlSourceKey::Group)
        .map(|key| {
            group_domain(node, key.field.as_ref())
                .unwrap_or_default()
                .into_iter()
                .map(|label| BTreeMap::from([(key.clone(), assigned_control(Some(label), 1))]))
                .collect()
        })
        .collect()
}

pub(in crate::graph_verifier) fn single_outcome_dimension(
    node: &GraphNode,
    keys: &[SelectorKey],
) -> Option<Vec<Assignment>> {
    let choices = per_execution_outcomes(node, keys)?;
    (choices.len() as u64 <= FULL_V1_MAX_GUARD_ASSIGNMENTS).then_some(choices)
}

pub(in crate::graph_verifier) fn aggregate_assignments_from_outcomes(
    keys: &[SelectorKey],
    outcomes: &[Assignment],
    maximum: u64,
) -> Option<Vec<Assignment>> {
    let count = bounded_distribution_count(maximum, outcomes.len())?;
    if count > FULL_V1_MAX_GUARD_ASSIGNMENTS {
        return None;
    }
    let expected = usize::try_from(count).ok()?;
    let mut assignments = Vec::with_capacity(expected);
    let mut valid = true;
    let completed = for_each_outcome_multiset(outcomes.len(), maximum, |outcome_occurrences| {
        if assignments.len() >= expected {
            valid = false;
            return false;
        }
        let Some(assignment) = combine_outcome_occurrences(keys, outcomes, outcome_occurrences)
        else {
            valid = false;
            return false;
        };
        assignments.push(assignment);
        true
    });
    (completed && valid && assignments.len() == expected).then_some(assignments)
}

pub(in crate::graph_verifier) fn assignment_matches_parallel_join_correlation(
    assignment: &Assignment,
    name: &NodeName,
    correlation: &ParallelJoinCorrelation,
) -> bool {
    let Some(control) = parallel_join_control(assignment, name, correlation) else {
        return true;
    };
    if control.counts.values().all(|count| *count == 0) {
        return true;
    }
    match correlation {
        ParallelJoinCorrelation::Joined { completion } => {
            joined_control_matches(control, completion, assignment)
        }
        ParallelJoinCorrelation::First {
            satisfaction,
            all_completions,
        } => first_control_matches(control, satisfaction, all_completions, assignment),
    }
}

fn joined_control_matches(
    control: &AssignedControl,
    completion: &CompletionPredicate,
    assignment: &Assignment,
) -> bool {
    let completed = completion.evaluate(assignment);
    (control_reports(control, "reached") && completed)
        || (control_reports(control, "quorum_unreachable") && !completed)
}

fn first_control_matches(
    control: &AssignedControl,
    satisfaction: &CompletionPredicate,
    all_completions: &CompletionPredicate,
    assignment: &Assignment,
) -> bool {
    let satisfied = satisfaction.evaluate(assignment);
    (control_reports(control, "satisfied") && satisfied)
        || (control_reports(control, "no_satisfier")
            && !satisfied
            && all_completions.evaluate(assignment))
}

fn parallel_join_control<'a>(
    assignment: &'a Assignment,
    name: &NodeName,
    correlation: &ParallelJoinCorrelation,
) -> Option<&'a AssignedControl> {
    assignment.iter().find_map(|(key, value)| {
        (key.name == *name
            && key.source == ControlSourceKey::Group
            && key
                .field
                .as_ref()
                .is_some_and(|field| field.as_str() == correlation.field()))
        .then_some(value)
    })
}

fn control_reports(control: &AssignedControl, expected: &str) -> bool {
    control
        .counts
        .iter()
        .any(|(label, count)| label.as_str() == expected && *count > 0)
}

pub(in crate::graph_verifier) fn per_execution_outcomes(
    node: &GraphNode,
    keys: &[SelectorKey],
) -> Option<Vec<Assignment>> {
    let keys = OutcomeKeys::from(keys);
    let successful_count = successful_outcome_count(node, &keys.emitted)?;
    let runtime_errors = runtime_errors_for_node(node);
    let total_outcomes = successful_count.checked_add(u64::try_from(runtime_errors.len()).ok()?)?;
    if total_outcomes > FULL_V1_MAX_GUARD_ASSIGNMENTS {
        return None;
    }
    let successful = successful_outcomes(node, &keys);
    Some(with_runtime_errors(successful, &runtime_errors, &keys))
}

struct OutcomeKeys {
    emitted: Vec<SelectorKey>,
    errors: Vec<SelectorKey>,
    executions: Vec<SelectorKey>,
}

impl From<&[SelectorKey]> for OutcomeKeys {
    fn from(keys: &[SelectorKey]) -> Self {
        let emitted = keys
            .iter()
            .filter(|key| {
                matches!(
                    key.source,
                    ControlSourceKey::Signal | ControlSourceKey::Group
                )
            })
            .cloned()
            .collect();
        let errors = keys
            .iter()
            .filter(|key| key.source == ControlSourceKey::Error)
            .cloned()
            .collect();
        let executions = keys
            .iter()
            .filter(|key| key.source == ControlSourceKey::Execution)
            .cloned()
            .collect();
        Self {
            emitted,
            errors,
            executions,
        }
    }
}

fn successful_outcome_count(node: &GraphNode, emitted_keys: &[SelectorKey]) -> Option<u64> {
    let mut count = 1_u64;
    for key in emitted_keys {
        let label_count = u64::try_from(selector_key_domain(key, node).len()).ok()?;
        count = count.checked_mul(label_count)?;
        if count > FULL_V1_MAX_GUARD_ASSIGNMENTS {
            return None;
        }
    }
    Some(count)
}

fn runtime_errors_for_node(node: &GraphNode) -> Vec<EnumLabel> {
    matches!(node, GraphNode::Step(_) | GraphNode::Verifier(_))
        .then(error_labels)
        .unwrap_or_default()
}

fn successful_outcomes(node: &GraphNode, keys: &OutcomeKeys) -> Vec<Assignment> {
    let mut successful = vec![Assignment::new()];
    for key in &keys.emitted {
        let labels = selector_key_domain(key, node);
        successful = cartesian_emitted_outcomes(successful, key, &labels);
    }
    for assignment in &mut successful {
        insert_empty_controls(assignment, &keys.errors);
        insert_execution_controls(assignment, &keys.executions);
    }
    successful
}

fn with_runtime_errors(
    mut outcomes: Vec<Assignment>,
    runtime_errors: &[EnumLabel],
    keys: &OutcomeKeys,
) -> Vec<Assignment> {
    for error in runtime_errors {
        let mut assignment = Assignment::new();
        insert_empty_controls(&mut assignment, &keys.emitted);
        insert_execution_controls(&mut assignment, &keys.executions);
        for key in &keys.errors {
            assignment.insert(key.clone(), assigned_control(Some(error.clone()), 1));
        }
        outcomes.push(assignment);
    }
    outcomes.dedup();
    outcomes
}

fn insert_execution_controls(assignment: &mut Assignment, keys: &[SelectorKey]) {
    for key in keys {
        assignment.insert(
            key.clone(),
            assigned_control(Some(enum_label("executed")), 1),
        );
    }
}

pub(in crate::graph_verifier) fn cartesian_emitted_outcomes(
    prefixes: Vec<Assignment>,
    key: &SelectorKey,
    labels: &[EnumLabel],
) -> Vec<Assignment> {
    prefixes
        .into_iter()
        .flat_map(|prefix| {
            labels.iter().map(move |label| {
                let mut choice = prefix.clone();
                choice.insert(key.clone(), assigned_control(Some(label.clone()), 1));
                choice
            })
        })
        .collect()
}

pub(in crate::graph_verifier) fn insert_empty_controls(
    assignment: &mut Assignment,
    keys: &[SelectorKey],
) {
    for key in keys {
        assignment.insert(key.clone(), assigned_control(None, 0));
    }
}

pub(in crate::graph_verifier) fn combine_outcome_occurrences(
    keys: &[SelectorKey],
    outcomes: &[Assignment],
    outcome_occurrences: &[usize],
) -> Option<Assignment> {
    let mut combined = keys
        .iter()
        .cloned()
        .map(|key| (key, assigned_control(None, 0)))
        .collect::<Assignment>();
    for outcome_index in outcome_occurrences {
        let outcome = outcomes.get(*outcome_index)?;
        for (key, value) in outcome {
            let target = combined
                .entry(key.clone())
                .or_insert_with(|| assigned_control(None, 0));
            for (label, count) in &value.counts {
                let target_count = target.counts.entry(label.clone()).or_default();
                *target_count = target_count.checked_add(*count)?;
            }
        }
    }
    Some(combined)
}

pub(in crate::graph_verifier) fn evaluate_guard(guard: &Guard, assignment: &Assignment) -> bool {
    match guard {
        Guard::In { value, labels } => selector_matches(value, labels.values(), assignment),
        Guard::All { guards } => guards
            .as_slice()
            .iter()
            .all(|guard| evaluate_guard(guard, assignment)),
        Guard::Any { guards } => guards
            .as_slice()
            .iter()
            .any(|guard| evaluate_guard(guard, assignment)),
        Guard::Not { guard } => !evaluate_guard(guard, assignment),
        Guard::KOfN {
            count,
            values,
            labels,
        } => {
            values
                .as_slice()
                .iter()
                .filter(|selector| selector_matches(selector, labels.values(), assignment))
                .count() as u64
                >= count.get()
        }
        Guard::KOfMap {
            count,
            value,
            labels,
        } => selector_occurrences(value, labels.values(), assignment) >= count.get(),
    }
}

pub(in crate::graph_verifier) fn selector_matches(
    selector: &ControlSelector,
    labels: &[EnumLabel],
    assignment: &Assignment,
) -> bool {
    assignment
        .get(&SelectorKey::from(selector))
        .is_some_and(|value| {
            labels
                .iter()
                .any(|label| value.counts.get(label).is_some_and(|count| *count > 0))
        })
}

pub(in crate::graph_verifier) fn selector_occurrences(
    selector: &ControlSelector,
    labels: &[EnumLabel],
    assignment: &Assignment,
) -> u64 {
    assignment
        .get(&SelectorKey::from(selector))
        .map_or(0, |value| {
            labels
                .iter()
                .filter_map(|label| value.counts.get(label))
                .copied()
                .sum()
        })
}

pub(in crate::graph_verifier) fn assigned_control(
    label: Option<EnumLabel>,
    occurrences: u64,
) -> AssignedControl {
    AssignedControl {
        counts: label
            .map(|label| BTreeMap::from([(label, occurrences)]))
            .unwrap_or_default(),
    }
}

pub(in crate::graph_verifier) fn bounded_distribution_count(
    maximum: u64,
    labels: usize,
) -> Option<u64> {
    // Weak compositions of at most `maximum` occurrences across `labels` values:
    // C(maximum + labels, labels). Stop as soon as the verifier ceiling is crossed.
    let labels = u64::try_from(labels).ok()?;
    let mut result = 1_u64;
    for divisor in 1..=labels {
        let numerator = maximum.checked_add(divisor)?;
        result = result.checked_mul(numerator)?.checked_div(divisor)?;
        if result > FULL_V1_MAX_GUARD_ASSIGNMENTS {
            return Some(result);
        }
    }
    Some(result)
}

pub(in crate::graph_verifier) fn for_each_outcome_multiset(
    outcomes: usize,
    maximum: u64,
    mut visit: impl FnMut(&[usize]) -> bool,
) -> bool {
    if !visit(&[]) {
        return false;
    }
    if outcomes == 0 {
        return true;
    }
    let Ok(maximum) = usize::try_from(maximum) else {
        return false;
    };

    // A nondecreasing sequence of outcome indexes is the sparse form of one
    // count vector. Iterating multisets keeps stack and working memory bounded
    // by `maximum`, even when one map item has tens of thousands of outcomes.
    for total_occurrences in 1..=maximum {
        let mut occurrence_indexes = vec![0; total_occurrences];
        loop {
            if !visit(&occurrence_indexes) {
                return false;
            }
            let Some(position) = occurrence_indexes
                .iter()
                .rposition(|outcome| *outcome + 1 < outcomes)
            else {
                break;
            };
            let next_outcome = occurrence_indexes[position] + 1;
            occurrence_indexes[position..].fill(next_outcome);
        }
    }
    true
}

pub(in crate::graph_verifier) fn selector_key_domain(
    key: &SelectorKey,
    node: &GraphNode,
) -> Vec<EnumLabel> {
    match key.source {
        ControlSourceKey::Signal => match node {
            GraphNode::Verifier(verifier) => key
                .field
                .as_ref()
                .and_then(|field| verifier.signals.get(field))
                .map(|labels| labels.values().to_vec())
                .unwrap_or_default(),
            _ => Vec::new(),
        },
        ControlSourceKey::Error => error_labels(),
        ControlSourceKey::Group => group_domain(node, key.field.as_ref()).unwrap_or_default(),
        ControlSourceKey::Execution => vec![enum_label("executed")],
    }
}

pub(in crate::graph_verifier) fn group_domain(
    node: &GraphNode,
    field: Option<&FieldName>,
) -> Option<Vec<EnumLabel>> {
    let expected = group_domain_labels(node, field?.as_str())?;
    Some(expected.iter().map(|label| enum_label(label)).collect())
}

fn group_domain_labels(node: &GraphNode, field: &str) -> Option<&'static [&'static str]> {
    match field {
        "terminated" => {
            matches!(node, GraphNode::Loop(_)).then_some(&["converged", "exhausted"][..])
        }
        "overflow" => matches!(node, GraphNode::Map(_)).then_some(&["ok", "overflow"][..]),
        "joined" => {
            parallel_join_domain(node, false).then_some(&["reached", "quorum_unreachable"][..])
        }
        "raced" => parallel_join_domain(node, true).then_some(&["satisfied", "no_satisfier"][..]),
        _ => None,
    }
}

fn parallel_join_domain(node: &GraphNode, first: bool) -> bool {
    let GraphNode::Par(parallel) = node else {
        return false;
    };
    matches!(parallel.join, Join::First { .. }) == first
}

pub(in crate::graph_verifier) fn error_labels() -> Vec<EnumLabel> {
    ["timeout", "crash", "malformed", "refusal"]
        .into_iter()
        .map(enum_label)
        .collect()
}

pub(in crate::graph_verifier) fn signal_path_type(
    verifier: &VerifierNode,
    path: &FieldPath,
) -> Option<PayloadType> {
    let [field] = path.segments() else {
        return None;
    };
    verifier
        .signals
        .get(field)
        .cloned()
        .map(|values| PayloadType::Enum { values })
}
