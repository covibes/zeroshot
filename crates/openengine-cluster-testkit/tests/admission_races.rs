use std::sync::Arc;

use openengine_cluster_client::{ClusterClient, InProcessTransport};
use openengine_cluster_protocol::GENERATION_CONFLICT;
use openengine_cluster_server::admission::AdmissionCoordinator;
use openengine_cluster_server::{ConnectionContext, Dispatcher};
use openengine_cluster_testkit::admission::{
    compiled_from_graph_fixture, graph_fixture, ScriptedOutcome, ScriptedVerifier,
};
use serde_json::json;

#[path = "admission_support/mod.rs"]
mod admission_support;
use admission_support::{client, committed, rpc_code};

#[tokio::test]
async fn concurrent_first_use_and_stale_cas_have_one_winner() {
    let graph = graph_fixture("worker", json!({"kind":"null"}));
    let compiled = compiled_from_graph_fixture(&graph);
    let (client, _, store) = client(vec![
        ScriptedOutcome::approve(compiled.clone(), vec![]),
        ScriptedOutcome::approve(compiled, vec![]),
    ]);
    let client = Arc::new(client);
    let left = Arc::clone(&client);
    let right = Arc::clone(&client);
    let left_params = committed(graph.clone(), json!(null), 0, "race");
    let right_params = left_params.clone();
    let (left, right) = tokio::join!(left.apply(left_params), right.apply(right_params));
    let receipts = [left.assert_value(), right.assert_value()];
    assert_eq!(receipts.iter().filter(|receipt| receipt.deduped).count(), 1);
    assert_eq!(store.inspect().await.control_journal.len(), 1);

    let update_a = graph_fixture("updateA", json!({"kind":"null"}));
    let update_b = graph_fixture("updateB", json!({"kind":"null"}));
    let verifier = Arc::new(ScriptedVerifier::new(vec![
        ScriptedOutcome::approve(compiled_from_graph_fixture(&update_a), vec![]),
        ScriptedOutcome::approve(compiled_from_graph_fixture(&update_b), vec![]),
    ]));
    let backend = AdmissionCoordinator::from_shared(verifier, Arc::clone(&store));
    let update_client = Arc::new(ClusterClient::new(InProcessTransport::new(
        Dispatcher::new(backend, ConnectionContext::default()),
    )));
    let a = Arc::clone(&update_client);
    let b = Arc::clone(&update_client);
    let (a, b) = tokio::join!(
        a.apply(committed(update_a, json!(null), 1, "update-a")),
        b.apply(committed(update_b, json!(null), 1, "update-b"))
    );
    let successes = [a.as_ref().ok(), b.as_ref().ok()]
        .into_iter()
        .flatten()
        .count();
    assert_eq!(successes, 1);
    let failure = a.err().or_else(|| b.err()).assert_value();
    assert_eq!(rpc_code(failure), GENERATION_CONFLICT);
    assert_eq!(store.inspect().await.control_journal.len(), 2);
}

use openengine_cluster_testkit::assertions::AssertValue;
