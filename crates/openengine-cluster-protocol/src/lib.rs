//! Canonical Open Engine Cluster Protocol wire and domain types.

pub mod admission;
pub mod artifact;
pub mod canonical;
pub mod diagnostic;
pub mod graph;
mod graph_profile;
pub mod lifecycle;
pub mod payload;
mod payload_value;
mod value;
pub mod watch;
pub mod worker;

pub use worker::*;
pub use artifact::*;
pub use admission::*;
pub use canonical::*;
pub use diagnostic::*;
pub use graph::*;
pub use lifecycle::*;
pub use payload::*;
pub use payload_value::*;
pub use watch::*;

use std::borrow::Cow;

use schemars::{json_schema, JsonSchema, Schema, SchemaGenerator};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;
use thiserror::Error;

pub const JSON_RPC_VERSION: &str = "2.0";
pub const PROTOCOL_NAME: &str = "openengine.cluster";
/// The only wire protocol version accepted by Cluster Protocol v1 servers.
pub const PROTOCOL_VERSION: &str = "openengine.cluster/v1";
pub const BASE_PROFILE: &str = "openengine.cluster/base/v1";

pub const PARSE_ERROR: i64 = -32700;
pub const INVALID_REQUEST: i64 = -32600;
pub const METHOD_NOT_FOUND: i64 = -32601;
pub const INVALID_PARAMS: i64 = -32602;
pub const INTERNAL_ERROR: i64 = -32603;
pub const APPLICATION_ERROR: i64 = -32000;

pub const UNSUPPORTED_PROTOCOL_VERSION: &str = "UNSUPPORTED_PROTOCOL_VERSION";
pub const INTERNAL_ERROR_CODE: &str = "INTERNAL_ERROR";

pub const MAX_SAFE_GENERATION: u64 = 9_007_199_254_740_991;

#[derive(Clone, Debug, Deserialize, Eq, Hash, JsonSchema, PartialEq, Serialize)]
#[serde(untagged)]
pub enum RequestId {
    String(String),
    Integer(i64),
}

impl RequestId {
    /// Parses a JSON-RPC id from a decoded [`Value`]: a string, or a number representable as an
    /// `i64`. Shared by the server's request dispatcher and the client's response demultiplexer
    /// so both apply the exact same id-shape rules.
    #[must_use]
    pub fn from_json_value(value: &Value) -> Option<Self> {
        match value {
            Value::String(value) => Some(Self::String(value.clone())),
            Value::Number(value) => value.as_i64().map(Self::Integer),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JsonRpcRequest<P> {
    pub jsonrpc: String,
    pub id: RequestId,
    pub method: String,
    pub params: P,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JsonRpcNotification<P> {
    pub jsonrpc: String,
    pub method: String,
    pub params: P,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize)]
pub struct JsonRpcSuccess<T> {
    pub jsonrpc: String,
    pub id: RequestId,
    pub result: T,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
pub struct JsonRpcErrorResponse {
    pub jsonrpc: String,
    pub id: Option<RequestId>,
    pub error: JsonRpcError,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize)]
#[serde(untagged)]
pub enum JsonRpcResponse<T> {
    Success(JsonRpcSuccess<T>),
    Error(JsonRpcErrorResponse),
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
pub struct JsonRpcError {
    pub code: i64,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<DomainErrorData>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
pub struct DomainErrorData {
    pub code: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<Value>,
}

impl DomainErrorData {
    #[must_use]
    pub fn new(code: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            details: None,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct InitializeParams {
    #[schemars(schema_with = "protocol_version_schema")]
    pub protocol_version: String,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InitializeResult {
    #[schemars(schema_with = "protocol_version_schema")]
    pub protocol_version: String,
    pub capabilities: ServerCapabilities,
    pub status: ClusterStatus,
}

impl InitializeResult {
    #[must_use]
    pub fn new(capabilities: ServerCapabilities, status: ClusterStatus) -> Self {
        Self {
            protocol_version: PROTOCOL_VERSION.to_owned(),
            capabilities,
            status,
        }
    }

    pub fn validate_protocol_version(&self) -> Result<(), ProtocolVersionMismatch> {
        if self.protocol_version == PROTOCOL_VERSION {
            Ok(())
        } else {
            Err(ProtocolVersionMismatch {
                received: self.protocol_version.clone(),
            })
        }
    }
}

fn protocol_version_schema(_generator: &mut SchemaGenerator) -> Schema {
    json_schema!({
        "type": "string",
        "const": PROTOCOL_VERSION
    })
}

#[derive(Clone, Debug, Error, Eq, PartialEq)]
#[error("protocol version mismatch: expected {PROTOCOL_VERSION}, received {received}")]
pub struct ProtocolVersionMismatch {
    pub received: String,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct GetParams {
    #[serde(default)]
    pub at_cursor: Option<Cursor>,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GetResult {
    pub spec: Option<GraphSpec>,
    pub status: ClusterStatus,
    pub at_cursor: Option<Cursor>,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ServerCapabilities {
    #[serde(default)]
    #[schemars(schema_with = "graph_profile::graph_profile_set_schema")]
    pub graph_profiles: GraphProfileSet,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClusterStatus {
    pub phase: Phase,
    pub observed_generation: Option<Generation>,
    pub current_run_id: Option<RunId>,
    pub at_cursor: Option<Cursor>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub operational: Option<OperationalStatus>,
}

impl ClusterStatus {
    #[must_use]
    pub const fn empty() -> Self {
        Self {
            phase: Phase::Empty,
            observed_generation: None,
            current_run_id: None,
            at_cursor: None,
            operational: None,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    Empty,
    Admitting,
    Running,
    Finished,
}

impl Phase {
    #[must_use]
    pub const fn is_terminal(self) -> bool {
        matches!(self, Self::Finished)
    }
}

#[derive(
    Clone, Debug, Deserialize, Eq, Hash, JsonSchema, Ord, PartialEq, PartialOrd, Serialize,
)]
#[serde(transparent)]
pub struct Cursor(String);

impl Cursor {
    #[must_use]
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(
    Clone, Debug, Deserialize, Eq, Hash, JsonSchema, Ord, PartialEq, PartialOrd, Serialize,
)]
#[serde(transparent)]
pub struct RunId(String);

impl RunId {
    #[must_use]
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(transparent)]
pub struct Generation(u64);

impl Generation {
    pub fn new(value: u64) -> Result<Self, GenerationOutOfRange> {
        if value <= MAX_SAFE_GENERATION {
            Ok(Self(value))
        } else {
            Err(GenerationOutOfRange(value))
        }
    }

    #[must_use]
    pub const fn get(self) -> u64 {
        self.0
    }
}

impl<'de> Deserialize<'de> for Generation {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = value::deserialize_javascript_safe_u64(deserializer, 0)?;
        Generation::new(value).map_err(serde::de::Error::custom)
    }
}

impl JsonSchema for Generation {
    fn inline_schema() -> bool {
        true
    }

    fn schema_name() -> Cow<'static, str> {
        "Generation".into()
    }

    fn json_schema(_generator: &mut SchemaGenerator) -> Schema {
        value::javascript_safe_integer_schema(0)
    }
}

#[derive(Clone, Copy, Debug, Error, Eq, PartialEq)]
#[error("generation {0} exceeds the JavaScript-safe integer maximum {MAX_SAFE_GENERATION}")]
pub struct GenerationOutOfRange(pub u64);
