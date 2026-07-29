macro_rules! bounded_text_type {
    ($name:ident, $max:expr, $error:ident, $field:expr) => {
        #[derive(Clone, Debug, serde::Deserialize, Eq, Hash, Ord, PartialEq, PartialOrd, serde::Serialize)]
        #[serde(transparent)]
        pub struct $name($crate::provider_value::BoundedText<$max>);
        impl $name {
            pub fn new(value: impl Into<String>) -> Result<Self, $error> {
                $crate::provider_value::BoundedText::new(value)
                    .map(Self)
                    .map_err(|error| $error::new($field, error))
            }
            #[must_use]
            pub fn as_str(&self) -> &str { self.0.as_str() }
        }
        impl std::fmt::Display for $name {
            fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str(self.as_str())
            }
        }
    };
}

macro_rules! bounded_bytes_type {
    ($name:ident, $max:expr, $error:ident, $field:expr) => {
        #[derive(Clone, Debug, serde::Deserialize, Eq, Hash, Ord, PartialEq, PartialOrd, serde::Serialize)]
        #[serde(transparent)]
        pub struct $name($crate::provider_value::BoundedBytes<$max>);
        impl $name {
            pub fn new(value: impl Into<String>) -> Result<Self, $error> {
                $crate::provider_value::BoundedBytes::new(value)
                    .map(Self)
                    .map_err(|error| $error::new($field, error))
            }
            #[must_use]
            pub fn as_str(&self) -> &str {
                self.0.as_str()
            }
        }
        impl std::fmt::Display for $name {
            fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str(self.as_str())
            }
        }
    };
}

macro_rules! provider_id_type {
    ($name:ident, $error:ident, $field:expr) => {
        #[derive(Clone, Debug, serde::Deserialize, Eq, Hash, Ord, PartialEq, PartialOrd, serde::Serialize)]
        #[serde(transparent)]
        pub struct $name($crate::provider_value::ProviderIdValue);
        impl $name {
            pub fn new(value: impl Into<String>) -> Result<Self, $error> {
                $crate::provider_value::ProviderIdValue::new(value)
                    .map(Self)
                    .map_err(|error| $error::new($field, error))
            }
            #[must_use]
            pub fn as_str(&self) -> &str { self.0.as_str() }
        }
        impl std::fmt::Display for $name {
            fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str(self.as_str())
            }
        }
    };
}

macro_rules! digest_type {
    ($name:ident, $error:ident, $field:expr) => {
        #[derive(Clone, Debug, serde::Deserialize, Eq, Hash, Ord, PartialEq, PartialOrd, serde::Serialize)]
        #[serde(transparent)]
        pub struct $name($crate::provider_value::DigestValue);
        impl $name {
            pub fn new(value: impl Into<String>) -> Result<Self, $error> {
                $crate::provider_value::DigestValue::new(value)
                    .map(Self)
                    .map_err(|error| $error::new($field, error))
            }
            #[must_use]
            pub fn as_str(&self) -> &str { self.0.as_str() }
        }
        impl std::fmt::Display for $name {
            fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str(self.as_str())
            }
        }
    };
}

macro_rules! contract_error_type {
    ($name:ident) => {
        #[derive(Clone, Debug, Eq, thiserror::Error, PartialEq)]
        #[error("invalid {field}: {reason}")]
        pub struct $name {
            field: &'static str,
            reason: String,
        }
        impl $name {
            fn new(field: &'static str, error: impl std::fmt::Display) -> Self {
                Self {
                    field,
                    reason: error.to_string(),
                }
            }
            #[must_use]
            pub fn field(&self) -> &'static str {
                self.field
            }
            #[must_use]
            pub fn reason(&self) -> &str {
                &self.reason
            }
            fn checked<T: serde::Serialize>(value: T) -> Result<T, Self> {
                $crate::provider_value::validate_serialized(&value)
                    .map_err(|error| Self::new("serialized value", error))?;
                Ok(value)
            }
        }
    };
}

macro_rules! provider_ref_type {
    ($name:ident, $id:ident, $error:ident, $field:expr) => {
        #[derive(Clone, Debug, serde::Deserialize, Eq, Hash, Ord, PartialEq, PartialOrd, serde::Serialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        pub struct $name { id: $id, version: std::num::NonZeroU32 }
        impl $name {
            pub fn new(id: $id, version: u32) -> Result<Self, $error> {
                let version = std::num::NonZeroU32::new(version)
                    .ok_or_else(|| $error::new($field, "version must be greater than zero"))?;
                Ok(Self { id, version })
            }
            #[must_use]
            pub fn id(&self) -> &$id { &self.id }
            #[must_use]
            pub fn version(&self) -> u32 { self.version.get() }
        }
        impl std::fmt::Display for $name {
            fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                write!(formatter, "{}@{}", self.id, self.version)
            }
        }
    };
}

