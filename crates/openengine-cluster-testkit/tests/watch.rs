use openengine_cluster_client::{EventOrClosed, WatchClient};
use openengine_cluster_protocol::{
    GetParams, NodeAddress, NodeName, PositiveInteger, RunId, SubscriptionCloseReason, WatchEvent,
    WatchParams, WorkerOutcome, DEFAULT_SUBSCRIPTION_QUEUE_CAPACITY, GONE, NOT_FOUND,
};
use openengine_cluster_server::watch::WatchStreamItem;
use openengine_cluster_server::{ClusterBackend, ConnectionContext};
use openengine_cluster_testkit::admission::{
    compiled_from_graph_fixture, graph_fixture, ScriptedOutcome,
};
use openengine_cluster_testkit::fixture::dispatcher_fixture as setup;
use openengine_cluster_testkit::lifecycle::{resume, stop, suspend};
use openengine_cluster_testkit::watch::NodeEventBody;
use serde_json::{json, Value};

#[path = "admission_support/committed.rs"]
mod committed_support;
use committed_support::committed;

#[path = "admission_support/expect_record.rs"]
mod expect_record_support;
use expect_record_support::expect_record;

#[tokio::test]
async fn watch_parks_while_empty_and_attaches_on_the_next_committed_run() {
    let graph = graph_fixture("worker", json!({"kind":"null"}));
    let compiled = compiled_from_graph_fixture(&graph);
    let (client, dispatcher, _backend, _verifier, _store) =
        setup(vec![ScriptedOutcome::approve(compiled, vec![])]);

    let (parked, mut stream, _handle) = dispatcher
        .watch(WatchParams::default())
        .await
        .assert_value();
    assert_eq!(parked.run_id, None);
    assert_eq!(parked.at_cursor, None);

    let apply_result = client
        .apply(committed(graph, Value::Null, 0, "create"))
        .await
        .assert_value();
    let run_id = apply_result.run_id.assert_value();

    let record = expect_record(stream.next().await);
    assert_eq!(record.run_id, run_id);
    assert!(matches!(
        record.event,
        WatchEvent::Phase {
            admission: Some(_),
            ..
        }
    ));
}

#[tokio::test]
async fn parked_overflow_reconnect_stays_on_the_attached_run() {
    let graph_a = graph_fixture("worker-a", json!({"kind":"null"}));
    let compiled_a = compiled_from_graph_fixture(&graph_a);
    let graph_b = graph_fixture("worker-b", json!({"kind":"null"}));
    let compiled_b = compiled_from_graph_fixture(&graph_b);
    let (admission_client, dispatcher, _backend, _verifier, store) = setup(vec![
        ScriptedOutcome::approve(compiled_a, vec![]),
        ScriptedOutcome::approve(compiled_b, vec![]),
    ]);
    let watch_client = WatchClient::new(dispatcher);

    let (parked, mut stream, _handle) = watch_client
        .watch(WatchParams::default())
        .await
        .assert_value();
    assert_eq!(parked.run_id, None);

    let first = admission_client
        .apply(committed(graph_a, Value::Null, 0, "create-parked-a"))
        .await
        .assert_value();
    let first_run = first.run_id.assert_value();
    let node = NodeAddress {
        node: NodeName::new("worker-a").assert_value(),
        attempt: PositiveInteger::new(1).assert_value(),
    };
    for _ in 0..DEFAULT_SUBSCRIPTION_QUEUE_CAPACITY {
        store
            .emit_node_event(
                &first_run,
                node.clone(),
                NodeEventBody::Begin { input: Value::Null },
            )
            .await;
    }

    let second = admission_client
        .apply(committed(
            graph_b,
            Value::Null,
            first.generation.assert_value().get(),
            "create-parked-b",
        ))
        .await
        .assert_value();
    assert_ne!(second.run_id.as_ref(), Some(&first_run));

    loop {
        match stream.next().await.assert_value() {
            EventOrClosed::Event(record) => assert_eq!(record.run_id, first_run),
            EventOrClosed::Closed {
                reason,
                last_delivered_cursor,
            } => {
                assert_eq!(reason, SubscriptionCloseReason::SlowConsumer);
                assert!(last_delivered_cursor.is_some());
                break;
            }
        }
    }

    let (reconnected, mut stream, _handle) = watch_client.reconnect(stream).await.assert_value();
    assert_eq!(reconnected.run_id, Some(first_run.clone()));
    let record = match stream.next().await {
        Some(EventOrClosed::Event(record)) => Some(record),
        _ => None,
    }
    .assert_value_with("expected the attached run's overflowed event on reconnect");
    assert_eq!(record.run_id, first_run);
}

