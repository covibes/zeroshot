//! Closed, decidable payload type algebra for Cluster Protocol graphs.

use std::borrow::Cow;
use std::collections::{BTreeMap, BTreeSet};
use std::fmt;

use schemars::{json_schema, JsonSchema, Schema, SchemaGenerator};
use serde::de;
use serde::{Deserialize, Deserializer, Serialize};
use thiserror::Error;

use crate::MAX_SAFE_GENERATION;

pub const MAX_IDENTIFIER_LENGTH: usize = 128;
pub const MAX_PATH_SEGMENTS: usize = 64;
pub const MAX_COLLECTION_ITEMS: usize = 4096;

#[derive(Clone, Debug, Error, Eq, PartialEq)]
pub enum ContractValueError {
    #[error("{kind} must not be empty")]
    Empty { kind: &'static str },
    #[error("{kind} exceeds the maximum length of {maximum}")]
    TooLong { kind: &'static str, maximum: usize },
    #[error("{kind} contains invalid characters: {value}")]
    InvalidCharacters { kind: &'static str, value: String },
    #[error("{kind} must not contain duplicate values")]
    Duplicate { kind: &'static str },
    #[error("value must be between 1 and {MAX_SAFE_GENERATION}")]
    NotPositive,
}

fn validate_identifier(value: &str, kind: &'static str) -> Result<(), ContractValueError> {
    if value.len() > MAX_IDENTIFIER_LENGTH {
        return Err(ContractValueError::TooLong {
            kind,
            maximum: MAX_IDENTIFIER_LENGTH,
        });
    }
    let mut characters = value.chars();
    let Some(first) = characters.next() else {
        return Err(ContractValueError::Empty { kind });
    };
    if !(first.is_ascii_alphabetic() || first == '_')
        || !characters.all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '_' | '-' | '.')
        })
    {
        return Err(ContractValueError::InvalidCharacters {
            kind,
            value: value.to_owned(),
        });
    }
    Ok(())
}

macro_rules! identifier_type {
    ($name:ident, $kind:literal) => {
        #[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
        #[serde(transparent)]
        pub struct $name(String);

        impl $name {
            pub fn new(value: impl Into<String>) -> Result<Self, ContractValueError> {
                let value = value.into();
                validate_identifier(&value, $kind)?;
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

        impl std::str::FromStr for $name {
            type Err = ContractValueError;

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
                    "minLength": 1,
                    "maxLength": MAX_IDENTIFIER_LENGTH,
                    "pattern": "^[A-Za-z_][A-Za-z0-9_.-]*$"
                })
            }
        }
    };
}

identifier_type!(NodeName, "node name");
identifier_type!(FieldName, "field name");
identifier_type!(EnumLabel, "enum label");

#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(transparent)]
pub struct FieldPath(Vec<FieldName>);

impl FieldPath {
    pub fn new(segments: Vec<FieldName>) -> Result<Self, ContractValueError> {
        if segments.is_empty() {
            return Err(ContractValueError::Empty { kind: "field path" });
        }
        if segments.len() > MAX_PATH_SEGMENTS {
            return Err(ContractValueError::TooLong {
                kind: "field path",
                maximum: MAX_PATH_SEGMENTS,
            });
        }
        Ok(Self(segments))
    }

    #[must_use]
    pub fn segments(&self) -> &[FieldName] {
        &self.0
    }
}

impl<'de> Deserialize<'de> for FieldPath {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let segments = Vec::<FieldName>::deserialize(deserializer)?;
        Self::new(segments).map_err(de::Error::custom)
    }
}

impl JsonSchema for FieldPath {
    fn inline_schema() -> bool {
        true
    }

    fn schema_name() -> Cow<'static, str> {
        "FieldPath".into()
    }

    fn json_schema(generator: &mut SchemaGenerator) -> Schema {
        json_schema!({
            "type": "array",
            "minItems": 1,
            "maxItems": MAX_PATH_SEGMENTS,
            "items": generator.subschema_for::<FieldName>()
        })
    }
}

#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(transparent)]
pub struct PositiveInteger(u64);

impl PositiveInteger {
    pub(crate) const ONE: Self = Self(1);

