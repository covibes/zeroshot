use openengine_cluster_protocol::{LegacyShipRequest, WorkerErrorCode};
use serde_json::json;
use tokio::sync::watch;

use super::{normalize_terminal_receipt, validate_started_receipt, WorkerError};
use crate::hosted_oecp::test_support::NodeWorkerFixture;

fn request() -> LegacyShipRequest {
    serde_json::from_value(json!({
        "source": "prompt",
        "issue": null,
        "prompt": "perform the prepared task",
        "artifacts": [],
        "isolationProfile": "isolation.prepared-worktree@1",
        "providerProfile": "provider.fixed-proxy@1"
    }))
    .expect("legacy request")
}

#[test]
fn untrusted_failure_payload_is_reduced_to_a_closed_outcome() {
    let canary = "OPENROUTER_FAILURE_CANARY";
    let outcome = normalize_terminal_receipt(
        json!({
            "state": "failed",
            "clusterId": "untrusted-cluster",
            "finishedAt": 1,
            "outcome": {
                "status": "verified",
                "output": { "secret": canary },
                "artifacts": []
            }
        }),
        None,
    );
    assert_eq!(outcome.error_code(), Some(WorkerErrorCode::Crash));
    assert!(
        !serde_json::to_string(&outcome)
            .expect("closed outcome serializes")
            .contains(canary)
    );
}

#[test]
fn timed_out_worker_receipt_preserves_timeout_error_code() {
    let outcome = normalize_terminal_receipt(
        json!({
            "state": "timed_out",
            "clusterId": "hosted-timeout",
            "finishedAt": 1,
            "outcome": {
                "status": "error",
                "code": "timeout",
                "reason": "declared_failure"
            }
        }),
        Some("hosted-timeout"),
    );
    assert_eq!(outcome.error_code(), Some(WorkerErrorCode::Timeout));
}

#[test]
fn worker_receipts_must_preserve_one_strict_resource_identity() {
    let started = validate_started_receipt(json!({
        "state": "running",
        "clusterId": "hosted-resource-1",
        "sequence": 1,
        "stopRequested": false,
        "terminal": false
    }))
    .expect("canonical start receipt");
    let mismatched = normalize_terminal_receipt(
        json!({
            "state": "completed",
            "clusterId": "hosted-resource-2",
            "finishedAt": 1,
            "result": {
                "summary": "untrusted",
                "status": "succeeded",
                "artifacts": []
            }
        }),
        Some(&started),
    );
    assert_eq!(mismatched.error_code(), Some(WorkerErrorCode::Malformed));
    assert_eq!(
        validate_started_receipt(json!({
            "state": "running",
            "clusterId": "hosted-resource-1",
            "sequence": 1,
            "stopRequested": false,
            "terminal": false,
            "unexpected": true
        })),
        Err(WorkerError::Protocol)
    );
}

#[tokio::test]
async fn root_exit_reaps_forked_and_double_forked_descendants() {
    let fixture = NodeWorkerFixture::new("worker");
    let (_cancel, observer) = watch::channel(false);
    let mut execution = fixture.spawn(&request(), observer, "main").await;
    let outcome = execution
        .wait_terminal()
        .await
        .expect("worker terminal response");
    assert!(outcome.error_code().is_none());
    fixture.assert_stopped(execution).await;
}

#[tokio::test]
async fn cancellation_reaps_ignored_signal_process_tree() {
    let fixture = NodeWorkerFixture::new("worker");
    let (cancel, observer) = watch::channel(false);
    let mut execution = fixture.spawn(&request(), observer, "main").await;
    cancel.send_replace(true);
    assert!(matches!(
        execution.wait_terminal().await,
        Err(WorkerError::Exited | WorkerError::Cleanup)
    ));
    fixture.assert_stopped(execution).await;
}

#[tokio::test]
async fn protocol_failure_reaps_ignored_signal_process_tree() {
    let fixture = NodeWorkerFixture::new("worker");
    let (_cancel, observer) = watch::channel(false);
    let mut execution = fixture.spawn(&request(), observer, "bad-result").await;
    assert_eq!(execution.wait_terminal().await, Err(WorkerError::Protocol));
    fixture.assert_stopped(execution).await;
}
