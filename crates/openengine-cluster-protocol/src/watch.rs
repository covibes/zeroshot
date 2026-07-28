//! Durable watch events, opaque cursors, and generic subscription wire framing.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{
    BackendFault, ClusterStatus, Cursor, GraphSpec, NodeName, PositiveInteger, RequestId, RunId,
    StopMode, WorkerOutcome,
};

pub const NOT_FOUND: &str = "NOT_FOUND";
pub const GONE: &str = "GONE";
pub const SLOW_CONSUMER: &str = "SLOW_CONSUMER";

/// Default bounded per-subscription live-delivery queue capacity.
pub const DEFAULT_SUBSCRIPTION_QUEUE_CAPACITY: usize = 1024;

#[derive(Clone, Debug, Deserialize, Eq, Hash, JsonSchema, PartialEq, Serialize)]
#[serde(transparent)]
pub struct SubscriptionId(String);

impl SubscriptionId {
    #[must_use]
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Clone, Debug, Default, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct WatchParams {
    #[serde(default)]
    pub run_id: Option<RunId>,
    #[serde(default)]
    pub from_cursor: Option<Cursor>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchResult {
    pub subscription_id: SubscriptionId,
    pub run_id: Option<RunId>,
    pub at_cursor: Option<Cursor>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct NodeAddress {
    pub node: NodeName,
    pub attempt: PositiveInteger,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct AdmissionTransition {
    pub run_id: RunId,
    pub spec: GraphSpec,
    pub seed_input: Value,
}

/// The closed public event algebra. `Phase` folds the observable cluster status (admission
/// commit, update, suspend/resume, stop-request); `NodeBegin`/`NodeEnd` are a testkit-only
/// synthetic hook decoupled from the real dispatch/lease turn mechanism, since no native graph
/// executor exists yet; `Bookmark` advances the cursor without changing folded public state;
/// `Fault` carries a durable, backend-neutral projected `BackendFault`: it correlates to the
/// enclosing `EventNotification.run_id` plus its own optional opaque `executionRef`, and its
/// ordering/emission never itself authorizes a retry or changes terminal semantics -- it folds to
/// no public status change, exactly like `Bookmark`; `Finished` is always the last event for a
/// run.
#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields, tag = "type", rename_all = "snake_case")]
pub enum WatchEvent {
    Phase {
        status: ClusterStatus,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        admission: Option<Box<AdmissionTransition>>,
    },
    NodeBegin {
        node: NodeAddress,
        input: Value,
    },
    NodeEnd {
        node: NodeAddress,
        outcome: WorkerOutcome,
    },
    Bookmark,
    Fault {
        fault: BackendFault,
    },
    Finished {
        final_status: ClusterStatus,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        stop_mode: Option<StopMode>,
    },
}

/// Wire body of the generic `event` server notification.
#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct EventNotification {
    pub subscription_id: SubscriptionId,
    pub run_id: RunId,
    pub cursor: Cursor,
    pub event: WatchEvent,
}

/// Wire body of the generic `subscription/cancel` client notification.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SubscriptionCancelParams {
    pub subscription_id: SubscriptionId,
}

/// Wire body of the `$/cancelRequest` client notification: best-effort cancellation of an
/// in-flight unary request by its `RequestId`. Unknown or already-completed ids are a silent
/// no-op; cancelling after the backend has committed leaves that committed state unchanged and
/// emits no response or compensation.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CancelRequestParams {
    pub id: RequestId,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
pub enum SubscriptionCloseReason {
    #[serde(rename = "done")]
    Done,
    #[serde(rename = "SLOW_CONSUMER")]
    SlowConsumer,
}

/// Wire body of the terminal `subscription/closed` server notification.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SubscriptionClosedNotification {
    pub subscription_id: SubscriptionId,
    pub reason: SubscriptionCloseReason,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_delivered_cursor: Option<Cursor>,
}
