use super::*;

impl<'a> Analyzer<'a> {
    pub(super) fn validate_map(
        &mut self,
        group: &MapNode,
        context: &LocatedNodeValidationContext<'_>,
    ) -> Effects {
        self.validate_map_item_limit(group, &context.path);
        let (index_targets, own_index_targets) = self.map_index_targets(group, context);
        let item_type = self.validate_map_selector(group, context);
        let body = self.validate_node(
            &group.body,
            NodeValidationContext {
                incoming: context.node.incoming,
                state: &group.state,
                item: item_type.as_ref(),
                map_index_targets: Some(&index_targets),
            },
        );
        self.collect_map_execution_correlations(group);
        let mut effects = map_effects(group, context.node.incoming, &body);
        collect_indexed_map_writes(
            &mut effects,
            &body,
            &group.promoted_state_paths,
            &own_index_targets,
        );
        self.restrict_promotions(PromotionValidationContext {
            group_state: &group.state,
            enclosing_state: context.node.state,
            promoted: &group.promoted_state_paths,
            effects: &mut effects,
            path: &context.path,
            rule: PromotionRule::Map,
            target_overrides: context.node.map_index_targets,
        });
        effects
    }

    fn validate_map_item_limit(&mut self, group: &MapNode, path: &[DiagnosticPathSegment]) {
        if group.max_items.get() > FULL_V1_MAX_MAP_ITEMS {
            emit_diagnostic!(
                self,
                GraphDiagnosticCode::CeilingExceeded,
                format!("maxItems exceeds full-v1 limit {FULL_V1_MAX_MAP_ITEMS}"),
                with_field(path, "maxItems"),
                vec![group.name.clone()],
            );
        }
    }

    fn collect_map_execution_correlations(&mut self, group: &MapNode) {
        self.collect_map_node_execution(&group.body, &group.name, CompletionPredicate::Always);
    }

    fn collect_map_node_execution(
        &mut self,
        node: &GraphNode,
        owner: &NodeName,
        presence: CompletionPredicate,
    ) {
        match node {
            GraphNode::Step(_) | GraphNode::Verifier(_) => {
                self.map_execution_correlations.insert(
                    node.name().clone(),
                    MapExecutionCorrelation {
                        owner: owner.clone(),
                        presence,
                    },
                );
            }
            GraphNode::Seq(sequence) => {
                let mut child_presence = presence;
                for child in sequence.children.as_slice() {
                    self.collect_map_node_execution(child, owner, child_presence.clone());
                    child_presence = if self
                        .node_fallthrough
                        .get(&node_identity(child))
                        .copied()
                        .unwrap_or(true)
                    {
                        CompletionPredicate::all([
                            child_presence,
                            self.node_completion
                                .get(child.name())
                                .cloned()
                                .unwrap_or(CompletionPredicate::Always),
                        ])
                    } else {
                        CompletionPredicate::Never
                    };
                }
            }
            GraphNode::Choice(choice) => {
                for (branch, branch_presence) in choice
                    .branches
                    .as_slice()
                    .iter()
                    .zip(choice_branch_completion_predicates(choice))
                {
                    self.collect_map_node_execution(
                        &branch.node,
                        owner,
                        CompletionPredicate::all([presence.clone(), branch_presence]),
                    );
                }
                if let Some(otherwise) = &choice.otherwise {
                    self.collect_map_node_execution(
                        otherwise,
                        owner,
                        CompletionPredicate::all([
                            presence,
                            choice_otherwise_completion_predicate(choice),
                        ]),
                    );
                }
            }
            GraphNode::Par(parallel) => {
                self.map_execution_correlations.insert(
                    parallel.name.clone(),
                    MapExecutionCorrelation {
                        owner: owner.clone(),
                        presence: presence.clone(),
                    },
                );
                if parallel_required_completions(&parallel.join, parallel.branches.as_slice().len())
                    == u64::try_from(parallel.branches.as_slice().len()).unwrap_or(u64::MAX)
                {
                    for branch in parallel.branches.as_slice() {
                        self.collect_map_node_execution(branch, owner, presence.clone());
                    }
                }
            }
            GraphNode::Loop(group) => {
                self.map_execution_correlations.insert(
                    group.name.clone(),
                    MapExecutionCorrelation {
                        owner: owner.clone(),
                        presence: presence.clone(),
                    },
                );
                self.collect_map_node_execution(&group.body, owner, presence);
            }
            GraphNode::Map(nested) => {
                self.map_execution_correlations.insert(
                    nested.name.clone(),
                    MapExecutionCorrelation {
                        owner: owner.clone(),
                        presence,
                    },
                );
            }
            GraphNode::Succeed(_) | GraphNode::Fail(_) => {}
        }
    }

