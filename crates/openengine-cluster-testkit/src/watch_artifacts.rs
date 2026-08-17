//! Generated watch/subscription golden fixtures. `watch-session.json` is produced by driving a
//! real `AdmissionCoordinator` through a committed apply plus the synthetic node golden-vector
//! hook and recording every event an actual subscriber receives; the remaining fixtures document
//! standalone wire shapes for request/close framing that no single session exercises.

use crate::fixture::*;

use openengine_cluster_protocol::{
    BackendFault, Cursor, EventNotification, FaultAction, FaultCode, FaultConsequence,
    FaultRetryDisposition, FaultSeverity, NodeAddress, NodeName, PositiveInteger, RunId,
    SubscriptionCancelParams, SubscriptionCloseReason, SubscriptionClosedNotification,
    SubscriptionId, WatchEvent, WatchParams, WorkerOutcome,
};
use openengine_cluster_server::watch::WatchStreamItem;
use serde_json::{json, Value};

use crate::admission_artifacts::scripted_dispatcher;
use crate::artifacts::{json_artifact, Artifact};
use crate::fixture::sample_backend_fault;
use crate::watch::NodeEventBody;

const ROOT: &str = "protocol/openengine-cluster/v1";

pub(crate) async fn generate_watch_goldens() -> Vec<Artifact> {
    vec![
        json_artifact(
            format!("{ROOT}/goldens/watch-session.json"),
            json!(watch_session().await),
        ),
        json_artifact(
            format!("{ROOT}/fixtures/watch/watch-params.json"),
            json!([
                WatchParams::default(),
                WatchParams {
                    run_id: Some(RunId::new("run-1")),
                    from_cursor: Some(Cursor::new("cursor-1")),
                },
            ]),
        ),
        json_artifact(
            format!("{ROOT}/fixtures/watch/subscription-cancel-params.json"),
            json!(SubscriptionCancelParams {
                subscription_id: SubscriptionId::new("sub-1"),
            }),
        ),
        json_artifact(
            format!("{ROOT}/fixtures/watch/subscription-closed.json"),
            json!([
                SubscriptionClosedNotification {
                    subscription_id: SubscriptionId::new("sub-1"),
                    reason: SubscriptionCloseReason::Done,
                    last_delivered_cursor: None,
                },
                SubscriptionClosedNotification {
                    subscription_id: SubscriptionId::new("sub-2"),
                    reason: SubscriptionCloseReason::SlowConsumer,
                    last_delivered_cursor: Some(Cursor::new("cursor-7")),
                },
            ]),
        ),
        json_artifact(
            format!("{ROOT}/fixtures/watch/backend-fault.json"),
            json!([sample_backend_fault("evt-1"), non_retryable_backend_fault()]),
        ),
        json_artifact(
            format!("{ROOT}/fixtures/watch/fault-event.json"),
            json!(WatchEvent::Fault {
                fault: sample_backend_fault("evt-1"),
            }),
        ),
    ]
}

/// A second deterministic `BackendFault` covering a distinct code/severity/action-retry-consistent
/// combination from [`sample_backend_fault`], for golden-vector coverage.
fn non_retryable_backend_fault() -> BackendFault {
    BackendFault {
        code: FaultCode::PermissionDenied,
        consequence: FaultConsequence::RunFailed,
        retry: FaultRetryDisposition::NotRetryable,
        action: FaultAction::Abort,
        severity: FaultSeverity::Critical,
        ..sample_backend_fault("evt-2")
    }
}

/// Commits one run through a real `AdmissionCoordinator`, attaches a watch subscription, then
/// emits the synthetic `NodeBegin`/`NodeEnd` golden-vector hook, and returns every
/// `EventNotification` an actual subscriber receives: the admission `Phase` transition followed
/// by the two synthetic node events.
async fn watch_session() -> Vec<EventNotification> {
    let (graph, dispatcher, store) = scripted_dispatcher(1);

    let apply_request = json!({
        "jsonrpc": "2.0", "id": "watch-golden-apply", "method": "apply",
        "params": {
            "graph": graph, "input": null, "ifGeneration": 0,
            "idempotencyKey": "watch-golden"
        }
    })
    .to_string();
    dispatcher.dispatch(&apply_request).await;

    let (result, mut stream, _handle) = dispatcher
        .watch(WatchParams::default())
        .await
        .assert_value_with("the admission backend must support watch");
    let run_id = result
        .run_id
        .clone()
        .assert_value_with("the seeded apply must have committed a run before watch attaches");

    let node = NodeAddress {
        node: NodeName::new("worker").assert_value_with("fixture node name must be valid"),
        attempt: PositiveInteger::new(1).assert_value_with("fixture attempt must be positive"),
    };
    store
        .emit_node_event(
            &run_id,
            node.clone(),
            NodeEventBody::Begin {
                input: json!({ "kind": "null" }),
            },
        )
        .await;
    store
        .emit_node_event(
            &run_id,
            node,
            NodeEventBody::End {
                outcome: WorkerOutcome::Verified {
                    output: Value::Null,
                    artifacts: vec![],
                },
            },
        )
        .await;

    let mut notifications = Vec::new();
    while notifications.len() < 3 {
        match stream.next().await {
            Some(WatchStreamItem::Record(record)) => {
                notifications.push(EventNotification {
                    subscription_id: result.subscription_id.clone(),
                    run_id: record.run_id,
                    cursor: record.cursor,
                    event: record.event,
                });
            }
            _ => break,
        }
    }
    notifications
}
