use super::*;

pub(super) async fn drain_terminalizing_tasks(
    tasks: &mut JoinSet<FinishedDispatch>,
) -> Result<(), NativeV2SupervisorError> {
    while let Some(finished) = tasks.join_next().await {
        let finished = finished.map_err(|_| NativeV2SupervisorError::Task)?;
        match finished.result {
            DispatchResult::LogFailure(error) => return Err(error.into()),
            DispatchResult::LogTaskFailed => return Err(NativeV2SupervisorError::Task),
            DispatchResult::Completed(_)
            | DispatchResult::TimedOut
            | DispatchResult::Interrupted => {}
        }
    }
    Ok(())
}

pub(super) enum StartNode {
    Started(NodeHandle),
    Failed(WorkerOutcome),
}

pub(super) enum Initialization {
    Terminal(TerminalResult),
    Program(Box<RunProgram>),
}

pub(super) struct RunProgram {
    pub(super) admitted: AdmittedRun,
    pub(super) timeouts: BTreeMap<NodeName, Duration>,
}

#[derive(Default)]
pub(super) struct ActiveDispatches {
    pub(super) tasks: JoinSet<FinishedDispatch>,
    pub(super) cancellations: BTreeMap<ExecutionId, oneshot::Sender<ExecutionInterrupt>>,
    pub(super) pending_voids: BTreeMap<ExecutionId, ExecutionVoidReason>,
}

pub(super) struct Dispatch {
    pub(super) reference: ExecutionRef,
    pub(super) occurrence: crate::full_v1_reducer::StructuralOccurrence,
    pub(super) attempt: openengine_cluster_protocol::PositiveInteger,
    pub(super) worker: openengine_cluster_protocol::WorkerRef,
    pub(super) input: serde_json::Value,
}

pub(super) fn void_decisions(decisions: &[Decision]) -> Vec<(ExecutionId, ExecutionVoidReason)> {
    decisions
        .iter()
        .filter_map(|decision| match decision {
            Decision::VoidLoser { execution, reason } => Some((*execution, *reason)),
            _ => None,
        })
        .collect()
}

pub(super) fn dispatch_decisions(run_id: &RunId, decisions: Vec<Decision>) -> Vec<Dispatch> {
    decisions
        .into_iter()
        .filter_map(|decision| match decision {
            Decision::Dispatch {
                node_instance,
                execution,
                occurrence,
                attempt,
                worker,
                input,
            } => Some(Dispatch {
                reference: ExecutionRef {
                    run_id: run_id.clone(),
                    node: occurrence.node.clone(),
                    node_instance,
                    execution,
                },
                occurrence,
                attempt,
                worker,
                input,
            }),
            Decision::VoidLoser { .. }
            | Decision::Continue { .. }
            | Decision::Promote { .. }
            | Decision::Terminal { .. } => None,
        })
        .collect()
}

#[derive(Clone, Copy)]
pub(super) enum ExecutionInterrupt {
    Void,
}

pub(super) enum DispatchResult {
    Completed(Result<NodeCompletion, NodeRunnerError>),
    TimedOut,
    Interrupted,
    LogFailure(RunLedgerError),
    LogTaskFailed,
}

pub(super) struct FinishedDispatch {
    pub(super) execution: ExecutionId,
    pub(super) reference: ExecutionRef,
    pub(super) result: DispatchResult,
}

pub(super) struct DispatchTask {
    pub(super) handle: NodeHandle,
    pub(super) timeout: Duration,
    pub(super) cancel: oneshot::Receiver<ExecutionInterrupt>,
    pub(super) ledger: Arc<dyn RunLedger>,
    pub(super) run_id: RunId,
    pub(super) registration: Option<Box<dyn LiveOutputRegistration>>,
    pub(super) output: crate::native_v2_runner::DurableOutput,
}

