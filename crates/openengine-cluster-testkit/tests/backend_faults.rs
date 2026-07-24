//! Drives a real `AdmissionCoordinator` through the testkit-only `emit_fault_event` synthetic
//! hook and proves a `fault` `WatchEvent` round-trips through both retained-history replay and a
//! `fromCursor` reconnect, exactly like the `node_begin`/`node_end` synthetic hook.

use openengine_cluster_protocol::{WatchEvent, WatchParams};
use openengine_cluster_testkit::admission::{
    compiled_from_graph_fixture, graph_fixture, ScriptedOutcome,
};
use openengine_cluster_testkit::fixture::{dispatcher_fixture, sample_backend_fault};
use serde_json::{json, Value};

#[path = "admission_support/committed.rs"]
mod committed_support;
use committed_support::committed;

#[path = "admission_support/expect_record.rs"]
mod expect_record_support;
use expect_record_support::expect_record;

#[tokio::test]
async fn synthetic_fault_event_round_trips_through_replay_and_a_from_cursor_reconnect() {
    let graph = graph_fixture("worker", json!({"kind":"null"}));
    let compiled = compiled_from_graph_fixture(&graph);
    let (client, dispatcher, _backend, _verifier, store) =
        dispatcher_fixture(vec![ScriptedOutcome::approve(compiled, vec![])]);

    let apply_result = client
        .apply(committed(graph, Value::Null, 0, "create"))
        .await
        .unwrap();
    let run_id = apply_result.run_id.unwrap();

    let fault_cursor = store
        .emit_fault_event(&run_id, sample_backend_fault("evt-1"))
        .await;

    let (_result, mut stream, _handle) = dispatcher
        .watch(WatchParams {
            run_id: Some(run_id.clone()),
            from_cursor: None,
        })
        .await
        .unwrap();
    let admission = expect_record(stream.next().await);
    assert!(matches!(admission.event, WatchEvent::Phase { .. }));
    let replayed = expect_record(stream.next().await);
    assert_eq!(replayed.cursor, fault_cursor);
    let WatchEvent::Fault { fault } = replayed.event else {
        panic!("expected a fault event");
    };
    assert_eq!(fault, sample_backend_fault("evt-1"));

    let (reconnected, mut reconnect_stream, _handle) = dispatcher
        .watch(WatchParams {
            run_id: Some(run_id),
            from_cursor: Some(admission.cursor.clone()),
        })
        .await
        .unwrap();
    assert_eq!(reconnected.run_id, Some(replayed.run_id.clone()));
    let after_reconnect = expect_record(reconnect_stream.next().await);
    assert_eq!(after_reconnect.cursor, fault_cursor);
    assert!(matches!(after_reconnect.event, WatchEvent::Fault { .. }));
}
