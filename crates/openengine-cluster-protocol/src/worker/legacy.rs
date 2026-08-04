//! Reserved legacy Zeroshot single-worker facade contract.

use std::borrow::Cow;
use std::collections::BTreeMap;

use schemars::{json_schema, JsonSchema, Schema, SchemaGenerator};
use serde::{Deserialize, Serialize};

use super::{RegistryProfileRef, WorkerContractError};
use crate::{ArtifactRef, EnumLabel, FieldName, NonEmptyEnumSet, PayloadType, RecordField};

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LegacyShipSourceKind {
    Issue,
    Prompt,
    Artifact,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(
    deny_unknown_fields,
    rename_all = "camelCase",
    try_from = "LegacyShipRequestWire"
)]
pub struct LegacyShipRequest {
    pub source: LegacyShipSourceKind,
    pub issue: Option<String>,
    pub prompt: Option<String>,
    pub artifacts: Vec<ArtifactRef>,
    pub isolation_profile: RegistryProfileRef,
    pub provider_profile: RegistryProfileRef,
    pub repository: String,
    pub provider: String,
    pub model_level: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct LegacyShipRequestWire {
    source: LegacyShipSourceKind,
    issue: Option<String>,
    prompt: Option<String>,
    artifacts: Vec<ArtifactRef>,
    isolation_profile: RegistryProfileRef,
    provider_profile: RegistryProfileRef,
    repository: String,
    provider: String,
    model_level: String,
}

impl LegacyShipRequest {
    pub fn validate(&self) -> Result<(), WorkerContractError> {
        let valid = match self.source {
            LegacyShipSourceKind::Issue => self.valid_issue_source(),
            LegacyShipSourceKind::Prompt => self.valid_prompt_source(),
            LegacyShipSourceKind::Artifact => self.valid_artifact_source(),
        } && nonempty_string(&self.repository)
            && nonempty_string(&self.provider)
            && matches!(self.model_level.as_str(), "level1" | "level2" | "level3");
        valid
            .then_some(())
            .ok_or(WorkerContractError::InvalidLegacySource)
    }

    fn valid_issue_source(&self) -> bool {
        nonempty(&self.issue) && self.prompt.is_none() && self.artifacts.is_empty()
    }

    fn valid_prompt_source(&self) -> bool {
        nonempty(&self.prompt) && self.issue.is_none() && self.artifacts.is_empty()
    }

    fn valid_artifact_source(&self) -> bool {
        !self.artifacts.is_empty() && self.issue.is_none() && self.prompt.is_none()
    }
}

fn nonempty(value: &Option<String>) -> bool {
    value.as_ref().is_some_and(|value| !value.trim().is_empty())
}

fn nonempty_string(value: &str) -> bool {
    !value.trim().is_empty()
}

impl TryFrom<LegacyShipRequestWire> for LegacyShipRequest {
    type Error = WorkerContractError;

    fn try_from(wire: LegacyShipRequestWire) -> Result<Self, Self::Error> {
        let request = Self {
            source: wire.source,
            issue: wire.issue,
            prompt: wire.prompt,
            artifacts: wire.artifacts,
            isolation_profile: wire.isolation_profile,
            provider_profile: wire.provider_profile,
            repository: wire.repository,
            provider: wire.provider,
            model_level: wire.model_level,
        };
        request.validate()?;
        Ok(request)
    }
}

impl JsonSchema for LegacyShipRequest {
    fn schema_name() -> Cow<'static, str> {
        "LegacyShipRequest".into()
    }

    fn json_schema(generator: &mut SchemaGenerator) -> Schema {
        json_schema!({
            "type": "object",
            "additionalProperties": false,
            "required": ["source", "artifacts", "isolationProfile", "providerProfile", "repository", "provider", "modelLevel"],
            "properties": {
                "source": { "enum": ["issue", "prompt", "artifact"] },
                "issue": { "type": ["string", "null"] },
                "prompt": { "type": ["string", "null"] },
                "artifacts": { "type": "array", "items": generator.subschema_for::<ArtifactRef>() },
                "isolationProfile": generator.subschema_for::<RegistryProfileRef>(),
                "providerProfile": generator.subschema_for::<RegistryProfileRef>(),
                "repository": { "type": "string", "minLength": 1, "pattern": "\\S" },
                "provider": { "type": "string", "minLength": 1, "pattern": "\\S" },
                "modelLevel": { "enum": ["level1", "level2", "level3"] }
            },
            "oneOf": source_schemas()
        })
    }
}

