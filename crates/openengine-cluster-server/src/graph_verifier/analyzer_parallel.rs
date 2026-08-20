use super::*;

impl<'a> Analyzer<'a> {
    pub(super) fn assignment_count_is_bounded(
        &mut self,
        dimensions: &[Vec<Assignment>],
        path: &[DiagnosticPathSegment],
    ) -> bool {
        if !compatible_assignment_count_is_bounded(dimensions, FULL_V1_MAX_GUARD_ASSIGNMENTS) {
            self.assignment_ceiling(path);
            return false;
        }
        true
    }

    pub(super) fn assignment_ceiling(&mut self, path: &[DiagnosticPathSegment]) {
        emit_diagnostic!(
            self,
            GraphDiagnosticCode::CeilingExceeded,
            format!("control assignment space exceeds {FULL_V1_MAX_GUARD_ASSIGNMENTS}"),
            path.to_vec(),
            Vec::new(),
        );
    }

    pub(super) fn validate_parallel_writes(
        &mut self,
        par: &ParNode,
        branches: &[Effects],
        path: &[DiagnosticPathSegment],
    ) {
        self.validate_parallel_promotion_types(par, branches, path);
        self.validate_parallel_write_conflicts(par, branches, path);
    }

    pub(super) fn validate_parallel_promotion_types(
        &mut self,
        par: &ParNode,
        branches: &[Effects],
        path: &[DiagnosticPathSegment],
    ) {
        for (promotion_index, promoted) in par.promoted_state_paths.iter().enumerate() {
            let promoted_types = branches
                .iter()
                .flat_map(|branch| {
                    branch
                        .possible_write_types
                        .get(promoted)
                        .into_iter()
                        .flatten()
                })
                .collect::<Vec<_>>();
            for (left, left_type) in promoted_types.iter().enumerate() {
                for right_type in promoted_types.iter().skip(left + 1) {
                    if !compatible_types(left_type, right_type) {
                        emit_diagnostic!(
                            self,
                            GraphDiagnosticCode::SchemaSafety,
                            "parallel promotion has incompatible branch value types",
                            indexed_field_path(path, "promotedStatePaths", promotion_index),
                            vec![par.name.clone()],
                        );
                    }
                }
            }
        }
    }

    pub(super) fn validate_parallel_write_conflicts(
        &mut self,
        par: &ParNode,
        branches: &[Effects],
        path: &[DiagnosticPathSegment],
    ) {
        if !matches!(par.join, Join::All {}) {
            return;
        }
        for (left, (left_branch, left_node)) in
            branches.iter().zip(par.branches.as_slice()).enumerate()
        {
            for (right_branch, right_node) in
                branches.iter().zip(par.branches.as_slice()).skip(left + 1)
            {
                for left_path in left_branch.possible_writes.keys() {
                    for right_path in right_branch.possible_writes.keys() {
                        if paths_overlap(left_path, right_path) {
                            emit_diagnostic!(
                                self,
                                GraphDiagnosticCode::WriteConflict,
                                "parallel all branches have overlapping writes",
                                with_field(path, "branches"),
                                vec![left_node.name().clone(), right_node.name().clone(),],
                            );
                        }
                    }
                }
            }
        }
    }

    pub(super) fn validate_join(
        &mut self,
        group: &ParNode,
        incoming: &Flow,
        path: &[DiagnosticPathSegment],
    ) {
        if let Join::First { when } = &group.join {
            let mut available = incoming.available.clone();
            available.extend(collect_descendant_names(&group.branches));
            for selector in guard_selectors(when) {
                self.dependencies
                    .entry(group.name.clone())
                    .or_default()
                    .insert(selector.name.clone());
            }
            self.validate_guard(
                when,
                &available,
                GuardValidationContext {
                    path: &field_path(path, &["join", "when"]),
                    code: GraphDiagnosticCode::InvalidGraphShape,
                },
            );
        }
        if let Join::Quorum { count } = group.join {
            if count.get() > u64::try_from(group.branches.as_slice().len()).unwrap_or(u64::MAX) {
                emit_diagnostic!(
                    self,
                    GraphDiagnosticCode::InvalidGraphShape,
                    "parallel quorum exceeds branch count",
                    field_path(path, &["join", "count"]),
                    vec![group.name.clone()],
                );
            }
        }
    }

