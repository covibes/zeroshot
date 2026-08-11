#[path = "support/native_execution.rs"]
pub mod native_execution;
#[path = "support/native_process.rs"]
pub mod native_process;

use native_execution::{deterministic_graph, effect_count};
use native_process::{assert_one_deduped, rpc_domain_code, spawn, TempState};
use openengine_cluster_protocol::{
    ApplyParams, Generation, GetParams, GraphSpec, IdempotencyKey, Phase, PlanParams,
    TerminalResult, GENERATION_CONFLICT, GRAPH_INVALID,
};
use serde_json::{json, Value};

fn apply_request(graph: GraphSpec, key: &str) -> ApplyParams {
    ApplyParams {
        graph,
        input: Some(json!({ "value": 0 })),
        dry_run: false,
        if_generation: Some(Generation::new(0).unwrap()),
        idempotency_key: Some(IdempotencyKey::new(key).unwrap()),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn real_process_executes_settles_and_restarts_without_a_second_effect() {
    let state = TempState::new("single-execution");
    let graph = deterministic_graph();
    let request = apply_request(graph.clone(), "execute-once");
    let (process, client) = spawn(state.path(), "single-execution");
    client.initialize().await.unwrap();
    let plan = client
        .plan(PlanParams {
            graph: graph.clone(),
        })
        .await
        .unwrap();
    assert!(plan.ok, "{:#?}", plan.diagnostics);
    let applied = client.apply(request.clone()).await.unwrap();
    assert_eq!(applied.phase, Phase::Running);
    let before = client.get(GetParams::default()).await.unwrap();
    assert_eq!(before.status.phase, Phase::Finished);
    assert_eq!(
        before.terminal_result,
        Some(TerminalResult::Succeeded {
            output: json!({ "value": 42 })
        })
    );
    assert_eq!(effect_count(&state), 1);
    println!(
        "before restart terminal: {}; effects: {}",
        serde_json::to_string(&before).unwrap(),
        effect_count(&state)
    );

    drop(client);
    process.join_success().await;

    let (restart, restart_client) = spawn(state.path(), "single-execution");
    let initialized = restart_client.initialize().await.unwrap();
    assert_eq!(initialized.status.phase, Phase::Finished);
    let after = restart_client.get(GetParams::default()).await.unwrap();
    assert_eq!(after, before);
    assert_eq!(effect_count(&state), 1);
    let replayed = restart_client.apply(request).await.unwrap();
    assert!(replayed.deduped);
    assert_eq!(effect_count(&state), 1);
    println!(
        "after restart terminal: {}; effects: {}",
        serde_json::to_string(&after).unwrap(),
        effect_count(&state)
    );
    drop(restart_client);
    restart.join_success().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_identical_applies_share_one_dispatch_authority() {
    let state = TempState::new("single-execution-race");
    let request = apply_request(deterministic_graph(), "same-execution");
    let (process, client) = spawn(state.path(), "single-execution-race");
    client.initialize().await.unwrap();
    let (first, second) =
        tokio::join!(client.apply(request.clone()), client.apply(request.clone()),);
    let first = first.unwrap();
    let second = second.unwrap();
    assert_one_deduped(&first, &second);
    let result = client.get(GetParams::default()).await.unwrap();
    assert_eq!(result.status.phase, Phase::Finished);
    assert_eq!(effect_count(&state), 1);
    let replayed = client.apply(request).await.unwrap();
    assert!(replayed.deduped);
    assert_eq!(effect_count(&state), 1);
    drop(client);
    process.join_success().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_distinct_keys_for_one_graph_still_create_one_effect() {
    let state = TempState::new("single-execution-distinct-key-race");
    let graph = deterministic_graph();
    let first_request = apply_request(graph.clone(), "first-execution-key");
    let second_request = apply_request(graph, "second-execution-key");
    let (process, client) = spawn(state.path(), "single-execution-distinct-key-race");
    client.initialize().await.unwrap();
    let (first, second) = tokio::join!(client.apply(first_request), client.apply(second_request));
    let accepted = match (first, second) {
        (Ok(accepted), Err(rejected)) | (Err(rejected), Ok(accepted)) => {
            assert_eq!(rpc_domain_code(&rejected), Some(GENERATION_CONFLICT));
            accepted
        }
        outcomes => panic!("expected one apply and one generation conflict: {outcomes:?}"),
    };
    assert_eq!(accepted.generation, Generation::new(1).ok());
    assert_eq!(
        client.get(GetParams::default()).await.unwrap().status.phase,
        Phase::Finished
    );
    assert_eq!(effect_count(&state), 1);
    drop(client);
    process.join_success().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn two_clusters_sharing_one_state_root_have_distinct_effect_identities() {
    let state = TempState::new("shared-root-clusters");
    let graph = deterministic_graph();
    let (first_process, first_client) = spawn(state.path(), "shared-root-first");
    let (second_process, second_client) = spawn(state.path(), "shared-root-second");
    let (first_init, second_init) =
        tokio::join!(first_client.initialize(), second_client.initialize());
    first_init.unwrap();
    second_init.unwrap();
    let (first, second) = tokio::join!(
        first_client.apply(apply_request(graph.clone(), "shared-root-first-key")),
        second_client.apply(apply_request(graph, "shared-root-second-key")),
    );
    first.unwrap();
    second.unwrap();
    assert_eq!(effect_count(&state), 2);
    drop(first_client);
    drop(second_client);
    let ((), ()) = tokio::join!(first_process.join_success(), second_process.join_success());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn fixed_worker_is_rejected_outside_the_exact_topology_before_effect() {
    let state = TempState::new("single-execution-topology");
    let mut graph = serde_json::to_value(deterministic_graph()).unwrap();
    graph["root"]["children"][0]["attempts"] = json!(2);
    let graph: GraphSpec = serde_json::from_value(graph).unwrap();
    let (process, client) = spawn(state.path(), "single-execution-topology");
    client.initialize().await.unwrap();
    let plan = client
        .plan(PlanParams {
            graph: graph.clone(),
        })
        .await
        .unwrap();
    assert!(!plan.ok);
    let error = client
        .apply(apply_request(graph, "wrong-topology"))
        .await
        .unwrap_err();
    assert_eq!(rpc_domain_code(&error), Some(GRAPH_INVALID));
    assert_eq!(effect_count(&state), 0);
    assert_eq!(
        client.get(GetParams::default()).await.unwrap().status.phase,
        Phase::Empty
    );
    drop(client);
    process.join_success().await;
}

#[test]
fn deterministic_input_is_closed() {
    let graph = deterministic_graph();
    assert_eq!(
        graph.initial_input.validate_value(&json!({ "value": 0 })),
        Ok(())
    );
    assert!(
        graph
            .initial_input
            .validate_value(&Value::String("unexpected".to_owned()))
            .is_err()
    );
}
