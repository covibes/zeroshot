use std::collections::HashSet;

use openengine_cluster_protocol::{
    ClusterStatus, Cursor, GetParams, RunId, StopMode, WatchEvent, WatchParams,
};
use openengine_cluster_server::watch::WatchStreamItem;
use openengine_cluster_testkit::admission::{
    compiled_from_graph_fixture, graph_fixture, ScriptedOutcome,
};
use openengine_cluster_testkit::fixture::dispatcher_fixture;
use openengine_cluster_testkit::lifecycle::{resume, stop, suspend};
use serde_json::{json, Value};

#[path = "admission_support/committed.rs"]
mod committed_support;
use committed_support::committed;

/// A continuous watch spanning apply -> update(suspend) -> update(resume) -> stop(drain) ->
/// finished must, after `(runId, cursor)` dedup, fold to the same public state as authoritative
/// `get`, and see exactly one `Finished` event.
#[tokio::test]
async fn continuous_watch_through_the_full_lifecycle_folds_to_the_authoritative_get() {
    let graph = graph_fixture("worker", json!({"kind":"null"}));
    let compiled = compiled_from_graph_fixture(&graph);
    let (client, dispatcher, _backend, _verifier, _store) =
        dispatcher_fixture(vec![ScriptedOutcome::approve(compiled, vec![])]);

    let (parked, mut stream, _handle) = dispatcher.watch(WatchParams::default()).await.unwrap();
    assert_eq!(parked.run_id, None);

    let apply_result = client
        .apply(committed(graph, Value::Null, 0, "create"))
        .await
        .unwrap();
    let generation = apply_result.generation.unwrap().get();

    client
        .update(suspend(generation, "reconnect-suspend"))
        .await
        .unwrap();
    client
        .update(resume(generation, "reconnect-resume"))
        .await
        .unwrap();
    client
        .stop(stop(StopMode::Drain, generation, "reconnect-stop"))
        .await
        .unwrap();

    let mut seen: HashSet<(RunId, Cursor)> = HashSet::new();
    let mut finished_count = 0;
    let final_status: ClusterStatus = loop {
        let Some(WatchStreamItem::Record(record)) = stream.next().await else {
            panic!("stream closed before a Finished event was observed");
        };
        assert!(
            seen.insert((record.run_id.clone(), record.cursor.clone())),
            "duplicate (runId,cursor) delivered: {:?} {:?}",
            record.run_id,
            record.cursor
        );
        if let WatchEvent::Finished { final_status, .. } = record.event {
            finished_count += 1;
            break final_status;
        }
    };
    assert_eq!(finished_count, 1);

    let authoritative = client.get(GetParams::default()).await.unwrap();
    assert_eq!(final_status, authoritative.status);
}