fn source_schemas() -> Vec<serde_json::Value> {
    vec![
        text_source_schema("issue", "issue", "prompt"),
        text_source_schema("prompt", "prompt", "issue"),
        artifact_source_schema(),
    ]
}

fn text_source_schema(source: &str, present: &str, absent: &str) -> serde_json::Value {
    serde_json::json!({
        "properties": {
            "source": { "const": source },
            present: { "type": "string", "minLength": 1, "pattern": "\\S" },
            absent: { "type": "null" },
            "artifacts": { "maxItems": 0 }
        },
        "required": [present]
    })
}

fn artifact_source_schema() -> serde_json::Value {
    serde_json::json!({
        "properties": {
            "source": { "const": "artifact" },
            "issue": { "type": "null" },
            "prompt": { "type": "null" },
            "artifacts": { "minItems": 1 }
        }
    })
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LegacyShipStatus {
    Succeeded,
    Failed,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(
    deny_unknown_fields,
    rename_all = "camelCase",
    try_from = "LegacyShipResultWire"
)]
pub struct LegacyShipResult {
    pub summary: String,
    pub status: LegacyShipStatus,
    pub artifacts: Vec<ArtifactRef>,
    pub repository: Option<String>,
    pub branch: Option<String>,
    pub head_revision: Option<String>,
    pub pull_request_url: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct LegacyShipResultWire {
    summary: String,
    status: LegacyShipStatus,
    artifacts: Vec<ArtifactRef>,
    repository: Option<String>,
    branch: Option<String>,
    head_revision: Option<String>,
    pull_request_url: Option<String>,
}

impl LegacyShipResult {
    pub fn validate(&self) -> Result<(), WorkerContractError> {
        let receipt = [
            self.repository.as_deref(),
            self.branch.as_deref(),
            self.head_revision.as_deref(),
            self.pull_request_url.as_deref(),
        ];
        let valid = nonempty_string(&self.summary)
            && match self.status {
                LegacyShipStatus::Succeeded => {
                    receipt.iter().all(|value| value.is_none())
                        || receipt
                            .into_iter()
                            .all(|value| value.is_some_and(nonempty_string))
                }
                LegacyShipStatus::Failed => receipt.into_iter().all(|value| value.is_none()),
            };
        valid
            .then_some(())
            .ok_or(WorkerContractError::InvalidLegacySource)
    }
}

impl TryFrom<LegacyShipResultWire> for LegacyShipResult {
    type Error = WorkerContractError;

    fn try_from(wire: LegacyShipResultWire) -> Result<Self, Self::Error> {
        let result = Self {
            summary: wire.summary,
            status: wire.status,
            artifacts: wire.artifacts,
            repository: wire.repository,
            branch: wire.branch,
            head_revision: wire.head_revision,
            pull_request_url: wire.pull_request_url,
        };
        result.validate()?;
        Ok(result)
    }
}

impl JsonSchema for LegacyShipResult {
    fn schema_name() -> Cow<'static, str> {
        "LegacyShipResult".into()
    }

    fn json_schema(generator: &mut SchemaGenerator) -> Schema {
        json_schema!({
            "type": "object",
            "additionalProperties": false,
            "required": ["summary", "status", "artifacts"],
            "properties": {
                "summary": { "type": "string", "minLength": 1, "pattern": "\\S" },
                "status": { "enum": ["succeeded", "failed"] },
                "artifacts": { "type": "array", "items": generator.subschema_for::<ArtifactRef>() },
                "repository": { "type": ["string", "null"] },
                "branch": { "type": ["string", "null"] },
                "headRevision": { "type": ["string", "null"] },
                "pullRequestUrl": { "type": ["string", "null"] }
            },
            "oneOf": [
                {
                    "properties": {
                        "status": { "const": "succeeded" },
                        "repository": { "type": "string", "minLength": 1, "pattern": "\\S" },
                        "branch": { "type": "string", "minLength": 1, "pattern": "\\S" },
                        "headRevision": { "type": "string", "minLength": 1, "pattern": "\\S" },
                        "pullRequestUrl": { "type": "string", "minLength": 1, "pattern": "\\S" }
                    },
                    "required": ["repository", "branch", "headRevision", "pullRequestUrl"]
                },
                {
                    "properties": {
                        "status": { "const": "succeeded" },
                        "repository": { "type": "null" },
                        "branch": { "type": "null" },
                        "headRevision": { "type": "null" },
                        "pullRequestUrl": { "type": "null" }
                    }
                },
                {
                    "properties": {
                        "status": { "const": "failed" },
                        "repository": { "type": "null" },
                        "branch": { "type": "null" },
                        "headRevision": { "type": "null" },
                        "pullRequestUrl": { "type": "null" }
                    }
                }
            ]
        })
    }
}

/// Canonical graph-level input contract reserved for `legacy.zeroshot.ship@1`.
#[must_use]
pub fn legacy_ship_request_payload_type() -> PayloadType {
    record([
        ("source", enumeration(["issue", "prompt", "artifact"]), true),
        ("issue", PayloadType::String, false),
        ("prompt", PayloadType::String, false),
        (
            "artifacts",
            PayloadType::Array {
                items: Box::new(artifact_ref_payload_type()),
            },
            true,
        ),
        ("isolationProfile", PayloadType::String, true),
        ("providerProfile", PayloadType::String, true),
        ("repository", PayloadType::String, true),
        ("provider", PayloadType::String, true),
        (
            "modelLevel",
            enumeration(["level1", "level2", "level3"]),
            true,
        ),
    ])
}

/// Canonical graph-level terminal result contract reserved for `legacy.zeroshot.ship@1`.
#[must_use]
pub fn legacy_ship_result_payload_type() -> PayloadType {
    record([
        ("summary", PayloadType::String, true),
        ("status", enumeration(["succeeded", "failed"]), true),
        (
            "artifacts",
            PayloadType::Array {
                items: Box::new(artifact_ref_payload_type()),
            },
            true,
        ),
        ("repository", PayloadType::String, false),
        ("branch", PayloadType::String, false),
        ("headRevision", PayloadType::String, false),
        ("pullRequestUrl", PayloadType::String, false),
    ])
}

fn artifact_ref_payload_type() -> PayloadType {
    record([
        ("artifactId", PayloadType::String, true),
        ("sha256", PayloadType::String, true),
        ("byteLength", PayloadType::Integer, true),
        ("mediaType", PayloadType::String, true),
        ("typeId", PayloadType::String, true),
        (
            "producer",
            record([
                ("node", PayloadType::String, true),
                ("worker", PayloadType::String, true),
            ]),
            true,
        ),
        (
            "lineage",
            record([
                ("generation", PayloadType::Integer, true),
                ("runId", PayloadType::String, true),
                ("attempt", PayloadType::Integer, true),
            ]),
            true,
        ),
        (
            "redaction",
            enumeration(["public", "internal", "confidential", "restricted"]),
            true,
        ),
    ])
}

fn record<const N: usize>(fields: [(&str, PayloadType, bool); N]) -> PayloadType {
    PayloadType::Record {
        fields: fields
            .into_iter()
            .map(|(name, value_type, required)| {
                (
                    FieldName::new(name).expect("legacy contract field names are valid"),
                    RecordField {
                        value_type,
                        required,
                    },
                )
            })
            .collect::<BTreeMap<_, _>>(),
    }
}

fn enumeration<const N: usize>(values: [&str; N]) -> PayloadType {
    PayloadType::Enum {
        values: NonEmptyEnumSet::new(
            values
                .into_iter()
                .map(|value| EnumLabel::new(value).expect("legacy enum labels are valid"))
                .collect(),
        )
        .expect("legacy enum sets are non-empty"),
    }
}
