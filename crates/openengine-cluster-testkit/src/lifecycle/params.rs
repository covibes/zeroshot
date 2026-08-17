//! Typed lifecycle parameter constructors for deterministic fixtures.

use crate::fixture::*;

use openengine_cluster_protocol::{
    DeleteParams, Generation, IdempotencyKey, ResubmitParams, RetryParams, RunId, StopMode,
    StopParams, TurnFailureKind, UpdateParams,
};
use openengine_cluster_server::lifecycle::{FailedCompletion, FailureRetryability, LeaseId};
use serde_json::Value;

#[must_use]
pub fn suspend(generation: u64, key: &str) -> UpdateParams {
    update_suspension(true, generation, key)
}

#[must_use]
pub fn resume(generation: u64, key: &str) -> UpdateParams {
    update_suspension(false, generation, key)
}

fn update_suspension(suspended: bool, generation: u64, key: &str) -> UpdateParams {
    UpdateParams {
        labels: None,
        log_level: None,
        suspended: Some(suspended),
        if_generation: fixture_generation(generation),
        idempotency_key: fixture_key(key),
    }
}

#[must_use]
pub fn stop(mode: StopMode, generation: u64, key: &str) -> StopParams {
    StopParams {
        mode,
        if_generation: fixture_generation(generation),
        idempotency_key: fixture_key(key),
    }
}

#[must_use]
pub fn retry(generation: u64, key: &str) -> RetryParams {
    RetryParams {
        if_generation: fixture_generation(generation),
        idempotency_key: fixture_key(key),
    }
}

#[must_use]
pub fn resubmit(
    generation: u64,
    run_id: &str,
    key: &str,
    replacement: Option<Value>,
) -> ResubmitParams {
    ResubmitParams {
        if_generation: fixture_generation(generation),
        if_run_id: RunId::new(run_id),
        idempotency_key: fixture_key(key),
        replacement_input: replacement,
    }
}

#[must_use]
pub fn delete(generation: u64, run_id: Option<&str>, key: &str) -> DeleteParams {
    DeleteParams {
        if_generation: fixture_generation(generation),
        if_run_id: run_id.map(RunId::new),
        idempotency_key: fixture_key(key),
    }
}

#[must_use]
pub fn fail(kind: TurnFailureKind, lease_id: &str) -> FailedCompletion {
    failed_completion(kind, lease_id, FailureRetryability::Retryable)
}

#[must_use]
pub fn fail_exhausted(kind: TurnFailureKind, lease_id: &str) -> FailedCompletion {
    failed_completion(kind, lease_id, FailureRetryability::AttemptsExhausted)
}

fn failed_completion(
    kind: TurnFailureKind,
    lease_id: &str,
    retryability: FailureRetryability,
) -> FailedCompletion {
    FailedCompletion {
        lease_id: LeaseId::new(lease_id),
        kind,
        retryability,
    }
}

fn fixture_generation(value: u64) -> Generation {
    Generation::new(value).assert_value_with("fixture generation is in range")
}

fn fixture_key(value: &str) -> IdempotencyKey {
    IdempotencyKey::new(value).assert_value_with("fixture key is valid")
}