pub(super) async fn run_dispatch(task: DispatchTask) -> FinishedDispatch {
    let DispatchTask {
        mut handle,
        timeout,
        cancel,
        ledger,
        run_id,
        registration,
        output,
    } = task;
    let reference = handle.reference().clone();
    let execution = reference.execution;
    let logs = tokio::spawn(bridge_logs(ledger, run_id, execution, output));
    let interrupt = async {
        tokio::select! {
            _ = tokio::time::sleep(timeout) => DispatchResult::TimedOut,
            _ = cancel => DispatchResult::Interrupted,
        }
    };
    tokio::pin!(interrupt);
    let result = tokio::select! {
        completion = handle.completion() => DispatchResult::Completed(completion),
        interrupt = &mut interrupt => {
            handle.cancel();
            let _ = handle.completion().await;
            interrupt
        }
    };
    let result = match logs.await {
        Ok(Ok(())) => result,
        Ok(Err(error)) => DispatchResult::LogFailure(error),
        Err(_) => DispatchResult::LogTaskFailed,
    };
    if let Some(registration) = registration {
        registration.close().await;
    }
    FinishedDispatch {
        execution,
        reference,
        result,
    }
}

pub(super) async fn bridge_logs(
    ledger: Arc<dyn RunLedger>,
    run_id: RunId,
    execution: ExecutionId,
    mut output: crate::native_v2_runner::DurableOutput,
) -> Result<(), RunLedgerError> {
    while let Ok(output) = output.recv().await {
        ledger
            .append(
                &run_id,
                vec![RunEvent::SafeLog {
                    execution: Some(execution),
                    stream: safe_log_stream(output.stream),
                    line: SafeLogLine::new(output.text)?,
                }],
            )
            .await?;
    }
    Ok(())
}

pub(super) const fn safe_log_stream(stream: LiveOutputStream) -> SafeLogStream {
    match stream {
        LiveOutputStream::Output => SafeLogStream::Output,
        LiveOutputStream::Error => SafeLogStream::Error,
        LiveOutputStream::System => SafeLogStream::System,
    }
}

pub(super) fn reduce(
    admitted: &AdmittedRun,
    snapshot: &RunSnapshot,
) -> Result<crate::full_v1_reducer::Reduction, NativeV2SupervisorError> {
    let executions = durable_history(snapshot)?;
    let verified = VerifiedGraph {
        compiled_ir: admitted.graph.clone(),
        diagnostics: Vec::new(),
    };
    Ok(FullV1Reducer::native_v2(&verified).reduce(ReductionInput {
        initial_input: &admitted.initial_input,
        executions: &executions,
        next_node_instance: next_node_instance(&executions)?,
        next_execution: next_execution(&executions)?,
    })?)
}

pub(super) fn durable_history(
    snapshot: &RunSnapshot,
) -> Result<Vec<DurableExecution>, NativeV2SupervisorError> {
    let mut executions = snapshot
        .executions
        .values()
        .map(durable_execution)
        .collect::<Result<Vec<_>, _>>()?;
    executions.sort_by_key(|execution| (execution.dispatch_position, execution.execution));
    Ok(executions)
}

pub(super) fn durable_execution(
    node: &NodeSnapshot,
) -> Result<DurableExecution, NativeV2SupervisorError> {
    let state = match &node.state {
        NodeState::Active => DurableExecutionState::Active,
        NodeState::Completed { at, outcome } => DurableExecutionState::Settled {
            position: history_position(at)?,
            outcome: outcome.clone(),
        },
        NodeState::Voided { at, reason } => DurableExecutionState::Voided {
            position: history_position(at)?,
            reason: *reason,
        },
    };
    Ok(DurableExecution {
        dispatch_position: history_position(&node.started_at)?,
        node_instance: node.reference.node_instance,
        execution: node.reference.execution,
        occurrence: node.occurrence.clone(),
        attempt: node.attempt,
        input: node.input.clone(),
        state,
    })
}

pub(super) fn history_position(
    cursor: &openengine_cluster_protocol::Cursor,
) -> Result<HistoryPosition, NativeV2SupervisorError> {
    HistoryPosition::new(cursor_sequence(cursor)?)
        .map_err(|_| NativeV2SupervisorError::InvalidState)
}

pub(super) fn next_node_instance(
    executions: &[DurableExecution],
) -> Result<u64, NativeV2SupervisorError> {
    executions
        .iter()
        .map(|execution| execution.node_instance.get())
        .max()
        .unwrap_or(FIRST_IDENTITY - 1)
        .checked_add(1)
        .ok_or(NativeV2SupervisorError::InvalidState)
}

