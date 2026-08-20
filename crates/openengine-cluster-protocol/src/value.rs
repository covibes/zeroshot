use std::fmt;

use std::borrow::Cow;

use schemars::{json_schema, JsonSchema, Schema, SchemaGenerator};
use serde::de::{self, Visitor};
use serde::{Deserialize, Deserializer, Serialize};

use crate::MAX_SAFE_GENERATION;

pub(crate) fn identifier_keyed_map_schema<K, V>(generator: &mut SchemaGenerator) -> Schema
where
    K: JsonSchema,
    V: JsonSchema,
{
    json_schema!({
        "type": "object",
        "propertyNames": generator.subschema_for::<K>(),
        "additionalProperties": generator.subschema_for::<V>()
    })
}

#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(transparent)]
pub struct BoundedString256(String);

impl BoundedString256 {
    pub fn new(value: impl Into<String>) -> Result<Self, &'static str> {
        let value = value.into();
        if value.is_empty() {
            Err("value must not be empty")
        } else if value.chars().count() > 256 || value.chars().any(char::is_control) {
            Err("value must be at most 256 non-control characters")
        } else {
            Ok(Self(value))
        }
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for BoundedString256 {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(transparent)]
pub(crate) struct Sha256String(String);

impl Sha256String {
    pub(crate) fn new(value: String) -> Result<Self, &'static str> {
        if value.len() == 64
            && value
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            Ok(Self(value))
        } else {
            Err("SHA-256 must be exactly 64 lowercase hexadecimal characters")
        }
    }

    pub(crate) fn as_str(&self) -> &str {
        &self.0
    }

    pub(crate) fn from_digest(bytes: &[u8]) -> Self {
        let mut encoded = String::with_capacity(bytes.len() * 2);
        for byte in bytes {
            encoded.push(hex_digit(byte >> 4));
            encoded.push(hex_digit(byte & 0x0f));
        }
        Self(encoded)
    }
}

fn hex_digit(value: u8) -> char {
    match value {
        0..=9 => char::from(b'0' + value),
        10..=15 => char::from(b'a' + value - 10),
        _ => '?',
    }
}

impl<'de> Deserialize<'de> for Sha256String {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        Self::new(String::deserialize(deserializer)?).map_err(de::Error::custom)
    }
}

impl JsonSchema for Sha256String {
    fn inline_schema() -> bool {
        true
    }

    fn schema_name() -> Cow<'static, str> {
        "Sha256String".into()
    }

    fn json_schema(_generator: &mut SchemaGenerator) -> Schema {
        json_schema!({ "type": "string", "pattern": "^[0-9a-f]{64}$" })
    }
}

impl<'de> Deserialize<'de> for BoundedString256 {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        Self::new(String::deserialize(deserializer)?).map_err(de::Error::custom)
    }
}

impl JsonSchema for BoundedString256 {
    fn inline_schema() -> bool {
        true
    }

    fn schema_name() -> Cow<'static, str> {
        "BoundedString256".into()
    }

    fn json_schema(_generator: &mut SchemaGenerator) -> Schema {
        json_schema!({
            "type": "string",
            "minLength": 1,
            "maxLength": 256,
            "pattern": r"^[^\u0000-\u001f\u007f-\u009f]+$"
        })
    }
}

pub(crate) fn deserialize_javascript_safe_u64<'de, D>(
    deserializer: D,
    minimum: u64,
) -> Result<u64, D::Error>
where
    D: Deserializer<'de>,
{
    struct SafeIntegerVisitor {
        minimum: u64,
    }

    impl Visitor<'_> for SafeIntegerVisitor {
        type Value = u64;

        fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
            write!(
                formatter,
                "an integer from {} through {MAX_SAFE_GENERATION}",
                self.minimum
            )
        }

        fn visit_u64<E>(self, value: u64) -> Result<Self::Value, E>
        where
            E: de::Error,
        {
            if value < self.minimum {
                Err(E::custom(format!(
                    "integer must be at least {}",
                    self.minimum
                )))
            } else if value > MAX_SAFE_GENERATION {
                Err(E::custom("integer is outside the JavaScript-safe range"))
            } else {
                Ok(value)
            }
        }

        fn visit_i64<E>(self, value: i64) -> Result<Self::Value, E>
        where
            E: de::Error,
        {
            let value = u64::try_from(value).map_err(E::custom)?;
            self.visit_u64(value)
        }

        fn visit_f64<E>(self, value: f64) -> Result<Self::Value, E>
        where
            E: de::Error,
        {
            if !value.is_finite() || value.fract() != 0.0 {
                return Err(E::custom("number is not an integer"));
            }
            if value < self.minimum as f64 {
                return Err(E::custom(format!(
                    "integer must be at least {}",
                    self.minimum
                )));
            }
            if value > MAX_SAFE_GENERATION as f64 {
                return Err(E::custom("integer is outside the JavaScript-safe range"));
            }
            integral_f64_to_u64(value)
                .ok_or_else(|| E::custom("number is not a JavaScript-safe integer"))
                .and_then(|value| self.visit_u64(value))
        }
    }

    deserializer.deserialize_any(SafeIntegerVisitor { minimum })
}

pub(crate) fn deserialize_validated_wire<'de, D, W, T, E>(
    deserializer: D,
    convert: impl FnOnce(W) -> Result<T, E>,
) -> Result<T, D::Error>
where
    D: Deserializer<'de>,
    W: Deserialize<'de>,
    E: fmt::Display,
{
    convert(W::deserialize(deserializer)?).map_err(de::Error::custom)
}

pub(crate) fn deserialize_u32<'de, D>(deserializer: D) -> Result<u32, D::Error>
where
    D: Deserializer<'de>,
{
    struct U32Visitor;

    impl Visitor<'_> for U32Visitor {
        type Value = u32;

        fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
            write!(formatter, "an integer from 0 through {}", u32::MAX)
        }

        fn visit_u64<E>(self, value: u64) -> Result<Self::Value, E>
        where
            E: de::Error,
        {
            u32::try_from(value).map_err(|_| E::custom("integer is outside the u32 range"))
        }

        fn visit_i64<E>(self, value: i64) -> Result<Self::Value, E>
        where
            E: de::Error,
        {
            let value =
                u64::try_from(value).map_err(|_| E::custom("integer is outside the u32 range"))?;
            self.visit_u64(value)
        }

        fn visit_f64<E>(self, value: f64) -> Result<Self::Value, E>
        where
            E: de::Error,
        {
            if !value.is_finite() || value.fract() != 0.0 {
                return Err(E::custom("number is not an integer"));
            }
            if value < 0.0 || value > f64::from(u32::MAX) {
                return Err(E::custom("integer is outside the u32 range"));
            }
            integral_f64_to_u64(value)
                .ok_or_else(|| E::custom("number is not an integer in the u32 range"))
                .and_then(|value| self.visit_u64(value))
        }
    }

    deserializer.deserialize_any(U32Visitor)
}

fn integral_f64_to_u64(value: f64) -> Option<u64> {
    if value == 0.0 {
        return Some(0);
    }
    value.to_string().parse().ok()
}

pub(crate) fn javascript_safe_integer_schema(minimum: u64) -> Schema {
    json_schema!({
        "type": "integer",
        "minimum": minimum,
        "maximum": MAX_SAFE_GENERATION
    })
}
