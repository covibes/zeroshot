use std::sync::Arc;

use openengine_cluster_protocol::{
    admission_fingerprint, Cursor, DispatchState, Generation, IdempotencyKey, StopMode, StopParams,
    UpdateParams, GENERATION_CONFLICT, IDEMPOTENCY_REUSE, INTERNAL_ERROR_CODE, SCHEMA_VIOLATION,
};
use openengine_cluster_server::admission::{AdmissionCoordinator, StoreError};
use openengine_cluster_server::lifecycle::{
    LifecycleEvent, LifecycleRecord, LifecycleStore, TurnId, UpdateProposal, VerifiedCompletion,
};
use openengine_cluster_server::{BackendErrorKind, ClusterBackend, ConnectionContext};
use openengine_cluster_testkit::admission::ScriptedVerifier;
use openengine_cluster_testkit::lifecycle::{resume, stop, suspend};
use serde_json::json;

#[path = "admission_support/mod.rs"]
mod admission_support;
#[path = "lifecycle_support/mod.rs"]
mod lifecycle_support;
use admission_support::{rpc_code, FixtureClient};
use lifecycle_support::running;

fn empty_update(key: &str) -> UpdateParams {
    UpdateParams {
        labels: None,
        log_level: None,
        suspended: None,
        if_generation: Generation::new(1).assert_value(),
        idempotency_key: IdempotencyKey::new(key).assert_value(),
    }
}

#[tokio::test]
async fn typed_empty_update_is_rejected_at_backend_and_store_boundaries() {
    let (_client, store) = running().await;
    let backend = AdmissionCoordinator::from_shared(
        Arc::new(ScriptedVerifier::new(vec![])),
        Arc::clone(&store),
    );
    let before = store.inspect().await;

    let backend_error = ClusterBackend::update(
        &backend,
        &ConnectionContext::default(),
        empty_update("empty-backend"),
    )
    .await
    .assert_error();
    assert_eq!(backend_error.kind, BackendErrorKind::InvalidParams);
    assert_eq!(backend_error.code, SCHEMA_VIOLATION);
    assert_eq!(store.inspect().await, before);

    let store_error = <_ as LifecycleStore>::update_lifecycle(
        store.as_ref(),
        UpdateProposal {
            params: empty_update("empty-store"),
            fingerprint: admission_fingerprint("update", &json!({"ifGeneration":1})).assert_value(),
        },
    )
    .await
    .assert_error();
    assert_eq!(
        store_error,
        StoreError::SchemaViolation(
            "update requires at least one of labels, logLevel, or suspended".into()
        )
    );
    assert_eq!(store.inspect().await, before);
}

#[tokio::test]
async fn lifecycle_suspend_in_flight_resume_preserves_the_durable_frontier() {
    let (client, store) = running().await;

    let permit = store
        .acquire_dispatch(TurnId::new("turn-1"))
        .await
        .assert_value();
    let suspended = client.update(suspend(1, "suspend")).await.assert_value();
    assert_eq!(
        suspended.operational.dispatch_state,
        DispatchState::Suspended
    );
    assert_eq!(suspended.operational.in_flight, 1);
    assert!(
        store
            .acquire_dispatch(TurnId::new("blocked"))
            .await
            .is_err()
    );

    store
        .complete_dispatch(VerifiedCompletion {
            lease_id: permit.lease_id,
            output: json!({"verified":true}),
        })
        .await
        .assert_value();
    let while_suspended = client
        .get(openengine_cluster_protocol::GetParams::default())
        .await
        .assert_value();
    assert_eq!(
        while_suspended
            .status
            .operational
            .as_ref()
            .assert_value()
            .dispatch_state,
        DispatchState::Suspended
    );
    assert_eq!(
        while_suspended.status.operational.assert_value().in_flight,
        0
    );
    let completion_cursor = while_suspended.at_cursor.assert_value();

    let resumed = client.update(resume(1, "resume")).await.assert_value();
    assert_eq!(resumed.operational.dispatch_state, DispatchState::Active);
    assert_ne!(resumed.at_cursor, completion_cursor);
    store
        .acquire_dispatch(TurnId::new("successor"))
        .await
        .assert_value();

    let effects = store.inspect().await;
    assert_eq!(effects.lifecycle.verified_turns.len(), 1);
    assert_eq!(
        effects.lifecycle.verified_turns.assert_at(0).output,
        json!({"verified":true})
    );
}

