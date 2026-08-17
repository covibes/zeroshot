use super::*;

impl Engine<'_> {
    pub(super) fn guard(
        &self,
        guard: &Guard,
        context: &Context,
        map_indices: &[u64],
    ) -> Result<bool, ReducerError> {
        match guard {
            Guard::In { value, labels } => Ok(self
                .control_values(value, context, map_indices)
                .iter()
                .any(|actual| labels.values().iter().any(|label| label.as_str() == actual))),
            Guard::All { guards } => guards.as_slice().iter().try_fold(true, |matches, guard| {
                Ok(matches && self.guard(guard, context, map_indices)?)
            }),
            Guard::Any { guards } => guards.as_slice().iter().try_fold(false, |matches, guard| {
                Ok(matches || self.guard(guard, context, map_indices)?)
            }),
            Guard::Not { guard } => Ok(!self.guard(guard, context, map_indices)?),
            Guard::KOfN {
                count,
                values,
                labels,
            } => Ok(values
                .as_slice()
                .iter()
                .filter(|selector| {
                    self.control_values(selector, context, map_indices)
                        .iter()
                        .any(|actual| labels.values().iter().any(|label| label.as_str() == actual))
                })
                .count() as u64
                >= count.get()),
            Guard::KOfMap {
                count,
                value,
                labels,
            } => Ok(self
                .control_values(value, context, map_indices)
                .iter()
                .filter(|actual| {
                    labels
                        .values()
                        .iter()
                        .any(|label| label.as_str() == *actual)
                })
                .count() as u64
                >= count.get()),
        }
    }

    pub(super) fn control_values(
        &self,
        selector: &ControlSelector,
        context: &Context,
        map_indices: &[u64],
    ) -> Vec<String> {
        let depth = self.map_depths.get(&selector.name).copied().unwrap_or(0);
        let aggregate = depth > map_indices.len();
        context
            .controls
            .iter()
            .filter(|(key, _)| {
                key.node == selector.name
                    && key.source == selector.source
                    && key.field.as_deref() == selector.field.as_ref().map(|field| field.as_str())
                    && if aggregate {
                        key.map_indices.starts_with(map_indices) && key.map_indices.len() == depth
                    } else {
                        map_indices
                            .get(..depth)
                            .is_some_and(|indices| key.map_indices == indices)
                    }
            })
            .map(|(_, value)| value.clone())
            .collect()
    }

    pub(super) fn set_control(&self, context: &mut Context, update: ControlUpdate<'_>) {
        let depth = self.map_depths.get(update.node).copied().unwrap_or(0);
        context.controls.insert(
            ControlKey {
                node: update.node.clone(),
                source: update.source,
                field: update.field.map(str::to_owned),
                map_indices: update.map_indices.iter().take(depth).copied().collect(),
            },
            update.label.to_owned(),
        );
    }

    pub(super) fn set_group_control(&self, context: &mut Context, update: GroupControlUpdate<'_>) {
        self.set_control(
            context,
            ControlUpdate {
                node: update.node,
                source: ControlSource::Group,
                field: Some(update.field),
                label: update.label,
                map_indices: update.map_indices,
            },
        );
    }

    pub(super) fn continue_decision(&mut self, node: &NodeName, mode: EvalMode) {
        if mode == EvalMode::Decide {
            self.decisions
                .push(Decision::Continue { node: node.clone() });
        }
    }

    pub(super) fn record_void_cutoff(
        &mut self,
        execution: ExecutionId,
        position: HistoryPosition,
        reason: ExecutionVoidReason,
    ) -> ExecutionVoidReason {
        let cutoff = self
            .void_cutoffs
            .entry(execution)
            .or_insert(VoidCutoff { position, reason });
        if position < cutoff.position {
            *cutoff = VoidCutoff { position, reason };
        }
        cutoff.reason
    }

    pub(super) fn void_active_descendants(&mut self, node: &GraphNode, scope: VoidScope<'_>) {
        let descendants = descendant_names(node);
        let mut losers = self
            .executions
            .iter()
            .filter(|execution| {
                self.consumed_executions.contains(&execution.execution)
                    && descendants.contains(&execution.occurrence.node)
                    && execution
                        .occurrence
                        .map_indices
                        .starts_with(scope.map_indices)
                    && !matches!(execution.state, DurableExecutionState::Settled { .. })
            })
            .map(|execution| {
                (
                    execution.dispatch_position,
                    execution.execution,
                    matches!(execution.state, DurableExecutionState::Active),
                )
            })
            .collect::<Vec<_>>();
        losers.sort_unstable();
        for (_, execution, active) in losers {
            let reason = self.record_void_cutoff(execution, scope.cutoff, scope.reason);
            if active && scope.emit_decisions {
                self.push_void_decision(execution, reason);
            }
        }
    }

    pub(super) fn void_map_losers(&mut self, body: &GraphNode, scope: MapVoidScope<'_>) {
        let descendants = descendant_names(body);
        let mut losers = self
            .executions
            .iter()
            .filter(|execution| {
                self.consumed_executions.contains(&execution.execution)
                    && descendants.contains(&execution.occurrence.node)
                    && execution
                        .occurrence
                        .map_indices
                        .starts_with(scope.common.map_indices)
                    && !execution
                        .occurrence
                        .map_indices
                        .starts_with(scope.winner_scope)
                    && !matches!(execution.state, DurableExecutionState::Settled { .. })
            })
            .map(|execution| {
                (
                    execution.dispatch_position,
                    execution.execution,
                    matches!(execution.state, DurableExecutionState::Active),
                )
            })
            .collect::<Vec<_>>();
        losers.sort_unstable();
        for (_, execution, active) in losers {
            let reason =
                self.record_void_cutoff(execution, scope.common.cutoff, scope.common.reason);
            if active && scope.common.emit_decisions {
                self.push_void_decision(execution, reason);
            }
        }
    }
}
