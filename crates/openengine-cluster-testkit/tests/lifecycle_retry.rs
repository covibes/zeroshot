use std::sync::Arc;

use openengine_cluster_client::ClientError;
use openengine_cluster_protocol::{
    DispatchState, Generation, IdempotencyKey, Phase, RetryParams, StopMode, TurnFailureKind,
    GENERATION_CONFLICT, IDEMPOTENCY_REUSE, INVALID_PHASE, NO_RETRYABLE_FRONTIER,
};
use openengine_cluster_server::lifecycle::{LifecycleEvent, TurnId, VerifiedCompletion};
use openengine_cluster_testkit::lifecycle::{fail, fail_exhausted, retry, stop, suspend};
use serde_json::json;

#[path = "admission_support/mod.rs"]
mod admission_support;
#[path = "lifecycle_support/mod.rs"]
mod lifecycle_support;
use admission_support::rpc_code;
use lifecycle_support::running;

fn rpc_error_parts(error: ClientError) -> (String, String) {
    match error {
        ClientError::Rpc(error) => {
            let data = error.data.expect("domain error data");
            let details = data.details.expect("domain error details");
            (
                data.code,
                details["reason"]
                    .as_str()
                    .expect("reason is a string")
                    .to_owned(),
            )
        }
        other => panic!("expected RPC error, got {other}"),
    }
}

#[test]
fn retry_wire_types_expose_no_execution_selector_field_names() {
    let params_schema = serde_json::to_value(schemars::schema_for!(RetryParams)).unwrap();
    let result_schema = serde_json::to_value(schemars::schema_for!(
        openengine_cluster_protocol::RetryResult
    ))
    .unwrap();
    for forbidden in ["executionId", "session", "workspacePath", "provider"] {
        assert!(
            !params_schema["properties"]
                .as_object()
                .unwrap()
                .contains_key(forbidden)
        );
        assert!(
            !result_schema["properties"]
                .as_object()
                .unwrap()
                .contains_key(forbidden)
        );
    }
}

#[tokio::test]
async fn retry_before_any_failure_reports_exhausted() {
    let (client, _store) = running().await;
    let error = client.retry(retry(1, "no-failure")).await.unwrap_err();
    let (code, reason) = rpc_error_parts(error);
    assert_eq!(code, NO_RETRYABLE_FRONTIER);
    assert_eq!(reason, "exhausted");
}

#[tokio::test]
async fn retry_after_authored_attempts_are_exhausted_fails_closed() {
    let (client, store) = running().await;
    let permit = store.acquire_dispatch(TurnId::new("turn-1")).await.unwrap();
    store
        .fail_dispatch(fail_exhausted(
            TurnFailureKind::Timeout,
            permit.lease_id.as_str(),
        ))
        .await
        .unwrap();

    let error = client
        .retry(retry(1, "attempts-exhausted"))
        .await
        .unwrap_err();
    let (code, reason) = rpc_error_parts(error);
    assert_eq!(code, NO_RETRYABLE_FRONTIER);
    assert_eq!(reason, "exhausted");
    assert!(store.inspect().await.lifecycle.pending_retry_turn.is_none());
}

#[tokio::test]
async fn retry_after_verified_turn_reports_success() {
    let (client, store) = running().await;
    let permit = store.acquire_dispatch(TurnId::new("turn-1")).await.unwrap();
    store
        .complete_dispatch(VerifiedCompletion {
            lease_id: permit.lease_id,
            output: json!({"ok": true}),
        })
        .await
        .unwrap();

    let error = client
        .retry(retry(1, "no-failure-after-success"))
        .await
        .unwrap_err();
    let (code, reason) = rpc_error_parts(error);
    assert_eq!(code, NO_RETRYABLE_FRONTIER);
    assert_eq!(reason, "success");
}

#[tokio::test]
async fn retry_while_turn_still_leased_reports_active() {
    let (client, store) = running().await;
    store.acquire_dispatch(TurnId::new("turn-1")).await.unwrap();

    let error = client.retry(retry(1, "still-leased")).await.unwrap_err();
    let (code, reason) = rpc_error_parts(error);
    assert_eq!(code, NO_RETRYABLE_FRONTIER);
    assert_eq!(reason, "active");
}

#[tokio::test]
async fn retry_while_suspended_is_denied() {
    let (client, store) = running().await;
    let permit = store.acquire_dispatch(TurnId::new("turn-1")).await.unwrap();
    store
        .fail_dispatch(fail(TurnFailureKind::Failed, permit.lease_id.as_str()))
        .await
        .unwrap();
    client.update(suspend(1, "suspend")).await.unwrap();

    let error = client.retry(retry(1, "while-suspended")).await.unwrap_err();
    assert_eq!(rpc_code(error), INVALID_PHASE);
}