#[tokio::test]
async fn lifecycle_cas_and_method_qualified_idempotency_are_atomic() {
    let (client, store) = running().await;

    let stale = client
        .update(UpdateParams {
            labels: None,
            log_level: None,
            suspended: Some(true),
            if_generation: Generation::new(2).assert_value(),
            idempotency_key: IdempotencyKey::new("stale").assert_value(),
        })
        .await
        .assert_error();
    assert_eq!(rpc_code(stale), GENERATION_CONFLICT);
    let before = store.inspect().await;

    let original = suspend(1, "shared-key");
    let receipt = client.update(original.clone()).await.assert_value();
    let replay = client.update(original).await.assert_value();
    assert!(replay.deduped);
    assert_eq!(replay.at_cursor, receipt.at_cursor);

    let conflict = client
        .update(UpdateParams {
            labels: None,
            log_level: None,
            suspended: Some(false),
            if_generation: Generation::new(1).assert_value(),
            idempotency_key: IdempotencyKey::new("shared-key").assert_value(),
        })
        .await
        .assert_error();
    assert_eq!(rpc_code(conflict), IDEMPOTENCY_REUSE);
    let cross_method = client
        .stop(StopParams {
            mode: StopMode::Force,
            if_generation: Generation::new(1).assert_value(),
            idempotency_key: IdempotencyKey::new("shared-key").assert_value(),
        })
        .await
        .assert_error();
    assert_eq!(rpc_code(cross_method), IDEMPOTENCY_REUSE);
    assert_eq!(before.control, store.inspect().await.control);
}

#[tokio::test]
async fn authoritative_reads_reject_malformed_lifecycle_snapshots() {
    let (client, store) = running().await;
    let mut malformed = store.inspect().await.lifecycle;
    malformed.operational = None;
    store.replace_lifecycle_snapshot_for_test(malformed).await;
    assert!(client.initialize().await.is_err());
    assert!(
        client
            .get(openengine_cluster_protocol::GetParams::default())
            .await
            .is_err()
    );
}

async fn assert_authoritative_reads_reject(
    client: &FixtureClient,
    store: &openengine_cluster_testkit::admission::InMemoryAdmissionStore,
    snapshot: openengine_cluster_server::lifecycle::LifecycleSnapshot,
    case: &str,
) {
    store.replace_lifecycle_snapshot_for_test(snapshot).await;
    assert_eq!(
        rpc_code(client.initialize().await.assert_error()),
        INTERNAL_ERROR_CODE,
        "initialize accepted {case}"
    );
    assert_eq!(
        rpc_code(
            client
                .get(openengine_cluster_protocol::GetParams::default())
                .await
                .assert_error()
        ),
        INTERNAL_ERROR_CODE,
        "get accepted {case}"
    );
}

async fn reject_force_request_with_active_status() {
    let (client, store) = running().await;
    let mut snapshot = store.inspect().await.lifecycle;
    let force_cursor = Cursor::new("corrupt-force-request");
    snapshot.records.push(LifecycleRecord {
        cursor: force_cursor.clone(),
        event: LifecycleEvent::StopRequested {
            accepted_mode: StopMode::Force,
            effective_mode: StopMode::Force,
        },
    });
    snapshot.latest_cursor = Some(force_cursor);
    assert_authoritative_reads_reject(
        &client,
        &store,
        snapshot,
        "force stop request with active operational status",
    )
    .await;
}

async fn reject_update_ignored_by_operational_status() {
    let (client, store) = running().await;
    client
        .update(suspend(1, "suspend-fold"))
        .await
        .assert_value();
    let mut snapshot = store.inspect().await.lifecycle;
    snapshot.operational.as_mut().assert_value().dispatch_state = DispatchState::Active;
    assert_authoritative_reads_reject(
        &client,
        &store,
        snapshot,
        "suspend update with active operational status",
    )
    .await;
}

async fn reject_dispatch_after_drain() {
    let (client, store) = running().await;
    store
        .acquire_dispatch(TurnId::new("existing"))
        .await
        .assert_value();
    client
        .stop(stop(StopMode::Drain, 1, "drain-fold"))
        .await
        .assert_value();
    let mut snapshot = store.inspect().await.lifecycle;
    let dispatch_cursor = Cursor::new("corrupt-dispatch-after-drain");
    snapshot.records.push(LifecycleRecord {
        cursor: dispatch_cursor.clone(),
        event: LifecycleEvent::Dispatched {
            turn_id: TurnId::new("forbidden-successor"),
        },
    });
    snapshot.latest_cursor = Some(dispatch_cursor);
    snapshot.operational.as_mut().assert_value().in_flight = 2;
    assert_authoritative_reads_reject(&client, &store, snapshot, "dispatch after drain").await;
}

async fn reject_finished_mode_mismatch() {
    let (client, store) = running().await;
    client
        .stop(stop(StopMode::Force, 1, "force-fold"))
        .await
        .assert_value();
    let mut snapshot = store.inspect().await.lifecycle;
    let last = snapshot.records.last_mut().assert_value();
    last.event = LifecycleEvent::Finished {
        mode: StopMode::Drain,
    };
    assert_authoritative_reads_reject(
        &client,
        &store,
        snapshot,
        "drain finished event with force operational status",
    )
    .await;
}

#[tokio::test]
async fn authoritative_reads_reconstruct_every_lifecycle_transition() {
    reject_force_request_with_active_status().await;
    reject_update_ignored_by_operational_status().await;
    reject_dispatch_after_drain().await;
    reject_finished_mode_mismatch().await;
}

use openengine_cluster_testkit::assertions::{AssertAt, AssertError, AssertValue};
