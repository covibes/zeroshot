#[path = "support/assert_value.rs"]
mod assert_value;

#[path = "support/json_read.rs"]
mod json_read;

use assert_value::AssertValue;
use openengine_cluster_protocol::{
    ActiveExecution, Cursor, ExecutionRef, NodeName, RunAttachEventNotification, RunAttachParams,
    RunForceParams, RunForceResult, RunId, RunLogEventNotification, RunLogsParams, RunMetadata,
    RunSize, RunStatus, RunStatusParams, RunStatusResult, RunTitle, RunWatchEventNotification,
    RunWatchParams, ResolvedSource, SubscriptionId, TerminalResult, TokenCount, TokenUsage,
    MAX_SAFE_GENERATION,
};
use serde_json::json;

fn title() -> RunTitle {
    RunTitle::new("Repair checkout flow").assert_value()
}

fn source() -> ResolvedSource {
    serde_json::from_slice(
        br#"{
            "repository": "open-engine/zeroshot",
            "branch": "main",
            "revision": "0123456789abcdef0123456789abcdef01234567"
        }"#,
    )
    .assert_value()
}

fn execution(value: &str) -> ExecutionRef {
    ExecutionRef::new(value).assert_value()
}

fn active(execution_ref: &str, node: &str) -> ActiveExecution {
    ActiveExecution {
        execution: execution(execution_ref),
        node: NodeName::new(node).assert_value(),
    }
}

fn running_status() -> RunStatus {
    RunStatus::Running {
        active_executions: vec![
            active("opaque-verifier-a", "verify-a"),
            active("opaque-verifier-b", "verify-b"),
        ],
    }
}

#[test]
fn status_exposes_every_parallel_execution_without_private_identity() {
    let result = RunStatusResult {
        run_id: RunId::new("run-1"),
        title: title(),
        source: source(),
        size: RunSize::Standard,
        at_cursor: Cursor::new("v2:7"),
        status: running_status(),
    };
    let value = serde_json::to_value(&result).assert_value();

    assert_eq!(
        value,
        json!({
            "runId": "run-1",
            "title": "Repair checkout flow",
            "source": {
                "repository": "open-engine/zeroshot",
                "branch": "main",
                "revision": "0123456789abcdef0123456789abcdef01234567"
            },
            "size": "standard",
            "atCursor": "v2:7",
            "status": {
                "phase": "running",
                "activeExecutions": [
                    { "execution": "opaque-verifier-a", "node": "verify-a" },
                    { "execution": "opaque-verifier-b", "node": "verify-b" }
                ]
            }
        })
    );
    let encoded = serde_json::to_string(&value).assert_value();
    for private_name in ["capsule", "session", "provider", "executionId"] {
        assert!(!encoded.contains(private_name));
    }
    assert!(
        serde_json::from_value::<RunStatusResult>(json!({
            "runId": "run-1",
            "title": "Repair checkout flow",
            "source": {
                "repository": "open-engine/zeroshot",
                "branch": "main",
                "revision": "0123456789abcdef0123456789abcdef01234567"
            },
            "size": "standard",
            "atCursor": "v2:7",
            "status": {
                "phase": "running",
                "activeExecutions": [],
                "sessionId": "private"
            }
        }))
        .is_err()
    );
}

#[test]
fn watch_and_logs_use_required_run_id_and_exclusive_resume_cursor() {
    let watch = RunWatchParams {
        run_id: RunId::new("run-1"),
        from_cursor: Some(Cursor::new("v2:7")),
    };
    assert_eq!(
        serde_json::to_value(&watch).assert_value(),
        json!({ "runId": "run-1", "fromCursor": "v2:7" })
    );

    let logs = RunLogsParams {
        run_id: RunId::new("run-1"),
        from_cursor: Some(Cursor::new("v2:7")),
        execution: Some(execution("opaque-verifier-b")),
    };
    assert_eq!(
        serde_json::to_value(&logs).assert_value(),
        json!({
            "runId": "run-1",
            "fromCursor": "v2:7",
            "execution": "opaque-verifier-b"
        })
    );

    assert!(serde_json::from_value::<RunWatchParams>(json!({})).is_err());
    assert!(serde_json::from_value::<RunLogsParams>(json!({ "fromCursor": "v2:7" })).is_err());
}

#[test]
fn token_usage_rejects_counters_that_javascript_cannot_represent_exactly() {
    assert!(TokenCount::new(MAX_SAFE_GENERATION).is_ok());
    assert!(TokenCount::new(MAX_SAFE_GENERATION + 1).is_err());
    assert!(
        serde_json::from_value::<TokenUsage>(json!({
            "inputTokens": MAX_SAFE_GENERATION + 1,
            "outputTokens": 0,
            "complete": true
        }))
        .is_err()
    );
}

