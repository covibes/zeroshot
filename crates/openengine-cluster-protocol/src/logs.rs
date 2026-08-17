//! Capability-gated, cursorless, future-only bounded log records. `logs` has no run scoping, no
//! replay, and no reconnect: it is deliberately not a specialization of `watch`'s durable event
//! algebra, so none of `RunId`/`Cursor` appear anywhere in this module's wire types.

use std::borrow::Cow;

use schemars::{JsonSchema, Schema, SchemaGenerator};
use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::wire::{
    impl_bounded_nonempty_string, impl_bounded_redactable_string, impl_validate_gated_wire,
};
use crate::{LogLevel, SubscriptionCloseReason, SubscriptionId};

pub const MAX_LOG_TARGET_BYTES: usize = 128;
pub const MAX_LOG_MESSAGE_BYTES: usize = 16_384;
pub const MAX_LOG_EVENT_ENCODED_BYTES: usize = 65_536;
pub const REDACTED_LOG_MESSAGE: &str = "<redacted: message exceeded bounds>";

/// A non-empty, bounded log target (for example a module or component name). Bounded by UTF-8
/// byte length, not character count.
#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(transparent)]
pub struct BoundedLogTarget(String);

impl_bounded_nonempty_string!(
    BoundedLogTarget,
    MAX_LOG_TARGET_BYTES,
    "128",
    "BoundedLogTarget"
);

/// A possibly-empty, bounded, redacted-on-overflow log message. Bounded by UTF-8 byte length, not
/// character count. This is the only bounded fallback text available for an oversized message --
/// there is no raw passthrough path anywhere in this module.
#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(transparent)]
pub struct BoundedLogMessage(String);

impl_bounded_redactable_string!(
    BoundedLogMessage,
    MAX_LOG_MESSAGE_BYTES,
    "16384",
    "BoundedLogMessage",
    REDACTED_LOG_MESSAGE
);

/// The closed public log record shape: a level, a bounded target, and a bounded (possibly
/// redacted) message. No raw bytes, reasoning, tools, credentials, env, or provider/session IDs
/// are representable.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct LogRecord {
    pub level: LogLevel,
    pub target: BoundedLogTarget,
    pub message: BoundedLogMessage,
}

/// `logs` establishment parameters. v1 has zero caller filters: this is deliberately empty and
/// closed, rejecting any unknown field.
#[derive(Clone, Debug, Default, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct LogsParams {}

/// The `logs` establishment result: only a `subscriptionId`. Deliberately carries no `runId` or
/// `atCursor` -- `logs` is not run-scoped and has no cursor.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct LogsResult {
    pub subscription_id: SubscriptionId,
}

#[derive(Clone, Copy, Debug, Error, Eq, PartialEq)]
pub enum LogEventValidationError {
    #[error("log event encoded JSON exceeds {MAX_LOG_EVENT_ENCODED_BYTES} bytes")]
    EncodedTooLarge,
}

/// Wire body of the generic `event` server notification when carrying a log record. A closed,
/// bounded, validate-gated wire type: both `Serialize` and `Deserialize` run
/// [`LogEventNotification::validate`], so an oversized encoding can never be produced or accepted
/// on the wire.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LogEventNotification {
    pub subscription_id: SubscriptionId,
    pub record: LogRecord,
}

impl LogEventNotification {
    pub fn validate(&self) -> Result<(), LogEventValidationError> {
        let encoded_len = serde_json::to_vec(&LogEventNotificationRef::from(self))
            .map_or(usize::MAX, |encoded| encoded.len());
        if encoded_len > MAX_LOG_EVENT_ENCODED_BYTES {
            return Err(LogEventValidationError::EncodedTooLarge);
        }
        Ok(())
    }
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct LogEventNotificationWire {
    subscription_id: SubscriptionId,
    record: LogRecord,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LogEventNotificationRef<'a> {
    subscription_id: &'a SubscriptionId,
    record: &'a LogRecord,
}

impl From<LogEventNotificationWire> for LogEventNotification {
    fn from(wire: LogEventNotificationWire) -> Self {
        Self {
            subscription_id: wire.subscription_id,
            record: wire.record,
        }
    }
}

impl<'a> From<&'a LogEventNotification> for LogEventNotificationRef<'a> {
    fn from(notification: &'a LogEventNotification) -> Self {
        Self {
            subscription_id: &notification.subscription_id,
            record: &notification.record,
        }
    }
}

impl_validate_gated_wire!(
    LogEventNotification,
    LogEventNotificationWire,
    LogEventNotificationRef
);

impl JsonSchema for LogEventNotification {
    fn schema_name() -> Cow<'static, str> {
        "LogEventNotification".into()
    }

    fn json_schema(generator: &mut SchemaGenerator) -> Schema {
        generator.subschema_for::<LogEventNotificationWire>()
    }
}

/// Wire body of the terminal `subscription/closed` server notification for a `logs` subscription.
/// Deliberately carries no cursor field -- `logs` gives a type-level "cursorless" guarantee, unlike
/// [`crate::SubscriptionClosedNotification`].
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct LogsClosedNotification {
    pub subscription_id: SubscriptionId,
    pub reason: SubscriptionCloseReason,
}
