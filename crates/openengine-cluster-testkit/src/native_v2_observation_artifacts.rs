//! Deterministic schemas and examples for the additive native-v2 observation contract.

use openengine_cluster_protocol::{
    ActiveExecution, AgentAttachEvent, BoundedAssistantOutput, BoundedLogMessage, BoundedLogTarget,
    Cursor, ExecutionRef, JsonRpcNotification, JsonRpcRequest, JsonRpcResponse, LogLevel,
    LogRecord, NodeName, RunAttachEventNotification, RunAttachParams, RunAttachResult,
    RunForceParams, RunForceResult, RunId, RunLogEventNotification, RunLogsParams, RunLogsResult,
    RunStatus, RunStatusParams, RunStatusResult, RunWatchEventNotification, RunWatchParams,
    RunWatchResult, SubscriptionId,
};
use schemars::{schema_for, JsonSchema};
use serde_json::{json, Value};

use crate::artifacts::{json_artifact, Artifact};

const ROOT: &str = "protocol/openengine-cluster/v1";

#[derive(JsonSchema)]
#[allow(dead_code)] // Schema witness: fields exist only so schemars retains every wire root.
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
        .expect("native-v2 observation schema serialization must succeed");
    vec![
        json_artifact(format!("{ROOT}/native-v2-observation.schema.json"), schema),
        json_artifact(
            format!("{ROOT}/fixtures/native_v2_observation/status.json"),
            serde_json::to_value(status()).unwrap(),
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
    ExecutionRef::new(value).unwrap()
}

fn status() -> RunStatusResult {
    RunStatusResult {
        run_id: run_id(),
        at_cursor: cursor(7),
        status: RunStatus::Running {
            active_executions: vec![
                ActiveExecution {
                    execution: execution("opaque-verifier-a"),
                    node: NodeName::new("verify-a").unwrap(),
                },
                ActiveExecution {
                    execution: execution("opaque-verifier-b"),
                    node: NodeName::new("verify-b").unwrap(),
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
            cursor: cursor(8),
            status: status().status,
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
                target: BoundedLogTarget::new("agent").unwrap(),
                message: BoundedLogMessage::new("historical output").unwrap(),
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
                text: BoundedAssistantOutput::new("live output").unwrap(),
            },
        }
    })
}

fn force_fixture() -> Value {
    let mut result = status();
    result.at_cursor = cursor(10);
    let active_executions = match result.status {
        RunStatus::Running { active_executions } => active_executions,
        _ => unreachable!("fixture status is running"),
    };
    result.status = RunStatus::Stopping { active_executions };
    json!({
        "params": RunForceParams { run_id: run_id() },
        "result": RunForceResult {
            run_id: result.run_id,
            at_cursor: result.at_cursor,
            status: result.status,
        }
    })
}
