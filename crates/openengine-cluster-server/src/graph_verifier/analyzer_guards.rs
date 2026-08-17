use super::*;

impl<'a> Analyzer<'a> {
    pub(super) fn validate_choice(
        &mut self,
        choice: &ChoiceNode,
        incoming: &Flow,
        path: &[DiagnosticPathSegment],
    ) -> ChoiceControl {
        if !self.validate_choice_guards(choice, incoming, path) {
            return ChoiceControl::unknown(choice);
        }
        let guards = choice
            .branches
            .as_slice()
            .iter()
            .map(|branch| &branch.when)
            .collect::<Vec<_>>();
        let Some(assignments) = self.assignments_for_guards(&guards, &with_field(path, "branches"))
        else {
            return ChoiceControl::unknown(choice);
        };
        let (branches, branch_reachable, covered) =
            self.choice_branch_outcomes(choice, &assignments, path);
        let uncovered = assignments
            .iter()
            .zip(covered)
            .filter_map(|(assignment, covered)| (!covered).then_some(assignment))
            .collect::<Vec<_>>();
        let (exhaustive, otherwise_reachable) =
            self.record_choice_exhaustiveness(choice, &uncovered, path);
        ChoiceControl {
            branches,
            branch_reachable,
            branch_completion: choice_branch_completion_predicates(choice),
            otherwise: outcome_refinement(&uncovered),
            otherwise_reachable,
            otherwise_completion: choice_otherwise_completion_predicate(choice),
            exhaustive,
        }
    }

    pub(super) fn validate_choice_guards(
        &mut self,
        choice: &ChoiceNode,
        incoming: &Flow,
        path: &[DiagnosticPathSegment],
    ) -> bool {
        let mut valid = true;
        for (index, branch) in choice.branches.as_slice().iter().enumerate() {
            let guard_path = guard_path(path, "branches", index, "when");
            valid &= self.validate_guard(
                &branch.when,
                &incoming.available,
                GuardValidationContext {
                    path: &guard_path,
                    code: GraphDiagnosticCode::ChoiceExhaustiveness,
                },
            );
            for selector in guard_selectors(&branch.when) {
                self.dependencies
                    .entry(choice.name.clone())
                    .or_default()
                    .insert(selector.name.clone());
            }
        }
        valid
    }

    pub(super) fn choice_branch_outcomes(
        &mut self,
        choice: &ChoiceNode,
        assignments: &[Assignment],
        path: &[DiagnosticPathSegment],
    ) -> (Vec<OutcomeRefinement>, Vec<bool>, Vec<bool>) {
        let mut prior = vec![false; assignments.len()];
        let mut outcomes = Vec::with_capacity(choice.branches.as_slice().len());
        let mut reachable = Vec::with_capacity(choice.branches.as_slice().len());
        for (index, branch) in choice.branches.as_slice().iter().enumerate() {
            let mut residual = Vec::new();
            for (assignment, matched_prior) in assignments.iter().zip(&mut prior) {
                let matches = evaluate_guard(&branch.when, assignment);
                if matches && !*matched_prior {
                    residual.push(assignment);
                }
                *matched_prior |= matches;
            }
            if residual.is_empty() {
                emit_diagnostic!(
                    self,
                    GraphDiagnosticCode::ChoiceExhaustiveness,
                    "choice branch is unreachable after excluding earlier branches",
                    guard_path(path, "branches", index, "when"),
                    vec![choice.name.clone()],
                );
            }
            reachable.push(!residual.is_empty());
            outcomes.push(outcome_refinement(&residual));
        }
        (outcomes, reachable, prior)
    }

