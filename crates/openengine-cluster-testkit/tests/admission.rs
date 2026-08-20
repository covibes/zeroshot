use std::sync::Arc;

use openengine_cluster_client::{ClusterClient, InProcessTransport};
use openengine_cluster_protocol::{
    ApplyParams, Generation, GetParams, IdempotencyKey, PlanParams, CANCELLED, GENERATION_CONFLICT,
    IDEMPOTENCY_REUSE, INTERNAL_ERROR_CODE, SCHEMA_VIOLATION,
};
use openengine_cluster_server::admission::{AdmissionCoordinator, CancellationSignal};
use openengine_cluster_server::{ConnectionContext, Dispatcher};
use openengine_cluster_testkit::admission::{
    compiled_from_graph_fixture, graph_fixture, InMemoryAdmissionStore, ScriptedOutcome,
    ScriptedVerifier,
};
use serde_json::json;

#[path = "admission_support/mod.rs"]
mod admission_support;
use admission_support::{client, committed, rpc_code};

#[tokio::test]
async fn plan_is_pure_for_approve_and_reject() {
    let graph = graph_fixture("worker", json!({"kind":"null"}));
    let compiled = compiled_from_graph_fixture(&graph);
    let diagnostic = openengine_cluster_testkit::admission::diagnostic_fixture("rejected");
    let (client, verifier, store) = client(vec![
        ScriptedOutcome::approve(compiled, vec![]),
        ScriptedOutcome::reject(vec![diagnostic.clone()]),
    ]);

    let approved = client
        .plan(PlanParams {
            graph: graph.clone(),
        })
        .await
        .assert_value();
    assert!(approved.ok);
    assert!(approved.bounds.is_some());
    let rejected = client.plan(PlanParams { graph }).await.assert_value();
    assert!(!rejected.ok);
    assert_eq!(rejected.diagnostics, vec![diagnostic]);
    assert!(rejected.bounds.is_none());
    assert_eq!(verifier.call_count(), 2);
    assert!(store.inspect().await.is_empty());
}

#[tokio::test]
async fn dry_run_reports_sorted_diff_without_writes() {
    let graph = graph_fixture("zeta", json!({"kind":"null"}));
    let compiled = compiled_from_graph_fixture(&graph);
    let (client, _, store) = client(vec![ScriptedOutcome::approve(compiled, vec![])]);
    let result = client
        .apply(ApplyParams {
            graph,
            input: None,
            dry_run: true,
            if_generation: None,
            idempotency_key: None,
        })
        .await
        .assert_value();
    assert_eq!(result.generation, None);
    assert_eq!(
        result.diff.assert_value().added.assert_at(0).as_str(),
        "zeta"
    );
    assert!(store.inspect().await.is_empty());
}

#[tokio::test]
async fn dry_run_rejects_input_and_keys_before_verification() {
    let graph = graph_fixture("worker", json!({"kind":"null"}));
    let (client, verifier, store) = client(vec![]);
    for params in [
        ApplyParams {
            graph: graph.clone(),
            input: Some(json!(null)),
            dry_run: true,
            if_generation: None,
            idempotency_key: None,
        },
        ApplyParams {
            graph: graph.clone(),
            input: None,
            dry_run: true,
            if_generation: None,
            idempotency_key: Some(IdempotencyKey::new("forbidden").assert_value()),
        },
    ] {
        assert_eq!(
            rpc_code(client.apply(params).await.assert_error()),
            SCHEMA_VIOLATION
        );
    }
    assert_eq!(verifier.call_count(), 0);
    assert!(store.inspect().await.is_empty());
}

#[tokio::test]
async fn dry_run_change_and_noop_leave_committed_effects_byte_stable() {
    let original = graph_fixture("original", json!({"kind":"null"}));
    let changed = graph_fixture("changed", json!({"kind":"null"}));
    let original_ir = compiled_from_graph_fixture(&original);
    let changed_ir = compiled_from_graph_fixture(&changed);
    let (client, _, store) = client(vec![
        ScriptedOutcome::approve(original_ir.clone(), vec![]),
        ScriptedOutcome::approve(original_ir, vec![]),
        ScriptedOutcome::approve(changed_ir, vec![]),
    ]);
    client
        .apply(committed(original.clone(), json!(null), 0, "create"))
        .await
        .assert_value();
    let effects = store.inspect().await;

    let noop = client
        .apply(ApplyParams {
            graph: original,
            input: None,
            dry_run: true,
            if_generation: Some(Generation::new(1).assert_value()),
            idempotency_key: None,
        })
        .await
        .assert_value();
    assert!(noop.diff.assert_value().is_empty());
    let changed = client
        .apply(ApplyParams {
            graph: changed,
            input: None,
            dry_run: true,
            if_generation: Some(Generation::new(1).assert_value()),
            idempotency_key: None,
        })
        .await
        .assert_value();
    let diff = changed.diff.assert_value();
    assert_eq!(diff.added.assert_at(0).as_str(), "changed");
    assert_eq!(diff.removed.assert_at(0).as_str(), "original");
    assert_eq!(store.inspect().await, effects);
}

