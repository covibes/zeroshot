#[path = "support/native_execution.rs"]
pub mod native_execution;
#[path = "support/native_process.rs"]
pub mod native_process;
#[path = "support/native_recovery.rs"]
pub mod native_recovery;

use native_execution::{deterministic_graph, effect_count};
use native_process::{spawn, TempState};
use native_recovery::{descriptor, seed_admission, seed_dispatch, SeedAdmission};
use serde_json::json;
use zeroshot_engine::cluster_ledger::record::CanonicalDigest;
use zeroshot_engine::cluster_ledger::store::IdempotencyId;
use zeroshot_engine::cluster_ledger::LedgerErrorKind;

async fn assert_startup_fails_without_effect(state: &TempState, cluster: &str) {
    let (process, client) = spawn(state.path(), cluster);
    assert!(client.initialize().await.is_err());
    drop(client);
    let diagnostics = process.join_failure().await;
    assert!(
        diagnostics.contains("execution state is invalid"),
        "unexpected native diagnostics: {diagnostics}"
    );
    assert_eq!(effect_count(state), 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn corrupt_compiled_reconstruction_refuses_startup() {
    let state = TempState::new("compiled-corruption");
    let ledger = seed_admission(
        &state,
        "compiled-corruption",
        SeedAdmission {
            graph: deterministic_graph(),
            input: json!({ "value": 0 }),
            descriptor: Some(descriptor()),
            corrupt_compiled_ir: true,
        },
    )
    .await;
    ledger.release_fence().await.unwrap();

    assert_startup_fails_without_effect(&state, "compiled-corruption").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn malformed_verified_output_refuses_recovery() {
    let state = TempState::new("output-corruption");
    let ledger = seed_admission(
        &state,
        "output-corruption",
        SeedAdmission {
            graph: deterministic_graph(),
            input: json!({ "value": 0 }),
            descriptor: Some(descriptor()),
            corrupt_compiled_ir: false,
        },
    )
    .await;
    let dispatch = seed_dispatch(&ledger).await;
    let bytes = b"{}".to_vec();
    let digest = CanonicalDigest::of(&bytes);
    ledger
        .settle(
            IdempotencyId::new("corrupt-output-settlement").unwrap(),
            digest.as_bytes(),
            dispatch.execution,
            digest,
            Some(bytes),
        )
        .await
        .unwrap();
    ledger.release_fence().await.unwrap();

    assert_startup_fails_without_effect(&state, "output-corruption").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn settlement_without_verified_output_refuses_recovery() {
    let state = TempState::new("settlement-corruption");
    let ledger = seed_admission(
        &state,
        "settlement-corruption",
        SeedAdmission {
            graph: deterministic_graph(),
            input: json!({ "value": 0 }),
            descriptor: Some(descriptor()),
            corrupt_compiled_ir: false,
        },
    )
    .await;
    let dispatch = seed_dispatch(&ledger).await;
    let digest = CanonicalDigest::of(b"missing-output");
    let error = ledger
        .settle(
            IdempotencyId::new("missing-output-settlement").unwrap(),
            digest.as_bytes(),
            dispatch.execution,
            digest,
            None,
        )
        .await
        .unwrap_err();
    assert_eq!(error.kind(), &LedgerErrorKind::Encoding);
    ledger.release_fence().await.unwrap();

    assert_startup_fails_without_effect(&state, "settlement-corruption").await;
}
