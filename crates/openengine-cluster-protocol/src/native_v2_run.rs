//! Public native-v2 run admission and inventory values.
//!
//! The protocol carries the immutable source snapshot, graph, actual initial value, runtime plan,
//! run title, and existing submission-key seam. Runtime plans declare environment names only;
//! resolved values and provider credentials remain private host input.

use std::borrow::Cow;
use std::collections::BTreeSet;
use std::fmt;
use std::marker::PhantomData;

use schemars::{JsonSchema, Schema, SchemaGenerator, json_schema};
use serde::de;
use serde::{Deserialize, Deserializer, Serialize};
pub const RUN_SUBMIT_METHOD: &str = "run/submit";
pub const RUN_LIST_METHOD: &str = "run/list";
pub const RUN_STATUS_METHOD: &str = "run/status";
pub const RUN_WATCH_METHOD: &str = "run/watch";
pub const RUN_LOGS_METHOD: &str = "run/logs";
pub const RUN_ATTACH_METHOD: &str = "run/attach";
pub const RUN_FORCE_METHOD: &str = "run/force";

pub const MAX_DECLARED_ENVIRONMENT_NAMES: usize = 64;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NativeV2RunValueError(&'static str);

impl fmt::Display for NativeV2RunValueError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.0)
    }
}

impl std::error::Error for NativeV2RunValueError {}

mod string_kind_sealed {
    pub trait Sealed {}
}

#[doc(hidden)]
pub trait NativeV2StringKind: string_kind_sealed::Sealed {
    const SCHEMA_NAME: &'static str;

    fn validate(value: &str) -> Result<(), NativeV2RunValueError>;

    fn schema() -> Schema;
}

/// Validated protocol string tagged by one closed native-v2 value domain.
#[derive(Clone, Debug, Deserialize, Eq, Hash, Ord, PartialEq, PartialOrd)]
#[serde(try_from = "String")]
pub struct NativeV2String<Kind: NativeV2StringKind>(String, #[serde(skip)] PhantomData<Kind>);

impl<Kind: NativeV2StringKind> NativeV2String<Kind> {
    pub fn new(value: impl Into<String>) -> Result<Self, NativeV2RunValueError> {
        let value = value.into();
        Kind::validate(&value)?;
        Ok(Self(value, PhantomData))
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl<Kind: NativeV2StringKind> TryFrom<String> for NativeV2String<Kind> {
    type Error = NativeV2RunValueError;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        Self::new(value)
    }
}

impl<Kind: NativeV2StringKind> Serialize for NativeV2String<Kind> {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.0)
    }
}

impl<Kind: NativeV2StringKind> fmt::Display for NativeV2String<Kind> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl<Kind: NativeV2StringKind> JsonSchema for NativeV2String<Kind> {
    fn inline_schema() -> bool {
        true
    }

    fn schema_name() -> Cow<'static, str> {
        Kind::SCHEMA_NAME.into()
    }

    fn json_schema(_generator: &mut SchemaGenerator) -> Schema {
        Kind::schema()
    }
}

macro_rules! native_v2_string_kind {
    ($kind:ident, $name:ident, $validator:ident, $schema:expr) => {
        #[doc(hidden)]
        #[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
        pub enum $kind {}

        impl string_kind_sealed::Sealed for $kind {}

        impl NativeV2StringKind for $kind {
            const SCHEMA_NAME: &'static str = stringify!($name);

            fn validate(value: &str) -> Result<(), NativeV2RunValueError> {
                $validator(value)
            }

            fn schema() -> Schema {
                $schema
            }
        }

        pub type $name = NativeV2String<$kind>;
    };
}

fn validate_title(value: &str) -> Result<(), NativeV2RunValueError> {
    validate_non_control_text(
        value,
        256,
        "run title must be 1..=256 non-control characters",
    )
}

fn validate_repository(value: &str) -> Result<(), NativeV2RunValueError> {
    let Some((owner, name)) = value.split_once('/') else {
        return Err(NativeV2RunValueError(
            "source repository must have the form owner/name",
        ));
    };
    if value.len() > 255
        || name.contains('/')
        || !valid_repository_part(owner)
        || !valid_repository_part(name)
    {
        return Err(NativeV2RunValueError(
            "source repository must have the form owner/name",
        ));
    }
    Ok(())
}

