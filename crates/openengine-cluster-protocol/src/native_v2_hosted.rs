//! Host-owned native-v2 lifecycle projections.
//!
//! A host may own a run before its OECP target exists. `queued` is the sole host-only phase;
//! every later phase is a mechanical projection of the target's OECP lifecycle.

use serde::{Deserialize, Serialize};

use crate::{
    ActiveExecution, Cursor, RunForceResult, RunId, RunListResult, RunLogEventNotification,
    RunSize, RunStatus, RunStatusResult, RunTitle, RunWatchEventNotification,
    SubscriptionCloseReason, SubscriptionId, TerminalResult, ResolvedSource,
};

/// Lifecycle exposed by a hosted target.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields, tag = "phase", rename_all = "snake_case")]
pub enum HostedRunStatus {
    Queued {},
    Admitted {},
    Running {
        #[serde(rename = "activeExecutions")]
        active_executions: Vec<ActiveExecution>,
    },
    Stopping {
        #[serde(rename = "activeExecutions")]
        active_executions: Vec<ActiveExecution>,
    },
    Finished {
        #[serde(rename = "terminalResult")]
        terminal_result: TerminalResult,
    },
}

impl From<RunStatus> for HostedRunStatus {
    fn from(status: RunStatus) -> Self {
        match status {
            RunStatus::Admitted {} => Self::Admitted {},
            RunStatus::Running { active_executions } => Self::Running { active_executions },
            RunStatus::Stopping { active_executions } => Self::Stopping { active_executions },
            RunStatus::Finished { terminal_result } => Self::Finished { terminal_result },
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct HostedRunStatusResult {
    pub run_id: RunId,
    pub title: RunTitle,
    pub source: ResolvedSource,
    pub size: RunSize,
    pub at_cursor: Cursor,
    pub status: HostedRunStatus,
}

impl From<RunStatusResult> for HostedRunStatusResult {
    fn from(result: RunStatusResult) -> Self {
        Self {
            run_id: result.run_id,
            title: result.title,
            source: result.source,
            size: result.size,
            at_cursor: result.at_cursor,
            status: result.status.into(),
        }
    }
}

impl From<RunForceResult> for HostedRunStatusResult {
    fn from(result: RunForceResult) -> Self {
        Self {
            run_id: result.run_id,
            title: result.title,
            source: result.source,
            size: result.size,
            at_cursor: result.at_cursor,
            status: result.status.into(),
        }
    }
}

/// Force returns the same run projection as status.
pub type HostedRunForceResult = HostedRunStatusResult;

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct HostedRunListResult {
    pub runs: Vec<HostedRunStatusResult>,
}

impl From<RunListResult> for HostedRunListResult {
    fn from(result: RunListResult) -> Self {
        Self {
            runs: result.runs.into_iter().map(Into::into).collect(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct HostedRunWatchEventNotification {
    pub subscription_id: SubscriptionId,
    pub run_id: RunId,
    pub title: RunTitle,
    pub source: ResolvedSource,
    pub size: RunSize,
    pub cursor: Cursor,
    pub status: HostedRunStatus,
}

impl From<RunWatchEventNotification> for HostedRunWatchEventNotification {
    fn from(event: RunWatchEventNotification) -> Self {
        Self {
            subscription_id: event.subscription_id,
            run_id: event.run_id,
            title: event.title,
            source: event.source,
            size: event.size,
            cursor: event.cursor,
            status: event.status.into(),
        }
    }
}

/// One host lifecycle stream frame. Hosts use this shape for both watch and logs streams.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(
    bound(deserialize = "E: Deserialize<'de>"),
    bound(serialize = "E: Serialize"),
    deny_unknown_fields,
    rename_all = "snake_case",
    tag = "type"
)]
pub enum HostedRunStreamFrame<E> {
    Event { event: E },
    Closed { reason: SubscriptionCloseReason },
}

pub type HostedRunLogStreamFrame = HostedRunStreamFrame<RunLogEventNotification>;
pub type HostedRunWatchStreamFrame = HostedRunStreamFrame<HostedRunWatchEventNotification>;

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{HostedRunStatus, HostedRunStreamFrame};
    use crate::{RunStatus, SubscriptionCloseReason};

    #[test]
    fn oecp_status_conversion_never_synthesizes_queued() {
        for value in [
            json!({"phase":"admitted"}),
            json!({"phase":"running","activeExecutions":[]}),
            json!({"phase":"stopping","activeExecutions":[]}),
            json!({
                "phase":"finished",
                "terminalResult":{"status":"succeeded","output":null}
            }),
        ] {
            let oecp = serde_json::from_value::<RunStatus>(value);
            assert!(oecp.is_ok());
            let Ok(oecp) = oecp else {
                return;
            };
            assert!(!matches!(
                HostedRunStatus::from(oecp),
                HostedRunStatus::Queued {}
            ));
        }
    }

    #[test]
    fn closed_stream_frame_has_stable_ndjson_shape() {
        let frame = HostedRunStreamFrame::<serde_json::Value>::Closed {
            reason: SubscriptionCloseReason::Done,
        };
        let serialized = serde_json::to_value(frame);
        assert!(
            serialized
                .as_ref()
                .is_ok_and(|value| value == &json!({"type":"closed","reason":"done"}))
        );
    }
}
