use std::borrow::Cow;
use std::fmt;

use schemars::{json_schema, JsonSchema, Schema, SchemaGenerator};
use serde::{Deserialize, Deserializer, Serialize};
use thiserror::Error;

/// Maximum UTF-8 byte length of authored instructions for one executable node.
pub const MAX_NODE_INSTRUCTIONS_BYTES: usize = 16_384;

/// Authored behavior for one agent-backed graph leaf.
#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(transparent)]
pub struct NodeInstructions(String);

impl NodeInstructions {
    pub fn new(value: impl Into<String>) -> Result<Self, NodeInstructionsError> {
        let value = value.into();
        if value.trim().is_empty() {
            Err(NodeInstructionsError::Empty)
        } else if value.len() > MAX_NODE_INSTRUCTIONS_BYTES {
            Err(NodeInstructionsError::TooLong)
        } else if value.contains('\0') {
            Err(NodeInstructionsError::Nul)
        } else {
            Ok(Self(value))
        }
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for NodeInstructions {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

#[derive(Clone, Copy, Debug, Error, Eq, PartialEq)]
pub enum NodeInstructionsError {
    #[error("node instructions must contain a non-whitespace character")]
    Empty,
    #[error("node instructions exceed {MAX_NODE_INSTRUCTIONS_BYTES} UTF-8 bytes")]
    TooLong,
    #[error("node instructions must not contain NUL")]
    Nul,
}

impl<'de> Deserialize<'de> for NodeInstructions {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        crate::value::deserialize_validated_wire(deserializer, |value: String| Self::new(value))
    }
}

impl JsonSchema for NodeInstructions {
    fn inline_schema() -> bool {
        false
    }

    fn schema_name() -> Cow<'static, str> {
        "NodeInstructions".into()
    }

    fn json_schema(_generator: &mut SchemaGenerator) -> Schema {
        json_schema!({
            "type": "string",
            "minLength": 1,
            "maxLength": MAX_NODE_INSTRUCTIONS_BYTES,
            "pattern": r"^[^\u0000]*[^\s\u0000][^\u0000]*$"
        })
    }
}
