#[path = "support/native_process.rs"]
mod native_process;

use std::sync::Arc;

use native_process::{spawn, NativeClient, TempState};
use openengine_cluster_client::{ClientError, ClusterClient};
use openengine_cluster_protocol::{
    canonical_value_bytes, ApplyParams, Generation, GetParams, GetResult, GraphSpec,
    IdempotencyKey, PlanParams, Phase, GENERATION_CONFLICT, GRAPH_INVALID, IDEMPOTENCY_REUSE,
};
use serde_json::{json, Value};
use tokio::time::{sleep, Duration};
use zeroshot_engine::cluster_ledger::record::CanonicalDigest;
use zeroshot_engine::cluster_ledger::replay::replay;
use zeroshot_engine::cluster_ledger::store::sqlite::{database_path, SqliteLedgerStore};
use zeroshot_engine::cluster_ledger::store::LedgerStore;
use zeroshot_engine::cluster_ledger::ResourceId;
use zeroshot_engine::NATIVE_FENCE_TTL_MS;

fn succeed_graph(name: &str) -> GraphSpec {
    serde_json::from_value(json!({
        "profile": "openengine.graph.full/v1",
        "initialInput": {"kind": "null"},
        "policy": {"policy": "policy.default@1", "default": "deny"},
        "root": {
            "kind": "succeed",
            "name": name,
            "output": {"kind": "null"},
            "bindings": []
        }
    }))
    .unwrap()
}

fn unresolved_worker_graph() -> GraphSpec {
    serde_json::from_value(json!({
        "profile": "openengine.graph.full/v1",
        "initialInput": {"kind": "null"},
        "policy": {"policy": "policy.default@1", "default": "deny"},
        "root": {
            "kind": "step",
            "name": "worker",
            "worker": "worker.unavailable@1",
            "input": {"kind": "null"},
            "output": {"kind": "null"},
            "inputBindings": [],
            "writeBindings": [],
            "timeoutMs": 1,
            "attempts": 1
        }
    }))
    .unwrap()
}

fn committed_apply(graph: GraphSpec, key: &str, generation: u64) -> ApplyParams {
    ApplyParams {
        graph,
        input: Some(Value::Null),
        dry_run: false,
        if_generation: Some(Generation::new(generation).unwrap()),
        idempotency_key: Some(IdempotencyKey::new(key).unwrap()),
    }
}

fn rpc_domain_code(error: &ClientError) -> Option<&str> {
    let ClientError::Rpc(error) = error else {
        return None;
    };
    error.data.as_ref().map(|data| data.code.as_str())
}

async fn assert_empty_initialize<T>(client: &ClusterClient<T>)
where
    T: openengine_cluster_client::JsonRpcTransport,
{
    let initialized = client.initialize().await.unwrap();
    assert!(initialized.capabilities.graph_profiles.values().is_empty());
    assert!(!initialized.capabilities.logs);
    assert!(!initialized.capabilities.agent_attach);
    assert_eq!(initialized.status.phase, Phase::Empty);
}

async fn assert_precommit_behavior(client: &NativeClient, graph: &GraphSpec) {
    let plan = client
        .plan(PlanParams {
            graph: graph.clone(),
        })
        .await
        .unwrap();
    assert!(plan.ok);
    let dry_run = client
        .apply(ApplyParams {
            graph: graph.clone(),
            input: None,
            dry_run: true,
            if_generation: Some(Generation::new(0).unwrap()),
            idempotency_key: None,
        })
        .await
        .unwrap();
    assert_eq!(dry_run.generation, None);

    let invalid = unresolved_worker_graph();
    assert!(
        !client
            .plan(PlanParams {
                graph: invalid.clone(),
            })
            .await
            .unwrap()
            .ok
    );
    let invalid_error = client
        .apply(committed_apply(invalid, "invalid-apply", 0))
        .await
        .unwrap_err();
    assert_eq!(rpc_domain_code(&invalid_error), Some(GRAPH_INVALID));
    assert_eq!(
        client.get(GetParams::default()).await.unwrap().status.phase,
        Phase::Empty
    );
}

