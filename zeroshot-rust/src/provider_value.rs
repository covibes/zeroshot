use std::collections::{BTreeMap, BTreeSet};
use std::fmt;

use serde::{de, Deserialize, Deserializer, Serialize};

pub(crate) const MAX_COLLECTION_ENTRIES: usize = 64;
pub(crate) const MAX_SERIALIZED_BYTES: usize = 65_536;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum ValueError {
    Empty,
    TooLong {
        max: usize,
        actual: usize,
        unit: &'static str,
    },
    ControlCharacter,
    InvalidProviderId,
    InvalidDigest,
    TooManyEntries {
        max: usize,
        actual: usize,
    },
    SerializedTooLarge {
        max: usize,
        actual: usize,
    },
    Serialization(String),
}

impl fmt::Display for ValueError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Empty => formatter.write_str("value must not be empty"),
            Self::TooLong { max, actual, unit } => {
                write!(formatter, "value is {actual} {unit}; maximum is {max}")
            }
            Self::ControlCharacter => formatter.write_str("value contains a control character"),
            Self::InvalidProviderId => formatter
                .write_str("provider id must match [a-z0-9][a-z0-9._-]* using lowercase ASCII"),
            Self::InvalidDigest => formatter.write_str(
                "fingerprint or digest must be exactly 64 lowercase hexadecimal characters",
            ),
            Self::TooManyEntries { max, actual } => {
                write!(
                    formatter,
                    "collection has {actual} entries; maximum is {max}"
                )
            }
            Self::SerializedTooLarge { max, actual } => {
                write!(
                    formatter,
                    "serialized value is {actual} bytes; maximum is {max}"
                )
            }
            Self::Serialization(message) => write!(formatter, "serialization failed: {message}"),
        }
    }
}

impl std::error::Error for ValueError {}

mod macros;

pub(crate) use macros::{
    bounded_bytes_type, bounded_text_type, contract_error_type, digest_type,
    profile_descriptor_type, provider_contract_types, provider_descriptor_type, provider_id_type,
    provider_ref_type,
};

fn validate_bounded(
    value: &str,
    max: usize,
    actual: usize,
    unit: &'static str,
) -> Result<(), ValueError> {
    if value.is_empty() {
        return Err(ValueError::Empty);
    }
    if actual > max {
        return Err(ValueError::TooLong { max, actual, unit });
    }
    if value.chars().any(char::is_control) {
        return Err(ValueError::ControlCharacter);
    }
    Ok(())
}

fn validate_text(value: &str, max: usize) -> Result<(), ValueError> {
    validate_bounded(value, max, value.chars().count(), "characters")
}

fn validate_bytes(value: &str, max: usize) -> Result<(), ValueError> {
    validate_bounded(value, max, value.len(), "bytes")
}

#[derive(Clone, Debug, Deserialize, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(try_from = "String")]
pub(crate) struct BoundedText<const MAX: usize>(String);

impl<const MAX: usize> BoundedText<MAX> {
    pub(crate) fn new(value: impl Into<String>) -> Result<Self, ValueError> {
        let value = value.into();
        validate_text(&value, MAX)?;
        Ok(Self(value))
    }

    pub(crate) fn as_str(&self) -> &str {
        &self.0
    }
}

impl<const MAX: usize> fmt::Display for BoundedText<MAX> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl<const MAX: usize> TryFrom<String> for BoundedText<MAX> {
    type Error = ValueError;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        Self::new(value)
    }
}

#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(transparent)]
pub(crate) struct BoundedBytes<const MAX: usize>(String);

impl<const MAX: usize> BoundedBytes<MAX> {
    pub(crate) fn new(value: impl Into<String>) -> Result<Self, ValueError> {
        let value = value.into();
        validate_bytes(&value, MAX)?;
        Ok(Self(value))
    }

    pub(crate) fn as_str(&self) -> &str {
        &self.0
    }
}

impl<'de, const MAX: usize> Deserialize<'de> for BoundedBytes<MAX> {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Self::new(value).map_err(de::Error::custom)
    }
}

#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(transparent)]
pub(crate) struct ProviderIdValue(String);

