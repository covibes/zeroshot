use super::*;

impl<'a> Analyzer<'a> {
    pub(super) fn new(graph: &'a GraphSpec) -> Self {
        Self {
            graph,
            nodes: BTreeMap::new(),
            authored: Vec::new(),
            dependencies: BTreeMap::new(),
            loops: Vec::new(),
            attempts: BTreeMap::new(),
            diagnostics: Vec::new(),
            guard_nodes: 0,
            exhaustive_choices: BTreeSet::new(),
            choice_reachability: BTreeMap::new(),
            parallel_join_correlations: BTreeMap::new(),
            map_execution_correlations: BTreeMap::new(),
            node_completion: BTreeMap::new(),
            node_fallthrough: BTreeMap::new(),
        }
    }

    pub(super) fn analyze(&mut self) -> Option<StructuralBounds> {
        self.validate_profile();
        let root_path = vec![field_segment("root"), node_segment(self.graph.root.name())];
        self.index_node(&self.graph.root, root_path, 1);
        self.validate_global_limits();

        let initial = Flow {
            defined: required_paths_with_types(&self.graph.initial_input),
            ..Flow::default()
        };
        self.validate_node(
            &self.graph.root,
            NodeValidationContext {
                incoming: &initial,
                state: &self.graph.initial_input,
                item: None,
                map_index_targets: None,
            },
        );
        self.validate_terminal_coverage();
        let order = self.reference_topological_order();
        let fold = self.fold_node(&self.graph.root);

        if !self.diagnostics.is_empty() {
            return None;
        }
        self.build_bounds(fold?, order)
    }

    pub(super) fn validate_profile(&mut self) {
        if self.graph.profile != GraphProfile::Full {
            emit_diagnostic!(
                self,
                GraphDiagnosticCode::InvalidGraphShape,
                "production full-v1 verifier accepts only openengine.graph.full/v1",
                vec![field_segment("profile")],
                Vec::new(),
            );
        }
    }

    pub(super) fn validate_global_limits(&mut self) {
        if u64::try_from(self.authored.len()).unwrap_or(u64::MAX) > FULL_V1_MAX_GRAPH_NODES {
            emit_diagnostic!(
                self,
                GraphDiagnosticCode::CeilingExceeded,
                format!("graph node count exceeds {FULL_V1_MAX_GRAPH_NODES}"),
                vec![field_segment("root")],
                Vec::new(),
            );
        }
        if self.guard_nodes > FULL_V1_MAX_GUARD_NODES {
            emit_diagnostic!(
                self,
                GraphDiagnosticCode::CeilingExceeded,
                format!("graph guard-node count exceeds {FULL_V1_MAX_GUARD_NODES}"),
                vec![field_segment("root")],
                Vec::new(),
            );
        }
    }

    pub(super) fn build_bounds(
        &self,
        fold: Fold,
        order: Vec<NodeName>,
    ) -> Option<StructuralBounds> {
        let max_node_executions = PositiveInteger::new(fold.executions.max(1)).ok()?;
        let peak_concurrency = PositiveInteger::new(fold.concurrency.max(1)).ok()?;
        let termination = if self.loops.is_empty() {
            TerminationWitness::Acyclic {
                order: NonEmptyVec::new(order).ok()?,
            }
        } else {
            let ranking = self
                .loops
                .iter()
                .map(|name| {
                    field_name(name.as_str()).and_then(|name| FieldPath::new(vec![name]).ok())
                })
                .collect::<Option<Vec<_>>>()?;
            TerminationWitness::Bounded {
                ranking: NonEmptyVec::new(ranking).ok()?,
                max_iterations: PositiveInteger::new(fold.loop_entries).ok()?,
            }
        };
        Some(StructuralBounds {
            termination,
            max_node_executions,
            peak_concurrency,
            attempts_per_node: self.attempts.clone(),
        })
    }

    pub(super) fn index_node(
        &mut self,
        node: &'a GraphNode,
        path: Vec<DiagnosticPathSegment>,
        depth: u64,
    ) {
        self.index_identity(node, &path);
        self.validate_node_depth(node.name(), &path, depth);
        self.index_children(node, &path, depth);
    }

    pub(super) fn index_identity(&mut self, node: &'a GraphNode, path: &[DiagnosticPathSegment]) {
        let name = node.name().clone();
        let ordinal = self.authored.len();
        self.authored.push(name.clone());
        self.dependencies.entry(name.clone()).or_default();
        if let Some(previous) = self.nodes.get(&name) {
            emit_diagnostic!(
                self,
                GraphDiagnosticCode::InvalidGraphShape,
                format!("duplicate node name {name}"),
                path.to_vec(),
                vec![previous.node.name().clone()],
            );
        } else {
            self.nodes.insert(
                name.clone(),
                NodeInfo {
                    node,
                    path: path.to_vec(),
                    ordinal,
                },
            );
        }
    }

