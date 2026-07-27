use super::*;

impl<'a> Analyzer<'a> {
    pub(super) fn guard_has_satisfying_assignment(
        &mut self,
        guard: &Guard,
        path: &[DiagnosticPathSegment],
    ) -> bool {
        self.assignments_for_guards(&[guard], path)
            .is_some_and(|assignments| {
                assignments
                    .iter()
                    .any(|assignment| evaluate_guard(guard, assignment))
            })
    }

    pub(super) fn restrict_completion(
        &mut self,
        effects: &mut Effects,
        condition: CompletionPredicate,
        path: &[DiagnosticPathSegment],
    ) {
        effects.completion = CompletionPredicate::all([condition, effects.completion.clone()]);
        effects.falls_through = effects.falls_through
            && self
                .completion_is_satisfiable(&effects.completion, path)
                .unwrap_or(true);
    }

    pub(super) fn completion_is_satisfiable(
        &mut self,
        predicate: &CompletionPredicate,
        path: &[DiagnosticPathSegment],
    ) -> Option<bool> {
        self.assignments_for_completion_predicates(&[predicate], path)
            .map(|assignments| {
                assignments
                    .iter()
                    .any(|assignment| predicate.evaluate(assignment))
            })
    }

    pub(super) fn assignments_for_completion_predicates(
        &mut self,
        predicates: &[&CompletionPredicate],
        path: &[DiagnosticPathSegment],
    ) -> Option<Vec<Assignment>> {
        let mut guards = Vec::new();
        for predicate in predicates {
            predicate.collect_guards(&mut guards);
        }
        self.assignments_for_guards(&guards, path)
    }

    pub(super) fn assignments_for_guards(
        &mut self,
        guards: &[&Guard],
        path: &[DiagnosticPathSegment],
    ) -> Option<Vec<Assignment>> {
        let (selectors, map_aggregates, join_correlations) = self.assignment_inputs(guards);
        let Some(dimensions) = build_dimensions(
            &selectors,
            DimensionInputs {
                nodes: &self.nodes,
                map_aggregates: &map_aggregates,
                join_correlations: &self.parallel_join_correlations,
                execution_correlations: &self.map_execution_correlations,
            },
        ) else {
            self.assignment_ceiling(path);
            return None;
        };
        if !self.assignment_count_is_bounded(&dimensions, path) {
            return None;
        }
        let mut assignments = enumerate_assignments(dimensions);
        assignments.retain(|assignment| {
            join_correlations
                .iter()
                .all(|name| self.assignment_matches_parallel_join_correlation(assignment, name))
        });
        Some(assignments)
    }

    pub(super) fn assignment_inputs(
        &self,
        guards: &[&Guard],
    ) -> (
        Vec<ControlSelector>,
        BTreeMap<SelectorKey, MapAggregate>,
        BTreeSet<NodeName>,
    ) {
        let mut expanded = guards.to_vec();
        let mut aggregates = self.explicit_map_aggregates(&expanded);
        let mut join_correlations = BTreeSet::new();
        let mut execution_correlations = BTreeSet::new();
        loop {
            let mut discovered = false;
            let selectors = expanded
                .iter()
                .flat_map(|guard| guard_selectors(guard))
                .collect::<Vec<_>>();
            for selector in selectors {
                let Some(correlation) = self.parallel_join_correlations.get(&selector.name) else {
                    continue;
                };
                if !is_parallel_join_selector(selector, correlation.field())
                    || !join_correlations.insert(selector.name.clone())
                {
                    continue;
                }
                let mut correlation_guards = Vec::new();
                correlation.collect_guards(&mut correlation_guards);
                if let Some(aggregate) = aggregates.get(&SelectorKey::from(selector)).cloned() {
                    for dependency in correlation_guards
                        .iter()
                        .flat_map(|guard| guard_selectors(guard))
                    {
                        if self
                            .map_control_scope(dependency)
                            .is_some_and(|scope| scope.owner == aggregate.owner)
                        {
                            aggregates.insert(SelectorKey::from(dependency), aggregate.clone());
                        }
                    }
                }
                expanded.extend(correlation_guards);
                aggregates.extend(self.explicit_map_aggregates(&expanded));
                discovered = true;
            }
            let aggregate_controls = aggregates.clone();
            for (key, aggregate) in aggregate_controls {
                let Some(correlation) = self.map_execution_correlations.get(&key.name) else {
                    continue;
                };
                if correlation.owner != aggregate.owner
                    || !execution_correlations.insert(key.name.clone())
                {
                    continue;
                }
                let mut correlation_guards = Vec::new();
                correlation.presence.collect_guards(&mut correlation_guards);
                for dependency in correlation_guards
                    .iter()
                    .flat_map(|guard| guard_selectors(guard))
                {
                    let dependency_key = SelectorKey::from(dependency);
                    if self
                        .map_control_scope(dependency)
                        .is_some_and(|scope| scope.owner == aggregate.owner)
                    {
                        aggregates.insert(dependency_key, aggregate.clone());
                    }
                }
                expanded.extend(correlation_guards);
                discovered = true;
            }
            if !discovered {
                break;
            }
        }
        let selectors = expanded
            .iter()
            .flat_map(|guard| guard_selectors(guard))
            .cloned()
            .collect::<Vec<_>>();

        (selectors, aggregates, join_correlations)
    }

    fn explicit_map_aggregates(&self, guards: &[&Guard]) -> BTreeMap<SelectorKey, MapAggregate> {
        guards
            .iter()
            .copied()
            .flat_map(|guard| guard_selector_uses(guard))
            .filter_map(|(selector, aggregate)| {
                aggregate
                    .then(|| self.map_control_scope(selector))
                    .flatten()
                    .map(|aggregate| (SelectorKey::from(selector), aggregate))
            })
            .collect()
    }

    fn assignment_matches_parallel_join_correlation(
        &self,
        assignment: &Assignment,
        name: &NodeName,
    ) -> bool {
        self.parallel_join_correlations
            .get(name)
            .is_none_or(|correlation| {
                assignment_matches_parallel_join_correlation(assignment, name, correlation)
            })
    }
}

fn is_parallel_join_selector(selector: &ControlSelector, field: &str) -> bool {
    selector.source == ControlSource::Group
        && selector
            .field
            .as_ref()
            .is_some_and(|selector_field| selector_field.as_str() == field)
}