    pub fn new(value: u64) -> Result<Self, ContractValueError> {
        if value == 0 || value > MAX_SAFE_GENERATION {
            Err(ContractValueError::NotPositive)
        } else {
            Ok(Self(value))
        }
    }

    #[must_use]
    pub const fn get(self) -> u64 {
        self.0
    }
}

impl<'de> Deserialize<'de> for PositiveInteger {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = crate::value::deserialize_javascript_safe_u64(deserializer, 1)?;
        PositiveInteger::new(value).map_err(de::Error::custom)
    }
}

impl JsonSchema for PositiveInteger {
    fn inline_schema() -> bool {
        true
    }

    fn schema_name() -> Cow<'static, str> {
        "PositiveInteger".into()
    }

    fn json_schema(_generator: &mut SchemaGenerator) -> Schema {
        crate::value::javascript_safe_integer_schema(1)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NonEmptyVec<T>(Vec<T>);

impl<T> NonEmptyVec<T> {
    pub fn new(values: Vec<T>) -> Result<Self, ContractValueError> {
        if values.is_empty() {
            return Err(ContractValueError::Empty {
                kind: "non-empty collection",
            });
        }
        if values.len() > MAX_COLLECTION_ITEMS {
            return Err(ContractValueError::TooLong {
                kind: "collection",
                maximum: MAX_COLLECTION_ITEMS,
            });
        }
        Ok(Self(values))
    }

    #[must_use]
    pub fn as_slice(&self) -> &[T] {
        &self.0
    }

    #[must_use]
    pub fn into_vec(self) -> Vec<T> {
        self.0
    }
}

impl<T> Serialize for NonEmptyVec<T>
where
    T: Serialize,
{
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        self.0.serialize(serializer)
    }
}

impl<'de, T> Deserialize<'de> for NonEmptyVec<T>
where
    T: Deserialize<'de>,
{
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let values = Vec::<T>::deserialize(deserializer)?;
        Self::new(values).map_err(de::Error::custom)
    }
}

impl<T> JsonSchema for NonEmptyVec<T>
where
    T: JsonSchema,
{
    fn schema_name() -> Cow<'static, str> {
        format!("NonEmptyVec_of_{}", T::schema_name()).into()
    }

    fn json_schema(generator: &mut SchemaGenerator) -> Schema {
        json_schema!({
            "type": "array",
            "minItems": 1,
            "maxItems": MAX_COLLECTION_ITEMS,
            "items": generator.subschema_for::<T>()
        })
    }
}

#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(transparent)]
pub struct NonEmptyEnumSet(Vec<EnumLabel>);

impl NonEmptyEnumSet {
    pub fn new(values: Vec<EnumLabel>) -> Result<Self, ContractValueError> {
        let values: BTreeSet<_> = values.into_iter().collect();
        if values.is_empty() {
            return Err(ContractValueError::Empty { kind: "enum set" });
        }
        if values.len() > MAX_COLLECTION_ITEMS {
            return Err(ContractValueError::TooLong {
                kind: "enum set",
                maximum: MAX_COLLECTION_ITEMS,
            });
        }
        Ok(Self(values.into_iter().collect()))
    }

    #[must_use]
    pub fn values(&self) -> &[EnumLabel] {
        &self.0
    }

    #[must_use]
    pub fn is_subset(&self, other: &Self) -> bool {
        self.0
            .iter()
            .all(|value| other.0.binary_search(value).is_ok())
    }
}

impl<'de> Deserialize<'de> for NonEmptyEnumSet {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let values = Vec::<EnumLabel>::deserialize(deserializer)?;
        let distinct: BTreeSet<_> = values.iter().cloned().collect();
        if distinct.len() != values.len() {
            return Err(de::Error::custom(ContractValueError::Duplicate {
                kind: "enum set",
            }));
        }
        Self::new(values).map_err(de::Error::custom)
    }
}

impl JsonSchema for NonEmptyEnumSet {
    fn inline_schema() -> bool {
        true
    }