async fn commit_and_read(client: &NativeClient, graph: &GraphSpec) -> (ApplyParams, GetResult) {
    let request = committed_apply(graph.clone(), "apply-1", 0);
    let applied = client.apply(request.clone()).await.unwrap();
    assert_eq!(applied.generation.map(Generation::get), Some(1));
    assert_eq!(applied.phase, Phase::Running);
    assert!(!applied.deduped);
    assert_eq!(
        client.get(GetParams::default()).await.unwrap().status.phase,
        Phase::Running
    );
    let replayed = client.apply(request.clone()).await.unwrap();
    assert!(replayed.deduped);
    assert_eq!(replayed.generation, applied.generation);
    assert_eq!(replayed.run_id, applied.run_id);

    let reuse_error = client
        .apply(committed_apply(succeed_graph("different"), "apply-1", 0))
        .await
        .unwrap_err();
    assert_eq!(rpc_domain_code(&reuse_error), Some(IDEMPOTENCY_REUSE));
    let stale_error = client
        .apply(committed_apply(succeed_graph("next"), "apply-stale", 0))
        .await
        .unwrap_err();
    assert_eq!(rpc_domain_code(&stale_error), Some(GENERATION_CONFLICT));

    let before = client.get(GetParams::default()).await.unwrap();
    assert_eq!(before.spec, Some(graph.clone()));
    assert!(before.at_cursor.is_some());
    println!(
        "before restart: {}",
        serde_json::to_string(&before).unwrap()
    );
    (request, before)
}

