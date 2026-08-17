//! Capability-gated, future-only, read-only `agent/attach` subscription. Scoped to a single bounded
//! opaque [`ExecutionRef`] rather than being cluster-wide. Only a closed `Working`/`Output`/
//! `Settled` progress algebra is representable: reasoning, tools, provider frames, usage, and
//! session identifiers have no variant. Like [`crate::logs`], this has no run scoping, no replay,
//! and no reconnect: none of `RunId`/`Cursor` appear anywhere in this module's wire types.

use std::borrow::Cow;

use schemars::{JsonSchema, Schema, SchemaGenerator};
use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::wire::{
    impl_bounded_nonempty_string, impl_bounded_redactable_string, impl_validate_gated_wire,
};
use crate::{SubscriptionCloseReason, SubscriptionId};

pub const MAX_EXECUTION_REF_BYTES: usize = 128;
pub const MAX_ASSISTANT_OUTPUT_BYTES: usize = 16_384;
pub const MAX_AGENT_ATTACH_EVENT_ENCODED_BYTES: usize = 65_536;
pub const REDACTED_ASSISTANT_OUTPUT: &str = "<redacted: output exceeded bounds>";

/// A non-empty, bounded, opaque reference to a native execution. Native execution ids are private
/// numeric values; this is deliberately an opaque bounded string rather than exposing storage
/// identity. Bounded by UTF-8 byte length, not character count.
#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(transparent)]
pub struct ExecutionRef(String);

impl_bounded_nonempty_string!(ExecutionRef, MAX_EXECUTION_REF_BYTES, "128", "ExecutionRef");

/// A possibly-empty, bounded, redacted-on-overflow assistant-display output chunk. Bounded by
/// UTF-8 byte length, not character count. This is the only bounded fallback text available for an
/// oversized output -- there is no raw passthrough path anywhere in this module.
#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(transparent)]
pub struct BoundedAssistantOutput(String);

impl_bounded_redactable_string!(
    BoundedAssistantOutput,
    MAX_ASSISTANT_OUTPUT_BYTES,
    "16384",
    "BoundedAssistantOutput",
    REDACTED_ASSISTANT_OUTPUT
);

/// `agent/attach` establishment parameters: the named `{execution}` request. Deliberately closed,
/// rejecting any unknown field.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct AgentAttachParams {
    pub execution: ExecutionRef,
}

/// The `agent/attach` establishment result: only a `subscriptionId`. Deliberately carries no
/// `runId` or `atCursor` -- `agent/attach` is not run-scoped and has no cursor.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct AgentAttachResult {
    pub subscription_id: SubscriptionId,
}

/// The closed public agent-attach progress algebra. This is the only representable shape:
/// reasoning, tools, provider frames, usage, and session identifiers have no variant. `Working`
/// and `Settled` are empty struct variants rather than bare units: serde's internally tagged enum
/// deserialization silently ignores unknown fields on a unit variant regardless of
/// `deny_unknown_fields`, which would otherwise let an unrepresentable field ride along
/// undetected on either of these two variants.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields, tag = "type", rename_all = "snake_case")]
pub enum AgentAttachEvent {
    Working {},
    Output { text: BoundedAssistantOutput },
    Settled {},
}

#[derive(Clone, Copy, Debug, Error, Eq, PartialEq)]
pub enum AgentAttachEventValidationError {
    #[error("agent attach event encoded JSON exceeds {MAX_AGENT_ATTACH_EVENT_ENCODED_BYTES} bytes")]
    EncodedTooLarge,
}

/// Wire body of the generic `event` server notification when carrying an agent-attach progress
/// event. A closed, bounded, validate-gated wire type: both `Serialize` and `Deserialize` run
/// [`AgentAttachEventNotification::validate`], so an oversized encoding can never be produced or
/// accepted on the wire.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentAttachEventNotification {
    pub subscription_id: SubscriptionId,
    pub event: AgentAttachEvent,
}

impl AgentAttachEventNotification {
    pub fn validate(&self) -> Result<(), AgentAttachEventValidationError> {
        let encoded_len = serde_json::to_vec(&AgentAttachEventNotificationRef::from(self))
            .map_or(usize::MAX, |encoded| encoded.len());
        if encoded_len > MAX_AGENT_ATTACH_EVENT_ENCODED_BYTES {
            return Err(AgentAttachEventValidationError::EncodedTooLarge);
        }
        Ok(())
    }
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct AgentAttachEventNotificationWire {
    subscription_id: SubscriptionId,
    event: AgentAttachEvent,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentAttachEventNotificationRef<'a> {
    subscription_id: &'a SubscriptionId,
    event: &'a AgentAttachEvent,
}

impl From<AgentAttachEventNotificationWire> for AgentAttachEventNotification {
    fn from(wire: AgentAttachEventNotificationWire) -> Self {
        Self {
            subscription_id: wire.subscription_id,
            event: wire.event,
        }
    }
}

impl<'a> From<&'a AgentAttachEventNotification> for AgentAttachEventNotificationRef<'a> {
    fn from(notification: &'a AgentAttachEventNotification) -> Self {
        Self {
            subscription_id: &notification.subscription_id,
            event: &notification.event,
        }
    }
}

impl_validate_gated_wire!(
    AgentAttachEventNotification,
    AgentAttachEventNotificationWire,
    AgentAttachEventNotificationRef
);

impl JsonSchema for AgentAttachEventNotification {
    fn schema_name() -> Cow<'static, str> {
        "AgentAttachEventNotification".into()
    }

    fn json_schema(generator: &mut SchemaGenerator) -> Schema {
        generator.subschema_for::<AgentAttachEventNotificationWire>()
    }
}

/// Wire body of the terminal `subscription/closed` server notification for an `agent/attach`
/// subscription. Deliberately carries no cursor field -- `agent/attach` gives a type-level
/// "cursorless" guarantee, unlike [`crate::SubscriptionClosedNotification`].
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct AgentAttachClosedNotification {
    pub subscription_id: SubscriptionId,
    pub reason: SubscriptionCloseReason,
}
