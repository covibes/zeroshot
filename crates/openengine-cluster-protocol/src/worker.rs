//! Stable worker descriptors and byte-free normalized worker outcomes.
//!
//! These types deliberately describe resolution contracts only. They contain no command,
//! endpoint, transport, credential value, callback, or execution configuration.

use std::borrow::Cow;
use std::collections::BTreeMap;

use schemars::{json_schema, JsonSchema, Schema, SchemaGenerator};
use serde::de;
use serde::{Deserialize, Deserializer, Serialize};

use crate::{
    FieldName, GraphProfile, MediaType, NonEmptyEnumSet, PayloadType, RedactionClass, TypeId,
    WorkerErrorCode, WorkerRef, LEGACY_ZEROSHOT_WORKER, SINGLE_WORKER_GRAPH_PROFILE,
};

mod error;
mod legacy;
mod outcome;
pub use error::*;
pub use legacy::*;
pub use outcome::*;

pub const ACP_VERSION: &str = "1";
pub const ACP_PROFILE: &str = "openengine.worker.acp/v1";
pub const A2A_VERSION: &str = "1.0";
pub const A2A_PROFILE: &str = "openengine.worker.a2a/1.0";
pub const LEGACY_ZEROSHOT_VERSION: &str = "1";
pub const LEGACY_ZEROSHOT_PROFILE: &str = "legacy.zeroshot.ship/v1";
pub const BUILTIN_VERSION: &str = "1";
pub const BUILTIN_PROFILE: &str = "openengine.worker.builtin/v1";
pub const RUNTIME_WORKER_ERRORS: [WorkerErrorCode; 4] = [
    WorkerErrorCode::Timeout,
    WorkerErrorCode::Crash,
    WorkerErrorCode::Malformed,
    WorkerErrorCode::Refusal,
];

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkerProtocol {
    Acp,
    A2a,
    LegacyZeroshot,
    Builtin,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct WorkerProtocolBinding {
    pub protocol: WorkerProtocol,
    pub version: String,
    pub profile: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct WorkerProtocolBindingWire {
    protocol: WorkerProtocol,
    version: String,
    profile: String,
}

impl WorkerProtocolBinding {
    pub fn new(
        protocol: WorkerProtocol,
        version: impl Into<String>,
        profile: impl Into<String>,
    ) -> Result<Self, WorkerContractError> {
        let binding = Self {
            protocol,
            version: version.into(),
            profile: profile.into(),
        };
        binding.validate()?;
        Ok(binding)
    }

    pub fn acp_v1() -> Self {
        Self::new(WorkerProtocol::Acp, ACP_VERSION, ACP_PROFILE)
            .expect("built-in ACP binding is valid")
    }

    pub fn a2a_1_0() -> Self {
        Self::new(WorkerProtocol::A2a, A2A_VERSION, A2A_PROFILE)
            .expect("built-in A2A binding is valid")
    }

    pub fn legacy_zeroshot_ship_v1() -> Self {
        Self::new(
            WorkerProtocol::LegacyZeroshot,
            LEGACY_ZEROSHOT_VERSION,
            LEGACY_ZEROSHOT_PROFILE,
        )
        .expect("built-in legacy binding is valid")
    }

    pub fn builtin_v1() -> Self {
        Self::new(WorkerProtocol::Builtin, BUILTIN_VERSION, BUILTIN_PROFILE)
            .expect("built-in binding is valid")
    }

    pub fn validate(&self) -> Result<(), WorkerContractError> {
        let expected = expected_binding(self.protocol);
        if (self.version.as_str(), self.profile.as_str()) == expected {
            Ok(())
        } else {
            Err(WorkerContractError::UnsupportedProtocolBinding)
        }
    }
}

const fn expected_binding(protocol: WorkerProtocol) -> (&'static str, &'static str) {
    match protocol {
        WorkerProtocol::Acp => (ACP_VERSION, ACP_PROFILE),
        WorkerProtocol::A2a => (A2A_VERSION, A2A_PROFILE),
        WorkerProtocol::LegacyZeroshot => (LEGACY_ZEROSHOT_VERSION, LEGACY_ZEROSHOT_PROFILE),
        WorkerProtocol::Builtin => (BUILTIN_VERSION, BUILTIN_PROFILE),
    }
}

impl<'de> Deserialize<'de> for WorkerProtocolBinding {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let wire = WorkerProtocolBindingWire::deserialize(deserializer)?;
        Self::new(wire.protocol, wire.version, wire.profile).map_err(de::Error::custom)
    }
}

impl JsonSchema for WorkerProtocolBinding {
    fn schema_name() -> Cow<'static, str> {
        "WorkerProtocolBinding".into()
    }

    fn json_schema(_generator: &mut SchemaGenerator) -> Schema {
        json_schema!({
            "oneOf": [
                {
                    "type": "object",
                    "additionalProperties": false,
                    "required": ["protocol", "version", "profile"],
                    "properties": {
                        "protocol": { "const": "acp" },
                        "version": { "const": ACP_VERSION },
                        "profile": { "const": ACP_PROFILE }
                    }
                },
                {
                    "type": "object",
                    "additionalProperties": false,
                    "required": ["protocol", "version", "profile"],
                    "properties": {
                        "protocol": { "const": "a2a" },
                        "version": { "const": A2A_VERSION },
                        "profile": { "const": A2A_PROFILE }
                    }
                },
                {
                    "type": "object",
                    "additionalProperties": false,
                    "required": ["protocol", "version", "profile"],
                    "properties": {
                        "protocol": { "const": "legacy_zeroshot" },
                        "version": { "const": LEGACY_ZEROSHOT_VERSION },
                        "profile": { "const": LEGACY_ZEROSHOT_PROFILE }
                    }
                },
                {
                    "type": "object",
                    "additionalProperties": false,
                    "required": ["protocol", "version", "profile"],
                    "properties": {
                        "protocol": { "const": "builtin" },
                        "version": { "const": BUILTIN_VERSION },
                        "profile": { "const": BUILTIN_PROFILE }
                    }
                }
            ]
        })
    }
}

