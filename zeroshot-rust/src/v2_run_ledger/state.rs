use openengine_cluster_protocol::{Cursor, TerminalResult};
use serde::Serialize;

use super::{
    CreateRun, ExecutionId, ExecutionRef, ExecutionVoidReason, MAX_ADMITTED_RUN_BYTES,
    MAX_EVENT_BYTES, NodeCompletion, NodeSnapshot, NodeState, RunEvent, RunLedgerError, RunPhase,
    RunSnapshot, INITIAL_CURSOR,
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
