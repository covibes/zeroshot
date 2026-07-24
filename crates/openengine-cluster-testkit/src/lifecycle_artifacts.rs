//! Generated operational lifecycle transcript fixtures.

use openengine_cluster_protocol::TurnFailureKind;
use openengine_cluster_server::lifecycle::{FailedCompletion, TurnId};
use serde_json::json;

use crate::admission_artifacts::{scripted_dispatcher, transcript};
use crate::artifacts::Artifact;

pub(crate) async fn generate_lifecycle_goldens() -> Vec<Artifact> {
    let (graph, dispatcher, store) = scripted_dispatcher(1);
    let mut artifact = transcript(
        "lifecycle-controls.ndjson",
        &dispatcher,
        vec![json!({
            "jsonrpc":"2.0","id":"lifecycle-apply","method":"apply",
            "params":{"graph":graph,"input":null,"ifGeneration":0,"idempotencyKey":"lifecycle-create"}
        })],
    )
    .await;

    let permit = store
        .acquire_dispatch(TurnId::new("lifecycle-turn"))
        .await
        .expect("golden dispatch succeeds");
    store
        .fail_dispatch(FailedCompletion {
            lease_id: permit.lease_id,
            kind: TurnFailureKind::Timeout,
            retryability: openengine_cluster_server::lifecycle::FailureRetryability::Retryable,
        })
        .await
        .expect("golden dispatch failure succeeds");

    let remainder = transcript(
        "lifecycle-controls.ndjson",
        &dispatcher,
        vec![
            json!({
                "jsonrpc":"2.0","id":"lifecycle-retry","method":"retry",
                "params":{"ifGeneration":1,"idempotencyKey":"lifecycle-retry"}
            }),
            json!({
                "jsonrpc":"2.0","id":"lifecycle-update","method":"update",
                "params":{"labels":{"environment":"test"},"logLevel":"debug","suspended":false,
                    "ifGeneration":1,"idempotencyKey":"lifecycle-update"}
            }),
            json!({
                "jsonrpc":"2.0","id":"lifecycle-stop","method":"stop",
                "params":{"mode":"drain","ifGeneration":1,"idempotencyKey":"lifecycle-stop"}
            }),
            json!({
                "jsonrpc":"2.0","id":"lifecycle-get","method":"get","params":{}
            }),
        ],
    )
    .await;
    artifact.bytes.extend_from_slice(&remainder.bytes);
    vec![artifact]
}

pub(crate) async fn generate_resubmit_goldens() -> Vec<Artifact> {
    let (graph, dispatcher, _store) = scripted_dispatcher(1);
    let artifact = transcript(
        "lifecycle-resubmit.ndjson",
        &dispatcher,
        vec![
            json!({
                "jsonrpc":"2.0","id":"resubmit-apply","method":"apply",
                "params":{"graph":graph,"input":null,"ifGeneration":0,"idempotencyKey":"resubmit-create"}
            }),
            json!({
                "jsonrpc":"2.0","id":"resubmit-stop","method":"stop",
                "params":{"mode":"force","ifGeneration":1,"idempotencyKey":"resubmit-stop"}
            }),
            json!({
                "jsonrpc":"2.0","id":"resubmit-resubmit","method":"resubmit",
                "params":{"ifGeneration":1,"ifRunId":"run-1","idempotencyKey":"resubmit-resubmit"}
            }),
            json!({
                "jsonrpc":"2.0","id":"resubmit-get","method":"get","params":{}
            }),
        ],
    )
    .await;
    vec![artifact]
}

pub(crate) async fn generate_delete_goldens() -> Vec<Artifact> {
    let (graph, dispatcher, _store) = scripted_dispatcher(1);
    let artifact = transcript(
        "lifecycle-delete.ndjson",
        &dispatcher,
        vec![
            json!({
                "jsonrpc":"2.0","id":"delete-apply","method":"apply",
                "params":{"graph":graph,"input":null,"ifGeneration":0,"idempotencyKey":"delete-create"}
            }),
            json!({
                "jsonrpc":"2.0","id":"delete-stop","method":"stop",
                "params":{"mode":"force","ifGeneration":1,"idempotencyKey":"delete-stop"}
            }),
            json!({
                "jsonrpc":"2.0","id":"delete-delete","method":"delete",
                "params":{"ifGeneration":1,"ifRunId":"run-1","idempotencyKey":"delete-delete"}
            }),
            json!({
                "jsonrpc":"2.0","id":"delete-get","method":"get","params":{}
            }),
        ],
    )
    .await;
    vec![artifact]
}
