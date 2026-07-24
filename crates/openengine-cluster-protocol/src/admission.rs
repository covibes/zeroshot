//! Typed admission wire values for `plan`, `apply`, and authoritative `get`.

use schemars::{JsonSchema, Schema, SchemaGenerator};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;

use crate::{Generation, GraphDiagnostic, GraphSpec, NodeName, Phase, RunId, StructuralBounds};
use crate::value::BoundedString256;

pub const GRAPH_INVALID: &str = "GRAPH_INVALID";
pub const SCHEMA_VIOLATION: &str = "SCHEMA_VIOLATION";
pub const GENERATION_CONFLICT: &str = "GENERATION_CONFLICT";
pub const RUN_CONFLICT: &str = "RUN_CONFLICT";
pub const IDEMPOTENCY_REUSE: &str = "IDEMPOTENCY_REUSE";
pub const INVALID_PHASE: &str = "INVALID_PHASE";
pub const CANCELLED: &str = "CANCELLED";
pub const NO_RETRYABLE_FRONTIER: &str = "NO_RETRYABLE_FRONTIER";
pub const MAX_IDEMPOTENCY_KEY_LENGTH: usize = 256;

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct PlanParams {
    pub graph: GraphSpec,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct PlanResult {
    pub ok: bool,
    pub diagnostics: Vec<GraphDiagnostic>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bounds: Option<StructuralBounds>,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ApplyParams {
    pub graph: GraphSpec,
    #[serde(
        default,
        deserialize_with = "deserialize_present_value",
        skip_serializing_if = "Option::is_none"
    )]
    pub input: Option<Value>,
    #[serde(default)]
    pub dry_run: bool,
    #[serde(
        default,
        deserialize_with = "deserialize_present_generation",
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(schema_with = "generation_field_schema")]
    pub if_generation: Option<Generation>,
    #[serde(
        default,
        deserialize_with = "deserialize_present_idempotency_key",
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(schema_with = "idempotency_key_field_schema")]
    pub idempotency_key: Option<IdempotencyKey>,
}

pub(crate) fn deserialize_present_value<'de, D>(deserializer: D) -> Result<Option<Value>, D::Error>
where
    D: Deserializer<'de>,
{
    Value::deserialize(deserializer).map(Some)
}

fn deserialize_present_idempotency_key<'de, D>(
    deserializer: D,
) -> Result<Option<IdempotencyKey>, D::Error>
where
    D: Deserializer<'de>,
{
    IdempotencyKey::deserialize(deserializer).map(Some)
}

fn deserialize_present_generation<'de, D>(deserializer: D) -> Result<Option<Generation>, D::Error>
where
    D: Deserializer<'de>,
{
    Generation::deserialize(deserializer).map(Some)
}

fn generation_field_schema(generator: &mut SchemaGenerator) -> Schema {
    generator.subschema_for::<Generation>()
}

fn idempotency_key_field_schema(generator: &mut SchemaGenerator) -> Schema {
    generator.subschema_for::<IdempotencyKey>()
}

#[derive(Clone, Debug, Default, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct GraphDiff {
    pub added: Vec<NodeName>,
    pub removed: Vec<NodeName>,
    pub changed: Vec<NodeName>,
}

impl GraphDiff {
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.added.is_empty() && self.removed.is_empty() && self.changed.is_empty()
    }
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ApplyResult {
    pub generation: Option<Generation>,
    pub run_id: Option<RunId>,
    pub phase: Phase,
    pub deduped: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diff: Option<GraphDiff>,
}

pub type IdempotencyKey = BoundedString256;
pub type IdempotencyKeyError = &'static str;
