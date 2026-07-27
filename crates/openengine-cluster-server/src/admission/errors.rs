//! Apply-mode/generation/input validation and store-error-to-backend-error mapping.

use openengine_cluster_protocol::{
    ApplyParams, CompiledGraphIr, Generation, GraphSpec, CANCELLED, GENERATION_CONFLICT, GONE,
    IDEMPOTENCY_REUSE, INTERNAL_ERROR_CODE, INVALID_PHASE, NOT_FOUND, NO_RETRYABLE_FRONTIER,
    RUN_CONFLICT, SCHEMA_VIOLATION,
};
use serde_json::{json, Value};

use super::StoreError;
use crate::BackendError;

pub(super) fn validate_apply_mode(params: &ApplyParams) -> Result<(), BackendError> {
    if params.dry_run {
        if params.idempotency_key.is_some() {
            return Err(schema_error("dry-run apply must omit idempotencyKey"));
        }
        if params.input.is_some() {
            return Err(schema_error("dry-run apply must omit input"));
        }
    } else if params.idempotency_key.is_none() {
        return Err(schema_error("committed apply requires idempotencyKey"));
    }
    Ok(())
}

pub(super) fn precheck_generation(
    expected: Option<Generation>,
    current: Option<Generation>,
) -> Result<(), BackendError> {
    let matches = match expected {
        None => true,
        Some(expected) if expected.get() == 0 => current.is_none(),
        Some(expected) => current == Some(expected),
    };
    if matches {
        Ok(())
    } else {
        Err(BackendError::application(
            GENERATION_CONFLICT,
            "Generation precondition failed",
            Some(json!({ "currentGeneration": current })),
        ))
    }
}

pub(super) fn precheck_input(
    current: Option<&CompiledGraphIr>,
    desired: &CompiledGraphIr,
    graph: &GraphSpec,
    input: Option<&Value>,
) -> Result<(), BackendError> {
    let unchanged = current
        .map(|current| Ok(current.identity()? == desired.identity()?))
        .transpose()
        .map_err(|error: openengine_cluster_protocol::CanonicalError| {
            BackendError::new(INTERNAL_ERROR_CODE, error.to_string())
        })?
        .unwrap_or(false);
    if unchanged {
        if input.is_some() {
            return Err(schema_error(
                "unchanged apply must omit input; use resubmit to supply a new root input",
            ));
        }
        return Ok(());
    }
    let input = input.ok_or_else(|| schema_error("apply that starts a run requires input"))?;
    graph
        .initial_input
        .validate_value(input)
        .map_err(|error| schema_error(&error.to_string()))
}

pub(super) fn schema_error(message: &str) -> BackendError {
    BackendError::invalid_params(
        SCHEMA_VIOLATION,
        "Admission parameters violate the schema",
        Some(json!({ "reason": message })),
    )
}

pub(super) fn cancelled_error() -> BackendError {
    BackendError::application(CANCELLED, "Admission cancelled before commit", None)
}

pub(super) fn store_error_to_backend(error: StoreError) -> BackendError {
    match error {
        StoreError::Internal(message) => BackendError::new(INTERNAL_ERROR_CODE, message),
        StoreError::IdempotencyReuse => BackendError::application(
            IDEMPOTENCY_REUSE,
            "Idempotency key was reused with different parameters",
            None,
        ),
        StoreError::GenerationConflict { current } => BackendError::application(
            GENERATION_CONFLICT,
            "Generation precondition failed",
            Some(json!({ "currentGeneration": current })),
        ),
        StoreError::RunConflict { current } => BackendError::application(
            RUN_CONFLICT,
            "Run precondition failed",
            Some(json!({ "currentRunId": current })),
        ),
        StoreError::InvalidPhase { current } => BackendError::application(
            INVALID_PHASE,
            "Cluster phase does not admit apply",
            Some(json!({ "currentPhase": current })),
        ),
        StoreError::SchemaViolation(message) => schema_error(&message),
        StoreError::Cancelled => cancelled_error(),
        dispatch_error => dispatch_store_error_to_backend(dispatch_error),
    }
}

/// Handles the dispatch/lifecycle-lease `StoreError` variants that `store_error_to_backend`
/// delegates to in order to keep its own match arm count under the crate's complexity limit.
fn dispatch_store_error_to_backend(error: StoreError) -> BackendError {
    match error {
        StoreError::DispatchDenied { current } => BackendError::application(
            INVALID_PHASE,
            "Lifecycle state denies successor dispatch",
            Some(json!({ "dispatchState": current })),
        ),
        StoreError::UnknownLease => {
            BackendError::application(INVALID_PHASE, "Dispatch lease does not exist", None)
        }
        StoreError::CompletionRejected => BackendError::application(
            CANCELLED,
            "Dispatch completion was rejected after cancellation or terminalization",
            None,
        ),
        StoreError::UnknownRun => BackendError::application(NOT_FOUND, "Run does not exist", None),
        StoreError::RunGone { tombstoned_at } => BackendError::application(
            GONE,
            "Run history was deleted",
            Some(json!({ "tombstonedAt": tombstoned_at })),
        ),
        StoreError::NoRetryableFrontier { reason } => BackendError::application(
            NO_RETRYABLE_FRONTIER,
            "No retryable failed frontier",
            Some(json!({ "reason": reason })),
        ),
        non_dispatch_error => BackendError::new(
            INTERNAL_ERROR_CODE,
            format!("unmapped store error: {non_dispatch_error:?}"),
        ),
    }
}
