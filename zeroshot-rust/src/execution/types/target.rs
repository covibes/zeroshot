use std::num::NonZeroU32;

use openengine_cluster_protocol::ArtifactRef;
use serde::{Deserialize, Deserializer, Serialize};

use crate::cluster_ledger::ResourceId;
use super::common::{checked_value, contract_error, validate_serialized_with_limit};
use super::{
    BuiltinWorkerId, DriverFamilyId, ExecutionContractError, InlineExecutionInput, ProviderLaneId,
    WorkerBindingId,
};

#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkerBindingRef {
    binding_id: WorkerBindingId,
    driver_family: DriverFamilyId,
    provider_lane: ProviderLaneId,
    version: NonZeroU32,
    supports_node_instance: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkerBindingSpec {
    pub binding_id: WorkerBindingId,
    pub driver_family: DriverFamilyId,
    pub provider_lane: ProviderLaneId,
    pub version: u32,
    pub supports_node_instance: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EncodedWorkerBindingRef {
    binding_id: WorkerBindingId,
    driver_family: DriverFamilyId,
    provider_lane: ProviderLaneId,
    version: u32,
    supports_node_instance: bool,
}

impl WorkerBindingRef {
    pub fn new(spec: WorkerBindingSpec) -> Result<Self, ExecutionContractError> {
        let value = Self {
            binding_id: spec.binding_id,
            driver_family: spec.driver_family,
            provider_lane: spec.provider_lane,
            version: NonZeroU32::new(spec.version).ok_or_else(|| {
                contract_error("worker binding version", "must be greater than zero")
            })?,
            supports_node_instance: spec.supports_node_instance,
        };
        validate_serialized_with_limit(&value, 4096, "worker binding ref")?;
        checked_value(value)
    }

    #[must_use]
    pub fn binding_id(&self) -> &WorkerBindingId {
        &self.binding_id
    }

    #[must_use]
    pub fn driver_family(&self) -> &DriverFamilyId {
        &self.driver_family
    }

    #[must_use]
    pub fn provider_lane(&self) -> &ProviderLaneId {
        &self.provider_lane
    }

    #[must_use]
    pub fn version(&self) -> u32 {
        self.version.get()
    }

    #[must_use]
    pub const fn supports_node_instance(&self) -> bool {
        self.supports_node_instance
    }
}

impl<'de> Deserialize<'de> for WorkerBindingRef {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let encoded = EncodedWorkerBindingRef::deserialize(deserializer)?;
        Self::new(encoded.into()).map_err(serde::de::Error::custom)
    }
}

#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BuiltinWorkerRef {
    builtin_id: BuiltinWorkerId,
    version: NonZeroU32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EncodedBuiltinWorkerRef {
    builtin_id: BuiltinWorkerId,
    version: u32,
}

impl BuiltinWorkerRef {
    pub fn new(builtin_id: BuiltinWorkerId, version: u32) -> Result<Self, ExecutionContractError> {
        let value = Self {
            builtin_id,
            version: NonZeroU32::new(version).ok_or_else(|| {
                contract_error("builtin worker version", "must be greater than zero")
            })?,
        };
        validate_serialized_with_limit(&value, 2048, "builtin worker ref")?;
        Ok(value)
    }

    #[must_use]
    pub fn builtin_id(&self) -> &BuiltinWorkerId {
        &self.builtin_id
    }

    #[must_use]
    pub fn version(&self) -> u32 {
        self.version.get()
    }
}

impl<'de> Deserialize<'de> for BuiltinWorkerRef {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let encoded = EncodedBuiltinWorkerRef::deserialize(deserializer)?;
        Self::new(encoded.builtin_id, encoded.version).map_err(serde::de::Error::custom)
    }
}

#[derive(Clone, Debug, Deserialize, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(tag = "kind", content = "value", rename_all = "snake_case")]
pub enum ExecutionTargetRef {
    Agent(WorkerBindingRef),
    Builtin(BuiltinWorkerRef),
}

impl ExecutionTargetRef {
    #[must_use]
    pub fn provider_lane(&self) -> Option<&ProviderLaneId> {
        match self {
            Self::Agent(value) => Some(value.provider_lane()),
            Self::Builtin(_) => None,
        }
    }
}

#[derive(
    Clone, Copy, Debug, Default, Deserialize, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize,
)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceAccessMode {
    ReadOnly,
    #[default]
    Exclusive,
}

#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceAccessRef {
    lease_key: ResourceId,
    mode: WorkspaceAccessMode,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EncodedWorkspaceAccessRef {
    lease_key: ResourceId,
    mode: WorkspaceAccessMode,
}

impl WorkspaceAccessRef {
    pub fn new(
        lease_key: ResourceId,
        mode: WorkspaceAccessMode,
    ) -> Result<Self, ExecutionContractError> {
        let value = Self { lease_key, mode };
        validate_serialized_with_limit(&value, 1024, "workspace access")?;
        Ok(value)
    }

    #[must_use]
    pub fn lease_key(&self) -> &ResourceId {
        &self.lease_key
    }

    #[must_use]
    pub const fn mode(&self) -> WorkspaceAccessMode {
        self.mode
    }
}

impl<'de> Deserialize<'de> for WorkspaceAccessRef {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let encoded = EncodedWorkspaceAccessRef::deserialize(deserializer)?;
        Self::new(encoded.lease_key, encoded.mode).map_err(serde::de::Error::custom)
    }
}

#[derive(
    Clone, Copy, Debug, Default, Deserialize, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize,
)]
#[serde(rename_all = "snake_case")]
pub enum SessionScope {
    #[default]
    Execution,
    NodeInstance,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", content = "value", rename_all = "snake_case")]
pub enum ExecutionInput {
    Inline(InlineExecutionInput),
    Artifact(ArtifactRef),
}

impl ExecutionInput {
    pub fn inline(value: impl Into<String>) -> Result<Self, ExecutionContractError> {
        Ok(Self::Inline(InlineExecutionInput::new(value)?))
    }
}

impl From<EncodedWorkerBindingRef> for WorkerBindingSpec {
    fn from(value: EncodedWorkerBindingRef) -> Self {
        Self {
            binding_id: value.binding_id,
            driver_family: value.driver_family,
            provider_lane: value.provider_lane,
            version: value.version,
            supports_node_instance: value.supports_node_instance,
        }
    }
}
