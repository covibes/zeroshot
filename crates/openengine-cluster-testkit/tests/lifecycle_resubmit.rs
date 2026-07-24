use std::sync::Arc;

use openengine_cluster_protocol::{
    ResubmitParams, ResubmitResult, StopMode, GENERATION_CONFLICT, IDEMPOTENCY_REUSE,
    INVALID_PHASE, RUN_CONFLICT, SCHEMA_VIOLATION,
};
use openengine_cluster_server::watch::{ObservationStore, SubscribeRequest};
use openengine_cluster_testkit::admission::InMemoryAdmissionStore;
use openengine_cluster_testkit::lifecycle::{resubmit, stop};
use serde_json::json;

#[path = "admission_support/mod.rs"]
mod admission_support;
#[path = "lifecycle_support/mod.rs"]
mod lifecycle_support;
use admission_support::{rpc_code, FixtureClient};
use lifecycle_support::running;

/// A terminal run: `running()` immediately force-stopped, reaching `Phase::Finished` at
/// generation 1. `resubmit` requires a terminal retained run to mutate from.
async fn terminal_run() -> (FixtureClient, Arc<InMemoryAdmissionStore>) {
    let (client, store) = running().await;
    client
        .stop(stop(StopMode::Force, 1, "terminal-run-fixture"))
        .await
        .expect("fixture force-stop reaches a terminal run");
    (client, store)
}