#[tokio::test]
async fn committed_lifecycle_creates_changes_and_deduplicates() {
    let first = graph_fixture("first", json!({"kind":"null"}));
    let second = graph_fixture("second", json!({"kind":"null"}));
    let first_ir = compiled_from_graph_fixture(&first);
    let second_ir = compiled_from_graph_fixture(&second);
    let (client, _, store) = client(vec![
        ScriptedOutcome::approve(first_ir.clone(), vec![]),
        ScriptedOutcome::approve(second_ir, vec![]),
        ScriptedOutcome::approve(first_ir, vec![]),
    ]);

    let create = client
        .apply(committed(first.clone(), json!(null), 0, "create"))
        .await
        .assert_value();
    assert_eq!(create.generation, Some(Generation::new(1).assert_value()));
    assert_eq!(create.run_id.as_ref().assert_value().as_str(), "run-1");

    let changed = client
        .apply(committed(second, json!(null), 1, "change"))
        .await
        .assert_value();
    assert_eq!(changed.generation, Some(Generation::new(2).assert_value()));
    assert_eq!(changed.run_id.as_ref().assert_value().as_str(), "run-2");

    let changed_back = client
        .apply(committed(first.clone(), json!(null), 2, "back"))
        .await
        .assert_value();
    let replay = client
        .apply(committed(first, json!(null), 2, "back"))
        .await
        .assert_value();
    assert!(replay.deduped);
    assert_eq!(replay.generation, changed_back.generation);
    assert_eq!(store.inspect().await.seed_ledger.len(), 3);
}

#[tokio::test]
async fn committed_lifecycle_unchanged_apply_preserves_run_and_rejects_input() {
    let graph = graph_fixture("worker", json!({"kind":"null"}));
    let compiled = compiled_from_graph_fixture(&graph);
    let (client, _, store) = client(vec![
        ScriptedOutcome::approve(compiled.clone(), vec![]),
        ScriptedOutcome::approve(compiled.clone(), vec![]),
        ScriptedOutcome::approve(compiled, vec![]),
    ]);
    let created = client
        .apply(committed(graph.clone(), json!(null), 0, "create"))
        .await
        .assert_value();
    let unchanged = client
        .apply(ApplyParams {
            graph: graph.clone(),
            input: None,
            dry_run: false,
            if_generation: Some(Generation::new(1).assert_value()),
            idempotency_key: Some(IdempotencyKey::new("noop").assert_value()),
        })
        .await
        .assert_value();
    assert_eq!(unchanged.generation, created.generation);
    assert_eq!(unchanged.run_id, created.run_id);
    let before_invalid = store.inspect().await;
    let error = client
        .apply(committed(graph, json!(null), 1, "invalid-resubmit"))
        .await
        .assert_error();
    assert_eq!(rpc_code(error), SCHEMA_VIOLATION);
    assert_eq!(store.inspect().await, before_invalid);
}

