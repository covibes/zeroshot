//! Authoritative admission and lifecycle snapshot validation.

use openengine_cluster_protocol::{
    DispatchState, Labels, LogLevel, OperationalStatus, Phase, StopMode, INTERNAL_ERROR_CODE,
};

use crate::admission::AdmissionSnapshot;
use crate::lifecycle::{FailureRetryability, LifecycleEvent, LifecycleSnapshot};
use crate::BackendError;

pub(super) fn validate_snapshot(
    snapshot: &AdmissionSnapshot,
    lifecycle: &LifecycleSnapshot,
) -> Result<(), BackendError> {
    let is_empty = snapshot_is_empty(snapshot);
    let is_committed = snapshot_is_committed(snapshot);
    let lifecycle_empty = lifecycle == &LifecycleSnapshot::default();
    let lifecycle_committed = lifecycle_is_committed(snapshot, lifecycle);
    let valid = match snapshot.control.phase {
        Phase::Empty => is_empty && lifecycle_empty,
        Phase::Admitting => (is_empty && lifecycle_empty) || (is_committed && lifecycle_committed),
        Phase::Running | Phase::Finished | Phase::Deleting => is_committed && lifecycle_committed,
    };
    if valid {
        Ok(())
    } else {
        Err(BackendError::new(
            INTERNAL_ERROR_CODE,
            "admission store returned an inconsistent phase snapshot",
        ))
    }
}

fn lifecycle_is_committed(snapshot: &AdmissionSnapshot, lifecycle: &LifecycleSnapshot) -> bool {
    let Some(operational) = lifecycle.operational.as_ref() else {
        return false;
    };
    let Some(latest_cursor) = lifecycle.latest_cursor.as_ref() else {
        return false;
    };
    if !latest_cursor_matches(snapshot, lifecycle, latest_cursor) {
        return false;
    }
    if natural_terminal_lifecycle(snapshot.control.phase, lifecycle, operational) {
        return true;
    }
    phase_matches(snapshot.control.phase, lifecycle, operational)
        && stop_state_matches(operational)
        && lifecycle_record_fold_is_valid(lifecycle)
}

fn natural_terminal_lifecycle(
    phase: Phase,
    lifecycle: &LifecycleSnapshot,
    operational: &OperationalStatus,
) -> bool {
    phase == Phase::Finished
        && operational.dispatch_state == DispatchState::Stopped
        && operational.stop_mode.is_none()
        && operational.in_flight == 0
        && lifecycle.records.is_empty()
        && lifecycle.verified_turns.is_empty()
        && lifecycle.void_turns.is_empty()
        && lifecycle.pending_failed_frontier.is_none()
        && lifecycle.pending_retry_turn.is_none()
}

fn latest_cursor_matches(
    snapshot: &AdmissionSnapshot,
    lifecycle: &LifecycleSnapshot,
    latest_cursor: &openengine_cluster_protocol::Cursor,
) -> bool {
    lifecycle.records.last().map_or_else(
        || snapshot.control.cursor.as_ref() == Some(latest_cursor),
        |record| &record.cursor == latest_cursor,
    )
}

fn phase_matches(
    phase: Phase,
    lifecycle: &LifecycleSnapshot,
    operational: &openengine_cluster_protocol::OperationalStatus,
) -> bool {
    let finished_count = lifecycle
        .records
        .iter()
        .filter(|record| matches!(record.event, LifecycleEvent::Finished { .. }))
        .count();
    match phase {
        Phase::Finished | Phase::Deleting => {
            finished_phase_matches(lifecycle, operational, finished_count)
        }
        Phase::Empty => false,
        Phase::Admitting | Phase::Running => {
            running_phase_matches(operational.dispatch_state, finished_count)
        }
    }
}

fn finished_phase_matches(
    lifecycle: &LifecycleSnapshot,
    operational: &openengine_cluster_protocol::OperationalStatus,
    finished_count: usize,
) -> bool {
    operational.dispatch_state == DispatchState::Stopped
        && finished_count == 1
        && lifecycle.records.last().is_some_and(|record| {
            matches!(
                record.event,
                LifecycleEvent::Finished { mode } if operational.stop_mode == Some(mode)
            )
        })
}

fn running_phase_matches(
    dispatch_state: openengine_cluster_protocol::DispatchState,
    finished_count: usize,
) -> bool {
    !matches!(
        dispatch_state,
        openengine_cluster_protocol::DispatchState::Stopped
            | openengine_cluster_protocol::DispatchState::ForceStopping
    ) && finished_count == 0
}

fn stop_state_matches(operational: &openengine_cluster_protocol::OperationalStatus) -> bool {
    use openengine_cluster_protocol::{DispatchState, StopMode};

    match operational.dispatch_state {
        DispatchState::Active | DispatchState::Suspended => operational.stop_mode.is_none(),
        DispatchState::Draining => operational.stop_mode == Some(StopMode::Drain),
        DispatchState::ForceStopping => operational.stop_mode == Some(StopMode::Force),
        DispatchState::Stopped => operational.stop_mode.is_some(),
    }
}