fn valid_repository_part(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 100
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

fn validate_branch(value: &str) -> Result<(), NativeV2RunValueError> {
    let valid = !value.is_empty()
        && value.len() <= 255
        && !value.starts_with('-')
        && !value.ends_with('.')
        && !value.ends_with('/')
        && !value.ends_with(".lock")
        && !value.contains("..")
        && !value.contains("@{")
        && value.bytes().all(|byte| {
            byte.is_ascii_graphic()
                && !matches!(byte, b'~' | b'^' | b':' | b'?' | b'*' | b'[' | b'\\')
        });
    if valid {
        Ok(())
    } else {
        Err(NativeV2RunValueError(
            "source target branch is not a valid bounded Git branch",
        ))
    }
}

fn validate_revision(value: &str) -> Result<(), NativeV2RunValueError> {
    if value.len() == 40
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        Ok(())
    } else {
        Err(NativeV2RunValueError(
            "source base revision must be exactly 40 lowercase hexadecimal characters",
        ))
    }
}

fn validate_model(value: &str) -> Result<(), NativeV2RunValueError> {
    validate_non_control_bytes(value, 128, "model ID must be 1..=128 non-control bytes")
}

fn validate_environment_name(value: &str) -> Result<(), NativeV2RunValueError> {
    let mut bytes = value.bytes();
    let first = bytes
        .next()
        .is_some_and(|byte| byte.is_ascii_alphabetic() || byte == b'_');
    if value.len() <= 128 && first && bytes.all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
    {
        Ok(())
    } else {
        Err(NativeV2RunValueError(
            "environment variable name must match [A-Za-z_][A-Za-z0-9_]* and be at most 128 bytes",
        ))
    }
}

fn validate_non_control_text(
    value: &str,
    maximum: usize,
    message: &'static str,
) -> Result<(), NativeV2RunValueError> {
    if value.is_empty() || value.chars().count() > maximum || value.chars().any(char::is_control) {
        Err(NativeV2RunValueError(message))
    } else {
        Ok(())
    }
}

fn validate_non_control_bytes(
    value: &str,
    maximum: usize,
    message: &'static str,
) -> Result<(), NativeV2RunValueError> {
    if value.is_empty() || value.len() > maximum || value.chars().any(char::is_control) {
        Err(NativeV2RunValueError(message))
    } else {
        Ok(())
    }
}

native_v2_string_kind!(
    RunTitleKind,
    RunTitle,
    validate_title,
    json_schema!({
        "type": "string",
        "minLength": 1,
        "maxLength": 256,
        "pattern": r"^[^\u0000-\u001f\u007f-\u009f]+$"
    })
);
native_v2_string_kind!(
    SourceRepositoryIdKind,
    SourceRepositoryId,
    validate_repository,
    json_schema!({
        "type": "string",
        "minLength": 3,
        "maxLength": 255,
        "pattern": "^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$"
    })
);
native_v2_string_kind!(
    SourceBranchIdKind,
    SourceBranchId,
    validate_branch,
    json_schema!({ "type": "string", "minLength": 1, "maxLength": 255 })
);
native_v2_string_kind!(
    SourceRevisionIdKind,
    SourceRevisionId,
    validate_revision,
    json_schema!({ "type": "string", "pattern": "^[0-9a-f]{40}$" })
);
native_v2_string_kind!(
    ModelIdKind,
    ModelId,
    validate_model,
    json_schema!({ "type": "string", "minLength": 1, "maxLength": 128 })
);
native_v2_string_kind!(
    EnvironmentVariableNameKind,
    EnvironmentVariableName,
    validate_environment_name,
    json_schema!({
        "type": "string",
        "minLength": 1,
        "maxLength": 128,
        "pattern": "^[A-Za-z_][A-Za-z0-9_]*$"
    })
);

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SourceSnapshot {
    pub repository: SourceRepositoryId,
    pub target_branch: SourceBranchId,
    pub base_revision: SourceRevisionId,
}

