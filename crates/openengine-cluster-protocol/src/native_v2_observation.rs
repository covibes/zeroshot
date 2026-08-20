//! Additive, run-centric observation and force-stop wire contracts for native v2.
//!
//! These types deliberately do not change the legacy Cluster Protocol v1 methods. Native-v2
//! adapters bind them to status, watch, logs, attach, and force operations while sharing one
//! public [`RunId`]. [`ExecutionRef`] remains an opaque protocol-owned selector: status pairs it
//! with a graph node name so clients can distinguish simultaneous verifier executions without
//! learning product-local execution, capsule, harness, provider, or session identities.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::{
    AgentAttachEvent, Cursor, ExecutionRef, LogRecord, NodeName, RunId, SubscriptionId, RunSize,
    RunTitle, ResolvedSource, TerminalResult,
};

/// One currently active graph-leaf execution.
///
/// `execution` is the stable selector used by logs and attach. `node` is the graph-visible
/// identity that makes multiple simultaneous verifier executions obvious to a client.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ActiveExecution {
    pub execution: ExecutionRef,
    pub node: NodeName,
}

/// Public run state. The closed phase variants make impossible combinations unrepresentable:
/// admitted runs have no execution, stopping means force was requested, and finished runs have
/// exactly one terminal result and no active execution. Running/stopping report every active
/// execution rather than a single "current worker" slot.
#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields, tag = "phase", rename_all = "snake_case")]
pub enum RunStatus {
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

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RunStatusParams {
    pub run_id: RunId,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RunStatusResult {
    pub run_id: RunId,
    pub title: RunTitle,
    pub source: ResolvedSource,
    pub size: RunSize,
    pub at_cursor: Cursor,
    pub status: RunStatus,
}

/// Establishes a durable run watch.
///
/// `fromCursor` is exclusive. Reconnecting with the last delivered cursor therefore returns each
/// later watch record once, with no replayed boundary record and no skipped later record.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RunWatchParams {
    pub run_id: RunId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from_cursor: Option<Cursor>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RunWatchResult {
    pub subscription_id: SubscriptionId,
    pub run_id: RunId,
    pub at_cursor: Cursor,
}

/// One durable public status projection. `cursor` is stable run history, not a connection-local
/// sequence; clients resume strictly after it.
#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RunWatchEventNotification {
    pub subscription_id: SubscriptionId,
    pub run_id: RunId,
    pub title: RunTitle,
    pub source: ResolvedSource,
    pub size: RunSize,
    pub cursor: Cursor,
    pub status: RunStatus,
}

/// Establishes durable run log replay followed by live delivery.
///
/// An optional execution filter selects one active or settled execution using the exact opaque
/// reference advertised by status. `fromCursor` is exclusive, with the same reconnect semantics
/// as [`RunWatchParams`]. Omitting both fields after `runId` replays the run's complete retained
/// safe log history.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RunLogsParams {
    pub run_id: RunId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from_cursor: Option<Cursor>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub execution: Option<ExecutionRef>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RunLogsResult {
    pub subscription_id: SubscriptionId,
    pub run_id: RunId,
    pub at_cursor: Cursor,
}

/// One durable, reconnectable safe log record. Run-wide system records have no execution;
/// execution output carries the stable opaque selector used by status and attach.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RunLogEventNotification {
    pub subscription_id: SubscriptionId,
    pub run_id: RunId,
    pub cursor: Cursor,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub execution: Option<ExecutionRef>,
    pub record: LogRecord,
}

/// Establishes a live, read-only view of exactly one execution.
///
/// Attach has no cursor and no replay. Historical output is available through [`RunLogsParams`].
/// No client-to-execution input message exists in this contract.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RunAttachParams {
    pub run_id: RunId,
    pub execution: ExecutionRef,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RunAttachResult {
    pub subscription_id: SubscriptionId,
    pub run_id: RunId,
    pub execution: ExecutionRef,
}

/// One live read-only attach event. Carrying both identities prevents events from simultaneous
/// verifier attachments being confused on a multiplexed transport.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RunAttachEventNotification {
    pub subscription_id: SubscriptionId,
    pub run_id: RunId,
    pub execution: ExecutionRef,
    pub event: AgentAttachEvent,
}

/// Requests the MVP's only stop mode: force. Repeated requests are idempotent at the run ledger.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RunForceParams {
    pub run_id: RunId,
}

/// The durable run status after recording the force request.
#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RunForceResult {
    /// Public identity of the run whose force request was recorded.
    pub run_id: RunId,
    /// Immutable title captured when the run was admitted.
    pub title: RunTitle,
    /// Immutable repository snapshot captured when the run was admitted.
    pub source: ResolvedSource,
    /// Immutable execution size selected for the run.
    pub size: RunSize,
    /// Durable cursor after the force request was recorded.
    pub at_cursor: Cursor,
    /// Public phase projected after the force request was recorded.
    pub status: RunStatus,
}