#[tokio::test]
async fn input_and_cas_failures_preserve_the_authoritative_snapshot() {
    let graph = graph_fixture(
        "worker",
        json!({
            "kind":"record",
            "fields":{"count":{"type":{"kind":"integer"},"required":true}}
        }),
    );
    let compiled = compiled_from_graph_fixture(&graph);
    let changed = graph_fixture("changed", json!({"kind":"null"}));
    let changed_ir = compiled_from_graph_fixture(&changed);
    let (client, _, store) = client(vec![
        ScriptedOutcome::approve(compiled.clone(), vec![]),
        ScriptedOutcome::approve(compiled.clone(), vec![]),
        ScriptedOutcome::approve(compiled, vec![]),
        ScriptedOutcome::approve(changed_ir, vec![]),
    ]);

    let invalid = client
        .apply(committed(graph.clone(), json!({"count":1.5}), 0, "bad"))
        .await
        .assert_error();
    assert_eq!(rpc_code(invalid), SCHEMA_VIOLATION);
    assert!(store.inspect().await.is_empty());

    let missing = client
        .apply(ApplyParams {
            graph: graph.clone(),
            input: None,
            dry_run: false,
            if_generation: Some(Generation::new(0).assert_value()),
            idempotency_key: Some(IdempotencyKey::new("missing").assert_value()),
        })
        .await
        .assert_error();
    assert_eq!(rpc_code(missing), SCHEMA_VIOLATION);
    assert!(store.inspect().await.is_empty());

    client
        .apply(committed(graph, json!({"count":1}), 0, "create"))
        .await
        .assert_value();
    let before_conflict = store.inspect().await;
    let conflict = client
        .apply(committed(changed, json!(null), 0, "stale"))
        .await
        .assert_error();
    assert_eq!(rpc_code(conflict), GENERATION_CONFLICT);
    assert_eq!(store.inspect().await, before_conflict);
    let snapshot = client.get(GetParams::default()).await.assert_value();
    assert_eq!(snapshot.status.observed_generation.assert_value().get(), 1);
    assert_eq!(snapshot.at_cursor, before_conflict.control.cursor);
}

#[tokio::test]
async fn idempotency_and_cancellation_replay_preserves_atomic_append_order() {
    let graph = graph_fixture("worker", json!({"kind":"integer"}));
    let compiled = compiled_from_graph_fixture(&graph);
    let (client, verifier, store) = client(vec![ScriptedOutcome::approve(compiled, vec![])]);
    let original = committed(graph.clone(), json!(1), 0, "stable-key");
    let receipt = client.apply(original.clone()).await.assert_value();
    let effects = store.inspect().await;
    let append_kinds: Vec<_> = effects
        .append_order
        .iter()
        .map(|receipt| &receipt.kind)
        .collect();
    assert_eq!(
        append_kinds,
        [
            &openengine_cluster_testkit::admission::AppendKind::Control,
            &openengine_cluster_testkit::admission::AppendKind::VerifiedSeed,
            &openengine_cluster_testkit::admission::AppendKind::Idempotency,
        ]
    );
    assert_eq!(
        effects
            .append_order
            .iter()
            .map(|receipt| receipt.sequence)
            .collect::<Vec<_>>(),
        [1, 2, 3]
    );

    let conflict = client
        .apply(committed(graph.clone(), json!(2), 0, "stable-key"))
        .await
        .assert_error();
    assert_eq!(rpc_code(conflict), IDEMPOTENCY_REUSE);
    assert_eq!(
        verifier.call_count(),
        1,
        "conflicting reuse must skip verification"
    );
    assert_eq!(store.inspect().await, effects);

    let replay = client.apply(original).await.assert_value();
    assert!(replay.deduped);
    assert_eq!(replay.generation, receipt.generation);
    assert_eq!(replay.run_id, receipt.run_id);
}

#[tokio::test]
async fn idempotency_null_input_and_omitted_input_are_conflicting_requests() {
    let graph = graph_fixture("worker", json!({"kind":"null"}));
    let compiled = compiled_from_graph_fixture(&graph);
    let (client, verifier, store) = client(vec![ScriptedOutcome::approve(compiled, vec![])]);
    client
        .apply(committed(
            graph.clone(),
            json!(null),
            0,
            "presence-sensitive",
        ))
        .await
        .assert_value();
    let committed_effects = store.inspect().await;

    let error = client
        .apply(ApplyParams {
            graph,
            input: None,
            dry_run: false,
            if_generation: Some(Generation::new(0).assert_value()),
            idempotency_key: Some(IdempotencyKey::new("presence-sensitive").assert_value()),
        })
        .await
        .assert_error();

    assert_eq!(rpc_code(error), IDEMPOTENCY_REUSE);
    assert_eq!(
        verifier.call_count(),
        1,
        "conflicting reuse must not verify"
    );
    assert_eq!(store.inspect().await, committed_effects);
}

#[tokio::test]
async fn internal_verifier_failure_is_redacted_from_the_wire() {
    const SENTINEL: &str = "credential=fixture-secret-unverified-output";
    let graph = graph_fixture("worker", json!({"kind":"null"}));
    let (client, _, store) = client(vec![ScriptedOutcome::fail(SENTINEL)]);

    let error = client
        .apply(committed(graph, json!(null), 0, "internal-failure"))
        .await
        .assert_error();
    let rendered = format!("{error:?}");
    match error {
        openengine_cluster_client::ClientError::Rpc(error) => {
            assert_eq!(error.data.assert_value().code, INTERNAL_ERROR_CODE);
        }
        other => assert!(
            matches!(other, openengine_cluster_client::ClientError::Rpc(_)),
            "expected RPC error"
        ),
    }
    assert!(
        !rendered.contains(SENTINEL),
        "internal verifier text escaped in {rendered}"
    );
    assert!(store.inspect().await.is_empty());
}

