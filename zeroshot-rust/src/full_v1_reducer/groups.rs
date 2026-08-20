use super::*;

mod state;
use state::*;

mod map;

#[derive(Clone, Copy)]
enum ParallelControlResult {
    Reached,
    Unreachable,
}

struct GroupEvaluation<'a, G> {
    group: &'a G,
    context: &'a Context,
    traversal: Traversal<'a>,
}

struct GroupMutation<'a, G> {
    group: &'a G,
    context: &'a mut Context,
    traversal: Traversal<'a>,
}

impl Engine<'_> {
    pub(super) fn eval_choice(
        &mut self,
        group: &ChoiceNode,
        context: &mut Context,
        traversal: Traversal<'_>,
    ) -> Result<Status, ReducerError> {
        let mut local = context.clone();
        let selected = group
            .branches
            .as_slice()
            .iter()
            .find(|branch| {
                self.guard(&branch.when, &local, traversal.map_indices)
                    .unwrap_or(false)
            })
            .map(|branch| &branch.node)
            .or(group.otherwise.as_deref())
            .ok_or(ReducerError::MissingChoiceRoute)?;
        let status = self.eval(selected, &mut local, traversal)?;
        if let Status::Continue { position } = status {
            promote(PromotionRequest {
                node: &group.name,
                map_indices: traversal.map_indices,
                paths: &group.promoted_state_paths,
                local: &local,
                parent: context,
                mode: traversal.mode,
                decisions: &mut self.decisions,
            })?;
            merge_runtime_facts(&local, context);
            self.continue_decision(&group.name, traversal.mode);
            Ok(Status::Continue { position })
        } else {
            Ok(status)
        }
    }

    pub(super) fn eval_parallel(
        &mut self,
        group: &ParNode,
        context: &mut Context,
        traversal: Traversal<'_>,
    ) -> Result<Status, ReducerError> {
        let probes = self.probe_parallel(group, context, traversal)?;
        let (mut ordered, required) = self.parallel_completions(group, &probes, traversal)?;
        ordered.sort_by_key(|(index, position)| (*position, *index));
        if let Some(status) = self.unreached_parallel_join(
            GroupMutation {
                group,
                context: &mut *context,
                traversal,
            },
            ParallelProbeSummary {
                probes: &probes,
                completed: ordered.len(),
                required,
            },
        )? {
            return Ok(status);
        }
        let winners = ordered.into_iter().take(required).collect::<Vec<_>>();
        let (joined, join_position, winner_set) = self.join_parallel_winners(
            GroupEvaluation {
                group,
                context: &*context,
                traversal,
            },
            &winners,
        )?;
        self.finish_parallel_join(
            GroupMutation {
                group,
                context,
                traversal,
            },
            ParallelJoinResult {
                branch_count: probes.len(),
                required,
                joined,
                position: join_position,
                winners: winner_set,
            },
        )
    }

    fn probe_parallel(
        &mut self,
        group: &ParNode,
        context: &Context,
        traversal: Traversal<'_>,
    ) -> Result<Vec<(Status, Context)>, ReducerError> {
        group
            .branches
            .as_slice()
            .iter()
            .map(|branch| {
                let mut branch_context = context.clone();
                branch_context.local_writes.clear();
                let status = self.eval(
                    branch,
                    &mut branch_context,
                    Traversal {
                        mode: EvalMode::Probe,
                        ..traversal
                    },
                )?;
                Ok((status, branch_context))
            })
            .collect()
    }

    fn parallel_completions(
        &self,
        group: &ParNode,
        probes: &[(Status, Context)],
        traversal: Traversal<'_>,
    ) -> Result<(Vec<(usize, HistoryPosition)>, usize), ReducerError> {
        let mut completed = Vec::new();
        for (index, (status, branch_context)) in probes.iter().enumerate() {
            let Status::Continue { position } = status else {
                continue;
            };
            let satisfies = match &group.join {
                Join::First { when } => self.guard(when, branch_context, traversal.map_indices)?,
                Join::All {} | Join::Any {} | Join::Quorum { .. } => true,
            };
            if satisfies {
                completed.push((index, *position));
            }
        }
        let required = parallel_join_required(&group.join, probes.len())?;
        Ok((completed, required))
    }

    fn unreached_parallel_join(
        &mut self,
        evaluation: GroupMutation<'_, ParNode>,
        summary: ParallelProbeSummary<'_>,
    ) -> Result<Option<Status>, ReducerError> {
        let GroupMutation {
            group,
            context,
            traversal,
        } = evaluation;
        if summary.completed >= summary.required {
            return Ok(None);
        }
        let settled = summary
            .probes
            .iter()
            .all(|(status, _)| !matches!(status, Status::Pending));
        if !settled {
            if traversal.mode == EvalMode::Decide {
                for branch in group.branches.as_slice() {
                    let mut branch_context = context.clone();
                    let _ = self.eval(branch, &mut branch_context, traversal)?;
                }
            }
            return Ok(Some(Status::Pending));
        }
        self.record_parallel_control(
            GroupMutation {
                group,
                context,
                traversal,
            },
            ParallelControlResult::Unreachable,
        );
        self.continue_decision(&group.name, traversal.mode);
        let position = summary
            .probes
            .iter()
            .map(|(status, _)| status.position())
            .filter(|position| *position != HistoryPosition::MAX)
            .max()
            .unwrap_or(HistoryPosition::ZERO);
        Ok(Some(Status::Continue { position }))
    }

    fn join_parallel_winners(
        &mut self,
        evaluation: GroupEvaluation<'_, ParNode>,
        winners: &[(usize, HistoryPosition)],
    ) -> Result<(Context, HistoryPosition, BTreeSet<usize>), ReducerError> {
        let GroupEvaluation {
            group,
            context,
            traversal,
        } = evaluation;
        let join_position = winners
            .iter()
            .map(|(_, position)| *position)
            .max()
            .unwrap_or(HistoryPosition::ZERO);
        let winner_set = winners
            .iter()
            .map(|(index, _)| *index)
            .collect::<BTreeSet<_>>();
        let mut joined = context.clone();
        for (index, _) in winners {
            let mut branch_context = context.clone();
            branch_context.local_writes.clear();
            let branch = group
                .branches
                .as_slice()
                .get(*index)
                .ok_or(ReducerError::InconsistentHistory)?;
            let status = self.eval(
                branch,
                &mut branch_context,
                Traversal {
                    cutoff: join_position,
                    ..traversal
                },
            )?;
            if !matches!(status, Status::Continue { .. }) {
                return Err(ReducerError::InconsistentHistory);
            }
            for path in
                promoted_write_paths(&branch_context.local_writes, &group.promoted_state_paths)
            {
                let value = select(&branch_context.state, &path)?.clone();
                set_path(&mut joined.state, &path, value)?;
                joined.local_writes.insert(path);
            }
            merge_runtime_facts(&branch_context, &mut joined);
        }
        Ok((joined, join_position, winner_set))
    }

    fn finish_parallel_join(
        &mut self,
        evaluation: GroupMutation<'_, ParNode>,
        join: ParallelJoinResult,
    ) -> Result<Status, ReducerError> {
        let GroupMutation {
            group,
            context,
            traversal,
        } = evaluation;
        self.emit_parallel_promotion(group, &join.joined, traversal)?;
        *context = join.joined;
        self.record_parallel_control(
            GroupMutation {
                group,
                context,
                traversal,
            },
            ParallelControlResult::Reached,
        );
        if join.required < join.branch_count {
            for (index, branch) in group.branches.as_slice().iter().enumerate() {
                if !join.winners.contains(&index) {
                    self.void_active_descendants(
                        branch,
                        VoidScope {
                            map_indices: traversal.map_indices,
                            cutoff: join.position,
                            reason: ExecutionVoidReason::ParallelJoin,
                            emit_decisions: traversal.mode == EvalMode::Decide,
                        },
                    );
                }
            }
        }
        self.continue_decision(&group.name, traversal.mode);
        Ok(Status::Continue {
            position: join.position,
        })
    }

    fn record_parallel_control(
        &mut self,
        evaluation: GroupMutation<'_, ParNode>,
        result: ParallelControlResult,
    ) {
        let GroupMutation {
            group,
            context,
            traversal,
        } = evaluation;
        let first = matches!(group.join, Join::First { .. });
        let label = match (first, result) {
            (true, ParallelControlResult::Reached) => "satisfied",
            (true, ParallelControlResult::Unreachable) => "no_satisfier",
            (false, ParallelControlResult::Reached) => "reached",
            (false, ParallelControlResult::Unreachable) => "quorum_unreachable",
        };
        self.set_group_control(
            context,
            GroupControlUpdate {
                node: &group.name,
                field: if first { "raced" } else { "joined" },
                label,
                map_indices: traversal.map_indices,
            },
        );
    }

    fn emit_parallel_promotion(
        &mut self,
        group: &ParNode,
        joined: &Context,
        traversal: Traversal<'_>,
    ) -> Result<(), ReducerError> {
        if traversal.mode != EvalMode::Decide || group.promoted_state_paths.is_empty() {
            return Ok(());
        }
        let values = group
            .promoted_state_paths
            .iter()
            .map(|path| {
                Ok(PromotedValue {
                    path: path.clone(),
                    value: select(&joined.state, path)?.clone(),
                })
            })
            .collect::<Result<Vec<_>, ReducerError>>()?;
        self.decisions.push(Decision::Promote {
            node: group.name.clone(),
            map_indices: traversal.map_indices.to_vec(),
            values,
        });
        Ok(())
    }
    // Control and voiding operations live in the control companion module.
}

fn parallel_join_required(join: &Join, branch_count: usize) -> Result<usize, ReducerError> {
    match join {
        Join::All {} => Ok(branch_count),
        Join::Any {} | Join::First { .. } => Ok(1),
        Join::Quorum { count } => {
            usize::try_from(count.get()).map_err(|_| ReducerError::IdentityOutOfRange)
        }
    }
}
