use std::borrow::Cow;
use std::collections::{BTreeMap, BTreeSet};

use schemars::{JsonSchema, Schema, SchemaGenerator, json_schema};
use serde::de;
use serde::{Deserialize, Deserializer, Serialize};

use crate::{ConnectionKey, EnvironmentVariableName};

use super::{
    MAX_DECLARED_CONNECTIONS, MAX_DECLARED_ENVIRONMENT_NAMES, NativeV2RunValueError,
    ReasoningEffort, SessionScope,
};

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize)]
#[serde(transparent)]
pub struct DeclaredEnvironment(BTreeSet<EnvironmentVariableName>);

impl DeclaredEnvironment {
    pub fn new(
        values: impl IntoIterator<Item = EnvironmentVariableName>,
    ) -> Result<Self, NativeV2RunValueError> {
        let values = values.into_iter().collect::<Vec<_>>();
        if values.len() > MAX_DECLARED_ENVIRONMENT_NAMES {
            return Err(NativeV2RunValueError(
                "declared environment contains more than 64 names",
            ));
        }
        let unique = values.iter().cloned().collect::<BTreeSet<_>>();
        if unique.len() != values.len() {
            return Err(NativeV2RunValueError(
                "declared environment contains a duplicate name",
            ));
        }
        Ok(Self(unique))
    }

    #[must_use]
    pub const fn empty() -> Self {
        Self(BTreeSet::new())
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    #[must_use]
    pub const fn as_set(&self) -> &BTreeSet<EnvironmentVariableName> {
        &self.0
    }

    pub fn iter(&self) -> impl Iterator<Item = &EnvironmentVariableName> {
        self.0.iter()
    }

    #[must_use]
    pub fn contains(&self, name: &EnvironmentVariableName) -> bool {
        self.0.contains(name)
    }
}

impl<'de> Deserialize<'de> for DeclaredEnvironment {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        Self::new(Vec::<EnvironmentVariableName>::deserialize(deserializer)?)
            .map_err(de::Error::custom)
    }
}

impl JsonSchema for DeclaredEnvironment {
    fn schema_name() -> Cow<'static, str> {
        "DeclaredEnvironment".into()
    }

    fn json_schema(generator: &mut SchemaGenerator) -> Schema {
        let item = generator.subschema_for::<EnvironmentVariableName>();
        json_schema!({
            "type": "array",
            "items": item,
            "maxItems": 64,
            "uniqueItems": true
        })
    }
}

/// Secret-free connection requirements declared by one executable node.
///
/// Keys select stored connections. Values define the exact environment fields the node requires
/// from each selected connection. One environment name cannot be supplied by two connection keys
/// in the same node binding.
#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize)]
#[serde(transparent)]
pub struct DeclaredConnections(BTreeMap<ConnectionKey, DeclaredEnvironment>);

impl DeclaredConnections {
    pub fn new(
        values: impl IntoIterator<Item = (ConnectionKey, DeclaredEnvironment)>,
    ) -> Result<Self, NativeV2RunValueError> {
        let values = values.into_iter().collect::<Vec<_>>();
        if values.len() > MAX_DECLARED_CONNECTIONS {
            return Err(NativeV2RunValueError(
                "node declares more than 64 connections",
            ));
        }
        let unique = values.iter().cloned().collect::<BTreeMap<_, _>>();
        if unique.len() != values.len() {
            return Err(NativeV2RunValueError(
                "node declares a duplicate connection key",
            ));
        }
        if unique.values().any(DeclaredEnvironment::is_empty) {
            return Err(NativeV2RunValueError(
                "declared connection must require at least one environment name",
            ));
        }
        let names = unique
            .values()
            .flat_map(DeclaredEnvironment::iter)
            .collect::<Vec<_>>();
        if names.len() > MAX_DECLARED_ENVIRONMENT_NAMES {
            return Err(NativeV2RunValueError(
                "node connections declare more than 64 environment names",
            ));
        }
        if names.iter().copied().collect::<BTreeSet<_>>().len() != names.len() {
            return Err(NativeV2RunValueError(
                "an environment name cannot be declared by two node connections",
            ));
        }
        Ok(Self(unique))
    }

    pub fn single(
        key: impl Into<String>,
        environment: DeclaredEnvironment,
    ) -> Result<Self, NativeV2RunValueError> {
        Self::new([(ConnectionKey::new(key)?, environment)])
    }

    #[must_use]
    pub const fn empty() -> Self {
        Self(BTreeMap::new())
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    #[must_use]
    pub const fn as_map(&self) -> &BTreeMap<ConnectionKey, DeclaredEnvironment> {
        &self.0
    }

    pub fn iter(&self) -> impl Iterator<Item = (&ConnectionKey, &DeclaredEnvironment)> {
        self.0.iter()
    }

    pub fn environment_names(&self) -> impl Iterator<Item = &EnvironmentVariableName> {
        self.0.values().flat_map(DeclaredEnvironment::iter)
    }
}

impl<'de> Deserialize<'de> for DeclaredConnections {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        Self::new(BTreeMap::<ConnectionKey, DeclaredEnvironment>::deserialize(
            deserializer,
        )?)
        .map_err(de::Error::custom)
    }
}

impl JsonSchema for DeclaredConnections {
    fn schema_name() -> Cow<'static, str> {
        "DeclaredConnections".into()
    }

    fn json_schema(generator: &mut SchemaGenerator) -> Schema {
        let value = generator.subschema_for::<DeclaredEnvironment>();
        json_schema!({
            "type": "object",
            "additionalProperties": value,
            "maxProperties": 64
        })
    }
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields, tag = "kind", rename_all = "snake_case")]
pub enum NodeRuntimeBinding {
    Agent {
        model: super::ModelId,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        effort: Option<ReasoningEffort>,
        #[serde(
            default,
            rename = "sessionScope",
            skip_serializing_if = "is_execution_scope"
        )]
        session_scope: SessionScope,
        #[serde(default, skip_serializing_if = "DeclaredConnections::is_empty")]
        connections: DeclaredConnections,
    },
    GitDelivery {
        #[serde(default, skip_serializing_if = "DeclaredConnections::is_empty")]
        connections: DeclaredConnections,
    },
}

fn is_execution_scope(scope: &SessionScope) -> bool {
    *scope == SessionScope::Execution
}

impl NodeRuntimeBinding {
    #[must_use]
    pub const fn declared_connections(&self) -> &DeclaredConnections {
        match self {
            Self::Agent { connections, .. } | Self::GitDelivery { connections } => connections,
        }
    }
}
