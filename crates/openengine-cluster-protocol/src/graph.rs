//! Language-neutral graph syntax. These types describe graphs; they do not execute or admit them.

use std::borrow::Cow;
use std::collections::BTreeMap;
use std::fmt;
use std::str::FromStr;

use schemars::{json_schema, JsonSchema, Schema, SchemaGenerator};
use serde::de;
use serde::{Deserialize, Deserializer, Serialize};
use thiserror::Error;

use crate::{
    EnumLabel, FieldName, FieldPath, NodeName, NonEmptyEnumSet, NonEmptyVec, PayloadType,
    PositiveInteger,
};

pub use crate::graph_profile::{
    GraphProfile, GraphProfileSet, GraphProfilesError, FULL_GRAPH_PROFILE, GRAPH_PROFILES,
    SINGLE_WORKER_GRAPH_PROFILE,
};

pub const LEGACY_ZEROSHOT_WORKER: &str = "legacy.zeroshot.ship@1";

#[derive(Clone, Debug, Error, Eq, PartialEq)]
pub enum StableRefError {
    #[error("stable reference must have the form name@positiveVersion")]
    Malformed,
    #[error("stable reference name is invalid: {0}")]
    InvalidName(String),
    #[error("stable reference version must be a positive decimal integer")]
    InvalidVersion,
}

fn validate_stable_ref(value: &str) -> Result<(), StableRefError> {
    if value.len() > 256 {
        return Err(StableRefError::Malformed);
    }
    let (name, version) = value.rsplit_once('@').ok_or(StableRefError::Malformed)?;
    if name.is_empty()
        || !name
            .chars()
            .next()
            .is_some_and(|character| character.is_ascii_alphabetic() || character == '_')
        || !name.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '_' | '-' | '.')
        })
    {
        return Err(StableRefError::InvalidName(name.to_owned()));
    }
    if version.is_empty()
        || version.starts_with('0')
        || !version.bytes().all(|byte| byte.is_ascii_digit())
    {
        return Err(StableRefError::InvalidVersion);
    }
    Ok(())
}

macro_rules! stable_ref_type {
    ($name:ident) => {
        #[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
        #[serde(transparent)]
        pub struct $name(String);

        impl $name {
            pub fn new(value: impl Into<String>) -> Result<Self, StableRefError> {
                let value = value.into();
                validate_stable_ref(&value)?;
                Ok(Self(value))
            }

            #[must_use]
            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str(&self.0)
            }
        }

        impl FromStr for $name {
            type Err = StableRefError;

            fn from_str(value: &str) -> Result<Self, Self::Err> {
                Self::new(value)
            }
        }

        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
            where
                D: Deserializer<'de>,
            {
                let value = String::deserialize(deserializer)?;
                Self::new(value).map_err(de::Error::custom)
            }
        }

        impl JsonSchema for $name {
            fn inline_schema() -> bool {
                true
            }

            fn schema_name() -> Cow<'static, str> {
                stringify!($name).into()
            }

            fn json_schema(_generator: &mut SchemaGenerator) -> Schema {
                json_schema!({
                    "type": "string",
                    "maxLength": 256,
                    "pattern": "^[A-Za-z_][A-Za-z0-9_.-]*@[1-9][0-9]*$"
                })
            }
        }
    };
}

stable_ref_type!(WorkerRef);
stable_ref_type!(PolicyRef);

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PolicyDefault {
    #[default]
    Deny,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct PolicyBinding {
    pub policy: PolicyRef,
    pub default: PolicyDefault,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct GraphSpec {
    pub profile: GraphProfile,
    pub initial_input: PayloadType,
    pub policy: PolicyBinding,
    pub root: GraphNode,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields, tag = "source", rename_all = "snake_case")]
pub enum DataSelector {
    State { path: FieldPath },
    Item { path: FieldPath },
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct InputBinding {
    pub target: FieldPath,
    pub value: DataSelector,
}

#[derive(
    Clone, Copy, Debug, Deserialize, Eq, JsonSchema, Ord, PartialEq, PartialOrd, Serialize,
)]
#[serde(rename_all = "snake_case")]
pub enum NodeOutputChannel {
    Out,
    Signal,
    Diagnostic,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct NodeOutputSelector {
    pub node: NodeName,
    pub channel: NodeOutputChannel,
    pub path: FieldPath,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct WriteBinding {
    pub value: NodeOutputSelector,
    pub target: FieldPath,
}

#[derive(
    Clone, Copy, Debug, Deserialize, Eq, JsonSchema, Ord, PartialEq, PartialOrd, Serialize,
)]
#[serde(rename_all = "snake_case")]
pub enum WorkerErrorCode {
    Timeout,
    Crash,
    Malformed,
    Refusal,
}

impl WorkerErrorCode {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Timeout => "timeout",
            Self::Crash => "crash",
            Self::Malformed => "malformed",
            Self::Refusal => "refusal",
        }
    }
}

#[derive(
    Clone, Copy, Debug, Deserialize, Eq, JsonSchema, Ord, PartialEq, PartialOrd, Serialize,
)]
#[serde(rename_all = "snake_case")]
pub enum ControlSource {
    Signal,
    Error,
    Group,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ControlSelector {
    pub name: NodeName,
    pub source: ControlSource,
    pub field: Option<FieldName>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields, tag = "kind", rename_all = "snake_case")]
