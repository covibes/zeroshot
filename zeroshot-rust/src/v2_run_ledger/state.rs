use openengine_cluster_protocol::{Cursor, TerminalResult, TokenCount, TokenUsage};
use serde::Serialize;

use super::{
    CreateRun, ExecutionId, ExecutionRef, ExecutionVoidReason, MAX_ADMITTED_RUN_BYTES,
    MAX_EVENT_BYTES, NodeCompletion, NodeSnapshot, NodeState, RunEvent, RunLedgerError, RunPhase,
    RunSnapshot, TokenUsageDelta, INITIAL_CURSOR,
};

pub(crate) fn initial_cursor() -> Cursor {
    Cursor::new(INITIAL_CURSOR)
}

pub(crate) fn cursor_for(sequence: u64) -> Cursor {
    Cursor::new(format!("v2:{sequence}"))
}

pub(crate) fn cursor_sequence(cursor: &Cursor) -> Result<u64, RunLedgerError> {
    cursor
        .as_str()
        .strip_prefix("v2:")
        .and_then(|value| value.parse().ok())
        .ok_or(RunLedgerError::InvalidCursor)
}

pub(crate) fn validate_create(request: &CreateRun) -> Result<(), RunLedgerError> {
    bounded_json(&request.admitted, MAX_ADMITTED_RUN_BYTES)
        .map_err(|_| RunLedgerError::AdmittedRunTooLarge)
}

pub(crate) fn validate_event(event: &RunEvent) -> Result<(), RunLedgerError> {
    bounded_json(event, MAX_EVENT_BYTES).map_err(|_| RunLedgerError::EventTooLarge)
}

fn bounded_json(value: &impl Serialize, maximum: usize) -> Result<(), ()> {
    let bytes = serde_json::to_vec(value).map_err(|_| ())?;
    (bytes.len() <= maximum).then_some(()).ok_or(())
}

pub(crate) fn apply_event(
    snapshot: &mut RunSnapshot,
    event: &RunEvent,
    sequence: u64,
) -> Result<(), RunLedgerError> {
    if snapshot.terminal.is_some() {
        return Err(RunLedgerError::InvalidEvent("run is already terminal"));
    }
    validate_event(event)?;
    apply_event_kind(snapshot, event, sequence)?;
    snapshot.cursor = cursor_for(sequence);
    Ok(())
}

fn apply_event_kind(
    snapshot: &mut RunSnapshot,
    event: &RunEvent,
    sequence: u64,
) -> Result<(), RunLedgerError> {
    match event {
        RunEvent::RunStarted => apply_run_started(snapshot),
        RunEvent::NodeStarted { .. } => apply_node_started(snapshot, event, sequence),
        RunEvent::NodeCompleted { completion } => {
            apply_node_completed(snapshot, completion, sequence)
        }
        RunEvent::ExecutionVoided { reference, reason } => {
            apply_execution_voided(snapshot, reference, *reason, sequence)
        }
        RunEvent::SafeLog { execution, .. } => apply_safe_log(snapshot, *execution),
        RunEvent::TokenUsageObserved { execution, usage } => {
            apply_token_usage(snapshot, *execution, usage.as_ref())
        }
        RunEvent::ForceStopRequested => apply_force_stop(snapshot),
        RunEvent::Terminal { result } => apply_terminal(snapshot, result),
    }
}

fn apply_run_started(snapshot: &mut RunSnapshot) -> Result<(), RunLedgerError> {
    if snapshot.phase != RunPhase::Admitted {
        return Err(RunLedgerError::InvalidEvent("run already started"));
    }
    snapshot.phase = RunPhase::Running;
    Ok(())
}

fn apply_node_started(
    snapshot: &mut RunSnapshot,
    event: &RunEvent,
    sequence: u64,
) -> Result<(), RunLedgerError> {
    let RunEvent::NodeStarted {
        reference,
        occurrence,
        attempt,
        input,
    } = event
    else {
        return Err(RunLedgerError::InvalidEvent(
            "node-start projection received a different event",
        ));
    };
    require_running(snapshot)?;
    require_run(snapshot, reference)?;
    require_new_dispatch(snapshot, reference)?;
    snapshot.executions.insert(
        reference.execution,
        NodeSnapshot {
            reference: reference.clone(),
            occurrence: occurrence.clone(),
            attempt: *attempt,
            input: input.clone(),
            started_at: cursor_for(sequence),
            state: NodeState::Active,
        },
    );
    Ok(())
}

fn require_new_dispatch(
    snapshot: &RunSnapshot,
    reference: &ExecutionRef,
) -> Result<(), RunLedgerError> {
    if snapshot.force_stop_requested {
        return Err(RunLedgerError::InvalidEvent(
            "cannot dispatch after force-stop",
        ));
    }
    if snapshot.executions.contains_key(&reference.execution) {
        return Err(RunLedgerError::InvalidEvent(
            "execution was already dispatched",
        ));
    }
    Ok(())
}

fn apply_node_completed(
    snapshot: &mut RunSnapshot,
    completion: &NodeCompletion,
    sequence: u64,
) -> Result<(), RunLedgerError> {
    require_run(snapshot, &completion.reference)?;
    if matches!(
        &completion.outcome,
        openengine_cluster_protocol::WorkerOutcome::Verified { artifacts, .. }
            | openengine_cluster_protocol::WorkerOutcome::Verifier { artifacts, .. }
            if !artifacts.is_empty()
    ) {
        return Err(RunLedgerError::InvalidEvent(
            "native-v2 node outcomes cannot contain artifact references",
        ));
    }
    completion
        .outcome
        .validate()
        .map_err(|_| RunLedgerError::InvalidEvent("invalid worker outcome"))?;
    active_node_mut(snapshot, &completion.reference)?.state = NodeState::Completed {
        at: cursor_for(sequence),
        outcome: completion.outcome.clone(),
    };
    Ok(())
}