    pub(super) fn restrict_promotions(&mut self, context: PromotionValidationContext<'_>) {
        let allowed = context.promoted.iter().cloned().collect::<BTreeSet<_>>();
        for (index, promoted_path) in context.promoted.iter().enumerate() {
            self.validate_promotion(&context, promoted_path, index);
        }
        retain_promoted_writes(context.effects, &allowed);
    }

    pub(super) fn validate_promotion(
        &mut self,
        context: &PromotionValidationContext<'_>,
        promoted_path: &FieldPath,
        index: usize,
    ) {
        let diagnostic_path = indexed_field_path(context.path, "promotedStatePaths", index);
        if path_type(context.group_state, promoted_path).is_none() {
            emit_diagnostic!(
                self,
                GraphDiagnosticCode::SchemaSafety,
                "promoted state path does not exist in group state",
                diagnostic_path,
                Vec::new(),
            );
            return;
        }
        self.validate_promotion_target(context, promoted_path, &diagnostic_path);
        if matches!(context.rule, PromotionRule::Map)
            && !matches!(
                path_type(context.group_state, promoted_path),
                Some(PayloadType::Array { .. })
            )
        {
            return;
        }
        if !self.promotion_is_defined(context, promoted_path) {
            emit_diagnostic!(
                self,
                GraphDiagnosticCode::UndefinedRead,
                promotion_undefined_message(context.rule),
                diagnostic_path,
                Vec::new(),
            );
        }
    }

    pub(super) fn validate_promotion_target(
        &mut self,
        context: &PromotionValidationContext<'_>,
        promoted_path: &FieldPath,
        diagnostic_path: &[DiagnosticPathSegment],
    ) {
        match context
            .target_overrides
            .and_then(|targets| targets.get(promoted_path))
            .or_else(|| path_type(context.enclosing_state, promoted_path))
        {
            None => emit_diagnostic!(
                self,
                GraphDiagnosticCode::SchemaSafety,
                "promoted state path does not exist in enclosing state",
                diagnostic_path.to_vec(),
                Vec::new(),
            ),
            Some(target)
                if context
                    .effects
                    .possible_write_types
                    .get(promoted_path)
                    .is_some_and(|sources| {
                        sources.iter().any(|source| !source.is_subtype_of(target))
                    }) =>
            {
                emit_diagnostic!(
                    self,
                    GraphDiagnosticCode::SchemaSafety,
                    "promoted value is not a subtype of its enclosing state target",
                    diagnostic_path.to_vec(),
                    Vec::new(),
                );
            }
            Some(_) => {}
        }
    }

    pub(super) fn promotion_is_defined(
        &self,
        context: &PromotionValidationContext<'_>,
        promoted_path: &FieldPath,
    ) -> bool {
        let written = context
            .effects
            .definite_writes
            .values()
            .any(|write| write.guaranteed_paths.contains_key(promoted_path));
        if matches!(context.rule, PromotionRule::Map) {
            written
                || context.effects.outcome_writes.values().any(|writes| {
                    writes
                        .values()
                        .any(|write| write.guaranteed_paths.contains_key(promoted_path))
                })
        } else {
            let indexed = context
                .target_overrides
                .is_some_and(|targets| targets.contains_key(promoted_path));
            (!indexed && is_required_path(context.group_state, promoted_path)) || written
        }
    }
}

fn promotion_undefined_message(rule: PromotionRule) -> &'static str {
    match rule {
        PromotionRule::EveryAlternative => {
            "promoted path is not defined by every completing alternative"
        }
        PromotionRule::Map => "map promoted path has no indexed body write",
        PromotionRule::Definite => "promoted path is not definitely defined on completion",
    }
}
