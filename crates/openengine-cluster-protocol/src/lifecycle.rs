//! Typed operational lifecycle controls for admitted runs.

use std::borrow::Cow;
use std::collections::BTreeMap;

use schemars::{JsonSchema, Schema, SchemaGenerator};
use serde::de;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;

use crate::admission::deserialize_present_value;
use crate::value::{identifier_keyed_map_schema, BoundedString256};
use crate::{Cursor, Generation, IdempotencyKey, Phase, RunId};

pub const MAX_LABELS: usize = 64;

/// A bounded label key or value.
pub type Label = BoundedString256;

/// A complete, deterministically ordered replacement label map.
#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize)]
#[serde(transparent)]
pub struct Labels(BTreeMap<Label, Label>);

impl Labels {
    pub fn new(labels: BTreeMap<Label, Label>) -> Result<Self, &'static str> {
        if labels.len() > MAX_LABELS {
            Err("labels must contain at most 64 entries")
        } else {
            Ok(Self(labels))
        }
    }

    #[must_use]
    pub fn as_map(&self) -> &BTreeMap<Label, Label> {
        &self.0
    }

    #[must_use]
    pub fn into_map(self) -> BTreeMap<Label, Label> {
        self.0
    }
}

impl<'de> Deserialize<'de> for Labels {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        Self::new(BTreeMap::deserialize(deserializer)?).map_err(de::Error::custom)
    }
}

impl JsonSchema for Labels {
    fn schema_name() -> Cow<'static, str> {
        "Labels".into()
    }

    fn json_schema(generator: &mut SchemaGenerator) -> Schema {
        let mut schema = identifier_keyed_map_schema::<Label, Label>(generator);
        schema.insert("maxProperties".into(), MAX_LABELS.into());
        schema
    }
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LogLevel {
    Trace,
    Debug,
    #[default]
    Info,
    Warn,
    Error,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DispatchState {
    #[default]
    Active,
    Suspended,
    Draining,
    ForceStopping,
    Stopped,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum StopMode {
    Drain,
    Force,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TurnFailureKind {
    Failed,
    Refused,
    Timeout,
    Crash,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NoRetryableFrontierReason {
    Exhausted,
    Success,
    Active,
    Consumed,
}

impl NoRetryableFrontierReason {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Exhausted => "exhausted",
            Self::Success => "success",
            Self::Active => "active",
            Self::Consumed => "consumed",
        }
    }
}

impl std::fmt::Display for NoRetryableFrontierReason {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.as_str())
    }
}

#[derive(Clone, Debug, Default, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct OperationalStatus {
    pub labels: Labels,
    pub log_level: LogLevel,
    pub dispatch_state: DispatchState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stop_mode: Option<StopMode>,
    pub in_flight: u32,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct UpdateParams {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub labels: Option<Labels>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub log_level: Option<LogLevel>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub suspended: Option<bool>,
    pub if_generation: Generation,
    pub idempotency_key: IdempotencyKey,
}

impl UpdateParams {
    /// Validates invariants that serde enforces for wire callers but typed callers can bypass.
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.labels.is_none() && self.log_level.is_none() && self.suspended.is_none() {
            Err("update requires at least one of labels, logLevel, or suspended")
        } else {
            Ok(())
        }
    }
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct UpdateParamsSchema {
    #[serde(default, deserialize_with = "deserialize_present_labels")]
    labels: Option<Labels>,
    #[serde(default, deserialize_with = "deserialize_present_log_level")]
    log_level: Option<LogLevel>,
    #[serde(default, deserialize_with = "deserialize_present_bool")]
    suspended: Option<bool>,
    if_generation: Generation,
    idempotency_key: IdempotencyKey,
}

impl<'de> Deserialize<'de> for UpdateParams {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = UpdateParamsSchema::deserialize(deserializer)?;
        let params = Self {
            labels: value.labels,
            log_level: value.log_level,
            suspended: value.suspended,
            if_generation: value.if_generation,
            idempotency_key: value.idempotency_key,
        };
        params.validate().map_err(de::Error::custom)?;
        Ok(params)
    }
}

impl JsonSchema for UpdateParams {
    fn schema_name() -> Cow<'static, str> {
        "UpdateParams".into()
    }

    fn json_schema(generator: &mut SchemaGenerator) -> Schema {
        let mut schema = UpdateParamsSchema::json_schema(generator);
        let properties = schema
            .get_mut("properties")
            .and_then(serde_json::Value::as_object_mut)
            .expect("derived update schema has properties");
        properties.insert(
            "labels".into(),
            serde_json::to_value(generator.subschema_for::<Labels>())
                .expect("labels schema serializes"),
        );
        properties.insert(
            "logLevel".into(),
            serde_json::to_value(generator.subschema_for::<LogLevel>())
                .expect("log-level schema serializes"),
        );
        properties.insert("suspended".into(), serde_json::json!({ "type": "boolean" }));
        schema.insert(
            "anyOf".into(),
            serde_json::json!([
                { "required": ["labels"] },
                { "required": ["logLevel"] },
                { "required": ["suspended"] }
            ]),
        );
        schema
    }
}

fn deserialize_present_labels<'de, D>(deserializer: D) -> Result<Option<Labels>, D::Error>
where
    D: Deserializer<'de>,
{
    Labels::deserialize(deserializer).map(Some)
}

fn deserialize_present_log_level<'de, D>(deserializer: D) -> Result<Option<LogLevel>, D::Error>
where
    D: Deserializer<'de>,
{
    LogLevel::deserialize(deserializer).map(Some)
}

fn deserialize_present_bool<'de, D>(deserializer: D) -> Result<Option<bool>, D::Error>
where
    D: Deserializer<'de>,
{
    bool::deserialize(deserializer).map(Some)
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct StopParams {
    pub mode: StopMode,
    pub if_generation: Generation,
    pub idempotency_key: IdempotencyKey,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct UpdateResult {
    pub generation: Generation,
    pub run_id: RunId,
    pub phase: Phase,
    pub operational: OperationalStatus,
    pub at_cursor: Cursor,
    pub deduped: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct StopResult {
    pub generation: Generation,
    pub run_id: RunId,
    pub phase: Phase,
    pub accepted_mode: StopMode,
    pub effective_mode: StopMode,
    pub operational: OperationalStatus,
    pub at_cursor: Cursor,
    pub deduped: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RetryParams {
    pub if_generation: Generation,
    pub idempotency_key: IdempotencyKey,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RetryResult {
    pub generation: Generation,
    pub run_id: RunId,
    pub phase: Phase,
    pub retried_turn_id: String,
    pub retry_turn_id: String,
    pub operational: OperationalStatus,
    pub at_cursor: Cursor,
    pub deduped: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ResubmitParams {
    pub if_generation: Generation,
    pub if_run_id: RunId,
    pub idempotency_key: IdempotencyKey,
    #[serde(
        default,
        deserialize_with = "deserialize_present_value",
        skip_serializing_if = "Option::is_none"
    )]
    pub replacement_input: Option<Value>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ResubmitResult {
    pub generation: Generation,
    pub prior_run_id: RunId,
    pub run_id: RunId,
    pub phase: Phase,
    pub operational: OperationalStatus,
    pub at_cursor: Cursor,
    pub deduped: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct DeleteParams {
    pub if_generation: Generation,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub if_run_id: Option<RunId>,
    pub idempotency_key: IdempotencyKey,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct DeleteResult {
    pub deleted: bool,
    pub phase: Phase,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub generation: Option<Generation>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_id: Option<RunId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub at_cursor: Option<Cursor>,
    pub deduped: bool,
}