#[derive(
    Clone, Copy, Debug, Deserialize, Eq, Hash, JsonSchema, Ord, PartialEq, PartialOrd, Serialize,
)]
#[serde(rename_all = "snake_case")]
pub enum RunSize {
    Tiny,
    Small,
    Standard,
    Large,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CodexProvider {
    #[serde(rename = "openai")]
    OpenAi,
    #[serde(rename = "openrouter")]
    OpenRouter,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ClaudeProvider {
    Anthropic,
    #[serde(rename = "openrouter")]
    OpenRouter,
}

#[derive(
    Clone, Copy, Debug, Deserialize, Eq, Hash, JsonSchema, Ord, PartialEq, PartialOrd, Serialize,
)]
#[serde(rename_all = "snake_case")]
pub enum ReasoningEffort {
    Low,
    Medium,
    High,
    Xhigh,
    Max,
}

#[derive(
    Clone,
    Copy,
    Debug,
    Default,
    Deserialize,
    Eq,
    Hash,
    JsonSchema,
    Ord,
    PartialEq,
    PartialOrd,
    Serialize,
)]
#[serde(rename_all = "snake_case")]
pub enum SessionScope {
    #[default]
    Execution,
    NodeInstance,
}

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize)]
#[serde(transparent)]
pub struct DeclaredEnvironment(BTreeSet<EnvironmentVariableName>);

impl DeclaredEnvironment {
    pub fn new(
        values: impl IntoIterator<Item = EnvironmentVariableName>,
    ) -> Result<Self, NativeV2RunValueError> {
        let values = values.into_iter().collect::<Vec<_>>();
        if values.len() > MAX_DECLARED_ENVIRONMENT_NAMES {
            return Err(NativeV2RunValueError(
                "declared environment contains more than 64 names",
            ));
        }
        let unique = values.iter().cloned().collect::<BTreeSet<_>>();
        if unique.len() != values.len() {
            return Err(NativeV2RunValueError(
                "declared environment contains a duplicate name",
            ));
        }
        Ok(Self(unique))
    }

    #[must_use]
    pub const fn empty() -> Self {
        Self(BTreeSet::new())
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    #[must_use]
    pub const fn as_set(&self) -> &BTreeSet<EnvironmentVariableName> {
        &self.0
    }

    pub fn iter(&self) -> impl Iterator<Item = &EnvironmentVariableName> {
        self.0.iter()
    }

    #[must_use]
    pub fn contains(&self, name: &EnvironmentVariableName) -> bool {
        self.0.contains(name)
    }
}

impl<'de> Deserialize<'de> for DeclaredEnvironment {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        Self::new(Vec::<EnvironmentVariableName>::deserialize(deserializer)?)
            .map_err(de::Error::custom)
    }
}

impl JsonSchema for DeclaredEnvironment {
    fn schema_name() -> Cow<'static, str> {
        "DeclaredEnvironment".into()
    }

    fn json_schema(generator: &mut SchemaGenerator) -> Schema {
        let item = generator.subschema_for::<EnvironmentVariableName>();
        json_schema!({
            "type": "array",
            "items": item,
            "maxItems": 64,
            "uniqueItems": true
        })
    }
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields, tag = "kind", rename_all = "snake_case")]
pub enum NodeRuntimeBinding {
    Agent {
        model: ModelId,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        effort: Option<ReasoningEffort>,
        #[serde(
            default,
            rename = "sessionScope",
            skip_serializing_if = "is_execution_scope"
        )]
        session_scope: SessionScope,
        #[serde(default, skip_serializing_if = "DeclaredEnvironment::is_empty")]
        env: DeclaredEnvironment,
    },
    GitDelivery {
        #[serde(default, skip_serializing_if = "DeclaredEnvironment::is_empty")]
        env: DeclaredEnvironment,
    },
}

fn is_execution_scope(scope: &SessionScope) -> bool {
    *scope == SessionScope::Execution
}

impl NodeRuntimeBinding {
    #[must_use]
    pub const fn declared_environment(&self) -> &DeclaredEnvironment {
        match self {
            Self::Agent { env, .. } | Self::GitDelivery { env } => env,
        }
    }
}

mod wire;
pub use wire::{
    RunListParams, RunListResult, RunSubmission, RunSubmitParams, RunSubmitResult, RuntimePlan,
};