#[tokio::test]
async fn retry_after_terminal_stop_fails_invalid_phase() {
    let (client, store) = running().await;
    let permit = store.acquire_dispatch(TurnId::new("turn-1")).await.unwrap();
    store
        .fail_dispatch(fail(TurnFailureKind::Refused, permit.lease_id.as_str()))
        .await
        .unwrap();
    client
        .stop(stop(StopMode::Force, 1, "force-stop"))
        .await
        .unwrap();

    let error = client.retry(retry(1, "post-finish")).await.unwrap_err();
    assert_eq!(rpc_code(error), INVALID_PHASE);
}

#[tokio::test]
async fn retry_cas_and_idempotency_are_atomic_and_never_starts_a_new_run() {
    let (client, store) = running().await;
    let before = store.inspect().await;
    let permit = store.acquire_dispatch(TurnId::new("turn-1")).await.unwrap();
    store
        .fail_dispatch(fail(TurnFailureKind::Timeout, permit.lease_id.as_str()))
        .await
        .unwrap();

    let stale = client
        .retry(RetryParams {
            if_generation: Generation::new(2).unwrap(),
            idempotency_key: IdempotencyKey::new("stale").unwrap(),
        })
        .await
        .unwrap_err();
    assert_eq!(rpc_code(stale), GENERATION_CONFLICT);

    let first = client.retry(retry(1, "shared-key")).await.unwrap();
    assert!(!first.deduped);
    assert_eq!(first.run_id, before.control.run_id.unwrap());
    assert_eq!(first.generation, before.control.generation.unwrap());
    assert_eq!(first.retried_turn_id, "turn-1");

    let replay = client.retry(retry(1, "shared-key")).await.unwrap();
    assert!(replay.deduped);
    assert_eq!(replay.at_cursor, first.at_cursor);
    assert_eq!(replay.retry_turn_id, first.retry_turn_id);

    let conflict = client
        .retry(RetryParams {
            if_generation: Generation::new(2).unwrap(),
            idempotency_key: IdempotencyKey::new("shared-key").unwrap(),
        })
        .await
        .unwrap_err();
    assert_eq!(rpc_code(conflict), IDEMPOTENCY_REUSE);

    let cross_method = client
        .stop(stop(StopMode::Drain, 1, "shared-key"))
        .await
        .unwrap_err();
    assert_eq!(rpc_code(cross_method), IDEMPOTENCY_REUSE);

    let effects = store.inspect().await;
    assert_eq!(
        effects
            .lifecycle
            .records
            .iter()
            .filter(|record| matches!(record.event, LifecycleEvent::Retried { .. }))
            .count(),
        1
    );
}

#[tokio::test]
async fn retry_races_a_concurrent_error_successor_and_exactly_one_mutation_is_accepted() {
    let (client, store) = running().await;
    let client = Arc::new(client);
    let permit = store.acquire_dispatch(TurnId::new("turn-1")).await.unwrap();
    store
        .fail_dispatch(fail(TurnFailureKind::Crash, permit.lease_id.as_str()))
        .await
        .unwrap();

    let retry_call = {
        let client = Arc::clone(&client);
        tokio::spawn(async move { client.retry(retry(1, "race-retry")).await })
    };
    let dispatch_call = {
        let store = Arc::clone(&store);
        tokio::spawn(async move { store.acquire_dispatch(TurnId::new("turn-2")).await })
    };
    let retry_result = retry_call.await.unwrap();
    let dispatch_result = dispatch_call.await.unwrap();

    assert_ne!(
        retry_result.is_ok(),
        dispatch_result.is_ok(),
        "only retry or its competing error-successor may be accepted"
    );
    let effects = store.inspect().await;
    let retried_count = effects
        .lifecycle
        .records
        .iter()
        .filter(|record| matches!(record.event, LifecycleEvent::Retried { .. }))
        .count();
    match retry_result {
        Ok(result) => {
            assert_eq!(retried_count, 1);
            assert_eq!(
                effects
                    .lifecycle
                    .pending_retry_turn
                    .as_ref()
                    .unwrap()
                    .as_str(),
                result.retry_turn_id
            );
        }
        Err(error) => {
            let (code, reason) = rpc_error_parts(error);
            assert_eq!(code, NO_RETRYABLE_FRONTIER);
            assert_eq!(reason, "active");
            assert_eq!(retried_count, 0);
            assert!(effects.lifecycle.pending_retry_turn.is_none());
        }
    }
}