pub enum Guard {
    In {
        value: ControlSelector,
        labels: NonEmptyEnumSet,
    },
    All {
        guards: NonEmptyVec<Guard>,
    },
    Any {
        guards: NonEmptyVec<Guard>,
    },
    Not {
        guard: Box<Guard>,
    },
    KOfN {
        count: PositiveInteger,
        values: NonEmptyVec<ControlSelector>,
        labels: NonEmptyEnumSet,
    },
    KOfMap {
        count: PositiveInteger,
        value: ControlSelector,
        labels: NonEmptyEnumSet,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields, tag = "kind", rename_all = "snake_case")]
pub enum Join {
    All {},
    Any {},
    Quorum { count: PositiveInteger },
    First { when: Guard },
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct StepNode {
    pub name: NodeName,
    pub worker: WorkerRef,
    pub input: PayloadType,
    pub output: PayloadType,
    pub input_bindings: Vec<InputBinding>,
    pub write_bindings: Vec<WriteBinding>,
    pub timeout_ms: PositiveInteger,
    pub attempts: PositiveInteger,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct VerifierNode {
    pub name: NodeName,
    pub worker: WorkerRef,
    pub input: PayloadType,
    pub output: PayloadType,
    pub input_bindings: Vec<InputBinding>,
    pub write_bindings: Vec<WriteBinding>,
    pub timeout_ms: PositiveInteger,
    pub attempts: PositiveInteger,
    #[schemars(
        schema_with = "crate::value::identifier_keyed_map_schema::<FieldName, NonEmptyEnumSet>"
    )]
    pub signals: BTreeMap<FieldName, NonEmptyEnumSet>,
    pub diagnostic: PayloadType,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SeqNode {
    pub name: NodeName,
    pub state: PayloadType,
    pub children: NonEmptyVec<GraphNode>,
    pub promoted_state_paths: Vec<FieldPath>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ChoiceBranch {
    pub when: Guard,
    pub node: GraphNode,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ChoiceNode {
    pub name: NodeName,
    pub state: PayloadType,
    pub branches: NonEmptyVec<ChoiceBranch>,
    pub otherwise: Option<Box<GraphNode>>,
    pub promoted_state_paths: Vec<FieldPath>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ParNode {
    pub name: NodeName,
    pub state: PayloadType,
    pub branches: NonEmptyVec<GraphNode>,
    pub promoted_state_paths: Vec<FieldPath>,
    pub join: Join,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct LoopNode {
    pub name: NodeName,
    pub state: PayloadType,
    pub body: Box<GraphNode>,
    pub until: Guard,
    pub max_iterations: PositiveInteger,
    pub promoted_state_paths: Vec<FieldPath>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct MapNode {
    pub name: NodeName,
    pub state: PayloadType,
    pub body: Box<GraphNode>,
    pub over: DataSelector,
    pub max_items: PositiveInteger,
    pub promoted_state_paths: Vec<FieldPath>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SucceedNode {
    pub name: NodeName,
    pub output: PayloadType,
    pub bindings: Vec<InputBinding>,
}

#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(transparent)]
pub struct FailReason(EnumLabel);

impl FailReason {
    pub fn new(value: EnumLabel) -> Result<Self, FailReasonError> {
        if value.as_str() == "unhandled" {
            Err(FailReasonError)
        } else {
            Ok(Self(value))
        }
    }

    #[must_use]
    pub fn as_label(&self) -> &EnumLabel {
        &self.0
    }
}

#[derive(Clone, Copy, Debug, Error, Eq, PartialEq)]
#[error("fail reason 'unhandled' is reserved for the compiler's implicit sink")]
pub struct FailReasonError;

impl<'de> Deserialize<'de> for FailReason {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let label = EnumLabel::deserialize(deserializer)?;
        Self::new(label).map_err(de::Error::custom)
    }
}

impl JsonSchema for FailReason {
    fn inline_schema() -> bool {
        true
    }

    fn schema_name() -> Cow<'static, str> {
        "FailReason".into()
    }

    fn json_schema(_generator: &mut SchemaGenerator) -> Schema {
        json_schema!({
            "type": "string",
            "minLength": 1,
            "maxLength": 128,
            "pattern": "^(?!unhandled$)[A-Za-z_][A-Za-z0-9_.-]*$"
        })
    }
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct FailNode {
    pub name: NodeName,
    pub reason: FailReason,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields, tag = "kind", rename_all = "snake_case")]
pub enum GraphNode {
    Step(StepNode),
    Verifier(VerifierNode),
    Seq(SeqNode),
    Choice(ChoiceNode),
    Par(ParNode),
    Loop(LoopNode),
    Map(MapNode),
    Succeed(SucceedNode),
    Fail(FailNode),
}

impl GraphNode {
    #[must_use]
    pub fn name(&self) -> &NodeName {
        match self {
            Self::Step(node) => &node.name,
            Self::Verifier(node) => &node.name,
            Self::Seq(node) => &node.name,
            Self::Choice(node) => &node.name,
            Self::Par(node) => &node.name,
            Self::Loop(node) => &node.name,
            Self::Map(node) => &node.name,
            Self::Succeed(node) => &node.name,
            Self::Fail(node) => &node.name,
        }
    }
}