#[derive(Default)]
struct LifecycleFold {
    dispatched: std::collections::BTreeSet<crate::lifecycle::TurnId>,
    in_flight: std::collections::BTreeSet<crate::lifecycle::TurnId>,
    outcomes: std::collections::BTreeSet<crate::lifecycle::TurnId>,
    operational: OperationalStatus,
    finished: bool,
    pending_failed_frontier: Option<crate::lifecycle::TurnId>,
    pending_retry_turn: Option<crate::lifecycle::TurnId>,
}

fn lifecycle_record_fold_is_valid(lifecycle: &LifecycleSnapshot) -> bool {
    let mut fold = LifecycleFold::default();
    for record in &lifecycle.records {
        if fold.finished || !fold_record(&mut fold, lifecycle, record) {
            return false;
        }
    }
    fold_counts_match(&fold, lifecycle)
}

fn fold_record(
    fold: &mut LifecycleFold,
    lifecycle: &LifecycleSnapshot,
    record: &crate::lifecycle::LifecycleRecord,
) -> bool {
    match &record.event {
        LifecycleEvent::Dispatched { turn_id } => fold_dispatch(fold, turn_id),
        LifecycleEvent::Verified { turn_id } => fold_verified(fold, lifecycle, record, turn_id),
        LifecycleEvent::Void { turn_id } => fold_void(fold, lifecycle, record, turn_id),
        LifecycleEvent::Finished { mode } => fold_finished(fold, *mode),
        LifecycleEvent::Updated {
            labels,
            log_level,
            suspended,
        } => fold_update(fold, labels, *log_level, *suspended),
        LifecycleEvent::StopRequested {
            accepted_mode,
            effective_mode,
        } => fold_stop_request(fold, *accepted_mode, *effective_mode),
        LifecycleEvent::Failed {
            turn_id,
            kind: _,
            retryability,
        } => fold_failed(fold, turn_id, *retryability),
        LifecycleEvent::Retried {
            failed_turn_id,
            retry_turn_id,
        } => fold_retried(fold, failed_turn_id, retry_turn_id),
    }
}

fn fold_dispatch(fold: &mut LifecycleFold, turn_id: &crate::lifecycle::TurnId) -> bool {
    if fold.operational.dispatch_state != DispatchState::Active
        || !fold.dispatched.insert(turn_id.clone())
        || !fold.in_flight.insert(turn_id.clone())
        || fold
            .pending_retry_turn
            .as_ref()
            .is_some_and(|pending| pending != turn_id)
    {
        return false;
    }
    if fold.pending_retry_turn.as_ref() == Some(turn_id) {
        fold.pending_retry_turn = None;
    } else {
        fold.pending_failed_frontier = None;
    }
    sync_in_flight(fold)
}

fn fold_failed(
    fold: &mut LifecycleFold,
    turn_id: &crate::lifecycle::TurnId,
    retryability: FailureRetryability,
) -> bool {
    if matches!(
        fold.operational.dispatch_state,
        DispatchState::ForceStopping | DispatchState::Stopped
    ) || !fold.in_flight.remove(turn_id)
    {
        return false;
    }
    fold.pending_failed_frontier = match retryability {
        FailureRetryability::Retryable => Some(turn_id.clone()),
        FailureRetryability::AttemptsExhausted => None,
    };
    sync_in_flight(fold)
}

fn fold_retried(
    fold: &mut LifecycleFold,
    failed_turn_id: &crate::lifecycle::TurnId,
    retry_turn_id: &crate::lifecycle::TurnId,
) -> bool {
    if fold.pending_failed_frontier.as_ref() != Some(failed_turn_id)
        || fold.pending_retry_turn.is_some()
        || failed_turn_id == retry_turn_id
        || fold.dispatched.contains(retry_turn_id)
    {
        return false;
    }
    fold.pending_failed_frontier = None;
    fold.pending_retry_turn = Some(retry_turn_id.clone());
    true
}

fn fold_update(
    fold: &mut LifecycleFold,
    labels: &Option<Labels>,
    log_level: Option<LogLevel>,
    suspended: Option<bool>,
) -> bool {
    if !matches!(
        fold.operational.dispatch_state,
        DispatchState::Active | DispatchState::Suspended
    ) || (labels.is_none() && log_level.is_none() && suspended.is_none())
        || fold.operational.stop_mode.is_some()
    {
        return false;
    }
    if let Some(labels) = labels {
        fold.operational.labels = labels.clone();
    }
    if let Some(log_level) = log_level {
        fold.operational.log_level = log_level;
    }
    if let Some(suspended) = suspended {
        fold.operational.dispatch_state = if suspended {
            DispatchState::Suspended
        } else {
            DispatchState::Active
        };
    }
    true
}

