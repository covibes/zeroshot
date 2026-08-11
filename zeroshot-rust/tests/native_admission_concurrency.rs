#[path = "support/native_process.rs"]
pub mod native_process;

use native_process::{assert_one_deduped, rpc_domain_code, spawn, TempState};
use openengine_cluster_protocol::{
    ApplyParams, Generation, GraphSpec, IdempotencyKey, GENERATION_CONFLICT, IDEMPOTENCY_REUSE,
};
use serde_json::{json, Value};

fn graph(name: &str) -> GraphSpec {
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

fn apply(name: &str, key: &str) -> ApplyParams {
    ApplyParams {
        graph: graph(name),
        input: Some(Value::Null),
        dry_run: false,
        if_generation: Some(Generation::new(0).unwrap()),
        idempotency_key: Some(IdempotencyKey::new(key).unwrap()),
    }
}

fn upsert(name: &str, key: &str) -> ApplyParams {
    ApplyParams {
        if_generation: None,
        ..apply(name, key)
    }
}

async fn assert_distinct_generation_race() {
    let distinct_state = TempState::new("concurrency-distinct");
    let (distinct_process, distinct_client) = spawn(distinct_state.path(), "distinct");
    distinct_client.initialize().await.unwrap();
    let (first, second) = tokio::join!(
        distinct_client.apply(apply("first", "key-first")),
        distinct_client.apply(apply("second", "key-second")),
    );
    let outcomes = [first, second];
    assert_eq!(outcomes.iter().filter(|outcome| outcome.is_ok()).count(), 1);
    assert_eq!(
        outcomes
            .iter()
            .filter_map(|outcome| outcome.as_ref().err())
            .filter(|error| rpc_domain_code(error) == Some(GENERATION_CONFLICT))
            .count(),
        1
    );
    drop(distinct_client);
    distinct_process.join_success().await;
}

async fn assert_identical_key_race() {
    let identical_state = TempState::new("concurrency-identical");
    let (identical_process, identical_client) = spawn(identical_state.path(), "identical");
    identical_client.initialize().await.unwrap();
    let request = apply("same", "same-key");
    let (first, second) = tokio::join!(
        identical_client.apply(request.clone()),
        identical_client.apply(request),
    );
    let first = first.unwrap();
    let second = second.unwrap();
    assert_one_deduped(&first, &second);
    drop(identical_client);
    identical_process.join_success().await;
}

async fn assert_conflicting_reuse_race() {
    let reuse_state = TempState::new("concurrency-reuse");
    let (reuse_process, reuse_client) = spawn(reuse_state.path(), "reuse");
    reuse_client.initialize().await.unwrap();
    let (first, second) = tokio::join!(
        reuse_client.apply(apply("left", "reused-key")),
        reuse_client.apply(apply("right", "reused-key")),
    );
    let outcomes = [first, second];
    assert_eq!(outcomes.iter().filter(|outcome| outcome.is_ok()).count(), 1);
    assert_eq!(
        outcomes
            .iter()
            .filter_map(|outcome| outcome.as_ref().err())
            .filter(|error| rpc_domain_code(error) == Some(IDEMPOTENCY_REUSE))
            .count(),
        1
    );
    drop(reuse_client);
    reuse_process.join_success().await;
}

async fn assert_omitted_generation_upsert_race() {
    let upsert_state = TempState::new("concurrency-upsert");
    let (upsert_process, upsert_client) = spawn(upsert_state.path(), "upsert");
    upsert_client.initialize().await.unwrap();
    let (first, second) = tokio::join!(
        upsert_client.apply(upsert("first", "upsert-first")),
        upsert_client.apply(upsert("second", "upsert-second")),
    );
    let mut generations = [
        first.unwrap().generation.unwrap().get(),
        second.unwrap().generation.unwrap().get(),
    ];
    generations.sort_unstable();
    assert_eq!(generations, [1, 2]);
    drop(upsert_client);
    upsert_process.join_success().await;
}

async fn assert_unchanged_distinct_key_race() {
    let unchanged_state = TempState::new("concurrency-unchanged");
    let (mut unchanged_process, unchanged_client) = spawn(unchanged_state.path(), "unchanged");
    unchanged_client.initialize().await.unwrap();
    let seeded = unchanged_client
        .apply(apply("same", "unchanged-seed"))
        .await
        .unwrap();
    let unchanged = |key: &str| ApplyParams {
        graph: graph("same"),
        input: None,
        dry_run: false,
        if_generation: Some(Generation::new(1).unwrap()),
        idempotency_key: Some(IdempotencyKey::new(key).unwrap()),
    };
    let (first, second) = tokio::join!(
        unchanged_client.apply(unchanged("unchanged-first")),
        unchanged_client.apply(unchanged("unchanged-second")),
    );
    for result in [first.unwrap(), second.unwrap()] {
        assert!(!result.deduped);
        assert_eq!(result.generation, seeded.generation);
        assert_eq!(result.run_id, seeded.run_id);
    }
    unchanged_process.kill().await;
    drop(unchanged_client);
    let _ = unchanged_process.join_failure().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn process_admission_races_have_exact_domain_outcomes() {
    assert_distinct_generation_race().await;
    assert_identical_key_race().await;
    assert_conflicting_reuse_race().await;
    assert_omitted_generation_upsert_race().await;
    assert_unchanged_distinct_key_race().await;
}