#[test]
fn durable_events_carry_run_and_stable_cursor() {
    let terminal_output = json!({
        "kind": "verification_receipt",
        "summary": "checkout repaired",
        "passed": true
    });
    let watch = RunWatchEventNotification {
        subscription_id: SubscriptionId::new("watch-1"),
        run_id: RunId::new("run-1"),
        title: title(),
        source: source(),
        size: RunSize::Standard,
        cursor: Cursor::new("v2:8"),
        status: RunStatus::Finished {
            terminal_result: TerminalResult::Succeeded {
                output: terminal_output.clone(),
            },
            metadata: RunMetadata {
                token_usage: Some(TokenUsage {
                    input_tokens: TokenCount::new(17).assert_value(),
                    output_tokens: TokenCount::new(3).assert_value(),
                    cache_read_input_tokens: None,
                    cache_creation_input_tokens: None,
                    complete: false,
                }),
            },
        },
    };
    let value = serde_json::to_value(&watch).assert_value();
    assert_eq!(json_read::json_at(&value, "/cursor"), &json!("v2:8"));
    assert_eq!(
        json_read::json_at(&value, "/title"),
        &json!("Repair checkout flow")
    );
    assert_eq!(json_read::json_at(&value, "/size"), &json!("standard"));
    assert_eq!(
        json_read::json_at(&value, "/status/terminalResult/output"),
        &terminal_output
    );
    assert_eq!(
        json_read::json_at(&value, "/status/metadata/tokenUsage"),
        &json!({
            "inputTokens": 17,
            "outputTokens": 3,
            "complete": false
        })
    );

    let value = json!({
        "subscriptionId": "logs-1",
        "runId": "run-1",
        "cursor": "v2:9",
        "execution": "opaque-verifier-b",
        "record": {
            "level": "info",
            "target": "agent",
            "message": "historical output"
        }
    });
    let log: RunLogEventNotification = serde_json::from_value(value.clone()).assert_value();
    assert_eq!(serde_json::to_value(log).assert_value(), value);
    assert_eq!(json_read::json_at(&value, "/runId"), &json!("run-1"));
    assert_eq!(json_read::json_at(&value, "/cursor"), &json!("v2:9"));
    assert_eq!(
        json_read::json_at(&value, "/execution"),
        &json!("opaque-verifier-b")
    );
}

#[test]
fn attach_is_live_read_only_and_explicitly_selects_one_execution() {
    let params = RunAttachParams {
        run_id: RunId::new("run-1"),
        execution: execution("opaque-verifier-b"),
    };
    assert_eq!(
        serde_json::to_value(&params).assert_value(),
        json!({ "runId": "run-1", "execution": "opaque-verifier-b" })
    );
    assert!(
        serde_json::from_value::<RunAttachParams>(json!({
            "runId": "run-1",
            "execution": "opaque-verifier-b",
            "input": "write to the agent"
        }))
        .is_err()
    );

    let value = json!({
        "subscriptionId": "attach-1",
        "runId": "run-1",
        "execution": "opaque-verifier-b",
        "event": { "type": "output", "text": "live output" }
    });
    let event: RunAttachEventNotification = serde_json::from_value(value.clone()).assert_value();
    assert_eq!(serde_json::to_value(event).assert_value(), value);
    assert_eq!(json_read::json_at(&value, "/runId"), &json!("run-1"));
    assert_eq!(
        json_read::json_at(&value, "/execution"),
        &json!("opaque-verifier-b")
    );
    assert!(value.get("cursor").is_none());
}

#[test]
fn force_is_the_only_stop_shape_and_returns_durable_status() {
    let params = RunForceParams {
        run_id: RunId::new("run-1"),
    };
    assert_eq!(
        serde_json::to_value(&params).assert_value(),
        json!({ "runId": "run-1" })
    );
    assert!(
        serde_json::from_value::<RunForceParams>(json!({
            "runId": "run-1",
            "mode": "drain"
        }))
        .is_err()
    );

    let result = RunForceResult {
        run_id: RunId::new("run-1"),
        title: title(),
        source: source(),
        size: RunSize::Standard,
        at_cursor: Cursor::new("v2:10"),
        status: RunStatus::Stopping {
            active_executions: vec![active("opaque-verifier-b", "verify-b")],
        },
    };
    let value = serde_json::to_value(result).assert_value();
    assert_eq!(
        json_read::json_at(&value, "/status/phase"),
        &json!("stopping")
    );
}

#[test]
fn every_operation_rejects_unknown_or_missing_public_run_identity() {
    assert!(serde_json::from_value::<RunStatusParams>(json!({})).is_err());
    assert!(
        serde_json::from_value::<RunStatusParams>(json!({
            "runId": "run-1",
            "capsuleId": "private"
        }))
        .is_err()
    );
}