    pub(super) fn validate_node_depth(
        &mut self,
        name: &NodeName,
        path: &[DiagnosticPathSegment],
        depth: u64,
    ) {
        if depth > FULL_V1_MAX_GRAPH_DEPTH {
            emit_diagnostic!(
                self,
                GraphDiagnosticCode::CeilingExceeded,
                format!("graph depth exceeds {FULL_V1_MAX_GRAPH_DEPTH}"),
                path.to_vec(),
                vec![name.clone()],
            );
        }
    }

    pub(super) fn index_children(
        &mut self,
        node: &'a GraphNode,
        path: &[DiagnosticPathSegment],
        depth: u64,
    ) {
        match node {
            GraphNode::Step(step) => self.index_executable(ExecutableIndexContext {
                name: &step.name,
                attempts: step.attempts,
                path,
                bindings: &step.write_bindings,
            }),
            GraphNode::Verifier(verifier) => self.index_executable(ExecutableIndexContext {
                name: &verifier.name,
                attempts: verifier.attempts,
                path,
                bindings: &verifier.write_bindings,
            }),
            GraphNode::Seq(group) => self.index_sequence(group, path, depth),
            GraphNode::Choice(group) => self.index_choice(group, path, depth),
            GraphNode::Par(group) => self.index_parallel(group, path, depth),
            GraphNode::Loop(group) => self.index_loop(group, path, depth),
            GraphNode::Map(group) => self.index_node(
                &group.body,
                named_child_path(path, "body", group.body.name()),
                depth + 1,
            ),
            GraphNode::Succeed(_) | GraphNode::Fail(_) => {}
        }
    }

    pub(super) fn index_sequence(
        &mut self,
        group: &'a SeqNode,
        path: &[DiagnosticPathSegment],
        depth: u64,
    ) {
        for (index, child) in group.children.as_slice().iter().enumerate() {
            self.index_node(
                child,
                child_path(path, "children", index, child.name()),
                depth + 1,
            );
        }
    }

    pub(super) fn index_choice(
        &mut self,
        group: &'a ChoiceNode,
        path: &[DiagnosticPathSegment],
        depth: u64,
    ) {
        for (index, branch) in group.branches.as_slice().iter().enumerate() {
            self.count_guard(&branch.when, guard_path(path, "branches", index, "when"));
            let branch_path = choice_branch_node_path(path, index, branch.node.name());
            self.index_node(&branch.node, branch_path, depth + 1);
        }
        if let Some(otherwise) = &group.otherwise {
            self.index_node(
                otherwise,
                named_child_path(path, "otherwise", otherwise.name()),
                depth + 1,
            );
        }
    }

    pub(super) fn index_parallel(
        &mut self,
        group: &'a ParNode,
        path: &[DiagnosticPathSegment],
        depth: u64,
    ) {
        if let Join::First { when } = &group.join {
            self.count_guard(when, field_path(path, &["join", "when"]));
        }
        for (index, branch) in group.branches.as_slice().iter().enumerate() {
            self.index_node(
                branch,
                child_path(path, "branches", index, branch.name()),
                depth + 1,
            );
        }
    }

    pub(super) fn index_loop(
        &mut self,
        group: &'a LoopNode,
        path: &[DiagnosticPathSegment],
        depth: u64,
    ) {
        self.loops.push(group.name.clone());
        if let Some(until) = &group.until {
            self.count_guard(until, with_field(path, "until"));
        }
        self.index_node(
            &group.body,
            named_child_path(path, "body", group.body.name()),
            depth + 1,
        );
    }

    pub(super) fn index_executable(&mut self, context: ExecutableIndexContext<'_>) {
        if context.attempts.get() > FULL_V1_MAX_ATTEMPTS_PER_NODE {
            emit_diagnostic!(
                self,
                GraphDiagnosticCode::CeilingExceeded,
                format!("attempts exceeds full-v1 limit {FULL_V1_MAX_ATTEMPTS_PER_NODE}"),
                with_field(context.path, "attempts"),
                vec![context.name.clone()],
            );
        }
        self.attempts.insert(context.name.clone(), context.attempts);
        for binding in context.bindings {
            if binding.value.node != *context.name {
                self.dependencies
                    .entry(context.name.clone())
                    .or_default()
                    .insert(binding.value.node.clone());
            }
        }
    }

    pub(super) fn count_guard(&mut self, guard: &Guard, path: Vec<DiagnosticPathSegment>) {
        let count = guard_node_count(guard);
        self.guard_nodes = self.guard_nodes.saturating_add(count);
        for selector in guard_selectors(guard) {
            if selector.name != *self.graph.root.name() {
                // The exact owning-node edge is added during semantic validation.
                self.dependencies.entry(selector.name.clone()).or_default();
            }
        }
        if count > FULL_V1_MAX_GUARD_NODES {
            emit_diagnostic!(
                self,
                GraphDiagnosticCode::CeilingExceeded,
                format!("guard contains more than {FULL_V1_MAX_GUARD_NODES} nodes"),
                path,
                Vec::new(),
            );
        }
    }
}