    fn schema_name() -> Cow<'static, str> {
        "NonEmptyEnumSet".into()
    }

    fn json_schema(generator: &mut SchemaGenerator) -> Schema {
        json_schema!({
            "type": "array",
            "minItems": 1,
            "maxItems": MAX_COLLECTION_ITEMS,
            "uniqueItems": true,
            "items": generator.subschema_for::<EnumLabel>()
        })
    }
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RecordField {
    #[serde(rename = "type")]
    pub value_type: PayloadType,
    pub required: bool,
}

#[derive(Clone, Debug, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields, tag = "kind", rename_all = "snake_case")]
pub enum PayloadType {
    Null,
    Boolean,
    Integer,
    Number,
    String,
    Record {
        #[schemars(
            schema_with = "crate::value::identifier_keyed_map_schema::<FieldName, RecordField>"
        )]
        fields: BTreeMap<FieldName, RecordField>,
    },
    Array {
        items: Box<PayloadType>,
    },
    Enum {
        values: NonEmptyEnumSet,
    },
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum PayloadTypeWire {
    Null,
    Boolean,
    Integer,
    Number,
    String,
    Record {
        fields: BTreeMap<FieldName, RecordField>,
    },
    Array {
        items: Box<PayloadType>,
    },
    Enum {
        values: NonEmptyEnumSet,
    },
}

impl From<PayloadTypeWire> for PayloadType {
    fn from(wire: PayloadTypeWire) -> Self {
        match wire {
            PayloadTypeWire::Null => Self::Null,
            PayloadTypeWire::Boolean => Self::Boolean,
            PayloadTypeWire::Integer => Self::Integer,
            PayloadTypeWire::Number => Self::Number,
            PayloadTypeWire::String => Self::String,
            PayloadTypeWire::Record { fields } => Self::Record { fields },
            PayloadTypeWire::Array { items } => Self::Array { items },
            PayloadTypeWire::Enum { values } => Self::Enum { values },
        }
    }
}

fn payload_type_fields(kind: &str) -> &[&str] {
    match kind {
        "record" => &["kind", "fields"],
        "array" => &["kind", "items"],
        "enum" => &["kind", "values"],
        _ => &["kind"],
    }
}

fn reject_unknown_payload_type_fields(
    object: &serde_json::Map<String, serde_json::Value>,
    kind: &str,
) -> Result<(), String> {
    object
        .keys()
        .find(|key| !payload_type_fields(kind).contains(&key.as_str()))
        .map_or(Ok(()), |unknown| {
            Err(format!(
                "unknown field `{unknown}` in payload type `{kind}`"
            ))
        })
}

impl<'de> Deserialize<'de> for PayloadType {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = serde_json::Value::deserialize(deserializer)?;
        let object = value
            .as_object()
            .ok_or_else(|| de::Error::custom("payload type must be an object"))?;
        let kind = object
            .get("kind")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| de::Error::custom("payload type requires a string kind"))?;
        reject_unknown_payload_type_fields(object, kind).map_err(de::Error::custom)?;
        let wire = serde_json::from_value::<PayloadTypeWire>(value).map_err(de::Error::custom)?;
        Ok(wire.into())
    }
}

impl PayloadType {
    /// Total, recursive subtype relation for the closed v1 payload algebra.
    #[must_use]
    pub fn is_subtype_of(&self, target: &Self) -> bool {
        match (self, target) {
            (Self::Null, Self::Null)
            | (Self::Boolean, Self::Boolean)
            | (Self::Integer, Self::Integer)
            | (Self::Integer, Self::Number)
            | (Self::Number, Self::Number)
            | (Self::String, Self::String) => true,
            (Self::Array { items: source }, Self::Array { items: target }) => {
                source.is_subtype_of(target)
            }
            (Self::Enum { values: source }, Self::Enum { values: target }) => {
                source.is_subset(target)
            }
            (Self::Record { fields: source }, Self::Record { fields: target }) => target
                .iter()
                .all(|(name, target_field)| match source.get(name) {
                    Some(source_field) => {
                        (!target_field.required || source_field.required)
                            && source_field
                                .value_type
                                .is_subtype_of(&target_field.value_type)
                    }
                    None => !target_field.required,
                }),
            _ => false,
        }
    }
}