impl ProviderIdValue {
    pub(crate) fn new(value: impl Into<String>) -> Result<Self, ValueError> {
        let value = value.into();
        validate_text(&value, 64)?;
        let mut characters = value.chars();
        let first_is_valid = characters
            .next()
            .is_some_and(|character| character.is_ascii_lowercase() || character.is_ascii_digit());
        let rest_is_valid = characters.all(|character| {
            character.is_ascii_lowercase()
                || character.is_ascii_digit()
                || matches!(character, '.' | '_' | '-')
        });
        if !first_is_valid || !rest_is_valid {
            return Err(ValueError::InvalidProviderId);
        }
        Ok(Self(value))
    }

    pub(crate) fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for ProviderIdValue {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl<'de> Deserialize<'de> for ProviderIdValue {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Self::new(value).map_err(de::Error::custom)
    }
}

#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(transparent)]
pub(crate) struct DigestValue(String);

impl DigestValue {
    pub(crate) fn new(value: impl Into<String>) -> Result<Self, ValueError> {
        let value = value.into();
        let valid_hex = value
            .as_bytes()
            .iter()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'));
        if value.len() != 64 || !valid_hex {
            return Err(ValueError::InvalidDigest);
        }
        Ok(Self(value))
    }

    pub(crate) fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for DigestValue {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl<'de> Deserialize<'de> for DigestValue {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Self::new(value).map_err(de::Error::custom)
    }
}

pub(crate) fn validate_collection_len(actual: usize) -> Result<(), ValueError> {
    if actual > MAX_COLLECTION_ENTRIES {
        return Err(ValueError::TooManyEntries {
            max: MAX_COLLECTION_ENTRIES,
            actual,
        });
    }
    Ok(())
}

pub(crate) fn validate_serialized<T: Serialize + ?Sized>(value: &T) -> Result<(), ValueError> {
    let actual = serde_json::to_vec(value)
        .map_err(|error| ValueError::Serialization(error.to_string()))?
        .len();
    if actual > MAX_SERIALIZED_BYTES {
        return Err(ValueError::SerializedTooLarge {
            max: MAX_SERIALIZED_BYTES,
            actual,
        });
    }
    Ok(())
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(transparent)]
pub(crate) struct BoundedVec<T>(Vec<T>);

impl<T: Serialize> BoundedVec<T> {
    pub(crate) fn new(values: Vec<T>) -> Result<Self, ValueError> {
        validate_collection_len(values.len())?;
        validate_serialized(&values)?;
        Ok(Self(values))
    }

    pub(crate) fn as_slice(&self) -> &[T] {
        &self.0
    }
}

impl<'de, T> Deserialize<'de> for BoundedVec<T>
where
    T: Deserialize<'de> + Serialize,
{
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        Self::new(Vec::<T>::deserialize(deserializer)?).map_err(de::Error::custom)
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(transparent)]
pub(crate) struct BoundedSet<T>(BTreeSet<T>);

impl<T: Ord + Serialize> BoundedSet<T> {
    pub(crate) fn new(values: BTreeSet<T>) -> Result<Self, ValueError> {
        validate_collection_len(values.len())?;
        validate_serialized(&values)?;
        Ok(Self(values))
    }

    pub(crate) fn as_set(&self) -> &BTreeSet<T> {
        &self.0
    }
}

impl<'de, T> Deserialize<'de> for BoundedSet<T>
where
    T: Deserialize<'de> + Ord + Serialize,
{
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        Self::new(BTreeSet::<T>::deserialize(deserializer)?).map_err(de::Error::custom)
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(transparent)]
pub(crate) struct BoundedMap<K, V>(BTreeMap<K, V>);

impl<K: Ord + Serialize, V: Serialize> BoundedMap<K, V> {
    pub(crate) fn new(values: BTreeMap<K, V>) -> Result<Self, ValueError> {
        validate_collection_len(values.len())?;
        validate_serialized(&values)?;
        Ok(Self(values))
    }

    pub(crate) fn as_map(&self) -> &BTreeMap<K, V> {
        &self.0
    }
}

impl<'de, K, V> Deserialize<'de> for BoundedMap<K, V>
where
    K: Deserialize<'de> + Ord + Serialize,
    V: Deserialize<'de> + Serialize,
{
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        Self::new(BTreeMap::<K, V>::deserialize(deserializer)?).map_err(de::Error::custom)
    }
}