macro_rules! profile_descriptor_type {
    ($name:ident, $wire:ident, $wire_name:literal, $capability:ident, $error:ident, $cap_field:literal) => {
        #[derive(Clone, Debug, serde::Deserialize, Eq, PartialEq, serde::Serialize)]
        #[serde(try_from = $wire_name, rename_all = "camelCase")]
        pub struct $name {
            capabilities: $crate::provider_value::BoundedSet<$capability>,
            provider_native_idempotency: $crate::provider_value::BoundedSet<$capability>,
        }
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct $wire {
            capabilities: $crate::provider_value::BoundedSet<$capability>,
            provider_native_idempotency: $crate::provider_value::BoundedSet<$capability>,
        }
        impl TryFrom<$wire> for $name {
            type Error = $error;
            fn try_from(wire: $wire) -> Result<Self, Self::Error> {
                if !wire
                    .provider_native_idempotency
                    .as_set()
                    .is_subset(wire.capabilities.as_set())
                {
                    return Err($error::new(
                        "provider-native idempotency",
                        "idempotent capabilities must also be supported",
                    ));
                }
                $error::checked(Self {
                    capabilities: wire.capabilities,
                    provider_native_idempotency: wire.provider_native_idempotency,
                })
            }
        }
        impl $name {
            pub fn new(
                capabilities: std::collections::BTreeSet<$capability>,
                provider_native_idempotency: std::collections::BTreeSet<$capability>,
            ) -> Result<Self, $error> {
                if !provider_native_idempotency.is_subset(&capabilities) {
                    return Err($error::new(
                        "provider-native idempotency",
                        "idempotent capabilities must also be supported",
                    ));
                }
                $error::checked(Self {
                    capabilities: $crate::provider_value::BoundedSet::new(capabilities)
                        .map_err(|error| $error::new($cap_field, error))?,
                    provider_native_idempotency: $crate::provider_value::BoundedSet::new(
                        provider_native_idempotency,
                    )
                    .map_err(|error| $error::new("provider-native idempotency", error))?,
                })
            }
            #[must_use]
            pub fn capabilities(&self) -> &std::collections::BTreeSet<$capability> {
                self.capabilities.as_set()
            }
            #[must_use]
            pub fn supports(&self, capability: $capability) -> bool {
                self.capabilities.as_set().contains(&capability)
            }
            #[must_use]
            pub fn has_provider_native_idempotency(&self, capability: $capability) -> bool {
                self.provider_native_idempotency
                    .as_set()
                    .contains(&capability)
            }
        }
    };
}

macro_rules! provider_contract_types {
    (
        $error:ident, $provider_id:ident, $profile_id:ident, $account_id:ident,
        $credential_id:ident, $operation_id:ident, $fingerprint:ident, $provider_ref:ident,
        $profile_max:expr, $domain:literal
    ) => {
        $crate::provider_value::contract_error_type!($error);
        $crate::provider_value::provider_id_type!(
            $provider_id,
            $error,
            concat!($domain, " provider id")
        );
        $crate::provider_value::bounded_text_type!(
            $profile_id,
            $profile_max,
            $error,
            concat!($domain, " profile id")
        );
        $crate::provider_value::bounded_text_type!(
            $account_id,
            $profile_max,
            $error,
            concat!($domain, " account id")
        );
        $crate::provider_value::bounded_text_type!(
            $credential_id,
            $profile_max,
            $error,
            concat!($domain, " credential handle id")
        );
        $crate::provider_value::bounded_text_type!(
            $operation_id,
            $profile_max,
            $error,
            concat!($domain, " operation id")
        );
        $crate::provider_value::digest_type!($fingerprint, $error, "operation fingerprint");
        $crate::provider_value::provider_ref_type!(
            $provider_ref,
            $provider_id,
            $error,
            concat!($domain, " provider version")
        );
    };
}

macro_rules! provider_descriptor_type {
    (
        $name:ident, $wire:ident, $wire_name:literal, $provider_ref:ident, $profile_id:ident,
        $profile:ident, $error:ident, $field:literal
    ) => {
        #[derive(Clone, Debug, serde::Deserialize, Eq, PartialEq, serde::Serialize)]
        #[serde(try_from = $wire_name, rename_all = "camelCase")]
        pub struct $name {
            provider: $provider_ref,
            profiles: $crate::provider_value::BoundedMap<$profile_id, $profile>,
        }
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct $wire {
            provider: $provider_ref,
            profiles: $crate::provider_value::BoundedMap<$profile_id, $profile>,
        }
        impl TryFrom<$wire> for $name {
            type Error = $error;
            fn try_from(wire: $wire) -> Result<Self, Self::Error> {
                $error::checked(Self {
                    provider: wire.provider,
                    profiles: wire.profiles,
                })
            }
        }
        impl $name {
            pub fn new(
                provider: $provider_ref,
                profiles: std::collections::BTreeMap<$profile_id, $profile>,
            ) -> Result<Self, $error> {
                $error::checked(Self {
                    provider,
                    profiles: $crate::provider_value::BoundedMap::new(profiles)
                        .map_err(|error| $error::new($field, error))?,
                })
            }
            #[must_use]
            pub fn provider(&self) -> &$provider_ref {
                &self.provider
            }
            #[must_use]
            pub fn profiles(&self) -> &std::collections::BTreeMap<$profile_id, $profile> {
                self.profiles.as_map()
            }
            #[must_use]
            pub fn profile(&self, profile: &$profile_id) -> Option<&$profile> {
                self.profiles.as_map().get(profile)
            }
        }
    };
}

pub(crate) use bounded_text_type;
pub(crate) use bounded_bytes_type;
pub(crate) use contract_error_type;
pub(crate) use digest_type;
pub(crate) use profile_descriptor_type;
pub(crate) use provider_contract_types;
pub(crate) use provider_descriptor_type;
pub(crate) use provider_id_type;
pub(crate) use provider_ref_type;
