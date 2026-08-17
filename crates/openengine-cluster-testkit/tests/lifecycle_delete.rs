use openengine_cluster_protocol::{
    DeleteParams, DeleteResult, Phase, StopMode, GENERATION_CONFLICT, INVALID_PHASE, RUN_CONFLICT,
};
use openengine_cluster_server::admission::ControlSnapshot;
use openengine_cluster_server::watch::{ObservationStore, SubscribeRequest};
use openengine_cluster_testkit::admission::{
    compiled_from_graph_fixture, graph_fixture, ScriptedOutcome,
};
use openengine_cluster_testkit::lifecycle::{delete, stop};
use serde_json::json;

#[path = "admission_support/mod.rs"]
mod admission_support;
#[path = "lifecycle_support/mod.rs"]
mod lifecycle_support;
#[path = "mutation_fixture/mod.rs"]
mod mutation_fixture;
use admission_support::{client, committed, rpc_code};
use lifecycle_support::running;
use mutation_fixture::terminal_run;

#[test]
fn delete_wire_types_expose_no_provider_or_config_field_names() {
    let params_schema = serde_json::to_value(schemars::schema_for!(DeleteParams)).assert_value();
    let result_schema = serde_json::to_value(schemars::schema_for!(DeleteResult)).assert_value();
    for forbidden in [
        "provider",
        "config",
        "source",
        "turnId",
        "session",
        "workspacePath",
    ] {
        assert!(
            !params_schema
                .assert_key("properties")
                .as_object()
                .assert_value()
                .contains_key(forbidden)
        );
        assert!(
            !result_schema
                .assert_key("properties")
                .as_object()
                .assert_value()
                .contains_key(forbidden)
        );
    }
}

#[tokio::test]
async fn delete_before_terminal_is_denied_invalid_phase() {
    let (client, _store) = running().await;
    let error = client
        .delete(delete(1, Some("run-1"), "not-terminal"))
        .await
        .assert_error();
    assert_eq!(rpc_code(error), INVALID_PHASE);
}

#[tokio::test]
async fn delete_stale_generation_is_denied_generation_conflict() {
    let (client, _store) = terminal_run().await;
    let error = client
        .delete(delete(2, Some("run-1"), "stale-generation"))
        .await
        .assert_error();
    assert_eq!(rpc_code(error), GENERATION_CONFLICT);
}

#[tokio::test]
async fn delete_stale_run_is_denied_run_conflict() {
    let (client, _store) = terminal_run().await;
    let error = client
        .delete(delete(1, Some("run-99"), "stale-run"))
        .await
        .assert_error();
    assert_eq!(rpc_code(error), RUN_CONFLICT);
}

#[tokio::test]
async fn delete_on_fresh_empty_cluster_returns_deleted_false_phase_empty() {
    let (client, _verifier, store) = client(vec![]);

    let result = client
        .delete(delete(0, None, "empty-noop"))
        .await
        .assert_value();
    assert!(!result.deleted);
    assert_eq!(result.phase, Phase::Empty);
    assert!(!result.deduped);
    assert_eq!(store.inspect().await.control, ControlSnapshot::default());
}

#[tokio::test]
async fn delete_repeated_idempotency_key_replays_receipt() {
    let (client, store) = terminal_run().await;
    let before = store.inspect().await;

    let first = client
        .delete(delete(1, Some("run-1"), "replay-key"))
        .await
        .assert_value();
    assert!(first.deleted);
    assert!(!first.deduped);

    let replay = client
        .delete(delete(1, Some("run-1"), "replay-key"))
        .await
        .assert_value();
    assert!(replay.deduped);
    assert_eq!(replay.deleted, first.deleted);
    assert_eq!(replay.phase, first.phase);

    let after = store.inspect().await;
    assert_eq!(
        after.idempotency_records.len(),
        before.idempotency_records.len() + 1
    );
}

