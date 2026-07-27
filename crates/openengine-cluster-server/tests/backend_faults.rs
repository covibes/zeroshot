//! A `fault` `WatchEvent` must flow through replay and live delivery unchanged, exactly like every
//! other `WatchEvent` variant, against the minimal `FixtureStore` independent of the testkit's
//! `InMemoryAdmissionStore`.

use std::sync::Arc;

use openengine_cluster_protocol::{
    BackendFault, BoundedString256, Cursor, FaultAction, FaultCode, FaultConsequence,
    FaultRetryDisposition, FaultSeverity, FaultSourceFrame, RunId, WatchEvent, WatchParams,
    WatchResult,
};
use openengine_cluster_server::watch::fixtures::{FixtureBackend, FixtureStore};
use openengine_cluster_server::watch::{WatchEventStream, WatchHandle, WatchStreamItem};
use openengine_cluster_server::{ConnectionContext, Dispatcher};

const AMPLE_CAPACITY: usize = 8;

fn sample_fault() -> BackendFault {
    BackendFault {
        event_id: BoundedString256::new("evt-1").expect("fixture event id must be valid"),
        execution_ref: Some(
            BoundedString256::new("exec-1").expect("fixture execution ref must be valid"),
        ),
        code: FaultCode::ResourceExhausted,
        consequence: FaultConsequence::RunDegraded,
        retry: FaultRetryDisposition::NotRetryable,
        action: FaultAction::Escalate,
        severity: FaultSeverity::Critical,
        summary: BoundedString256::new("admission queue capacity exhausted")
            .expect("fixture summary must be valid"),
        source: vec![FaultSourceFrame {
            component: BoundedString256::new("admission-queue")
                .expect("fixture component must be valid"),
        }],
    }
}

/// Seeds a fresh `FixtureStore` for `run_id` with `history`, wires it through a `Dispatcher`, and
/// issues the initial `watch` call.
async fn watch_seeded_history(
    run_id: RunId,
    history: Vec<WatchEvent>,
) -> (
    Arc<FixtureStore>,
    WatchResult,
    WatchEventStream,
    WatchHandle,
) {
    let store = Arc::new(FixtureStore::new(run_id, history, AMPLE_CAPACITY));
    let dispatcher = Dispatcher::new(
        FixtureBackend::new(Arc::clone(&store)),
        ConnectionContext::default(),
    );
    let (result, stream, handle) = dispatcher.watch(WatchParams::default()).await.unwrap();
    (store, result, stream, handle)
}

#[tokio::test]
async fn seeded_fault_history_replays_unchanged_then_a_live_fault_delivers_unchanged() {
    let run_id = RunId::new("run-1");
    let (store, result, mut stream, _handle) = watch_seeded_history(
        run_id.clone(),
        vec![WatchEvent::Fault {
            fault: sample_fault(),
        }],
    )
    .await;
    assert_eq!(result.run_id, Some(run_id));
    assert_eq!(result.at_cursor, Some(Cursor::new("cursor-1")));

    let replayed = stream.next().await.unwrap();
    let WatchStreamItem::Record(record) = replayed else {
        panic!("expected a replayed record");
    };
    assert_eq!(record.cursor, Cursor::new("cursor-1"));
    assert_eq!(
        record.event,
        WatchEvent::Fault {
            fault: sample_fault()
        }
    );

    store
        .publish(WatchEvent::Fault {
            fault: sample_fault(),
        })
        .await;
    let live = stream.next().await.unwrap();
    let WatchStreamItem::Record(record) = live else {
        panic!("expected a live record");
    };
    assert_eq!(record.cursor, Cursor::new("cursor-2"));
    assert_eq!(
        record.event,
        WatchEvent::Fault {
            fault: sample_fault()
        }
    );
}