async fn assert_persisted_admission_facts(state: &TempState, graph: &GraphSpec) {
    let resource = ResourceId::new("cluster-a").unwrap();
    let store: Arc<dyn LedgerStore> = Arc::new(SqliteLedgerStore::new(state.path()).unwrap());
    let snapshot = store.read_prefix(&resource, None).await.unwrap();
    let replayed_state = replay(&snapshot, &resource).unwrap();
    let admitted = replayed_state.admission.unwrap();
    let canonical_policy =
        canonical_value_bytes(&serde_json::to_value(&graph.policy).unwrap()).unwrap();
    assert_eq!(
        admitted.policy_digest,
        CanonicalDigest::of(&canonical_policy)
    );
    assert_eq!(
        admitted.catalog_digest,
        CanonicalDigest::of(b"{\"version\":1,\"workers\":[]}")
    );
    assert_eq!(
        admitted.profile_digest,
        CanonicalDigest::of(b"{\"descriptors\":[]}")
    );
    assert_ne!(admitted.absolute_deadline_ms, u64::MAX);
    assert_eq!(replayed_state.mutation_receipts.len(), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn real_binary_client_sqlite_and_restart_preserve_durable_admission() {
    let state = TempState::new("admission-restart");
    let graph = succeed_graph("done");
    let (process, client) = spawn(state.path(), "cluster-a");

    assert_empty_initialize(&client).await;
    sleep(Duration::from_millis(NATIVE_FENCE_TTL_MS * 2 + 500)).await;
    assert_eq!(
        client.get(GetParams::default()).await.unwrap().status.phase,
        Phase::Empty
    );

    assert_precommit_behavior(&client, &graph).await;
    let (request, before) = commit_and_read(&client, &graph).await;

    let (overlap, overlap_client) = spawn(state.path(), "cluster-a");
    assert!(overlap_client.initialize().await.is_err());
    drop(overlap_client);
    let overlap_diagnostics = overlap.join_failure().await;
    assert!(overlap_diagnostics.to_ascii_lowercase().contains("fence"));

    drop(client);
    process.join_success().await;

    let (restart, restart_client) = spawn(state.path(), "cluster-a");
    let initialized = restart_client.initialize().await.unwrap();
    assert!(initialized.capabilities.graph_profiles.values().is_empty());
    assert_eq!(initialized.status.phase, Phase::Running);
    let after = restart_client.get(GetParams::default()).await.unwrap();
    println!("after restart: {}", serde_json::to_string(&after).unwrap());
    assert_eq!(after, before);
    let restarted_replay = restart_client.apply(request).await.unwrap();
    assert!(restarted_replay.deduped);
    drop(restart_client);
    restart.join_success().await;

    assert_persisted_admission_facts(&state, &graph).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn crash_takeover_waits_for_ttl_but_clean_shutdown_does_not() {
    let state = TempState::new("admission-crash");
    let graph = succeed_graph("crash-preserved");
    let request = committed_apply(graph, "crash-apply", 0);
    let (mut crashed, client) = spawn(state.path(), "cluster-crash");
    assert_empty_initialize(&client).await;
    let applied = client.apply(request.clone()).await.unwrap();
    let before = client.get(GetParams::default()).await.unwrap();
    crashed.kill().await;
    drop(client);
    let _ = crashed.join_failure().await;

    let (early, early_client) = spawn(state.path(), "cluster-crash");
    assert!(early_client.initialize().await.is_err());
    drop(early_client);
    assert!(
        early
            .join_failure()
            .await
            .to_ascii_lowercase()
            .contains("fence")
    );

    sleep(Duration::from_millis(NATIVE_FENCE_TTL_MS + 500)).await;
    let (recovered, recovered_client) = spawn(state.path(), "cluster-crash");
    let initialized = recovered_client.initialize().await.unwrap();
    assert_eq!(initialized.status.phase, Phase::Running);
    assert_eq!(
        recovered_client.get(GetParams::default()).await.unwrap(),
        before
    );
    let replayed = recovered_client.apply(request).await.unwrap();
    assert!(replayed.deduped);
    assert_eq!(replayed.generation, applied.generation);
    assert_eq!(replayed.run_id, applied.run_id);
    drop(recovered_client);
    recovered.join_success().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn corrupt_history_and_renewal_loss_end_the_process_before_further_service() {
    let corrupt_state = TempState::new("admission-corrupt");
    let graph = succeed_graph("done");
    let (seed, seed_client) = spawn(corrupt_state.path(), "cluster-corrupt");
    assert_empty_initialize(&seed_client).await;
    seed_client
        .apply(committed_apply(graph, "seed", 0))
        .await
        .unwrap();
    drop(seed_client);
    seed.join_success().await;

    let corrupt_resource = ResourceId::new("cluster-corrupt").unwrap();
    let connection =
        rusqlite::Connection::open(database_path(corrupt_state.path(), &corrupt_resource)).unwrap();
    connection
        .execute(
            "UPDATE records SET record_hash = zeroblob(32) WHERE sequence = 1",
            [],
        )
        .unwrap();
    drop(connection);
    let (corrupt, corrupt_client) = spawn(corrupt_state.path(), "cluster-corrupt");
    assert!(corrupt_client.initialize().await.is_err());
    drop(corrupt_client);
    assert!(corrupt.join_failure().await.contains("ledger"));

    let lease_state = TempState::new("admission-lease-loss");
    let (lost, lost_client) = spawn(lease_state.path(), "cluster-lease");
    assert_empty_initialize(&lost_client).await;
    sleep(Duration::from_millis(1_100)).await;
    assert_eq!(
        lost_client
            .get(GetParams::default())
            .await
            .unwrap()
            .status
            .phase,
        Phase::Empty
    );
    let lease_resource = ResourceId::new("cluster-lease").unwrap();
    let connection =
        rusqlite::Connection::open(database_path(lease_state.path(), &lease_resource)).unwrap();
    connection
        .execute(
            "UPDATE fence SET owner_id = 'forced-owner', epoch = epoch + 1 WHERE singleton = 1",
            [],
        )
        .unwrap();
    drop(connection);
    let diagnostics = lost.join_failure().await;
    assert!(diagnostics.contains("lease failed"));
    assert!(lost_client.get(GetParams::default()).await.is_err());
}
