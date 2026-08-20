//! Deterministic schemas and examples for the additive native-v2 observation contract.

use crate::fixture::*;

use openengine_cluster_protocol::{
    ActiveExecution, AgentAttachEvent, BoundedAssistantOutput, BoundedLogMessage, BoundedLogTarget,
    Cursor, ExecutionRef, JsonRpcNotification, JsonRpcRequest, JsonRpcResponse, LogLevel,
    LogRecord, NodeName, RunAttachEventNotification, RunAttachParams, RunAttachResult,
    RunForceParams, RunForceResult, RunId, RunLogEventNotification, RunLogsParams, RunLogsResult,
    RunSize, RunStatus, RunStatusParams, RunStatusResult, RunTitle, RunWatchEventNotification,
    RunWatchParams, RunWatchResult, SourceBranchId, SourceRepositoryId, SourceRevisionId,
    ResolvedSource, SubscriptionId, TerminalResult,
};
use schemars::{schema_for, JsonSchema};
use serde_json::{json, Value};

use crate::artifacts::{json_artifact, Artifact};

const ROOT: &str = "protocol/openengine-cluster/v1";

#[derive(JsonSchema)]
pub struct NativeV2ObservationSchema {
    pub status_request: JsonRpcRequest<RunStatusParams>,
    pub status_response: JsonRpcResponse<RunStatusResult>,
    pub watch_request: JsonRpcRequest<RunWatchParams>,
    pub watch_response: JsonRpcResponse<RunWatchResult>,
    pub watch_event_notification: JsonRpcNotification<RunWatchEventNotification>,
    pub logs_request: JsonRpcRequest<RunLogsParams>,
    pub logs_response: JsonRpcResponse<RunLogsResult>,
    pub log_event_notification: JsonRpcNotification<RunLogEventNotification>,
    pub attach_request: JsonRpcRequest<RunAttachParams>,
    pub attach_response: JsonRpcResponse<RunAttachResult>,
    pub attach_event_notification: JsonRpcNotification<RunAttachEventNotification>,
    pub force_request: JsonRpcRequest<RunForceParams>,
    pub force_response: JsonRpcResponse<RunForceResult>,
}

pub(crate) fn artifacts() -> Vec<Artifact> {
    let schema = serde_json::to_value(schema_for!(NativeV2ObservationSchema))
        .assert_value_with("native-v2 observation schema serialization must succeed");
    vec![
        json_artifact(format!("{ROOT}/native-v2-observation.schema.json"), schema),
        json_artifact(
            format!("{ROOT}/fixtures/native_v2_observation/status.json"),
            serde_json::to_value(status()).assert_value(),
        ),
        json_artifact(
            format!("{ROOT}/fixtures/native_v2_observation/watch.json"),
            watch_fixture(),
        ),
        json_artifact(
            format!("{ROOT}/fixtures/native_v2_observation/logs.json"),
            logs_fixture(),
        ),
        json_artifact(
            format!("{ROOT}/fixtures/native_v2_observation/attach.json"),
            attach_fixture(),
        ),
        json_artifact(
            format!("{ROOT}/fixtures/native_v2_observation/force.json"),
            force_fixture(),
        ),
    ]
}

fn run_id() -> RunId {
    RunId::new("run-1")
}

fn cursor(value: u64) -> Cursor {
    Cursor::new(format!("v2:{value}"))
}

fn execution(value: &str) -> ExecutionRef {
    ExecutionRef::new(value).assert_value()
}

fn title() -> RunTitle {
    RunTitle::new("Repair checkout flow").assert_value()
}

pub fn native_v2_source_fixture() -> ResolvedSource {
    ResolvedSource {
        repository: SourceRepositoryId::new("open-engine/zeroshot").assert_value(),
        branch: SourceBranchId::new("main").assert_value(),
        revision: SourceRevisionId::new("0123456789abcdef0123456789abcdef01234567").assert_value(),
    }
}

fn status() -> RunStatusResult {
    RunStatusResult {
        run_id: run_id(),
        title: title(),
        source: native_v2_source_fixture(),
        size: RunSize::Standard,
        at_cursor: cursor(7),
        status: RunStatus::Running {
            active_executions: vec![
                ActiveExecution {
                    execution: execution("opaque-verifier-a"),
                    node: NodeName::new("verify-a").assert_value(),
                },
                ActiveExecution {
                    execution: execution("opaque-verifier-b"),
                    node: NodeName::new("verify-b").assert_value(),
                },
            ],
        },
    }
}

fn watch_fixture() -> Value {
    json!({
        "params": RunWatchParams {
            run_id: run_id(),
            from_cursor: Some(cursor(7)),
        },
        "result": RunWatchResult {
            subscription_id: SubscriptionId::new("watch-1"),
            run_id: run_id(),
            at_cursor: cursor(7),
        },
        "event": RunWatchEventNotification {
            subscription_id: SubscriptionId::new("watch-1"),
            run_id: run_id(),
            title: title(),
            source: native_v2_source_fixture(),
            size: RunSize::Standard,
            cursor: cursor(8),
            status: RunStatus::Finished {
                terminal_result: TerminalResult::Succeeded {
                    output: json!({
                        "kind": "verification_receipt",
                        "summary": "checkout repaired",
                        "passed": true
                    }),
                },
            },
        }
    })
}

fn logs_fixture() -> Value {
    json!({
        "params": RunLogsParams {
            run_id: run_id(),
            from_cursor: Some(cursor(7)),
            execution: Some(execution("opaque-verifier-b")),
        },
        "result": RunLogsResult {
            subscription_id: SubscriptionId::new("logs-1"),
            run_id: run_id(),
            at_cursor: cursor(7),
        },
        "event": RunLogEventNotification {
            subscription_id: SubscriptionId::new("logs-1"),
            run_id: run_id(),
            cursor: cursor(9),
            execution: Some(execution("opaque-verifier-b")),
            record: LogRecord {
                level: LogLevel::Info,
                target: BoundedLogTarget::new("agent").assert_value(),
                message: BoundedLogMessage::new("historical output").assert_value(),
            },
        }
    })
}

fn attach_fixture() -> Value {
    json!({
        "params": RunAttachParams {
            run_id: run_id(),
            execution: execution("opaque-verifier-b"),
        },
        "result": RunAttachResult {
            subscription_id: SubscriptionId::new("attach-1"),
            run_id: run_id(),
            execution: execution("opaque-verifier-b"),
        },
        "event": RunAttachEventNotification {
            subscription_id: SubscriptionId::new("attach-1"),
            run_id: run_id(),
            execution: execution("opaque-verifier-b"),
            event: AgentAttachEvent::Output {
                text: BoundedAssistantOutput::new("live output").assert_value(),
            },
        }
    })
}

fn force_fixture() -> Value {
    let mut result = status();
    result.at_cursor = cursor(10);
    let active_executions = match result.status {
        RunStatus::Running { active_executions } => Some(active_executions),
        _ => None,
    }
    .assert_value_with("fixture status must be running");
    result.status = RunStatus::Stopping { active_executions };
    json!({
        "params": RunForceParams { run_id: run_id() },
        "result": RunForceResult {
            run_id: result.run_id,
            title: result.title,
            source: result.source,
            size: result.size,
            at_cursor: result.at_cursor,
            status: result.status,
        }
    })
}