#[tokio::test]
async fn get_then_watch_from_cursor_has_no_gap_under_a_concurrent_commit() {
    let graph = graph_fixture("worker", json!({"kind":"null"}));
    let compiled = compiled_from_graph_fixture(&graph);
    let (client, dispatcher, _backend, _verifier, _store) =
        setup(vec![ScriptedOutcome::approve(compiled, vec![])]);

    let snapshot = client.get(GetParams::default()).await.assert_value();
    assert_eq!(snapshot.at_cursor, None);

    let apply = client.apply(committed(graph, Value::Null, 0, "create"));
    let watch = dispatcher.watch(WatchParams {
        run_id: None,
        from_cursor: snapshot.at_cursor,
    });
    let (apply_result, watch_result) = tokio::join!(apply, watch);
    let apply_result = apply_result.assert_value();
    let run_id = apply_result.run_id.assert_value();
    let (_result, mut stream, _handle) = watch_result.assert_value();

    let record = expect_record(stream.next().await);
    assert_eq!(record.run_id, run_id);
    assert!(matches!(record.event, WatchEvent::Phase { .. }));
}

#[tokio::test]
async fn superseded_runs_stay_watchable_until_explicit_tombstone_and_unknown_runs_404() {
    let graph_a = graph_fixture("worker-a", json!({"kind":"null"}));
    let compiled_a = compiled_from_graph_fixture(&graph_a);
    let graph_b = graph_fixture("worker-b", json!({"kind":"null"}));
    let compiled_b = compiled_from_graph_fixture(&graph_b);
    let (client, dispatcher, _backend, _verifier, store) = setup(vec![
        ScriptedOutcome::approve(compiled_a, vec![]),
        ScriptedOutcome::approve(compiled_b, vec![]),
    ]);

    let first = client
        .apply(committed(graph_a, Value::Null, 0, "create-a"))
        .await
        .assert_value();
    let first_run = first.run_id.assert_value();
    let second = client
        .apply(committed(
            graph_b,
            Value::Null,
            first.generation.assert_value().get(),
            "create-b",
        ))
        .await
        .assert_value();
    let second_run = second.run_id.assert_value();
    assert_ne!(first_run, second_run);

    let (result, mut stream, _handle) = dispatcher
        .watch(WatchParams {
            run_id: Some(first_run.clone()),
            from_cursor: None,
        })
        .await
        .assert_value();
    assert_eq!(result.run_id, Some(first_run.clone()));
    let record = expect_record(stream.next().await);
    assert_eq!(record.run_id, first_run);

    let error = dispatcher
        .watch(WatchParams {
            run_id: Some(RunId::new("run-does-not-exist")),
            from_cursor: None,
        })
        .await
        .assert_error();
    assert_eq!(error.code, NOT_FOUND);

    store.tombstone_run(first_run.clone()).await;
    let error = dispatcher
        .watch(WatchParams {
            run_id: Some(first_run),
            from_cursor: None,
        })
        .await
        .assert_error();
    assert_eq!(error.code, GONE);
}

#[tokio::test]
async fn duplicate_physical_delivery_is_legal_and_carries_the_same_run_and_cursor() {
    let graph = graph_fixture("worker", json!({"kind":"null"}));
    let compiled = compiled_from_graph_fixture(&graph);
    let (client, dispatcher, _backend, _verifier, store) =
        setup(vec![ScriptedOutcome::approve(compiled, vec![])]);
    let apply_result = client
        .apply(committed(graph, Value::Null, 0, "create"))
        .await
        .assert_value();
    let run_id = apply_result.run_id.assert_value();

    let (_result, mut stream, _handle) = dispatcher
        .watch(WatchParams {
            run_id: Some(run_id.clone()),
            from_cursor: None,
        })
        .await
        .assert_value();
    let first = expect_record(stream.next().await);

    assert!(store.redeliver_last_event_for_test(&run_id).await);
    let duplicate = expect_record(stream.next().await);
    assert_eq!(duplicate.run_id, first.run_id);
    assert_eq!(duplicate.cursor, first.cursor);
    assert_eq!(duplicate.event, first.event);
}

#[tokio::test]
async fn concurrent_subscribers_to_one_run_observe_identical_order() {
    let graph = graph_fixture("worker", json!({"kind":"null"}));
    let compiled = compiled_from_graph_fixture(&graph);
    let (client, dispatcher, _backend, _verifier, _store) =
        setup(vec![ScriptedOutcome::approve(compiled, vec![])]);
    let apply_result = client
        .apply(committed(graph, Value::Null, 0, "create"))
        .await
        .assert_value();
    let run_id = apply_result.run_id.assert_value();
    let generation = apply_result.generation.assert_value().get();

    let (result_a, mut stream_a, _handle_a) = dispatcher
        .watch(WatchParams {
            run_id: Some(run_id.clone()),
            from_cursor: None,
        })
        .await
        .assert_value();
    let (result_b, mut stream_b, _handle_b) = dispatcher
        .watch(WatchParams {
            run_id: Some(run_id.clone()),
            from_cursor: None,
        })
        .await
        .assert_value();

    client
        .update(suspend(generation, "suspend-1"))
        .await
        .assert_value();
    client
        .update(resume(generation, "resume-1"))
        .await
        .assert_value();
    client
        .stop(stop(
            openengine_cluster_protocol::StopMode::Drain,
            generation,
            "stop-1",
        ))
        .await
        .assert_value();

    let mut order_a = Vec::new();
    while order_a.len() < 4 {
        order_a.push(expect_record(stream_a.next().await).cursor);
    }
    let mut order_b = Vec::new();
    while order_b.len() < 4 {
        order_b.push(expect_record(stream_b.next().await).cursor);
    }
    assert_eq!(order_a, order_b);
    assert_eq!(result_a.at_cursor, result_b.at_cursor);
}