fn apply_execution_voided(
    snapshot: &mut RunSnapshot,
    reference: &ExecutionRef,
    reason: ExecutionVoidReason,
    sequence: u64,
) -> Result<(), RunLedgerError> {
    require_run(snapshot, reference)?;
    active_node_mut(snapshot, reference)?.state = NodeState::Voided {
        at: cursor_for(sequence),
        reason,
    };
    Ok(())
}

fn apply_safe_log(
    snapshot: &RunSnapshot,
    execution: Option<ExecutionId>,
) -> Result<(), RunLedgerError> {
    match execution {
        None => Ok(()),
        Some(id) if snapshot.executions.contains_key(&id) => Ok(()),
        Some(_) => Err(RunLedgerError::InvalidEvent(
            "log references an unknown execution",
        )),
    }
}

fn apply_token_usage(
    snapshot: &mut RunSnapshot,
    execution: ExecutionId,
    usage: Option<&TokenUsageDelta>,
) -> Result<(), RunLedgerError> {
    require_active_execution(snapshot, execution)?;
    match (&mut snapshot.token_usage, usage) {
        (None, Some(usage)) => {
            snapshot.token_usage = Some(TokenUsage {
                input_tokens: usage.input_tokens,
                output_tokens: usage.output_tokens,
                cache_read_input_tokens: usage.cache_read_input_tokens,
                cache_creation_input_tokens: usage.cache_creation_input_tokens,
                complete: true,
            });
        }
        (None, None) => {
            snapshot.token_usage = Some(TokenUsage {
                input_tokens: TokenCount::default(),
                output_tokens: TokenCount::default(),
                cache_read_input_tokens: None,
                cache_creation_input_tokens: None,
                complete: false,
            });
        }
        (Some(total), Some(usage)) => {
            total.input_tokens = add_tokens(total.input_tokens, usage.input_tokens)?;
            total.output_tokens = add_tokens(total.output_tokens, usage.output_tokens)?;
            total.cache_read_input_tokens =
                add_optional_tokens(total.cache_read_input_tokens, usage.cache_read_input_tokens)?;
            total.cache_creation_input_tokens = add_optional_tokens(
                total.cache_creation_input_tokens,
                usage.cache_creation_input_tokens,
            )?;
        }
        (Some(total), None) => total.complete = false,
    }
    Ok(())
}

fn require_active_execution(
    snapshot: &RunSnapshot,
    execution: ExecutionId,
) -> Result<(), RunLedgerError> {
    match snapshot.executions.get(&execution) {
        Some(node) if matches!(node.state, NodeState::Active) => Ok(()),
        Some(_) => Err(RunLedgerError::InvalidEvent(
            "token usage references a settled execution",
        )),
        None => Err(RunLedgerError::InvalidEvent(
            "token usage references an unknown execution",
        )),
    }
}

fn add_tokens(left: TokenCount, right: TokenCount) -> Result<TokenCount, RunLedgerError> {
    left.checked_add(right)
        .ok_or(RunLedgerError::InvalidEvent("token usage overflow"))
}

fn add_optional_tokens(
    left: Option<TokenCount>,
    right: Option<TokenCount>,
) -> Result<Option<TokenCount>, RunLedgerError> {
    match (left, right) {
        (Some(left), Some(right)) => add_tokens(left, right).map(Some),
        _ => Ok(None),
    }
}

fn apply_force_stop(snapshot: &mut RunSnapshot) -> Result<(), RunLedgerError> {
    if snapshot.force_stop_requested {
        return Err(RunLedgerError::InvalidEvent(
            "force-stop was already requested",
        ));
    }
    snapshot.force_stop_requested = true;
    snapshot.phase = RunPhase::Stopping;
    Ok(())
}

fn apply_terminal(
    snapshot: &mut RunSnapshot,
    result: &TerminalResult,
) -> Result<(), RunLedgerError> {
    if snapshot.active_executions().next().is_some() {
        return Err(RunLedgerError::InvalidEvent(
            "cannot finish with active executions",
        ));
    }
    snapshot.terminal = Some(result.clone());
    snapshot.phase = RunPhase::Finished;
    Ok(())
}

fn require_running(snapshot: &RunSnapshot) -> Result<(), RunLedgerError> {
    (snapshot.phase == RunPhase::Running)
        .then_some(())
        .ok_or(RunLedgerError::InvalidEvent("run is not dispatchable"))
}

fn require_run(snapshot: &RunSnapshot, reference: &ExecutionRef) -> Result<(), RunLedgerError> {
    (snapshot.run_id == reference.run_id)
        .then_some(())
        .ok_or(RunLedgerError::InvalidEvent(
            "execution belongs to another run",
        ))
}

fn active_node_mut<'a>(
    snapshot: &'a mut RunSnapshot,
    reference: &ExecutionRef,
) -> Result<&'a mut NodeSnapshot, RunLedgerError> {
    let node = snapshot
        .executions
        .get_mut(&reference.execution)
        .ok_or(RunLedgerError::InvalidEvent("execution was not dispatched"))?;
    if node.reference != *reference {
        return Err(RunLedgerError::InvalidEvent(
            "execution reference does not match dispatch",
        ));
    }
    if !matches!(node.state, NodeState::Active) {
        return Err(RunLedgerError::InvalidEvent("execution is already settled"));
    }
    Ok(node)
}