    pub(super) fn record_choice_exhaustiveness(
        &mut self,
        choice: &ChoiceNode,
        uncovered: &[&Assignment],
        path: &[DiagnosticPathSegment],
    ) -> (bool, bool) {
        let exhaustive = choice.otherwise.is_some() || uncovered.is_empty();
        if choice.otherwise.is_none() && !exhaustive {
            emit_diagnostic!(
                self,
                GraphDiagnosticCode::ChoiceExhaustiveness,
                "choice branches do not cover every legal control assignment",
                with_field(path, "branches"),
                vec![choice.name.clone()],
            );
        }
        let otherwise_reachable = choice.otherwise.is_some() && !uncovered.is_empty();
        if let Some(otherwise) = &choice.otherwise {
            if !otherwise_reachable {
                emit_diagnostic!(
                    self,
                    GraphDiagnosticCode::ChoiceExhaustiveness,
                    "choice otherwise is unreachable because earlier branches cover every legal control assignment",
                    named_child_path(path, "otherwise", otherwise.name()),
                    vec![choice.name.clone()],
                );
            }
        }
        if exhaustive {
            self.exhaustive_choices.insert(choice.name.clone());
        }
        (exhaustive, otherwise_reachable)
    }

    pub(super) fn validate_guard(
        &mut self,
        guard: &Guard,
        available: &BTreeSet<NodeName>,
        context: GuardValidationContext<'_>,
    ) -> bool {
        let mut valid = true;
        for (selector, map_aggregate) in guard_selector_uses(guard) {
            let map_available = map_aggregate
                && self
                    .map_owner(&selector.name)
                    .is_some_and(|owner| available.contains(owner));
            if !available.contains(&selector.name) && !map_available {
                emit_diagnostic!(
                    self,
                    GraphDiagnosticCode::UndefinedRead,
                    format!(
                        "control selector {} does not dominate this guard",
                        selector.name
                    ),
                    context.path.to_vec(),
                    vec![selector.name.clone()],
                );
                valid = false;
            }
            if self.selector_domain(selector).is_none() {
                emit_diagnostic!(
                    self,
                    context.code,
                    format!("illegal control selector for node {}", selector.name),
                    context.path.to_vec(),
                    vec![selector.name.clone()],
                );
                valid = false;
            }
        }
        valid &= self.validate_guard_labels(guard, context);
        valid
    }

    pub(super) fn validate_guard_labels(
        &mut self,
        guard: &Guard,
        context: GuardValidationContext<'_>,
    ) -> bool {
        match guard {
            Guard::In { value, labels } => self.validate_selector_labels(
                value,
                SelectorLabelsValidationContext {
                    labels: labels.values(),
                    guard: context,
                    message: "guard labels exceed the selector's closed domain",
                },
            ),
            Guard::All { guards } | Guard::Any { guards } => {
                self.validate_nested_guard_labels(guards.as_slice(), context)
            }
            Guard::Not { guard } => self.validate_guard_labels(
                guard,
                GuardValidationContext {
                    path: &with_field(context.path, "guard"),
                    ..context
                },
            ),
            Guard::KOfN {
                count,
                values,
                labels,
            } => self.validate_k_of_n_labels(KOfNLabelsValidationContext {
                count: count.get(),
                selectors: values.as_slice(),
                labels: labels.values(),
                guard: context,
            }),
            Guard::KOfMap {
                count,
                value,
                labels,
            } => self.validate_k_of_map_labels(KOfMapLabelsValidationContext {
                count: count.get(),
                selector: value,
                labels: labels.values(),
                guard: context,
            }),
        }
    }

    pub(super) fn validate_nested_guard_labels(
        &mut self,
        guards: &[Guard],
        context: GuardValidationContext<'_>,
    ) -> bool {
        let mut valid = true;
        for (index, child) in guards.iter().enumerate() {
            valid &= self.validate_guard_labels(
                child,
                GuardValidationContext {
                    path: &indexed_field_path(context.path, "guards", index),
                    ..context
                },
            );
        }
        valid
    }

    pub(super) fn validate_selector_labels(
        &mut self,
        selector: &ControlSelector,
        context: SelectorLabelsValidationContext<'_>,
    ) -> bool {
        let outside_domain = self
            .selector_domain(selector)
            .is_some_and(|domain| !context.labels.iter().all(|label| domain.contains(label)));
        if outside_domain {
            emit_diagnostic!(
                self,
                context.guard.code,
                context.message,
                with_field(context.guard.path, "labels"),
                vec![selector.name.clone()],
            );
        }
        !outside_domain
    }

