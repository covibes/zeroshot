use super::*;

mod state;
use state::*;

impl Engine<'_> {
    pub(super) fn eval(
        &mut self,
        node: &GraphNode,
        context: &mut Context,
        traversal: Traversal<'_>,
    ) -> Result<Status, ReducerError> {
        match node {
            GraphNode::Step(_) | GraphNode::Verifier(_) => {
                self.eval_worker_node(node, context, traversal)
            }
            GraphNode::Seq(_)
            | GraphNode::Choice(_)
            | GraphNode::Par(_)
            | GraphNode::Loop(_)
            | GraphNode::Map(_) => self.eval_group_node(node, context, traversal),
            GraphNode::Succeed(_) | GraphNode::Fail(_) => {
                self.eval_terminal_node(node, context, traversal)
            }
        }
    }

    fn eval_worker_node(
        &mut self,
        node: &GraphNode,
        context: &mut Context,
        traversal: Traversal<'_>,
    ) -> Result<Status, ReducerError> {
        match node {
            GraphNode::Step(step) => self.eval_executable(
                ExecutableSpec {
                    name: &step.name,
                    worker: &step.worker,
                    input_bindings: &step.input_bindings,
                    write_bindings: &step.write_bindings,
                    attempt_ceiling: step.attempts,
                    verifier: false,
                },
                context,
                traversal,
            ),
            GraphNode::Verifier(verifier) => self.eval_executable(
                ExecutableSpec {
                    name: &verifier.name,
                    worker: &verifier.worker,
                    input_bindings: &verifier.input_bindings,
                    write_bindings: &verifier.write_bindings,
                    attempt_ceiling: verifier.attempts,
                    verifier: true,
                },
                context,
                traversal,
            ),
            _ => Err(ReducerError::InconsistentHistory),
        }
    }

    fn eval_group_node(
        &mut self,
        node: &GraphNode,
        context: &mut Context,
        traversal: Traversal<'_>,
    ) -> Result<Status, ReducerError> {
        match node {
            GraphNode::Seq(group) => self.eval_sequence(group, context, traversal),
            GraphNode::Choice(group) => self.eval_choice(group, context, traversal),
            GraphNode::Par(group) => self.eval_parallel(group, context, traversal),
            GraphNode::Loop(group) => self.eval_loop(group, context, traversal),
            GraphNode::Map(group) => self.eval_map(group, context, traversal),
            _ => Err(ReducerError::InconsistentHistory),
        }
    }

    fn eval_terminal_node(
        &self,
        node: &GraphNode,
        context: &Context,
        traversal: Traversal<'_>,
    ) -> Result<Status, ReducerError> {
        match node {
            GraphNode::Succeed(terminal) => {
                let output = bind_payload(&terminal.bindings, &context.state, traversal.item)?;
                Ok(Status::Terminal {
                    position: HistoryPosition::ZERO,
                    projection: TerminalProjection::Succeeded { output },
                })
            }
            GraphNode::Fail(terminal) => Ok(Status::Terminal {
                position: HistoryPosition::ZERO,
                projection: TerminalProjection::Failed {
                    reason: terminal.reason.as_label().clone(),
                },
            }),
            _ => Err(ReducerError::InconsistentHistory),
        }
    }

    fn eval_sequence(
        &mut self,
        group: &openengine_cluster_protocol::SeqNode,
        context: &mut Context,
        traversal: Traversal<'_>,
    ) -> Result<Status, ReducerError> {
        let mut local = context.clone();
        let mut position = HistoryPosition::ZERO;
        for child in group.children.as_slice() {
            match self.eval(child, &mut local, traversal)? {
                Status::Continue {
                    position: child_position,
                } => {
                    position = position.max(child_position);
                }
                other => return Ok(other.after(position)),
            }
        }
        promote(PromotionRequest {
            node: &group.name,
            map_indices: traversal.map_indices,
            paths: &group.promoted_state_paths,
            local: &local,
            parent: context,
            mode: traversal.mode,
            decisions: &mut self.decisions,
        })?;
        self.continue_decision(&group.name, traversal.mode);
        Ok(Status::Continue { position })
    }

    fn eval_loop(
        &mut self,
        group: &openengine_cluster_protocol::LoopNode,
        context: &mut Context,
        traversal: Traversal<'_>,
    ) -> Result<Status, ReducerError> {
        let mut local = context.clone();
        let mut position = HistoryPosition::ZERO;
        for _ in 1..=group.max_iterations.get() {
            match self.eval(&group.body, &mut local, traversal)? {
                Status::Continue {
                    position: body_position,
                } => {
                    position = position.max(body_position);
                }
                other => return Ok(other.after(position)),
            }
            let converged = match &group.until {
                Some(until) => self.guard(until, &local, traversal.map_indices)?,
                None => false,
            };
            if converged {
                return self.finish_loop(LoopFinishRequest {
                    group,
                    context,
                    traversal,
                    completion: LoopCompletion::new(local, position, "converged"),
                });
            }
        }
        self.finish_loop(LoopFinishRequest {
            group,
            context,
            traversal,
            completion: LoopCompletion::new(local, position, "exhausted"),
        })
    }

    fn finish_loop(&mut self, request: LoopFinishRequest<'_, '_>) -> Result<Status, ReducerError> {
        let LoopFinishRequest {
            group,
            context,
            traversal,
            completion,
        } = request;
        let LoopCompletion {
            mut local,
            position,
            label,
        } = completion;
        self.set_group_control(
            &mut local,
            GroupControlUpdate {
                node: &group.name,
                field: "terminated",
                label,
                map_indices: traversal.map_indices,
            },
        );
        promote(PromotionRequest {
            node: &group.name,
            map_indices: traversal.map_indices,
            paths: &group.promoted_state_paths,
            local: &local,
            parent: context,
            mode: traversal.mode,
            decisions: &mut self.decisions,
        })?;
        self.continue_decision(&group.name, traversal.mode);
        Ok(Status::Continue { position })
    }

    pub(super) fn eval_executable(
        &mut self,
        spec: ExecutableSpec<'_>,
        context: &mut Context,
        traversal: Traversal<'_>,
    ) -> Result<Status, ReducerError> {
        let resolution = self.resolve_visit(&spec, context, traversal.map_indices)?;
        let VisitResolution::Ready(visit) = resolution else {
            return attempts_exhausted();
        };
        let visit = *visit;
        let input = bind_payload(spec.input_bindings, &context.state, traversal.item)?;
        if let Some(execution) = &visit.existing {
            self.consumed_executions.insert(execution.execution);
        }
        mark_visit(
            spec.name,
            traversal.map_indices,
            &mut context.controls,
            visit.number,
        );
        let Some(execution) = visit.existing else {
            return self.dispatch_missing(MissingDispatchRequest {
                spec,
                visit,
                input,
                traversal,
            });
        };
        self.finish_existing_execution(ExistingExecutionRequest {
            spec,
            context,
            traversal,
            execution,
            input,
        })
    }

    fn finish_existing_execution(
        &mut self,
        request: ExistingExecutionRequest<'_, '_, '_>,
    ) -> Result<Status, ReducerError> {
        let ExistingExecutionRequest {
            spec,
            context,
            traversal,
            execution,
            input,
        } = request;
        if execution.dispatch_position > traversal.cutoff {
            return Ok(Status::Pending);
        }
        if execution.input != input {
            return Err(ReducerError::InconsistentHistory);
        }
        let DurableExecutionState::Settled { position, outcome } = &execution.state else {
            return Ok(Status::Pending);
        };
        if *position > traversal.cutoff {
            return Ok(Status::Pending);
        }
        let writes_applied = self.apply_outcome(OutcomeApplication {
            spec: &spec,
            context: &mut *context,
            map_indices: traversal.map_indices,
            outcome,
        })?;
        if writes_applied {
            self.promote_writes(&spec, context, traversal)?;
        }
        self.continue_decision(spec.name, traversal.mode);
        Ok(Status::continuing(*position))
    }

    fn resolve_visit(
        &self,
        spec: &ExecutableSpec<'_>,
        context: &Context,
        map_indices: &[u64],
    ) -> Result<VisitResolution, ReducerError> {
        let occurrence = StructuralOccurrence {
            node: spec.name.clone(),
            map_indices: map_indices.to_vec(),
        };
        let mut matching = self
            .executions
            .iter()
            .filter(|execution| execution.occurrence == occurrence)
            .cloned()
            .collect::<Vec<_>>();
        let number = next_visit(spec.name, map_indices, &context.controls);
        let (attempt, existing) = match self.execution_mode {
            ExecutionMode::LegacyAttempts => {
                matching.sort_by_key(|execution| execution.attempt);
                let attempt =
                    PositiveInteger::new(number).map_err(|_| ReducerError::InconsistentHistory)?;
                if attempt.get() > spec.attempt_ceiling.get() {
                    return Ok(VisitResolution::Exhausted);
                }
                let existing = matching
                    .iter()
                    .find(|execution| execution.attempt == attempt)
                    .cloned();
                (attempt, existing)
            }
            ExecutionMode::NativeV2NoRetry => {
                matching.sort_by_key(|execution| execution.dispatch_position);
                let attempt =
                    PositiveInteger::new(1).map_err(|_| ReducerError::InconsistentHistory)?;
                let index =
                    usize::try_from(number - 1).map_err(|_| ReducerError::IdentityOutOfRange)?;
                (attempt, matching.get(index).cloned())
            }
        };
        Ok(VisitResolution::Ready(Box::new(ExecutableVisit {
            occurrence,
            matching,
            number,
            attempt,
            existing,
        })))
    }

    fn dispatch_missing(
        &mut self,
        request: MissingDispatchRequest<'_, '_>,
    ) -> Result<Status, ReducerError> {
        let MissingDispatchRequest {
            spec,
            visit,
            input,
            traversal,
        } = request;
        if traversal.mode == EvalMode::Probe || traversal.cutoff != HistoryPosition::MAX {
            return Ok(Status::Pending);
        }
        let node_instance = match visit.matching.last() {
            Some(previous) => previous.node_instance,
            None => {
                let allocated = NodeInstanceId::new(self.next_node_instance)
                    .map_err(|_| ReducerError::IdentityOutOfRange)?;
                self.next_node_instance = self
                    .next_node_instance
                    .checked_add(1)
                    .ok_or(ReducerError::IdentityOutOfRange)?;
                allocated
            }
        };
        let execution =
            ExecutionId::new(self.next_execution).map_err(|_| ReducerError::IdentityOutOfRange)?;
        self.next_execution = self
            .next_execution
            .checked_add(1)
            .ok_or(ReducerError::IdentityOutOfRange)?;
        self.decisions.push(Decision::Dispatch {
            node_instance,
            execution,
            occurrence: visit.occurrence,
            attempt: visit.attempt,
            worker: spec.worker.clone(),
            input,
        });
        Ok(Status::Pending)
    }

    fn apply_outcome(
        &mut self,
        application: OutcomeApplication<'_, '_>,
    ) -> Result<bool, ReducerError> {
        let OutcomeApplication {
            spec,
            context,
            map_indices,
            outcome,
        } = application;
        match outcome {
            WorkerOutcome::Error { code, .. } => {
                self.set_control(
                    context,
                    ControlUpdate {
                        node: spec.name,
                        source: ControlSource::Error,
                        field: None,
                        label: code.as_str(),
                        map_indices,
                    },
                );
                return Ok(false);
            }
            WorkerOutcome::Verified { output, .. } if !spec.verifier => {
                apply_writes(
                    context,
                    WriteApplication {
                        name: spec.name,
                        output,
                        signals: None,
                        diagnostic: None,
                        bindings: spec.write_bindings,
                        map_indices,
                    },
                )?;
            }
            WorkerOutcome::Verifier {
                output,
                signals,
                diagnostic,
                ..
            } if spec.verifier => {
                for (field, label) in signals {
                    self.set_control(
                        context,
                        ControlUpdate {
                            node: spec.name,
                            source: ControlSource::Signal,
                            field: Some(field.as_str()),
                            label: label.as_str(),
                            map_indices,
                        },
                    );
                }
                apply_writes(
                    context,
                    WriteApplication {
                        name: spec.name,
                        output,
                        signals: Some(signals),
                        diagnostic: Some(diagnostic),
                        bindings: spec.write_bindings,
                        map_indices,
                    },
                )?;
            }
            _ => return Err(ReducerError::InconsistentHistory),
        }
        Ok(true)
    }

    fn promote_writes(
        &mut self,
        spec: &ExecutableSpec<'_>,
        context: &Context,
        traversal: Traversal<'_>,
    ) -> Result<(), ReducerError> {
        if traversal.mode != EvalMode::Decide || spec.write_bindings.is_empty() {
            return Ok(());
        }
        let values = spec
            .write_bindings
            .iter()
            .map(|binding| {
                Ok(PromotedValue {
                    path: binding.target.clone(),
                    value: select(&context.state, &binding.target)?.clone(),
                })
            })
            .collect::<Result<Vec<_>, ReducerError>>()?;
        self.decisions.push(Decision::Promote {
            node: spec.name.clone(),
            map_indices: traversal.map_indices.to_vec(),
            values,
        });
        Ok(())
    }
    // Choice, parallel, and map evaluation live in the groups companion module.
}