fn fold_stop_request(
    fold: &mut LifecycleFold,
    accepted_mode: StopMode,
    effective_mode: StopMode,
) -> bool {
    let valid = match fold.operational.dispatch_state {
        DispatchState::Active | DispatchState::Suspended => accepted_mode == effective_mode,
        DispatchState::Draining => matches!(
            (accepted_mode, effective_mode),
            (StopMode::Drain, StopMode::Drain) | (StopMode::Force, StopMode::Force)
        ),
        DispatchState::ForceStopping | DispatchState::Stopped => false,
    };
    if !valid {
        return false;
    }
    fold.operational.dispatch_state = match effective_mode {
        StopMode::Drain => DispatchState::Draining,
        StopMode::Force => DispatchState::ForceStopping,
    };
    fold.operational.stop_mode = Some(effective_mode);
    true
}

fn fold_verified(
    fold: &mut LifecycleFold,
    lifecycle: &LifecycleSnapshot,
    record: &crate::lifecycle::LifecycleRecord,
    turn_id: &crate::lifecycle::TurnId,
) -> bool {
    !matches!(
        fold.operational.dispatch_state,
        DispatchState::ForceStopping | DispatchState::Stopped
    ) && fold.in_flight.remove(turn_id)
        && fold.outcomes.insert(turn_id.clone())
        && lifecycle
            .verified_turns
            .iter()
            .any(|turn| turn.turn_id == *turn_id && turn.cursor == record.cursor)
        && sync_in_flight(fold)
}

fn fold_void(
    fold: &mut LifecycleFold,
    lifecycle: &LifecycleSnapshot,
    record: &crate::lifecycle::LifecycleRecord,
    turn_id: &crate::lifecycle::TurnId,
) -> bool {
    fold.operational.dispatch_state == DispatchState::ForceStopping
        && fold.in_flight.remove(turn_id)
        && fold.outcomes.insert(turn_id.clone())
        && lifecycle
            .void_turns
            .iter()
            .any(|turn| turn.turn_id == *turn_id && turn.cursor == record.cursor)
        && sync_in_flight(fold)
}

fn fold_finished(fold: &mut LifecycleFold, mode: StopMode) -> bool {
    let expected_dispatch_state = match mode {
        StopMode::Drain => DispatchState::Draining,
        StopMode::Force => DispatchState::ForceStopping,
    };
    if !fold.in_flight.is_empty()
        || fold.operational.dispatch_state != expected_dispatch_state
        || fold.operational.stop_mode != Some(mode)
    {
        return false;
    }
    fold.operational.dispatch_state = DispatchState::Stopped;
    fold.operational.in_flight = 0;
    fold.finished = true;
    fold.pending_failed_frontier = None;
    fold.pending_retry_turn = None;
    true
}

fn sync_in_flight(fold: &mut LifecycleFold) -> bool {
    let Ok(in_flight) = u32::try_from(fold.in_flight.len()) else {
        return false;
    };
    fold.operational.in_flight = in_flight;
    true
}

fn fold_counts_match(fold: &LifecycleFold, lifecycle: &LifecycleSnapshot) -> bool {
    let in_flight = lifecycle
        .operational
        .as_ref()
        .map_or(0, |status| status.in_flight);
    let count_matches = usize::try_from(in_flight).is_ok_and(|count| count == fold.in_flight.len());
    let outcome_count = lifecycle
        .verified_turns
        .len()
        .saturating_add(lifecycle.void_turns.len());
    count_matches
        && fold.outcomes.len() == outcome_count
        && lifecycle.pending_failed_frontier == fold.pending_failed_frontier
        && lifecycle.pending_retry_turn == fold.pending_retry_turn
        && lifecycle
            .operational
            .as_ref()
            .is_some_and(|operational| operational == &fold.operational)
}
fn snapshot_is_empty(snapshot: &AdmissionSnapshot) -> bool {
    snapshot.control.spec.is_none()
        && snapshot.control.compiled_ir.is_none()
        && snapshot.control.generation.is_none()
        && snapshot.control.run_id.is_none()
        && snapshot.control.cursor.is_none()
        && snapshot.seed.is_none()
}

fn snapshot_is_committed(snapshot: &AdmissionSnapshot) -> bool {
    matches!(
        (
            snapshot.control.spec.as_ref(),
            snapshot.control.compiled_ir.as_ref(),
            snapshot.control.generation,
            snapshot.control.run_id.as_ref(),
            snapshot.control.cursor.as_ref(),
            snapshot.seed.as_ref(),
        ),
        (
            Some(spec),
            Some(compiled_ir),
            Some(generation),
            Some(run_id),
            Some(cursor),
            Some(seed),
        ) if generation.get() > 0
            && seed.run_id == *run_id
            && seed.cursor == *cursor
            && spec.initial_input.validate_value(&seed.input).is_ok()
            && compiled_ir.identity().is_ok()
    )
}
