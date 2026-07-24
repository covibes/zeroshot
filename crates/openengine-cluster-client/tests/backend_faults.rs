//! Client-side NDJSON decode, `(runId, cursor)` dedup, and slow-consumer reconnect must treat a
//! `fault` `WatchEvent` identically to every other variant (`Bookmark`, `Finished`), with no
//! special-casing, driven over the wire against `serve_ndjson` exactly like
//! `tests/subscription_ndjson.rs`.

use std::io;
use std::sync::Arc;

use openengine_cluster_client::{EventOrClosed, NdjsonTransport, NdjsonWatchClient};
use openengine_cluster_protocol::{
    BackendFault, BoundedString256, ClusterStatus, Cursor, FaultAction, FaultCode,
    FaultConsequence, FaultRetryDisposition, FaultSeverity, FaultSourceFrame, RunId, StopMode,
    WatchEvent, WatchParams,
};
use openengine_cluster_server::watch::fixtures::{
    await_ndjson_shutdown, spawn_ndjson, FixtureBackend, FixtureStore,
};
use tokio::io::DuplexStream;
use tokio::task::JoinHandle;

#[path = "reconnect_support/mod.rs"]
mod reconnect_support;
use reconnect_support::FIXTURE_QUEUE_CAPACITY;

#[path = "reconnect_support/ndjson_scenario.rs"]
mod ndjson_scenario;
use ndjson_scenario::ndjson_overflow_and_reconnect_scenario;

fn sample_fault(event_id: &str) -> BackendFault {
    BackendFault {
        event_id: BoundedString256::new(event_id).expect("fixture event id must be valid"),
        execution_ref: None,
        code: FaultCode::DeadlineExceeded,
        consequence: FaultConsequence::RunDegraded,
        retry: FaultRetryDisposition::Indeterminate,
        action: FaultAction::Wait,
        severity: FaultSeverity::Warning,
        summary: BoundedString256::new("downstream node deadline exceeded")
            .expect("fixture summary must be valid"),
        source: vec![FaultSourceFrame {
            component: BoundedString256::new("node-runtime")
                .expect("fixture component must be valid"),
        }],
    }
}

/// Seeds a fresh `FixtureStore` for `run_id` with the given subscription queue `capacity` and
/// spawns a connected NDJSON server/transport pair for it.
async fn connect(
    run_id: &RunId,
    capacity: usize,
) -> (
    Arc<FixtureStore>,
    NdjsonTransport<DuplexStream, DuplexStream>,
    JoinHandle<io::Result<()>>,
) {
    let store = Arc::new(FixtureStore::new(run_id.clone(), Vec::new(), capacity));
    let (client_write, client_read, server) = spawn_ndjson(FixtureBackend::new(Arc::clone(&store)));
    (
        store,
        NdjsonTransport::new(client_read, client_write),
        server,
    )
}

#[tokio::test]
async fn fault_events_decode_over_ndjson_and_dedup_a_physical_duplicate() {
    let run_id = RunId::new("run-1");
    let (store, transport, server) = connect(&run_id, 8).await;
    let watch_client = NdjsonWatchClient::new(&transport);
    let (result, mut stream) = watch_client.watch(WatchParams::default()).await.unwrap();
    assert_eq!(result.run_id, Some(run_id));

    store
        .publish(WatchEvent::Fault {
            fault: sample_fault("evt-1"),
        })
        .await;
    match stream.next().await.unwrap() {
        EventOrClosed::Event(record) => {
            assert_eq!(record.cursor, Cursor::new("cursor-1"));
            assert_eq!(
                record.event,
                WatchEvent::Fault {
                    fault: sample_fault("evt-1")
                }
            );
        }
        other => panic!("expected a fault event, got {other:?}"),
    }

    // A legal at-least-once physical duplicate of the fault event must be silently dropped: the
    // next `next()` call must skip straight past it to the next distinct event with no
    // special-casing for the `fault` variant.
    store.republish_last().await;
    store
        .publish(WatchEvent::Finished {
            final_status: ClusterStatus::empty(),
            stop_mode: Some(StopMode::Drain),
        })
        .await;
    match stream.next().await.unwrap() {
        EventOrClosed::Event(record) => {
            assert_eq!(record.cursor, Cursor::new("cursor-2"));
            assert!(matches!(record.event, WatchEvent::Finished { .. }));
        }
        other => panic!("expected the Finished event, got {other:?}"),
    }

    drop(stream);
    drop(transport);
    await_ndjson_shutdown(server).await;
}

#[tokio::test]
async fn fault_events_survive_slow_consumer_reconnect_with_no_gap() {
    // Drive the exact same NDJSON overflow/gap-free-replay/dedup scenario used for `Bookmark` in
    // `tests/subscription_ndjson.rs`, publishing `fault` events instead: proves the reconnect
    // mechanics need no special-casing for the `fault` variant.
    ndjson_overflow_and_reconnect_scenario(RunId::new("run-1"), FIXTURE_QUEUE_CAPACITY, || {
        WatchEvent::Fault {
            fault: sample_fault("evt-1"),
        }
    })
    .await;
}