#[tokio::test]
async fn overflow_closes_with_slow_consumer_and_reconnect_recovers_without_a_gap() {
    let graph = graph_fixture("worker", json!({"kind":"null"}));
    let compiled = compiled_from_graph_fixture(&graph);
    let (client, _dispatcher, backend, _verifier, _store) =
        setup(vec![ScriptedOutcome::approve(compiled, vec![])]);
    let apply_result = client
        .apply(committed(graph, Value::Null, 0, "create"))
        .await
        .assert_value();
    let run_id = apply_result.run_id.assert_value();
    let generation = apply_result.generation.assert_value().get();

    let context = ConnectionContext::default();
    let (_result, mut stream, _handle) = backend
        .watch(
            &context,
            WatchParams {
                run_id: Some(run_id.clone()),
                from_cursor: None,
            },
            1,
        )
        .await
        .assert_value();
    let admission_record = expect_record(stream.next().await);

    client
        .update(suspend(generation, "suspend-overflow-1"))
        .await
        .assert_value();
    client
        .update(resume(generation, "resume-overflow-1"))
        .await
        .assert_value();

    let delivered = expect_record(stream.next().await);
    assert_ne!(delivered.cursor, admission_record.cursor);

    let closed = stream.next().await;
    let (reason, last_delivered_cursor) = match closed {
        Some(WatchStreamItem::Closed {
            reason,
            last_delivered_cursor,
        }) => Some((reason, last_delivered_cursor)),
        _ => None,
    }
    .assert_value_with("expected a slow-consumer close");
    assert_eq!(
        reason,
        openengine_cluster_protocol::SubscriptionCloseReason::SlowConsumer
    );
    assert_eq!(last_delivered_cursor, Some(delivered.cursor.clone()));

    let (_reconnect_result, mut reconnect_stream, _reconnect_handle) = backend
        .watch(
            &context,
            WatchParams {
                run_id: Some(run_id),
                from_cursor: last_delivered_cursor,
            },
            8,
        )
        .await
        .assert_value();
    let recovered = expect_record(reconnect_stream.next().await);
    assert_ne!(recovered.cursor, delivered.cursor);
}

#[tokio::test]
async fn synthetic_node_begin_and_end_events_are_delivered_in_order() {
    let graph = graph_fixture("worker", json!({"kind":"null"}));
    let compiled = compiled_from_graph_fixture(&graph);
    let (client, dispatcher, _backend, _verifier, store) =
        setup(vec![ScriptedOutcome::approve(compiled, vec![])]);
    let apply_result = client
        .apply(committed(graph, Value::Null, 0, "create"))
        .await
        .assert_value();
    let run_id = apply_result.run_id.assert_value();

    let node = NodeAddress {
        node: NodeName::new("worker").assert_value(),
        attempt: PositiveInteger::new(1).assert_value(),
    };
    let begin_cursor = store
        .emit_node_event(
            &run_id,
            node.clone(),
            NodeEventBody::Begin {
                input: json!({ "text": "hi" }),
            },
        )
        .await;
    let end_cursor = store
        .emit_node_event(
            &run_id,
            node,
            NodeEventBody::End {
                outcome: WorkerOutcome::Verified {
                    output: json!({ "text": "done" }),
                    artifacts: vec![],
                },
            },
        )
        .await;
    assert_ne!(begin_cursor, end_cursor);

    let (_result, mut stream, _handle) = dispatcher
        .watch(WatchParams {
            run_id: Some(run_id),
            from_cursor: None,
        })
        .await
        .assert_value();
    let admission = expect_record(stream.next().await);
    assert!(matches!(admission.event, WatchEvent::Phase { .. }));
    let begin = expect_record(stream.next().await);
    assert_eq!(begin.cursor, begin_cursor);
    assert!(matches!(begin.event, WatchEvent::NodeBegin { .. }));
    let end = expect_record(stream.next().await);
    assert_eq!(end.cursor, end_cursor);
    assert!(matches!(end.event, WatchEvent::NodeEnd { .. }));
}

use openengine_cluster_testkit::assertions::{AssertError, AssertValue};