/// Opaque registry identity. The handle can select secret material but can never contain it.
#[derive(
    Clone, Debug, Deserialize, Eq, Hash, JsonSchema, Ord, PartialEq, PartialOrd, Serialize,
)]
#[serde(transparent)]
#[schemars(transparent)]
pub struct CredentialHandle(crate::PolicyRef);

impl CredentialHandle {
    pub fn new(value: impl Into<String>) -> Result<Self, WorkerContractError> {
        crate::PolicyRef::new(value)
            .map(Self)
            .map_err(|_| WorkerContractError::InvalidOpaqueHandle)
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        self.0.as_str()
    }
}

/// Opaque registry-owned provider or isolation profile identity.
pub type RegistryProfileRef = CredentialHandle;

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AutonomyPolicy {
    #[default]
    Strict,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CapabilityPolicy {
    pub autonomy: AutonomyPolicy,
    pub permission_policy: crate::PolicyRef,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct VerifierContract {
    #[schemars(
        schema_with = "crate::value::identifier_keyed_map_schema::<FieldName, NonEmptyEnumSet>"
    )]
    pub signals: BTreeMap<FieldName, NonEmptyEnumSet>,
    pub diagnostic: PayloadType,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct WorkerContract {
    pub input: PayloadType,
    pub output: PayloadType,
    pub verifier: Option<VerifierContract>,
    #[schemars(schema_with = "closed_worker_errors_schema")]
    pub errors: Vec<WorkerErrorCode>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ArtifactResultProfile {
    #[schemars(schema_with = "nonempty_unique_array_schema::<TypeId>")]
    pub allowed_type_ids: Vec<TypeId>,
    #[schemars(schema_with = "nonempty_unique_array_schema::<MediaType>")]
    pub allowed_media_types: Vec<MediaType>,
    pub minimum_redaction: RedactionClass,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct WorkerDescriptor {
    pub worker: WorkerRef,
    pub graph_profiles: Vec<GraphProfile>,
    pub binding: WorkerProtocolBinding,
    pub contract: WorkerContract,
    pub capability_policy: CapabilityPolicy,
    pub artifact_profile: ArtifactResultProfile,
    pub credential_requirements: Vec<CredentialHandle>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct WorkerDescriptorWire {
    worker: WorkerRef,
    #[schemars(schema_with = "nonempty_unique_array_schema::<GraphProfile>")]
    graph_profiles: Vec<GraphProfile>,
    binding: WorkerProtocolBinding,
    contract: WorkerContract,
    capability_policy: CapabilityPolicy,
    artifact_profile: ArtifactResultProfile,
    #[schemars(schema_with = "unique_array_schema::<CredentialHandle>")]
    credential_requirements: Vec<CredentialHandle>,
}

impl WorkerDescriptor {
    pub fn validate(&self) -> Result<(), WorkerContractError> {
        self.binding.validate()?;
        self.validate_collections()?;
        self.validate_legacy_binding()?;
        self.validate_builtin_binding()
    }

    fn validate_collections(&self) -> Result<(), WorkerContractError> {
        require_unique_nonempty(&self.graph_profiles, "graph profiles")?;
        require_unique_nonempty(&self.contract.errors, "worker errors")?;
        if self.contract.errors.len() != RUNTIME_WORKER_ERRORS.len()
            || !RUNTIME_WORKER_ERRORS
                .iter()
                .all(|code| self.contract.errors.contains(code))
        {
            return Err(WorkerContractError::IncompleteRuntimeErrors);
        }
        require_unique_nonempty(&self.artifact_profile.allowed_type_ids, "artifact type IDs")?;
        require_unique_nonempty(
            &self.artifact_profile.allowed_media_types,
            "artifact media types",
        )?;
        require_unique(&self.credential_requirements, "credential handles")
    }

    fn validate_legacy_binding(&self) -> Result<(), WorkerContractError> {
        let protocol_is_legacy = self.binding.protocol == WorkerProtocol::LegacyZeroshot;
        let identity_is_legacy = self.worker.as_str() == LEGACY_ZEROSHOT_WORKER;
        let valid_legacy = identity_is_legacy
            && self.graph_profiles == [GraphProfile::SingleWorker]
            && self.contract.input == legacy_ship_request_payload_type()
            && self.contract.output == legacy_ship_result_payload_type()
            && self.contract.verifier.is_none()
            && self.contract.errors == RUNTIME_WORKER_ERRORS;
        if (protocol_is_legacy && !valid_legacy) || (identity_is_legacy && !protocol_is_legacy) {
            Err(WorkerContractError::InvalidLegacyBinding)
        } else {
            Ok(())
        }
    }

    fn validate_builtin_binding(&self) -> Result<(), WorkerContractError> {
        if self.binding.protocol == WorkerProtocol::Builtin
            && !self.credential_requirements.is_empty()
        {
            Err(WorkerContractError::InvalidBuiltinBinding)
        } else {
            Ok(())
        }
    }
}

impl<'de> Deserialize<'de> for WorkerDescriptor {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let wire = WorkerDescriptorWire::deserialize(deserializer)?;
        let descriptor = Self {
            worker: wire.worker,
            graph_profiles: wire.graph_profiles,
            binding: wire.binding,
            contract: wire.contract,
            capability_policy: wire.capability_policy,
            artifact_profile: wire.artifact_profile,
            credential_requirements: wire.credential_requirements,
        };
        descriptor.validate().map_err(de::Error::custom)?;
        Ok(descriptor)
    }
}

impl JsonSchema for WorkerDescriptor {
    fn schema_name() -> Cow<'static, str> {
        "WorkerDescriptor".into()
    }

    fn json_schema(generator: &mut SchemaGenerator) -> Schema {
        let base = generator.subschema_for::<WorkerDescriptorWire>();
        let legacy_binding = serde_json::to_value(WorkerProtocolBinding::legacy_zeroshot_ship_v1())
            .expect("built-in legacy binding must serialize");
        let legacy_input = serde_json::to_value(legacy_ship_request_payload_type())
            .expect("legacy input payload type must serialize");
        let legacy_output = serde_json::to_value(legacy_ship_result_payload_type())
            .expect("legacy output payload type must serialize");
        let runtime_errors = serde_json::to_value(RUNTIME_WORKER_ERRORS)
            .expect("runtime worker errors must serialize");

        json_schema!({
            "allOf": [
                base,
                {
                    "oneOf": [
                        {
                            "required": ["worker", "graphProfiles", "binding", "contract"],
                            "properties": {
                                "worker": { "const": LEGACY_ZEROSHOT_WORKER },
                                "graphProfiles": { "const": [SINGLE_WORKER_GRAPH_PROFILE] },
                                "binding": { "const": legacy_binding },
                                "contract": {
                                    "required": ["input", "output", "verifier", "errors"],
                                    "properties": {
                                        "input": { "const": legacy_input },
                                        "output": { "const": legacy_output },
                                        "verifier": { "type": "null" },
                                        "errors": { "const": runtime_errors }
                                    }
                                }
                            }
                        },
                        {
                            "required": ["worker", "binding"],
                            "properties": {
                                "worker": { "not": { "const": LEGACY_ZEROSHOT_WORKER } },
                                "binding": {
                                    "required": ["protocol"],
                                    "properties": {
                                        "protocol": { "enum": ["acp", "a2a"] }
                                    }
                                }
                            }
                        },
                        {
                            "required": ["worker", "binding", "credentialRequirements"],
                            "properties": {
                                "worker": { "not": { "const": LEGACY_ZEROSHOT_WORKER } },
                                "binding": {
                                    "required": ["protocol"],
                                    "properties": {
                                        "protocol": { "const": "builtin" }
                                    }
                                },
                                "credentialRequirements": { "maxItems": 0 }
                            }
                        }
                    ]
                }
            ]
        })
    }
}

fn require_unique_nonempty<T>(values: &[T], kind: &'static str) -> Result<(), WorkerContractError>
where
    T: PartialEq,
{
    if values.is_empty() {
        return Err(WorkerContractError::Empty(kind));
    }
    require_unique(values, kind)
}

fn require_unique<T>(values: &[T], kind: &'static str) -> Result<(), WorkerContractError>
where
    T: PartialEq,
{
    if values
        .iter()
        .enumerate()
        .all(|(index, value)| !values[..index].contains(value))
    {
        Ok(())
    } else {
        Err(WorkerContractError::Duplicate(kind))
    }
}

fn nonempty_unique_array_schema<T>(generator: &mut SchemaGenerator) -> Schema
where
    T: JsonSchema,
{
    json_schema!({
        "type": "array",
        "minItems": 1,
        "uniqueItems": true,
        "items": generator.subschema_for::<T>()
    })
}

fn unique_array_schema<T>(generator: &mut SchemaGenerator) -> Schema
where
    T: JsonSchema,
{
    json_schema!({
        "type": "array",
        "uniqueItems": true,
        "items": generator.subschema_for::<T>()
    })
}

fn closed_worker_errors_schema(_generator: &mut SchemaGenerator) -> Schema {
    json_schema!({
        "type": "array",
        "minItems": RUNTIME_WORKER_ERRORS.len(),
        "maxItems": RUNTIME_WORKER_ERRORS.len(),
        "uniqueItems": true,
        "items": {
            "enum": ["timeout", "crash", "malformed", "refusal"]
        }
    })
}
