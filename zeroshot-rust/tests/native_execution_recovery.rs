#[path = "support/native_execution.rs"]
pub mod native_execution;
#[path = "support/native_process.rs"]
pub mod native_process;
#[path = "support/native_recovery.rs"]
pub mod native_recovery;

use native_execution::{deterministic_graph, effect_count};
use native_process::{spawn, TempState};
use native_recovery::{
    descriptor, predecessor_graph, reduce, seed_admission, seed_dispatch, SeedAdmission,
};
use openengine_cluster_protocol::{
    canonical_value_bytes, GetParams, Phase, TerminalResult, WorkerOutcome,
};
use serde_json::{json, Value};
use zeroshot_engine::cluster_ledger::record::CanonicalDigest;
use zeroshot_engine::cluster_ledger::store::IdempotencyId;
use zeroshot_engine::cluster_ledger::LedgerErrorKind;
use zeroshot_engine::full_v1_reducer::Decision;

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn settled_prefix_terminalizes_after_renewal_without_execution() {
    let state = TempState::new("settled-recovery");
    let ledger = seed_admission(
        &state,
        "settled-recovery",
        SeedAdmission {
            graph: deterministic_graph(),
            input: json!({ "value": 0 }),
            descriptor: Some(descriptor()),
            corrupt_compiled_ir: false,
        },
    )
    .await;
    let dispatch = seed_dispatch(&ledger).await;
    let outcome = WorkerOutcome::Verified {
        output: json!({ "value": 42 }),
        artifacts: Vec::new(),
    };
    let bytes = canonical_value_bytes(&serde_json::to_value(outcome).unwrap()).unwrap();
    let digest = CanonicalDigest::of(&bytes);
    ledger
        .settle(
            IdempotencyId::new("seed-settlement").unwrap(),
            digest.as_bytes(),
            dispatch.execution,
            digest,
            Some(bytes),
        )
        .await
        .unwrap();
    ledger.release_fence().await.unwrap();

    let (process, client) = spawn(state.path(), "settled-recovery");
    let initialized = client.initialize().await.unwrap();
    assert_eq!(initialized.status.phase, Phase::Finished);
    let result = client.get(GetParams::default()).await.unwrap();
    assert_eq!(
        result.terminal_result,
        Some(TerminalResult::Succeeded {
            output: json!({ "value": 42 })
        })
    );
    assert_eq!(effect_count(&state), 0);
    drop(client);
    process.join_success().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn active_dispatch_refuses_startup_and_never_redispatches() {
    let state = TempState::new("active-recovery");
    let ledger = seed_admission(
        &state,
        "active-recovery",
        SeedAdmission {
            graph: deterministic_graph(),
            input: json!({ "value": 0 }),
            descriptor: Some(descriptor()),
            corrupt_compiled_ir: false,
        },
    )
    .await;
    seed_dispatch(&ledger).await;
    ledger.release_fence().await.unwrap();

    let (process, client) = spawn(state.path(), "active-recovery");
    assert!(client.initialize().await.is_err());
    drop(client);
    let diagnostics = process.join_failure().await;
    assert!(diagnostics.contains("execution state is invalid"));
    assert_eq!(effect_count(&state), 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn corrupt_terminal_digest_refuses_startup_without_an_effect() {
    let state = TempState::new("terminal-corruption");
    let ledger = seed_admission(
        &state,
        "terminal-corruption",
        SeedAdmission {
            graph: deterministic_graph(),
            input: json!({ "value": 0 }),
            descriptor: Some(descriptor()),
            corrupt_compiled_ir: false,
        },
    )
    .await;
    let dispatch = seed_dispatch(&ledger).await;
    let outcome = WorkerOutcome::Verified {
        output: json!({ "value": 42 }),
        artifacts: Vec::new(),
    };
    let bytes = canonical_value_bytes(&serde_json::to_value(outcome).unwrap()).unwrap();
    let digest = CanonicalDigest::of(&bytes);
    ledger
        .settle(
            IdempotencyId::new("terminal-corruption-settlement").unwrap(),
            digest.as_bytes(),
            dispatch.execution,
            digest,
            Some(bytes),
        )
        .await
        .unwrap();
    ledger
        .terminalize_fixture(
            IdempotencyId::new("terminal-corruption-terminal").unwrap(),
            [7; 32],
            CanonicalDigest::of(b"wrong terminal"),
        )
        .await
        .unwrap();
    ledger.release_fence().await.unwrap();

    let (process, client) = spawn(state.path(), "terminal-corruption");
    assert!(client.initialize().await.is_err());
    drop(client);
    let diagnostics = process.join_failure().await;
    assert!(diagnostics.contains("execution state is invalid"));
    assert_eq!(effect_count(&state), 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn exact_worker_free_predecessor_state_reopens_after_upgrade() {
    let state = TempState::new("predecessor-upgrade");
    let graph = predecessor_graph();
    let ledger = seed_admission(
        &state,
        "predecessor-upgrade",
        SeedAdmission {
            graph: graph.clone(),
            input: Value::Null,
            descriptor: None,
            corrupt_compiled_ir: false,
        },
    )
    .await;
    ledger.release_fence().await.unwrap();

    let (process, client) = spawn(state.path(), "predecessor-upgrade");
    let initialized = client.initialize().await.unwrap();
    assert_eq!(initialized.status.phase, Phase::Running);
    let result = client.get(GetParams::default()).await.unwrap();
    assert_eq!(result.spec, Some(graph));
    assert_eq!(result.status.phase, Phase::Running);
    assert_eq!(result.terminal_result, None);
    drop(client);
    process.join_success().await;
}

#[tokio::test]
async fn reducer_dispatch_and_terminal_authorizations_are_prefix_bound() {
    let state = TempState::new("reducer-authority");
    let ledger = seed_admission(
        &state,
        "reducer-authority",
        SeedAdmission {
            graph: deterministic_graph(),
            input: json!({ "value": 0 }),
            descriptor: Some(descriptor()),
            corrupt_compiled_ir: false,
        },
    )
    .await;
    let reduction = reduce(&ledger).await;
    let execution = reduction
        .decisions
        .iter()
        .find_map(|decision| match decision {
            Decision::Dispatch { execution, .. } => Some(*execution),
            _ => None,
        })
        .unwrap();
    let authorization = reduction.dispatch_authorization(execution).unwrap();
    let dispatch_key = IdempotencyId::new("authorized-dispatch").unwrap();
    let committed = ledger
        .dispatch_reduction(dispatch_key.clone(), authorization.clone())
        .await
        .unwrap();
    assert!(!committed.replayed);
    let replayed = ledger
        .dispatch_reduction(dispatch_key, authorization.clone())
        .await
        .unwrap();
    assert!(replayed.replayed);
    let stale = ledger
        .dispatch_reduction(IdempotencyId::new("stale-dispatch").unwrap(), authorization)
        .await
        .unwrap_err();
    assert_eq!(stale.kind(), &LedgerErrorKind::InvalidLifecycle);

    let digest = settle_verified(&ledger, execution).await;
    let terminal_reduction = reduce(&ledger).await;
    let stale_terminal = terminal_reduction.terminal_authorization().unwrap();
    ledger
        .settle(
            IdempotencyId::new("duplicate-settlement").unwrap(),
            [9; 32],
            execution,
            digest,
            None,
        )
        .await
        .unwrap();
    let stale = ledger
        .terminalize_reduction(
            IdempotencyId::new("stale-terminal").unwrap(),
            stale_terminal,
        )
        .await
        .unwrap_err();
    assert_eq!(stale.kind(), &LedgerErrorKind::InvalidLifecycle);
    let fresh = reduce(&ledger).await;
    ledger
        .terminalize_reduction(
            IdempotencyId::new("fresh-terminal").unwrap(),
            fresh.terminal_authorization().unwrap(),
        )
        .await
        .unwrap();
    assert!(ledger.state().await.unwrap().terminal_outcome.is_some());
    ledger.release_fence().await.unwrap();
}

async fn settle_verified(
    ledger: &zeroshot_engine::cluster_ledger::ClusterLedger,
    execution: zeroshot_engine::cluster_ledger::ExecutionId,
) -> CanonicalDigest {
    let outcome = WorkerOutcome::Verified {
        output: json!({ "value": 42 }),
        artifacts: Vec::new(),
    };
    let bytes = canonical_value_bytes(&serde_json::to_value(outcome).unwrap()).unwrap();
    let digest = CanonicalDigest::of(&bytes);
    ledger
        .settle(
            IdempotencyId::new("authorized-settlement").unwrap(),
            digest.as_bytes(),
            execution,
            digest,
            Some(bytes),
        )
        .await
        .unwrap();
    digest
}