#[tokio::test]
async fn idempotency_and_cancellation_before_create_has_zero_effects() {
    let graph = graph_fixture("worker", json!({"kind":"integer"}));
    let barrier = openengine_cluster_testkit::admission::VerifierBarrier::default();
    let verifier = Arc::new(ScriptedVerifier::new(vec![ScriptedOutcome::park(
        barrier.clone(),
        ScriptedOutcome::approve(compiled_from_graph_fixture(&graph), vec![]),
    )]));
    let cancelled_store = Arc::new(InMemoryAdmissionStore::default());
    let backend =
        AdmissionCoordinator::from_shared(Arc::clone(&verifier), Arc::clone(&cancelled_store));
    let cancellation = CancellationSignal::default();
    let dispatcher = Dispatcher::new(
        backend,
        ConnectionContext::new(
            ConnectionContext::default().identity().clone(),
            cancellation.clone(),
        ),
    );
    let cancelled_client = Arc::new(ClusterClient::new(InProcessTransport::new(dispatcher)));
    let task_client = Arc::clone(&cancelled_client);
    let task_graph = graph.clone();
    let task = tokio::spawn(async move {
        task_client
            .apply(committed(task_graph, json!(1), 0, "cancelled"))
            .await
    });
    barrier.wait_until_entered().await;
    cancellation.cancel();
    barrier.release();
    assert_eq!(
        rpc_code(task.await.assert_value().assert_error()),
        CANCELLED
    );
    assert!(cancelled_store.inspect().await.is_empty());
}

#[tokio::test]
async fn idempotency_and_cancellation_restores_existing_run_and_replays_after_commit() {
    let graph = graph_fixture("worker", json!({"kind":"integer"}));
    let compiled = compiled_from_graph_fixture(&graph);
    let (client, _, store) = client(vec![ScriptedOutcome::approve(compiled, vec![])]);
    client
        .apply(committed(graph.clone(), json!(1), 0, "stable-key"))
        .await
        .assert_value();
    let effects = store.inspect().await;
    let changed = graph_fixture("changed", json!({"kind":"null"}));
    let barrier = openengine_cluster_testkit::admission::VerifierBarrier::default();
    let verifier = Arc::new(ScriptedVerifier::new(vec![ScriptedOutcome::park(
        barrier.clone(),
        ScriptedOutcome::approve(compiled_from_graph_fixture(&changed), vec![]),
    )]));
    let backend = AdmissionCoordinator::from_shared(verifier, Arc::clone(&store));
    let cancellation = CancellationSignal::default();
    let update_client = Arc::new(ClusterClient::new(InProcessTransport::new(
        Dispatcher::new(
            backend,
            ConnectionContext::new(
                ConnectionContext::default().identity().clone(),
                cancellation.clone(),
            ),
        ),
    )));
    let update_task_client = Arc::clone(&update_client);
    let update = tokio::spawn(async move {
        update_task_client
            .apply(committed(changed, json!(null), 1, "cancel-update"))
            .await
    });
    barrier.wait_until_entered().await;
    cancellation.cancel();
    barrier.release();
    assert_eq!(
        rpc_code(update.await.assert_value().assert_error()),
        CANCELLED
    );
    assert_eq!(store.inspect().await, effects);

    let replay_backend = AdmissionCoordinator::from_shared(
        Arc::new(ScriptedVerifier::new(vec![])),
        Arc::clone(&store),
    );
    let already_cancelled = CancellationSignal::default();
    already_cancelled.cancel();
    let replay_client = ClusterClient::new(InProcessTransport::new(Dispatcher::new(
        replay_backend,
        ConnectionContext::new(
            ConnectionContext::default().identity().clone(),
            already_cancelled,
        ),
    )));
    let recovered = replay_client
        .apply(committed(graph, json!(1), 0, "stable-key"))
        .await
        .assert_value();
    assert!(
        recovered.deduped,
        "post-commit cancellation must replay receipt"
    );
}

use openengine_cluster_testkit::assertions::{AssertAt, AssertError, AssertValue};
