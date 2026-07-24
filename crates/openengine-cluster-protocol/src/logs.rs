//! Capability-gated, cursorless, future-only bounded log records. `logs` has no run scoping, no
//! replay, and no reconnect: it is deliberately not a specialization of `watch`'s durable event
//! algebra, so none of `RunId`/`Cursor` appear anywhere in this module's wire types.

use std::borrow::Cow;

use schemars::{json_schema, JsonSchema, Schema, SchemaGenerator};
use serde::de;
use serde::{Deserialize, Deserializer, Serialize};
use thiserror::Error;

use crate::wire::impl_validate_gated_wire;
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

impl BoundedLogTarget {
    pub fn new(value: impl Into<String>) -> Result<Self, &'static str> {
        let value = value.into();
        if value.is_empty() {
            Err("value must not be empty")
        } else if value.len() > MAX_LOG_TARGET_BYTES || value.chars().any(char::is_control) {
            Err("value must be at most 128 non-control UTF-8 bytes")
        } else {
            Ok(Self(value))
        }
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl<'de> Deserialize<'de> for BoundedLogTarget {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        Self::new(String::deserialize(deserializer)?).map_err(de::Error::custom)
    }
}

impl JsonSchema for BoundedLogTarget {
    fn inline_schema() -> bool {
        true
    }

    fn schema_name() -> Cow<'static, str> {
        "BoundedLogTarget".into()
    }

    fn json_schema(_generator: &mut SchemaGenerator) -> Schema {
        json_schema!({
            "type": "string",
            "minLength": 1,
            "maxLength": MAX_LOG_TARGET_BYTES,
            "pattern": r"^[^\u0000-\u001f\u007f-\u009f]+$"
        })
    }
}

/// A possibly-empty, bounded, redacted-on-overflow log message. Bounded by UTF-8 byte length, not
/// character count. This is the only bounded fallback text available for an oversized message --
/// there is no raw passthrough path anywhere in this module.
#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(transparent)]
pub struct BoundedLogMessage(String);

impl BoundedLogMessage {
    pub fn new(value: impl Into<String>) -> Result<Self, &'static str> {
        let value = value.into();
        if value.len() > MAX_LOG_MESSAGE_BYTES || value.chars().any(char::is_control) {
            Err("value must be at most 16384 non-control UTF-8 bytes")
        } else {
            Ok(Self(value))
        }
    }

    /// The fixed bounded redaction marker used when a raw message could not be safely projected.
    #[must_use]
    pub fn redacted() -> Self {
        Self(REDACTED_LOG_MESSAGE.to_owned())
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl<'de> Deserialize<'de> for BoundedLogMessage {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        Self::new(String::deserialize(deserializer)?).map_err(de::Error::custom)
    }
}

impl JsonSchema for BoundedLogMessage {
    fn inline_schema() -> bool {
        true
    }

    fn schema_name() -> Cow<'static, str> {
        "BoundedLogMessage".into()
    }

    fn json_schema(_generator: &mut SchemaGenerator) -> Schema {
        json_schema!({
            "type": "string",
            "maxLength": MAX_LOG_MESSAGE_BYTES,
            "pattern": r"^[^\u0000-\u001f\u007f-\u009f]*$"
        })
    }
}

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
            .expect("LogEventNotificationRef fields serialize infallibly")
            .len();
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
