//! Durable, byte-free artifact receipts.

use std::borrow::Cow;
use std::fmt;
use std::str::FromStr;

use schemars::{JsonSchema, Schema, SchemaGenerator};
use serde::de;
use serde::{Deserialize, Deserializer, Serialize};
use thiserror::Error;

use crate::value::{BoundedString256, Sha256String};
use crate::{Generation, NodeName, PolicyRef, PositiveInteger, RunId, WorkerRef, MAX_SAFE_GENERATION};

#[derive(Clone, Copy, Debug, Error, Eq, PartialEq)]
pub enum ArtifactValueError {
    #[error("{0} must not be empty")]
    Empty(&'static str),
    #[error("{0} is invalid")]
    Invalid(&'static str),
    #[error("byte length exceeds the JavaScript-safe integer maximum")]
    ByteLengthOutOfRange,
}

macro_rules! bounded_artifact_string {
    ($name:ident, $kind:literal) => {
        #[derive(
            Clone, Debug, Deserialize, Eq, Hash, JsonSchema, Ord, PartialEq, PartialOrd, Serialize,
        )]
        #[serde(transparent)]
        #[schemars(transparent)]
        pub struct $name(BoundedString256);

        impl $name {
            pub fn new(value: impl Into<String>) -> Result<Self, ArtifactValueError> {
                let value = value.into();
                if value.is_empty() {
                    return Err(ArtifactValueError::Empty($kind));
                }
                BoundedString256::new(value)
                    .map(Self)
                    .map_err(|_| ArtifactValueError::Invalid($kind))
            }

            #[must_use]
            pub fn as_str(&self) -> &str {
                self.0.as_str()
            }
        }
    };
}

bounded_artifact_string!(ArtifactId, "artifact ID");
bounded_artifact_string!(MediaType, "media type");

#[derive(
    Clone, Debug, Deserialize, Eq, Hash, JsonSchema, Ord, PartialEq, PartialOrd, Serialize,
)]
#[serde(transparent)]
#[schemars(transparent)]
pub struct TypeId(PolicyRef);

impl TypeId {
    pub fn new(value: impl Into<String>) -> Result<Self, ArtifactValueError> {
        PolicyRef::new(value)
            .map(Self)
            .map_err(|_| ArtifactValueError::Invalid("type ID"))
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        self.0.as_str()
    }
}
#[derive(
    Clone, Debug, Deserialize, Eq, Hash, JsonSchema, Ord, PartialEq, PartialOrd, Serialize,
)]
#[serde(transparent)]
#[schemars(transparent)]
pub struct Sha256Digest(Sha256String);

impl Sha256Digest {
    pub fn new(value: impl Into<String>) -> Result<Self, Sha256DigestError> {
        Sha256String::new(value.into())
            .map(Self)
            .map_err(|_| Sha256DigestError)
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        self.0.as_str()
    }

    pub(crate) fn from_digest(bytes: &[u8]) -> Self {
        Self(Sha256String::from_digest(bytes))
    }
}

impl fmt::Display for Sha256Digest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

impl FromStr for Sha256Digest {
    type Err = Sha256DigestError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        Self::new(value)
    }
}

#[derive(Clone, Copy, Debug, Error, Eq, PartialEq)]
#[error("SHA-256 must be exactly 64 lowercase hexadecimal characters")]
pub struct Sha256DigestError;

#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(transparent)]
pub struct ByteLength(u64);

impl ByteLength {
    pub fn new(value: u64) -> Result<Self, ArtifactValueError> {
        if value > MAX_SAFE_GENERATION {
            Err(ArtifactValueError::ByteLengthOutOfRange)
        } else {
            Ok(Self(value))
        }
    }

    #[must_use]
    pub const fn get(self) -> u64 {
        self.0
    }
}

impl<'de> Deserialize<'de> for ByteLength {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = crate::value::deserialize_javascript_safe_u64(deserializer, 0)?;
        ByteLength::new(value).map_err(de::Error::custom)
    }
}

impl JsonSchema for ByteLength {
    fn inline_schema() -> bool {
        true
    }

    fn schema_name() -> Cow<'static, str> {
        "ByteLength".into()
    }

    fn json_schema(_generator: &mut SchemaGenerator) -> Schema {
        crate::value::javascript_safe_integer_schema(0)
    }
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ArtifactProducer {
    pub node: NodeName,
    pub worker: WorkerRef,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ArtifactLineage {
    pub generation: Generation,
    pub run_id: RunId,
    pub attempt: PositiveInteger,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RedactionClass {
    Public,
    Internal,
    Confidential,
    Restricted,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ArtifactRef {
    pub artifact_id: ArtifactId,
    pub sha256: Sha256Digest,
    pub byte_length: ByteLength,
    pub media_type: MediaType,
    pub type_id: TypeId,
    pub producer: ArtifactProducer,
    pub lineage: ArtifactLineage,
    pub redaction: RedactionClass,
}