    fn map_index_targets(
        &mut self,
        group: &MapNode,
        context: &LocatedNodeValidationContext<'_>,
    ) -> (
        BTreeMap<FieldPath, PayloadType>,
        BTreeMap<FieldPath, PayloadType>,
    ) {
        let mut inherited = context.node.map_index_targets.cloned().unwrap_or_default();
        let mut own = BTreeMap::new();
        for (index, promoted) in group.promoted_state_paths.iter().enumerate() {
            match context
                .node
                .map_index_targets
                .and_then(|targets| targets.get(promoted))
                .or_else(|| path_type(&group.state, promoted))
            {
                Some(PayloadType::Array { items }) => {
                    let item = (**items).clone();
                    inherited.insert(promoted.clone(), item.clone());
                    own.insert(promoted.clone(), item);
                }
                Some(_) => {
                    inherited.remove(promoted);
                    emit_diagnostic!(
                        self,
                        GraphDiagnosticCode::SchemaSafety,
                        "map promoted state path must be an array for indexed body writes",
                        indexed_field_path(&context.path, "promotedStatePaths", index),
                        vec![group.name.clone()],
                    );
                }
                None => {}
            }
        }
        (inherited, own)
    }
}

fn map_effects(group: &MapNode, incoming: &Flow, body: &Effects) -> Effects {
    Effects {
        definite_nodes: BTreeSet::from([group.name.clone()]),
        exit_failed: incoming.failed.union(&body.exit_failed).cloned().collect(),
        falls_through: true,
        completion: CompletionPredicate::Always,
        ..Effects::default()
    }
}

fn collect_indexed_map_writes(
    effects: &mut Effects,
    body: &Effects,
    promoted_paths: &[FieldPath],
    index_targets: &BTreeMap<FieldPath, PayloadType>,
) {
    for promoted in promoted_paths {
        let Some(expected_element_type) = index_targets.get(promoted) else {
            continue;
        };
        collect_definite_indexed_write(effects, body, promoted);
        collect_outcome_indexed_writes(effects, body, promoted);
        collect_possible_indexed_write(effects, body, promoted, expected_element_type);
    }
}

fn collect_definite_indexed_write(effects: &mut Effects, body: &Effects, target: &FieldPath) {
    let Some(write) = body.definite_writes.get(target) else {
        return;
    };
    let write = indexed_map_write(target, write);
    effects
        .definite_writes
        .insert(target.clone(), write.clone());
    effects.possible_writes.insert(target.clone(), write);
}

fn collect_outcome_indexed_writes(effects: &mut Effects, body: &Effects, target: &FieldPath) {
    for name in &body.outcome_order {
        let Some(writes) = body.outcome_writes.get(name) else {
            continue;
        };
        let Some(write) = writes.get(target) else {
            continue;
        };
        effects
            .outcome_writes
            .entry(name.clone())
            .or_default()
            .insert(target.clone(), indexed_map_write(target, write));
        if !effects.outcome_order.contains(name) {
            effects.outcome_order.push(name.clone());
        }
    }
}

fn collect_possible_indexed_write(
    effects: &mut Effects,
    body: &Effects,
    target: &FieldPath,
    expected_element_type: &PayloadType,
) {
    let possible_types = body
        .possible_write_types
        .get(target)
        .into_iter()
        .flatten()
        .map(|element_type| PayloadType::Array {
            items: Box::new(element_type.clone()),
        })
        .collect::<Vec<_>>();
    if !possible_types.is_empty() {
        effects
            .possible_write_types
            .insert(target.clone(), possible_types);
    }
    if let Some(write) = body.possible_writes.get(target) {
        effects
            .possible_writes
            .insert(target.clone(), indexed_map_write(target, write));
    } else if effects
        .outcome_writes
        .values()
        .any(|writes| writes.contains_key(target))
    {
        let array_type = PayloadType::Array {
            items: Box::new(expected_element_type.clone()),
        };
        effects.possible_writes.insert(
            target.clone(),
            WriteFact {
                value_type: array_type.clone(),
                guaranteed_paths: guaranteed_write_paths(target, &array_type, true),
            },
        );
    }
}

fn indexed_map_write(target: &FieldPath, element: &WriteFact) -> WriteFact {
    let value_type = PayloadType::Array {
        items: Box::new(element.value_type.clone()),
    };
    WriteFact {
        guaranteed_paths: guaranteed_write_paths(target, &value_type, true),
        value_type,
    }
}
