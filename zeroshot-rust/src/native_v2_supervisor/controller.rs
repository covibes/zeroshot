use super::*;

impl NativeV2Supervisor {
    pub(super) async fn dispatch(
        &self,
        program: &RunProgram,
        dispatches: Vec<Dispatch>,
        active: &mut ActiveDispatches,
    ) -> Result<bool, NativeV2SupervisorError> {
        if !self.record_dispatches(&dispatches).await? {
            return Ok(false);
        }
        for dispatch in dispatches {
            self.start_dispatch(program, dispatch, active).await?;
        }
        Ok(true)
    }

    pub(super) async fn record_dispatches(
        &self,
        dispatches: &[Dispatch],
    ) -> Result<bool, NativeV2SupervisorError> {
        let events = dispatches
            .iter()
            .map(|dispatch| RunEvent::NodeStarted {
                reference: dispatch.reference.clone(),
                occurrence: dispatch.occurrence.clone(),
                attempt: dispatch.attempt,
                input: dispatch.input.clone(),
            })
            .collect();
        if let Err(error) = self.ledger.append(&self.run_id, events).await {
            let snapshot = self.snapshot().await?;
            if snapshot.force_stop_requested || snapshot.terminal.is_some() {
                return Ok(false);
            }
            return Err(error.into());
        }
        Ok(true)
    }

    pub(super) async fn start_dispatch(
        &self,
        program: &RunProgram,
        dispatch: Dispatch,
        active: &mut ActiveDispatches,
    ) -> Result<(), NativeV2SupervisorError> {
        let mut handle = match self.start_node(program, &dispatch).await? {
            StartNode::Started(handle) => handle,
            StartNode::Failed(outcome) => {
                return self.settle_start_failure(dispatch.reference, outcome).await;
            }
        };
        let Some(output) = handle.take_initial_output() else {
            handle.cancel();
            let _ = handle.completion().await;
            return Err(NativeV2SupervisorError::InvalidState);
        };
        let registration = match self.register_live(&dispatch.reference, &mut handle).await {
            Ok(registration) => registration,
            Err(_) => {
                bridge_logs(
                    self.ledger.clone(),
                    self.run_id.clone(),
                    dispatch.reference.execution,
                    output,
                )
                .await?;
                return self
                    .settle_start_failure(
                        dispatch.reference,
                        WorkerOutcome::declared_failure(WorkerErrorCode::Crash),
                    )
                    .await;
            }
        };
        let timeout = *program
            .timeouts
            .get(&dispatch.reference.node)
            .ok_or(NativeV2SupervisorError::InvalidState)?;
        let execution = dispatch.reference.execution;
        let (cancel, receiver) = oneshot::channel();
        active.cancellations.insert(execution, cancel);
        active.tasks.spawn(run_dispatch(DispatchTask {
            handle,
            timeout,
            cancel: receiver,
            ledger: self.ledger.clone(),
            run_id: self.run_id.clone(),
            registration,
            output,
        }));
        Ok(())
    }

    pub(super) async fn start_node(
        &self,
        program: &RunProgram,
        dispatch: &Dispatch,
    ) -> Result<StartNode, NativeV2SupervisorError> {
        let binding = program
            .admitted
            .runtime
            .nodes()
            .get(&dispatch.reference.node)
            .cloned()
            .ok_or(NativeV2SupervisorError::InvalidState)?;
        let environment = match self.environment.resolve(&binding) {
            Ok(environment) => environment,
            Err(_) => {
                return Ok(StartNode::Failed(WorkerOutcome::authentication_refusal()));
            }
        };
        let invocation = NodeInvocation {
            reference: dispatch.reference.clone(),
            worker: dispatch.worker.clone(),
            input: dispatch.input.clone(),
            binding,
        };
        match self
            .runner
            .start(NodeRunRequest {
                invocation,
                environment,
            })
            .await
        {
            Ok(handle) => Ok(StartNode::Started(handle)),
            Err(error) => Ok(StartNode::Failed(runner_failure(error))),
        }
    }

    pub(super) async fn register_live(
        &self,
        reference: &ExecutionRef,
        handle: &mut NodeHandle,
    ) -> Result<Option<Box<dyn LiveOutputRegistration>>, LiveOutputUnavailable> {
        let Some(registrar) = &self.live_output else {
            return Ok(None);
        };
        let Some(source) = handle.live_output_source() else {
            handle.cancel();
            let _ = handle.completion().await;
            return Err(LiveOutputUnavailable);
        };
        match registrar.register(reference, source).await {
            Ok(registration) => Ok(Some(registration)),
            Err(_) => {
                handle.cancel();
                let _ = handle.completion().await;
                Err(LiveOutputUnavailable)
            }
        }
    }