#[test]
fn resubmit_wire_types_expose_no_provider_or_config_field_names() {
    let params_schema = serde_json::to_value(schemars::schema_for!(ResubmitParams)).unwrap();
    let result_schema = serde_json::to_value(schemars::schema_for!(ResubmitResult)).unwrap();
    for forbidden in [
        "provider",
        "config",
        "source",
        "turnId",
        "session",
        "workspacePath",
    ] {
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
async fn resubmit_before_terminal_is_denied_invalid_phase() {
    let (client, _store) = running().await;
    let error = client
        .resubmit(resubmit(1, "run-1", "not-terminal", None))
        .await
        .unwrap_err();
    assert_eq!(rpc_code(error), INVALID_PHASE);
}

#[tokio::test]
async fn resubmit_stale_generation_is_denied_generation_conflict() {
    let (client, _store) = terminal_run().await;
    let error = client
        .resubmit(resubmit(2, "run-1", "stale-generation", None))
        .await
        .unwrap_err();
    assert_eq!(rpc_code(error), GENERATION_CONFLICT);
}

#[tokio::test]
async fn resubmit_stale_run_is_denied_run_conflict() {
    let (client, _store) = terminal_run().await;
    let error = client
        .resubmit(resubmit(1, "run-99", "stale-run", None))
        .await
        .unwrap_err();
    assert_eq!(rpc_code(error), RUN_CONFLICT);
}

#[tokio::test]
async fn resubmit_malformed_replacement_input_is_denied_schema_violation() {
    let (client, _store) = terminal_run().await;
    let error = client
        .resubmit(resubmit(
            1,
            "run-1",
            "bad-input",
            Some(json!({"unexpected": "value"})),
        ))
        .await
        .unwrap_err();
    assert_eq!(rpc_code(error), SCHEMA_VIOLATION);
}

#[tokio::test]
async fn resubmit_repeated_idempotency_key_conflict_is_denied() {
    let (client, _store) = terminal_run().await;
    client
        .resubmit(resubmit(1, "run-1", "shared-key", None))
        .await
        .unwrap();

    let changed_params = client
        .resubmit(resubmit(1, "run-1", "shared-key", Some(json!(null))))
        .await
        .unwrap_err();
    assert_eq!(rpc_code(changed_params), IDEMPOTENCY_REUSE);

    let cross_method = client
        .stop(stop(
            openengine_cluster_protocol::StopMode::Drain,
            1,
            "shared-key",
        ))
        .await
        .unwrap_err();
    assert_eq!(rpc_code(cross_method), IDEMPOTENCY_REUSE);
}

#[tokio::test]
async fn resubmit_idempotent_replay_returns_original_receipt_no_second_run() {
    let (client, store) = terminal_run().await;
    let before = store.inspect().await;

    let first = client
        .resubmit(resubmit(1, "run-1", "replay-key", None))
        .await
        .unwrap();
    assert!(!first.deduped);

    let replay = client
        .resubmit(resubmit(1, "run-1", "replay-key", None))
        .await
        .unwrap();
    assert!(replay.deduped);
    assert_eq!(replay.run_id, first.run_id);
    assert_eq!(replay.at_cursor, first.at_cursor);

    let after = store.inspect().await;
    assert_eq!(
        after.control_journal.len(),
        before.control_journal.len() + 1
    );
}

#[tokio::test]
async fn resubmit_allocates_new_run_id_and_cursor() {
    let (client, store) = terminal_run().await;
    let before = store.inspect().await;
    let prior_run_id = before.control.run_id.clone().unwrap();

    let result = client
        .resubmit(resubmit(1, "run-1", "new-run", None))
        .await
        .unwrap();

    assert_eq!(result.prior_run_id, prior_run_id);
    assert_ne!(result.run_id, prior_run_id);
    assert_ne!(Some(result.at_cursor.clone()), before.control.cursor);
    assert_eq!(store.inspect().await.control.run_id, Some(result.run_id));
}

#[tokio::test]
async fn resubmit_preserves_generation_and_admitted_graph() {
    let (client, store) = terminal_run().await;
    let before = store.inspect().await;

    let result = client
        .resubmit(resubmit(1, "run-1", "preserve", None))
        .await
        .unwrap();
    assert_eq!(result.generation, before.control.generation.unwrap());

    let after = store.inspect().await;
    assert_eq!(after.control.generation, before.control.generation);
    assert_eq!(after.control.spec, before.control.spec);
    assert_eq!(after.control.compiled_ir, before.control.compiled_ir);
}

#[tokio::test]
async fn resubmit_prior_run_history_remains_watchable_and_immutable() {
    let (client, store) = terminal_run().await;
    let before = store.inspect().await;
    let prior_run_id = before.control.run_id.clone().unwrap();

    let before_subscription = store
        .subscribe(
            SubscribeRequest {
                run_id: Some(prior_run_id.clone()),
                from_cursor: None,
            },
            16,
        )
        .await
        .expect("prior run is watchable before resubmit");
    let before_tail = before_subscription.replay_through;

    let result = client
        .resubmit(resubmit(1, "run-1", "watch-immutable", None))
        .await
        .unwrap();
    assert_ne!(result.run_id, prior_run_id);

    let after_subscription = store
        .subscribe(
            SubscribeRequest {
                run_id: Some(prior_run_id.clone()),
                from_cursor: None,
            },
            16,
        )
        .await
        .expect("prior run remains watchable after resubmit");
    assert_eq!(after_subscription.replay_through, before_tail);

    let after = store.inspect().await;
    let prior_receipt_before = before
        .control_journal
        .iter()
        .find(|receipt| receipt.run_id == prior_run_id)
        .cloned();
    let prior_receipt_after = after
        .control_journal
        .iter()
        .find(|receipt| receipt.run_id == prior_run_id)
        .cloned();
    assert_eq!(prior_receipt_before, prior_receipt_after);
    assert!(
        after
            .seed_ledger
            .iter()
            .any(|seed| seed.run_id == prior_run_id)
    );
}

#[tokio::test]
async fn resubmit_exact_seed_reuse_when_no_replacement_given() {
    let (client, store) = terminal_run().await;
    let result = client
        .resubmit(resubmit(1, "run-1", "exact-seed", None))
        .await
        .unwrap();

    let inspected = store.inspect().await;
    let new_seed = inspected
        .seed_ledger
        .iter()
        .rev()
        .find(|seed| seed.run_id == result.run_id)
        .expect("resubmit records a new verified seed");
    assert_eq!(new_seed.input, serde_json::Value::Null);
}

#[tokio::test]
async fn resubmit_accepts_a_schema_valid_explicit_replacement_input() {
    let (client, store) = terminal_run().await;
    let result = client
        .resubmit(resubmit(
            1,
            "run-1",
            "explicit-replacement",
            Some(json!(null)),
        ))
        .await
        .unwrap();

    let inspected = store.inspect().await;
    let new_seed = inspected
        .seed_ledger
        .iter()
        .rev()
        .find(|seed| seed.run_id == result.run_id)
        .expect("resubmit records a new verified seed");
    assert_eq!(new_seed.input, serde_json::Value::Null);
}
