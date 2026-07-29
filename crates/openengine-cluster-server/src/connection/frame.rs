//! Duplicate-preserving, single-pass JSON-RPC frame decoding and request classification.

use openengine_cluster_protocol::{RequestId, SubscriptionId, PARSE_ERROR};
use serde::de::{self, MapAccess, SeqAccess, Visitor};
use serde::{Deserialize, Deserializer};
use serde_json::Value;

use super::{DecodedOutcome, DecodedRequest, RequestKind};
use crate::serialize_error;

/// One-pass JSON tree retaining duplicate object members until transport-specific notification
/// recognition and legacy admission classification are complete.
enum JsonNode {
    Null,
    Bool(bool),
    Number(serde_json::Number),
    String(String),
    Array(Vec<Self>),
    Object(Vec<(String, Self)>),
}

impl JsonNode {
    fn unique_field(&self, name: &str) -> Option<&Self> {
        let Self::Object(entries) = self else {
            return None;
        };
        let mut matching = entries
            .iter()
            .filter_map(|(key, value)| (key == name).then_some(value));
        let value = matching.next()?;
        matching.next().is_none().then_some(value)
    }

    fn request_id(&self) -> Option<RequestId> {
        match self {
            Self::String(value) => Some(RequestId::String(value.clone())),
            Self::Number(value) => value.as_i64().map(RequestId::Integer),
            _ => None,
        }
    }

    fn into_value(self) -> Value {
        match self {
            Self::Null => Value::Null,
            Self::Bool(value) => Value::Bool(value),
            Self::Number(value) => Value::Number(value),
            Self::String(value) => Value::String(value),
            Self::Array(values) => Value::Array(values.into_iter().map(Self::into_value).collect()),
            Self::Object(entries) => Value::Object(
                entries
                    .into_iter()
                    .map(|(key, value)| (key, value.into_value()))
                    .collect(),
            ),
        }
    }

    fn as_string(&self) -> Option<&str> {
        match self {
            Self::String(value) => Some(value),
            _ => None,
        }
    }
}

struct JsonNodeVisitor;

impl<'de> Visitor<'de> for JsonNodeVisitor {
    type Value = JsonNode;

    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("a JSON value")
    }

    fn visit_unit<E>(self) -> Result<Self::Value, E> {
        Ok(JsonNode::Null)
    }

    fn visit_bool<E>(self, value: bool) -> Result<Self::Value, E> {
        Ok(JsonNode::Bool(value))
    }

    fn visit_i64<E>(self, value: i64) -> Result<Self::Value, E> {
        Ok(JsonNode::Number(value.into()))
    }

    fn visit_u64<E>(self, value: u64) -> Result<Self::Value, E> {
        Ok(JsonNode::Number(value.into()))
    }

    fn visit_f64<E>(self, value: f64) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        serde_json::Number::from_f64(value)
            .map(JsonNode::Number)
            .ok_or_else(|| E::custom("invalid JSON number"))
    }

    fn visit_str<E>(self, value: &str) -> Result<Self::Value, E> {
        Ok(JsonNode::String(value.to_owned()))
    }

    fn visit_string<E>(self, value: String) -> Result<Self::Value, E> {
        Ok(JsonNode::String(value))
    }

    fn visit_seq<A>(self, mut sequence: A) -> Result<Self::Value, A::Error>
    where
        A: SeqAccess<'de>,
    {
        let mut values = Vec::new();
        while let Some(value) = sequence.next_element()? {
            values.push(value);
        }
        Ok(JsonNode::Array(values))
    }

    fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
    where
        A: MapAccess<'de>,
    {
        let mut entries = Vec::new();
        while let Some(entry) = map.next_entry()? {
            entries.push(entry);
        }
        Ok(JsonNode::Object(entries))
    }
}

impl<'de> Deserialize<'de> for JsonNode {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        deserializer.deserialize_any(JsonNodeVisitor)
    }
}

struct LegacyRequest {
    id: RequestId,
}

/// A frame parsed once while retaining enough source structure to preserve the pre-refactor
/// typed-envelope classification and duplicate-field behavior.
pub(crate) struct DecodedFrame {
    root: JsonNode,
}

impl DecodedFrame {
    pub(crate) fn decode(input: &str) -> Result<Self, String> {
        serde_json::from_str(input)
            .map(|root| Self { root })
            .map_err(|_| serialize_error(None, PARSE_ERROR, "Parse error", None))
    }

    fn legacy_request(&self) -> Option<LegacyRequest> {
        self.root.unique_field("jsonrpc")?.as_string()?;
        let id = self.root.unique_field("id")?.request_id()?;
        self.root.unique_field("method")?.as_string()?;
        self.root.unique_field("params")?;
        Some(LegacyRequest { id })
    }

    fn notification_params(&self, method: &str) -> Option<&[(String, JsonNode)]> {
        self.root.unique_field("jsonrpc")?.as_string()?;
        if self.root.unique_field("method")?.as_string()? != method {
            return None;
        }
        match self.root.unique_field("params")? {
            JsonNode::Object(entries) => Some(entries),
            _ => None,
        }
    }

    pub(crate) fn cancel_request_id(&self) -> Option<RequestId> {
        let entries = self.notification_params("$/cancelRequest")?;
        if entries.len() != 1 || entries[0].0 != "id" {
            return None;
        }
        entries[0].1.request_id()
    }

    fn subscription_cancel_id(&self) -> Option<SubscriptionId> {
        let entries = self.notification_params("subscription/cancel")?;
        if entries.len() != 1 || entries[0].0 != "subscriptionId" {
            return None;
        }
        Some(SubscriptionId::new(entries[0].1.as_string()?))
    }

    pub(crate) fn into_request_kind(self) -> RequestKind {
        let legacy = self.legacy_request();
        let legacy_classified = legacy.is_some();
        if !legacy_classified {
            if let Some(subscription_id) = self.subscription_cancel_id() {
                return RequestKind::Cancel(subscription_id);
            }
        }

        let admission_id = legacy.map(|request| request.id);
        match DecodedRequest::from_value(self.root.into_value()) {
            Ok(request) => {
                if legacy_classified {
                    match request.method.as_str() {
                        "watch" => {
                            return RequestKind::Watch {
                                id: request.id,
                                params: request.params,
                            };
                        }
                        "logs" => {
                            return RequestKind::Logs {
                                id: request.id,
                                params: request.params,
                            };
                        }
                        "agent/attach" => {
                            return RequestKind::AgentAttach {
                                id: request.id,
                                params: request.params,
                            };
                        }
                        _ => {}
                    }
                }
                RequestKind::Passthrough {
                    admission_id,
                    outcome: DecodedOutcome::Request(request),
                }
            }
            Err(response) => RequestKind::Passthrough {
                admission_id,
                outcome: DecodedOutcome::Response(response),
            },
        }
    }

    pub(super) fn into_value(self) -> Value {
        self.root.into_value()
    }
}