    pub(super) async fn settle_start_failure(
        &self,
        reference: ExecutionRef,
        outcome: WorkerOutcome,
    ) -> Result<(), NativeV2SupervisorError> {
        self.ledger
            .append(
                &self.run_id,
                vec![RunEvent::NodeCompleted {
                    completion: NodeCompletion { reference, outcome },
                }],
            )
            .await?;
        Ok(())
    }

    pub(super) async fn cancel_voids(
        &self,
        voids: Vec<(ExecutionId, ExecutionVoidReason)>,
        active: &mut ActiveDispatches,
    ) -> Result<(), NativeV2SupervisorError> {
        let targets = voids
            .into_iter()
            .map(|(execution, reason)| {
                active.pending_voids.insert(execution, reason);
                let cancel = active
                    .cancellations
                    .remove(&execution)
                    .ok_or(NativeV2SupervisorError::InvalidState)?;
                let _ = cancel.send(ExecutionInterrupt::Void);
                Ok(execution)
            })
            .collect::<Result<BTreeSet<_>, NativeV2SupervisorError>>()?;
        while targets
            .iter()
            .any(|execution| active.pending_voids.contains_key(execution))
        {
            let finished = Self::next_finished(active).await?;
            self.settle(finished, &mut active.pending_voids).await?;
        }
        Ok(())
    }

    pub(super) async fn settle(
        &self,
        finished: FinishedDispatch,
        pending_voids: &mut BTreeMap<ExecutionId, ExecutionVoidReason>,
    ) -> Result<(), NativeV2SupervisorError> {
        if let Some(reason) = pending_voids.remove(&finished.execution) {
            self.ledger
                .append(
                    &self.run_id,
                    vec![RunEvent::ExecutionVoided {
                        reference: finished.reference,
                        reason,
                    }],
                )
                .await?;
            return Ok(());
        }
        let force = self.snapshot().await?.force_stop_requested;
        let outcome = settled_outcome(&finished.reference, finished.result, force)?;
        self.ledger
            .append(
                &self.run_id,
                vec![RunEvent::NodeCompleted {
                    completion: NodeCompletion {
                        reference: finished.reference,
                        outcome,
                    },
                }],
            )
            .await?;
        Ok(())
    }

    pub(super) async fn append_terminal(
        &self,
        terminal: TerminalResult,
    ) -> Result<TerminalResult, NativeV2SupervisorError> {
        self.ledger
            .append(
                &self.run_id,
                vec![RunEvent::Terminal {
                    result: terminal.clone(),
                }],
            )
            .await?;
        Ok(terminal)
    }

    pub(super) async fn terminalize_force(
        &self,
        tasks: &mut JoinSet<FinishedDispatch>,
    ) -> Result<TerminalResult, NativeV2SupervisorError> {
        self.runner.close_run(&self.run_id).await;
        drain_terminalizing_tasks(tasks).await?;
        let snapshot = self.snapshot().await?;
        if let Some(terminal) = snapshot.terminal {
            return Ok(terminal);
        }
        let terminal = TerminalResult::Failed {
            reason: EnumLabel::new("force_stopped")
                .map_err(|_| NativeV2SupervisorError::InvalidState)?,
        };
        self.cleanup_runtime(RunRuntimeExit::ForceStopped).await?;
        let mut events = refusal_completions(&snapshot);
        events.push(RunEvent::Terminal {
            result: terminal.clone(),
        });
        self.ledger.append(&self.run_id, events).await?;
        Ok(terminal)
    }

    pub(super) async fn terminalize_lost(
        &self,
        tasks: &mut JoinSet<FinishedDispatch>,
    ) -> Result<TerminalResult, NativeV2SupervisorError> {
        self.runner.close_run(&self.run_id).await;
        drain_terminalizing_tasks(tasks).await?;
        let snapshot = self.snapshot().await?;
        if let Some(terminal) = snapshot.terminal {
            return Ok(terminal);
        }
        let terminal = TerminalResult::Failed {
            reason: EnumLabel::new("runtime_lost")
                .map_err(|_| NativeV2SupervisorError::InvalidState)?,
        };
        self.cleanup_runtime(RunRuntimeExit::RuntimeLost).await?;
        let mut events = snapshot
            .active_executions()
            .map(|node| RunEvent::NodeCompleted {
                completion: NodeCompletion {
                    reference: node.reference.clone(),
                    outcome: WorkerOutcome::declared_failure(WorkerErrorCode::Crash),
                },
            })
            .collect::<Vec<_>>();
        events.push(RunEvent::Terminal {
            result: terminal.clone(),
        });
        self.ledger.append(&self.run_id, events).await?;
        Ok(terminal)
    }
}