    pub(super) fn validate_k_of_n_labels(
        &mut self,
        context: KOfNLabelsValidationContext<'_>,
    ) -> bool {
        let mut valid = true;
        if context.count > u64::try_from(context.selectors.len()).unwrap_or(u64::MAX) {
            emit_diagnostic!(
                self,
                context.guard.code,
                "k_of_n count exceeds selector count",
                with_field(context.guard.path, "count"),
                Vec::new(),
            );
            valid = false;
        }
        let union = context
            .selectors
            .iter()
            .filter_map(|selector| self.selector_domain(selector))
            .flatten()
            .collect::<BTreeSet<_>>();
        if !context.labels.iter().all(|label| union.contains(label)) {
            emit_diagnostic!(
                self,
                context.guard.code,
                "k_of_n labels exceed the selectors' combined closed domains",
                with_field(context.guard.path, "labels"),
                context
                    .selectors
                    .iter()
                    .map(|selector| selector.name.clone())
                    .collect(),
            );
            valid = false;
        }
        let intersections_valid = self.validate_k_of_n_intersections(&context);
        valid && intersections_valid
    }

    pub(super) fn validate_k_of_n_intersections(
        &mut self,
        context: &KOfNLabelsValidationContext<'_>,
    ) -> bool {
        let mut valid = true;
        for selector in context.selectors {
            let disjoint = self
                .selector_domain(selector)
                .is_some_and(|domain| !context.labels.iter().any(|label| domain.contains(label)));
            if disjoint {
                emit_diagnostic!(
                    self,
                    context.guard.code,
                    "k_of_n labels do not intersect a selector domain",
                    with_field(context.guard.path, "labels"),
                    vec![selector.name.clone()],
                );
                valid = false;
            }
        }
        valid
    }

    pub(super) fn validate_k_of_map_labels(
        &mut self,
        context: KOfMapLabelsValidationContext<'_>,
    ) -> bool {
        let mut valid = true;
        match self.map_control_cardinality(context.selector) {
            Some(cardinality) if context.count > cardinality => {
                emit_diagnostic!(
                    self,
                    context.guard.code,
                    "k_of_map count exceeds the selected map bound",
                    with_field(context.guard.path, "count"),
                    vec![context.selector.name.clone()],
                );
                valid = false;
            }
            None => {
                emit_diagnostic!(
                    self,
                    context.guard.code,
                    "k_of_map selector has no bounded enclosing map scope",
                    with_field(context.guard.path, "value"),
                    vec![context.selector.name.clone()],
                );
                valid = false;
            }
            Some(_) => {}
        }
        let labels_valid = self.validate_selector_labels(
            context.selector,
            SelectorLabelsValidationContext {
                labels: context.labels,
                guard: context.guard,
                message: "k_of_map labels exceed the selector's closed domain",
            },
        );
        valid && labels_valid
    }

    pub(super) fn selector_domain(&self, selector: &ControlSelector) -> Option<Vec<EnumLabel>> {
        let node = self.nodes.get(&selector.name)?.node;
        match selector.source {
            ControlSource::Signal => {
                let GraphNode::Verifier(verifier) = node else {
                    return None;
                };
                let field = selector.field.as_ref()?;
                verifier
                    .signals
                    .get(field)
                    .map(|labels| labels.values().to_vec())
            }
            ControlSource::Error => {
                if selector.field.is_some()
                    || !matches!(node, GraphNode::Step(_) | GraphNode::Verifier(_))
                {
                    return None;
                }
                Some(error_labels())
            }
            ControlSource::Group => group_domain(node, selector.field.as_ref()),
        }
    }

    pub(super) fn map_control_cardinality(&self, selector: &ControlSelector) -> Option<u64> {
        self.map_control_scope(selector)
            .map(|aggregate| aggregate.maximum)
    }

    pub(super) fn map_control_scope(&self, selector: &ControlSelector) -> Option<MapAggregate> {
        self.nodes.get(&selector.name)?;
        let owner = self.map_owner(&selector.name)?.clone();
        self.nodes.get(&owner).and_then(|info| match info.node {
            GraphNode::Map(map) => Some(MapAggregate {
                owner,
                maximum: map.max_items.get(),
            }),
            _ => None,
        })
    }

    pub(super) fn map_owner(&self, target: &NodeName) -> Option<&NodeName> {
        find_map_owner(&self.graph.root, target, None)
    }
}
