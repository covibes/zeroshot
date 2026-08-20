//! CLI-visible run lifecycle.
//!
//! `queued` is owned by a cloud host before a one-run controller exists. OECP begins at
//! `admitted`; local and direct target adapters therefore only convert the four OECP phases.

use openengine_cluster_protocol::{
    ActiveExecution, Cursor, RunForceResult, RunId, RunListResult, RunSize, RunStatus,
    RunStatusResult, RunTitle, RunWatchEventNotification, SubscriptionId, TerminalResult,
    ResolvedSource,
};
use serde::{Deserialize, Serialize};

/// Public lifecycle rendered by the native-v2 CLI.
///
/// Cloud-owned target startup is part of `queued`; there is deliberately no separate `starting`
/// phase. All other variants are mechanical projections of OECP [`RunStatus`] values.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields, tag = "phase", rename_all = "snake_case")]
pub enum CliRunStatus {
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

impl From<RunStatus> for CliRunStatus {
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
pub struct CliRunStatusResult {
    pub run_id: RunId,
    pub title: RunTitle,
    pub source: ResolvedSource,
    pub size: RunSize,
    pub at_cursor: Cursor,
    pub status: CliRunStatus,
}

impl From<RunStatusResult> for CliRunStatusResult {
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

impl From<RunForceResult> for CliRunStatusResult {
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
pub type CliRunForceResult = CliRunStatusResult;

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CliRunListResult {
    pub runs: Vec<CliRunStatusResult>,
}

impl From<RunListResult> for CliRunListResult {
    fn from(result: RunListResult) -> Self {
        Self {
            runs: result.runs.into_iter().map(Into::into).collect(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CliRunWatchEventNotification {
    pub subscription_id: SubscriptionId,
    pub run_id: RunId,
    pub title: RunTitle,
    pub source: ResolvedSource,
    pub size: RunSize,
    pub cursor: Cursor,
    pub status: CliRunStatus,
}

impl From<RunWatchEventNotification> for CliRunWatchEventNotification {
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

#[cfg(test)]
mod tests {
    use openengine_cluster_protocol::RunStatus;
    use openengine_cluster_testkit::assertions::AssertValue;
    use serde_json::json;

    use super::CliRunStatus;

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
            let oecp = serde_json::from_value::<RunStatus>(value).assert_value();
            assert!(!matches!(CliRunStatus::from(oecp), CliRunStatus::Queued {}));
        }
    }
}