pub(super) fn next_execution(
    executions: &[DurableExecution],
) -> Result<u64, NativeV2SupervisorError> {
    executions
        .iter()
        .map(|execution| execution.execution.get())
        .max()
        .unwrap_or(FIRST_IDENTITY - 1)
        .checked_add(1)
        .ok_or(NativeV2SupervisorError::InvalidState)
}

pub(super) fn timeout_catalog(root: &GraphNode) -> BTreeMap<NodeName, Duration> {
    let mut timeouts = BTreeMap::new();
    collect_timeouts(root, &mut timeouts);
    timeouts
}

pub(super) fn collect_timeouts(node: &GraphNode, timeouts: &mut BTreeMap<NodeName, Duration>) {
    match node {
        GraphNode::Step(node) => {
            timeouts.insert(
                node.name.clone(),
                Duration::from_millis(node.timeout_ms.get()),
            );
        }
        GraphNode::Verifier(node) => {
            timeouts.insert(
                node.name.clone(),
                Duration::from_millis(node.timeout_ms.get()),
            );
        }
        GraphNode::Seq(node) => node
            .children
            .as_slice()
            .iter()
            .for_each(|child| collect_timeouts(child, timeouts)),
        GraphNode::Choice(node) => {
            node.branches
                .as_slice()
                .iter()
                .for_each(|branch| collect_timeouts(&branch.node, timeouts));
            if let Some(otherwise) = &node.otherwise {
                collect_timeouts(otherwise, timeouts);
            }
        }
        GraphNode::Par(node) => node
            .branches
            .as_slice()
            .iter()
            .for_each(|branch| collect_timeouts(branch, timeouts)),
        GraphNode::Loop(node) => collect_timeouts(&node.body, timeouts),
        GraphNode::Map(node) => collect_timeouts(&node.body, timeouts),
        GraphNode::Succeed(_) | GraphNode::Fail(_) => {}
    }
}

pub(super) fn runner_failure(error: NodeRunnerError) -> WorkerOutcome {
    let code = match error {
        NodeRunnerError::Cancelled | NodeRunnerError::RunClosed => WorkerErrorCode::Refusal,
        NodeRunnerError::InvalidRole
        | NodeRunnerError::SessionOpen
        | NodeRunnerError::SessionLost
        | NodeRunnerError::Driver
        | NodeRunnerError::ConnectionLost
        | NodeRunnerError::UnsafeOutput
        | NodeRunnerError::DurableOutputClosed
        | NodeRunnerError::CompletionClosed
        | NodeRunnerError::ExecutionActive => WorkerErrorCode::Crash,
    };
    WorkerOutcome::declared_failure(code)
}

pub(super) fn settled_outcome(
    reference: &ExecutionRef,
    result: DispatchResult,
    force: bool,
) -> Result<WorkerOutcome, NativeV2SupervisorError> {
    if force {
        return Ok(WorkerOutcome::declared_failure(WorkerErrorCode::Refusal));
    }
    match result {
        DispatchResult::Completed(Ok(completion)) if completion.reference == *reference => {
            Ok(completion.outcome)
        }
        DispatchResult::Completed(Ok(_)) => Err(NativeV2SupervisorError::InvalidState),
        DispatchResult::Completed(Err(error)) => Ok(runner_failure(error)),
        DispatchResult::TimedOut => Ok(WorkerOutcome::declared_failure(WorkerErrorCode::Timeout)),
        DispatchResult::Interrupted => Ok(WorkerOutcome::declared_failure(WorkerErrorCode::Crash)),
        DispatchResult::LogFailure(error) => Err(error.into()),
        DispatchResult::LogTaskFailed => Err(NativeV2SupervisorError::Task),
    }
}

pub(super) fn refusal_completions(snapshot: &RunSnapshot) -> Vec<RunEvent> {
    snapshot
        .active_executions()
        .map(|node| RunEvent::NodeCompleted {
            completion: NodeCompletion {
                reference: node.reference.clone(),
                outcome: WorkerOutcome::declared_failure(WorkerErrorCode::Refusal),
            },
        })
        .collect()
}
