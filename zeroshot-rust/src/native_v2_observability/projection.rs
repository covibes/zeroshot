use super::*;

pub(super) fn status_result(
    snapshot: &RunSnapshot,
) -> Result<RunStatusResult, NativeV2ObservationError> {
    Ok(RunStatusResult {
        run_id: snapshot.run_id.clone(),
        at_cursor: snapshot.cursor.clone(),
        status: status_from_snapshot(snapshot)?,
    })
}

pub(super) fn status_from_snapshot(
    snapshot: &RunSnapshot,
) -> Result<RunStatus, NativeV2ObservationError> {
    let active_executions = || {
        snapshot
            .active_executions()
            .map(|node| {
                Ok(ActiveExecution {
                    execution: opaque_execution(&node.reference)?,
                    node: node.reference.node.clone(),
                })
            })
            .collect::<Result<Vec<_>, NativeV2ObservationError>>()
    };
    match snapshot.phase {
        RunPhase::Admitted => Ok(RunStatus::Admitted {}),
        RunPhase::Running => Ok(RunStatus::Running {
            active_executions: active_executions()?,
        }),
        RunPhase::Stopping => Ok(RunStatus::Stopping {
            active_executions: active_executions()?,
        }),
        RunPhase::Finished => Ok(RunStatus::Finished {
            terminal_result: snapshot
                .terminal
                .clone()
                .ok_or(NativeV2ObservationError::InvalidState)?,
        }),
    }
}

pub(super) fn changes_public_status(event: &RunEvent) -> bool {
    !matches!(event, RunEvent::SafeLog { .. })
}

pub(super) fn log_notification(
    subscription_id: &SubscriptionId,
    snapshot: &RunSnapshot,
    filter: Option<ExecutionId>,
    stored: &StoredRunEvent,
) -> Result<Option<RunLogEventNotification>, NativeV2ObservationError> {
    let RunEvent::SafeLog {
        execution,
        stream,
        line,
    } = &stored.event
    else {
        return Ok(None);
    };
    if filter.is_some() && filter != *execution {
        return Ok(None);
    }
    let public_execution = execution
        .map(|execution| {
            snapshot
                .executions
                .get(&execution)
                .ok_or(NativeV2ObservationError::InvalidState)
                .and_then(|node| opaque_execution(&node.reference))
        })
        .transpose()?;
    Ok(Some(RunLogEventNotification {
        subscription_id: subscription_id.clone(),
        run_id: snapshot.run_id.clone(),
        cursor: stored.cursor.clone(),
        execution: public_execution,
        record: log_record(*stream, line.as_str())?,
    }))
}

fn log_record(stream: SafeLogStream, line: &str) -> Result<LogRecord, NativeV2ObservationError> {
    let level = match stream {
        SafeLogStream::Output => LogLevel::Info,
        SafeLogStream::Error => LogLevel::Error,
        SafeLogStream::System => LogLevel::Debug,
    };
    Ok(LogRecord {
        level,
        target: BoundedLogTarget::new(LOG_TARGET)
            .map_err(|_| NativeV2ObservationError::InvalidState)?,
        message: BoundedLogMessage::new(line).unwrap_or_else(|_| BoundedLogMessage::redacted()),
    })
}

pub(super) fn bounded_attach_output(text: &str) -> BoundedAssistantOutput {
    BoundedAssistantOutput::new(text).unwrap_or_else(|_| BoundedAssistantOutput::redacted())
}

pub(super) fn require_active_reference(
    snapshot: &RunSnapshot,
    reference: &ExecutionRef,
) -> Result<(), NativeV2ObservationError> {
    let node = snapshot
        .executions
        .get(&reference.execution)
        .ok_or(NativeV2ObservationError::ExecutionNotFound)?;
    if node.reference != *reference {
        return Err(NativeV2ObservationError::ExecutionNotFound);
    }
    if !matches!(node.state, NodeState::Active) {
        return Err(NativeV2ObservationError::ExecutionNotActive);
    }
    Ok(())
}

pub(super) fn resolve_public_execution(
    snapshot: &RunSnapshot,
    public: &PublicExecutionRef,
) -> Result<ExecutionId, NativeV2ObservationError> {
    for node in snapshot.executions.values() {
        if opaque_execution(&node.reference)? == *public {
            return Ok(node.reference.execution);
        }
    }
    Err(NativeV2ObservationError::ExecutionNotFound)
}

pub(super) fn opaque_execution(
    reference: &ExecutionRef,
) -> Result<PublicExecutionRef, NativeV2ObservationError> {
    let mut digest = Sha256::new();
    digest.update(b"zeroshot/native-v2/execution-ref/v1\0");
    digest.update(reference.run_id.as_str().as_bytes());
    digest.update(b"\0");
    digest.update(reference.node.as_str().as_bytes());
    digest.update(b"\0");
    digest.update(reference.node_instance.to_string().as_bytes());
    digest.update(b"\0");
    digest.update(reference.execution.to_string().as_bytes());
    let token = digest
        .finalize()
        .iter()
        .fold(String::from("nv2-"), |mut token, byte| {
            use std::fmt::Write as _;
            let _ = write!(token, "{byte:02x}");
            token
        });
    PublicExecutionRef::new(token).map_err(|_| NativeV2ObservationError::InvalidState)
}
