use std::sync::Arc;

use openengine_cluster_testkit::admission::{
    compiled_from_graph_fixture, graph_fixture, InMemoryAdmissionStore, ScriptedOutcome,
};

use crate::admission_support::{client, committed, FixtureClient};

pub async fn running() -> (FixtureClient, Arc<InMemoryAdmissionStore>) {
    let graph = graph_fixture("worker", serde_json::json!({"kind":"null"}));
    let compiled = compiled_from_graph_fixture(&graph);
    let (client, _, store) = client(vec![ScriptedOutcome::approve(compiled, vec![])]);
    client
        .apply(committed(graph, serde_json::Value::Null, 0, "create"))
        .await
        .assert_value_with("fixture admission succeeds");
    (client, store)
}

use openengine_cluster_testkit::assertions::AssertValue;
