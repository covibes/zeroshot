//! Shared `Deserialize`/`Serialize` glue for validated wire types: a type whose invariants are
//! checked by a `validate()` method that both serde directions must call, so an invalid value can
//! never be produced or accepted on the wire. Used by every type in this crate that follows this
//! pattern (a private `*Wire` mirror for `Deserialize`, a private `*Ref` for `Serialize`), so the
//! boilerplate exists exactly once rather than being hand-copied per type.
macro_rules! impl_validate_gated_wire {
    ($ty:ident, $wire:ty, $ref_ty:ident) => {
        impl<'de> serde::Deserialize<'de> for $ty {
            fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
            where
                D: serde::Deserializer<'de>,
            {
                let value = Self::from(<$wire>::deserialize(deserializer)?);
                value.validate().map_err(serde::de::Error::custom)?;
                Ok(value)
            }
        }

        impl serde::Serialize for $ty {
            fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
            where
                S: serde::Serializer,
            {
                self.validate().map_err(serde::ser::Error::custom)?;
                $ref_ty::from(self).serialize(serializer)
            }
        }
    };
}

pub(crate) use impl_validate_gated_wire;

/// Shared `new`/`Deserialize`/`JsonSchema` glue for a non-empty, control-character-free string
/// newtype bounded by UTF-8 byte length (not character count). Used by every wire identifier/
/// target type that must never be empty, so the boilerplate exists exactly once rather than being
/// hand-copied per type.
macro_rules! impl_bounded_nonempty_string {
    ($name:ident, $max_bytes:expr, $max_bytes_msg:literal, $schema_name:literal) => {
        impl $name {
            pub fn new(value: impl Into<String>) -> Result<Self, &'static str> {
                let value = value.into();
                if value.is_empty() {
                    Err("value must not be empty")
                } else if value.len() > $max_bytes || value.chars().any(char::is_control) {
                    Err(concat!(
                        "value must be at most ",
                        $max_bytes_msg,
                        " non-control UTF-8 bytes"
                    ))
                } else {
                    Ok(Self(value))
                }
            }

            #[must_use]
            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl<'de> serde::Deserialize<'de> for $name {
            fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
            where
                D: serde::Deserializer<'de>,
            {
                Self::new(String::deserialize(deserializer)?).map_err(serde::de::Error::custom)
            }
        }

        impl schemars::JsonSchema for $name {
            fn inline_schema() -> bool {
                true
            }

            fn schema_name() -> std::borrow::Cow<'static, str> {
                $schema_name.into()
            }

            fn json_schema(_generator: &mut schemars::SchemaGenerator) -> schemars::Schema {
                schemars::json_schema!({
                    "type": "string",
                    "minLength": 1,
                    "maxLength": $max_bytes,
                    "pattern": r"^[^\u0000-\u001f\u007f-\u009f]+$"
                })
            }
        }
    };
}

pub(crate) use impl_bounded_nonempty_string;

/// Shared `new`/`redacted`/`Deserialize`/`JsonSchema` glue for a possibly-empty,
/// control-character-free, redacted-on-overflow string newtype bounded by UTF-8 byte length (not
/// character count). Used by every wire body-text type whose only bounded fallback for an
/// oversized value is a fixed redaction marker, so the boilerplate exists exactly once rather than
/// being hand-copied per type.
macro_rules! impl_bounded_redactable_string {
    ($name:ident, $max_bytes:expr, $max_bytes_msg:literal, $schema_name:literal, $redacted:expr) => {
        impl $name {
            pub fn new(value: impl Into<String>) -> Result<Self, &'static str> {
                let value = value.into();
                if value.len() > $max_bytes || value.chars().any(char::is_control) {
                    Err(concat!(
                        "value must be at most ",
                        $max_bytes_msg,
                        " non-control UTF-8 bytes"
                    ))
                } else {
                    Ok(Self(value))
                }
            }

            /// The fixed bounded redaction marker used when a raw value could not be safely
            /// projected.
            #[must_use]
            pub fn redacted() -> Self {
                Self($redacted.to_owned())
            }

            #[must_use]
            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl<'de> serde::Deserialize<'de> for $name {
            fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
            where
                D: serde::Deserializer<'de>,
            {
                Self::new(String::deserialize(deserializer)?).map_err(serde::de::Error::custom)
            }
        }

        impl schemars::JsonSchema for $name {
            fn inline_schema() -> bool {
                true
            }

            fn schema_name() -> std::borrow::Cow<'static, str> {
                $schema_name.into()
            }

            fn json_schema(_generator: &mut schemars::SchemaGenerator) -> schemars::Schema {
                schemars::json_schema!({
                    "type": "string",
                    "maxLength": $max_bytes,
                    "pattern": r"^[^\u0000-\u001f\u007f-\u009f]*$"
                })
            }
        }
    };
}

pub(crate) use impl_bounded_redactable_string;
