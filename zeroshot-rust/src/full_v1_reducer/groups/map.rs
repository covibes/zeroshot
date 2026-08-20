use super::*;

struct MapItemsEvaluation<'a> {
    evaluation: GroupEvaluation<'a, MapNode>,
    items: &'a [Value],
}

impl Engine<'_> {
    pub(in crate::full_v1_reducer) fn eval_map(
        &mut self,
        group: &MapNode,
        context: &mut Context,
        traversal: Traversal<'_>,
    ) -> Result<Status, ReducerError> {
        let selected = select_data(&group.over, &context.state, traversal.item)?;
        let items = selected
            .as_array()
            .ok_or(ReducerError::InvalidDurableValue)?;
        if items.len() as u64 > group.max_items.get() {
            return Ok(self.map_overflow(group, context, traversal));
        }
        let probes = self.evaluate_map_items(
            MapItemsEvaluation {
                evaluation: GroupEvaluation {
                    group,
                    context: &*context,
                    traversal,
                },
                items,
            },
            EvalMode::Probe,
        )?;
        if let Some((terminal_index, terminal)) = earliest_terminal(&probes) {
            return self.finish_terminal_map_item(
                GroupEvaluation {
                    group,
                    context: &*context,
                    traversal,
                },
                TerminalMapSelection {
                    items,
                    probes: &probes,
                    index: terminal_index,
                    terminal,
                },
            );
        }
        let results = if traversal.mode == EvalMode::Probe {
            probes
        } else {
            self.evaluate_map_items(
                MapItemsEvaluation {
                    evaluation: GroupEvaluation {
                        group,
                        context: &*context,
                        traversal,
                    },
                    items,
                },
                traversal.mode,
            )?
        };
        if results
            .iter()
            .any(|result| matches!(result.status, Status::Pending))
        {
            return Ok(Status::Pending);
        }
        self.finish_map(
            GroupMutation {
                group,
                context,
                traversal,
            },
            &results,
        )
    }

    fn map_overflow(
        &mut self,
        group: &MapNode,
        context: &mut Context,
        traversal: Traversal<'_>,
    ) -> Status {
        self.set_group_control(
            context,
            GroupControlUpdate {
                node: &group.name,
                field: "overflow",
                label: "overflow",
                map_indices: traversal.map_indices,
            },
        );
        self.continue_decision(&group.name, traversal.mode);
        Status::Continue {
            position: HistoryPosition::ZERO,
        }
    }

    fn evaluate_map_items(
        &mut self,
        evaluation: MapItemsEvaluation<'_>,
        mode: EvalMode,
    ) -> Result<Vec<MapItemResult>, ReducerError> {
        let MapItemsEvaluation {
            evaluation:
                GroupEvaluation {
                    group,
                    context,
                    traversal,
                },
            items,
        } = evaluation;
        items
            .iter()
            .enumerate()
            .map(|(index, item)| {
                let mut scope = traversal.map_indices.to_vec();
                scope.push(index as u64);
                let mut item_context = context.clone();
                let status = self.eval(
                    &group.body,
                    &mut item_context,
                    Traversal {
                        map_indices: &scope,
                        item: Some(item),
                        mode,
                        ..traversal
                    },
                )?;
                Ok(MapItemResult {
                    status,
                    context: item_context,
                    scope,
                })
            })
            .collect()
    }

    fn finish_terminal_map_item(
        &mut self,
        evaluation: GroupEvaluation<'_, MapNode>,
        selected: TerminalMapSelection<'_>,
    ) -> Result<Status, ReducerError> {
        let GroupEvaluation {
            group,
            context,
            traversal,
        } = evaluation;
        let terminal_scope = &selected
            .probes
            .get(selected.index)
            .ok_or(ReducerError::InconsistentHistory)?
            .scope;
        let terminal = if traversal.mode == EvalMode::Decide {
            let mut terminal_context = context.clone();
            self.eval(
                &group.body,
                &mut terminal_context,
                Traversal {
                    map_indices: terminal_scope,
                    item: Some(
                        selected
                            .items
                            .get(selected.index)
                            .ok_or(ReducerError::InconsistentHistory)?,
                    ),
                    cutoff: selected.terminal.position(),
                    ..traversal
                },
            )?
        } else {
            selected.terminal
        };
        self.void_map_losers(
            &group.body,
            MapVoidScope {
                common: VoidScope {
                    map_indices: traversal.map_indices,
                    cutoff: terminal.position(),
                    reason: ExecutionVoidReason::MapTerminal,
                    emit_decisions: traversal.mode == EvalMode::Decide,
                },
                winner_scope: terminal_scope,
            },
        );
        Ok(terminal)
    }

    fn finish_map(
        &mut self,
        evaluation: GroupMutation<'_, MapNode>,
        results: &[MapItemResult],
    ) -> Result<Status, ReducerError> {
        let GroupMutation {
            group,
            context,
            traversal,
        } = evaluation;
        let mut local = context.clone();
        for path in &group.promoted_state_paths {
            let values = results
                .iter()
                .map(|item| select(&item.context.state, path).cloned())
                .collect::<Result<Vec<_>, _>>()?;
            set_path(&mut local.state, path, Value::Array(values))?;
            local.local_writes.insert(path.clone());
        }
        self.set_group_control(
            &mut local,
            GroupControlUpdate {
                node: &group.name,
                field: "overflow",
                label: "ok",
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
        for item in results {
            merge_runtime_facts(&item.context, context);
        }
        self.continue_decision(&group.name, traversal.mode);
        let position = results
            .iter()
            .map(|item| item.status.position())
            .max()
            .unwrap_or(HistoryPosition::ZERO);
        Ok(Status::Continue { position })
    }
}