#[tokio::test]
async fn retry_never_allocates_a_new_run_id() {
    let (client, store) = running().await;
    let before = store.inspect().await;
    let permit = store.acquire_dispatch(TurnId::new("turn-1")).await.unwrap();
    store
        .fail_dispatch(fail(TurnFailureKind::Timeout, permit.lease_id.as_str()))
        .await
        .unwrap();

    let result = client.retry(retry(1, "no-new-run")).await.unwrap();
    assert_eq!(result.run_id, before.control.run_id.unwrap());
    assert_eq!(result.generation, before.control.generation.unwrap());
    assert_eq!(store.inspect().await.control.run_id, Some(result.run_id));
}

#[tokio::test]
async fn accepted_retry_intent_must_dispatch_before_any_error_successor() {
    let (client, store) = running().await;
    let permit = store.acquire_dispatch(TurnId::new("turn-1")).await.unwrap();
    store
        .fail_dispatch(fail(TurnFailureKind::Failed, permit.lease_id.as_str()))
        .await
        .unwrap();

    let retried = client.retry(retry(1, "retry-intent")).await.unwrap();
    assert!(
        store
            .acquire_dispatch(TurnId::new("stale-error-successor"))
            .await
            .is_err()
    );
    let retry_turn = TurnId::new(retried.retry_turn_id);
    store.acquire_dispatch(retry_turn.clone()).await.unwrap();
    assert!(store.acquire_dispatch(retry_turn).await.is_err());
}

#[tokio::test]
async fn a_failed_turn_identity_can_never_be_dispatched_again() {
    let (_client, store) = running().await;
    let turn = TurnId::new("turn-1");
    let permit = store.acquire_dispatch(turn.clone()).await.unwrap();
    store
        .fail_dispatch(fail(TurnFailureKind::Failed, permit.lease_id.as_str()))
        .await
        .unwrap();

    assert!(store.acquire_dispatch(turn).await.is_err());
}

#[tokio::test]
async fn retry_turn_identity_skips_an_existing_dispatch_identity() {
    let (client, store) = running().await;
    let collision = store
        .acquire_dispatch(TurnId::new("retry-1"))
        .await
        .unwrap();
    store
        .complete_dispatch(VerifiedCompletion {
            lease_id: collision.lease_id,
            output: json!({"ok": true}),
        })
        .await
        .unwrap();
    let failed = store.acquire_dispatch(TurnId::new("turn-2")).await.unwrap();
    store
        .fail_dispatch(fail(TurnFailureKind::Crash, failed.lease_id.as_str()))
        .await
        .unwrap();

    let retried = client.retry(retry(1, "unique-retry-turn")).await.unwrap();
    assert_eq!(retried.retry_turn_id, "retry-2");
}

#[tokio::test]
async fn retry_waits_until_every_concurrent_lease_has_settled() {
    let (client, store) = running().await;
    let failed = store.acquire_dispatch(TurnId::new("failed")).await.unwrap();
    let active = store.acquire_dispatch(TurnId::new("active")).await.unwrap();
    store
        .fail_dispatch(fail(TurnFailureKind::Refused, failed.lease_id.as_str()))
        .await
        .unwrap();

    let error = client
        .retry(retry(1, "while-peer-active"))
        .await
        .unwrap_err();
    let (code, reason) = rpc_error_parts(error);
    assert_eq!(code, NO_RETRYABLE_FRONTIER);
    assert_eq!(reason, "active");
    store
        .complete_dispatch(VerifiedCompletion {
            lease_id: active.lease_id,
            output: json!({"ok": true}),
        })
        .await
        .unwrap();
}

#[tokio::test]
async fn final_failed_lease_finishes_a_draining_run() {
    let (client, store) = running().await;
    let permit = store.acquire_dispatch(TurnId::new("turn-1")).await.unwrap();
    let acknowledged = client
        .stop(stop(StopMode::Drain, 1, "drain-failed"))
        .await
        .unwrap();
    assert_eq!(
        acknowledged.operational.dispatch_state,
        DispatchState::Draining
    );

    let result = store
        .fail_dispatch(fail(TurnFailureKind::Crash, permit.lease_id.as_str()))
        .await
        .unwrap();
    assert!(result.terminalized);
    let state = store.inspect().await;
    assert_eq!(state.control.phase, Phase::Finished);
    assert!(state.lifecycle.pending_failed_frontier.is_none());
    assert!(state.lifecycle.pending_retry_turn.is_none());
    assert!(matches!(
        state.lifecycle.records.last().unwrap().event,
        LifecycleEvent::Finished {
            mode: StopMode::Drain
        }
    ));
}