#[tokio::test]
async fn delete_finalizes_history_and_next_apply_starts_generation_one() {
    let graph = graph_fixture("worker", json!({"kind":"null"}));
    let compiled = compiled_from_graph_fixture(&graph);
    let outcomes = vec![
        ScriptedOutcome::approve(compiled.clone(), vec![]),
        ScriptedOutcome::approve(compiled, vec![]),
    ];
    let (client, _verifier, store) = client(outcomes);
    client
        .apply(committed(graph.clone(), json!(null), 0, "create"))
        .await
        .assert_value();
    client
        .stop(stop(StopMode::Force, 1, "finish"))
        .await
        .assert_value();

    let result = client
        .delete(delete(1, Some("run-1"), "finalize"))
        .await
        .assert_value();
    assert!(result.deleted);
    assert_eq!(result.phase, Phase::Empty);
    assert!(result.generation.is_none());
    assert!(result.run_id.is_none());
    assert!(result.at_cursor.is_none());

    let after_delete = store.inspect().await;
    assert_eq!(after_delete.control, ControlSnapshot::default());
    assert_eq!(
        after_delete.lifecycle,
        openengine_cluster_server::lifecycle::LifecycleSnapshot::default()
    );

    let reapplied = client
        .apply(committed(graph, json!(null), 0, "recreate"))
        .await
        .assert_value();
    assert_eq!(reapplied.generation.assert_value().get(), 1);
    assert_ne!(
        reapplied.run_id,
        Some(openengine_cluster_protocol::RunId::new("run-1"))
    );
}

#[tokio::test]
async fn delete_pending_cleanup_holds_fence_preserves_history_and_rejects_competing_key() {
    let (client, store) = terminal_run().await;
    store.arm_pending_cleanup().await;
    let before = store.inspect().await;

    let result = client
        .delete(delete(1, Some("run-1"), "hold-fence"))
        .await
        .assert_value();
    assert!(!result.deleted);
    assert_eq!(result.phase, Phase::Deleting);
    assert!(!result.deduped);

    let after = store.inspect().await;
    let expected_control = ControlSnapshot {
        phase: Phase::Deleting,
        ..before.control.clone()
    };
    assert_eq!(after.control, expected_control);
    assert_eq!(after.lifecycle, before.lifecycle);
    assert_eq!(after.seed_ledger, before.seed_ledger);

    let competing = client
        .delete(delete(1, Some("run-1"), "competing-key"))
        .await
        .assert_error();
    assert_eq!(rpc_code(competing), INVALID_PHASE);

    let resolved = store.resolve_pending_deletion().await;
    assert!(resolved.deleted);
    assert_eq!(resolved.phase, Phase::Empty);
    assert_eq!(store.inspect().await.control, ControlSnapshot::default());
}

#[tokio::test]
async fn delete_after_removal_get_is_empty_and_watch_returns_gone() {
    let (client, store) = terminal_run().await;
    let before = store.inspect().await;
    let prior_run_id = before.control.run_id.clone().assert_value();

    let result = client
        .delete(delete(1, Some("run-1"), "remove"))
        .await
        .assert_value();
    assert!(result.deleted);

    let status = client.get(Default::default()).await.assert_value();
    assert_eq!(status.status.phase, Phase::Empty);
    assert!(status.status.current_run_id.is_none());
    assert!(status.status.observed_generation.is_none());
    assert!(status.spec.is_none());

    let subscribe_result = store
        .subscribe(
            SubscribeRequest {
                run_id: Some(prior_run_id),
                from_cursor: None,
            },
            16,
        )
        .await;
    assert!(matches!(
        subscribe_result,
        Err(openengine_cluster_server::admission::StoreError::RunGone { .. })
    ));

    let repeated = client
        .delete(delete(0, None, "repeated-after-removal"))
        .await
        .assert_value();
    assert!(!repeated.deleted);
    assert_eq!(repeated.phase, Phase::Empty);
}

use openengine_cluster_testkit::assertions::{AssertError, AssertValue};

use openengine_cluster_testkit::assertions::JsonAt;
