use openengine_cluster_protocol::{
    legacy_ship_request_payload_type, legacy_ship_result_payload_type, GraphProfile, GraphSpec,
};
use serde_json::json;

use super::{
    intent_graph, single_worker_diagnostics, HostedBackend, RunIntentIdentity, RunIntentLookup,
    RunIntentReservation, RunIntentStatus,
};

fn graph(profile: GraphProfile, worker: &str) -> GraphSpec {
    serde_json::from_value(json!({
        "profile": profile,
        "initialInput": legacy_ship_request_payload_type(),
        "policy": { "policy": "policy.strict@1", "default": "deny" },
        "root": {
            "kind": "step",
            "name": "zeroshot",
            "worker": worker,
            "input": legacy_ship_request_payload_type(),
            "output": legacy_ship_result_payload_type(),
            "inputBindings": [],
            "writeBindings": [],
            "timeoutMs": 3_600_000,
            "attempts": 1
        }
    }))
    .expect("hosted graph fixture must be valid protocol syntax")
}

#[tokio::test]
async fn canonical_single_worker_graph_has_fixed_structural_bounds() {
    let graph = graph(GraphProfile::SingleWorker, "legacy.zeroshot.ship@1");
    let planned = HostedBackend::new()
        .verify(&graph)
        .await
        .expect("canonical graph must verify");

    assert!(planned.ok);
    assert!(planned.diagnostics.is_empty());
    let bounds = planned.bounds.expect("accepted graph must have bounds");
    assert_eq!(bounds.max_node_executions.get(), 1);
    assert_eq!(bounds.peak_concurrency.get(), 1);
    assert_eq!(bounds.attempts_per_node.len(), 1);
}

#[tokio::test]
async fn internal_run_intent_owns_the_same_fixed_graph() {
    let fixed_graph = intent_graph().expect("the runtime-owned graph must construct");
    assert_eq!(
        fixed_graph,
        graph(GraphProfile::SingleWorker, "legacy.zeroshot.ship@1")
    );

    let planned = HostedBackend::new()
        .verify(&fixed_graph)
        .await
        .expect("the runtime-owned graph must verify");
    assert!(planned.ok);
}

#[tokio::test]
async fn run_intent_reservation_is_idempotent_and_capsule_exclusive() {
    let backend = HostedBackend::new();
    let identity = RunIntentIdentity {
        intent_id: "019f7437-8701-71e3-a056-2ba05c37609c".to_owned(),
        digest: format!("sha256:{}", "a".repeat(64)),
    };
    assert_eq!(
        backend.reserve_run_intent(identity.clone()).await,
        RunIntentReservation::Reserved
    );
    assert_eq!(
        backend.reserve_run_intent(identity.clone()).await,
        RunIntentReservation::Existing(RunIntentStatus::Running)
    );

    let mut conflicting = identity.clone();
    conflicting.digest = format!("sha256:{}", "b".repeat(64));
    assert_eq!(
        backend.reserve_run_intent(conflicting).await,
        RunIntentReservation::Conflict
    );
    assert_eq!(
        backend
            .get_run_intent(&identity.intent_id, &identity.digest)
            .await,
        RunIntentLookup::Found(RunIntentStatus::Running)
    );
    assert_eq!(
        backend
            .get_run_intent(&identity.intent_id, &format!("sha256:{}", "c".repeat(64)))
            .await,
        RunIntentLookup::Conflict
    );
    assert_eq!(
        backend
            .get_run_intent("019f7437-8701-71e3-a056-2ba05c37609d", &identity.digest)
            .await,
        RunIntentLookup::NotFound
    );
}

#[test]
fn broader_profiles_and_workers_are_rejected_at_the_facade() {
    let full = graph(GraphProfile::Full, "legacy.zeroshot.ship@1");
    let unsupported = graph(GraphProfile::SingleWorker, "example.worker@1");

    let full_messages = single_worker_diagnostics(&full)
        .into_iter()
        .map(|diagnostic| diagnostic.message)
        .collect::<Vec<_>>();
    let worker_messages = single_worker_diagnostics(&unsupported)
        .into_iter()
        .map(|diagnostic| diagnostic.message)
        .collect::<Vec<_>>();

    assert!(
        full_messages
            .iter()
            .any(|message| message.contains("single-worker/v1"))
    );
    assert!(
        worker_messages
            .iter()
            .any(|message| message.contains("legacy.zeroshot.ship@1"))
    );
}

#[test]
fn facade_rejects_noncanonical_contracts_before_worker_resolution() {
    let mut graph = graph(GraphProfile::SingleWorker, "legacy.zeroshot.ship@1");
    graph.initial_input = serde_json::from_value(json!({ "kind": "string" }))
        .expect("string is a valid payload type");

    let messages = single_worker_diagnostics(&graph)
        .into_iter()
        .map(|diagnostic| diagnostic.message)
        .collect::<Vec<_>>();
    assert_eq!(messages.len(), 1);
    assert!(messages[0].contains("canonical legacy Zeroshot request"));
}
