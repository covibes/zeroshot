use serde::{Deserialize, Deserializer, Serialize};

use crate::cluster_ledger::{ExecutionId, NodeInstanceId, ResourceId, RunSequence};
use super::common::{contract_error, validate_serialized_with_limit};
use super::{
    CatalogDigest, DispatchFence, ExecutionContractError, ExecutionInput, ExecutionTargetRef,
    ProfileDigest, RecoveryRef, RegistryDigest, SessionScope, WorkspaceAccessRef,
};

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExecutionCommand {
    cluster: ResourceId,
    run: RunSequence,
    node_instance: NodeInstanceId,
    execution: ExecutionId,
    dispatch_fence: DispatchFence,
    recovery_ref: RecoveryRef,
    target: ExecutionTargetRef,
    catalog_digest: CatalogDigest,
    profile_digest: ProfileDigest,
    registry_digest: RegistryDigest,
    workspace: WorkspaceAccessRef,
    input: ExecutionInput,
    #[serde(default)]
    session_scope: SessionScope,
    execution_deadline_ms: u64,
    session_deadline_ms: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ExecutionCommandSpec {
    pub cluster: ResourceId,
    pub run: RunSequence,
    pub node_instance: NodeInstanceId,
    pub execution: ExecutionId,
    pub dispatch_fence: DispatchFence,
    pub recovery_ref: RecoveryRef,
    pub target: ExecutionTargetRef,
    pub catalog_digest: CatalogDigest,
    pub profile_digest: ProfileDigest,
    pub registry_digest: RegistryDigest,
    pub workspace: WorkspaceAccessRef,
    pub input: ExecutionInput,
    pub session_scope: SessionScope,
    pub execution_deadline_ms: u64,
    pub session_deadline_ms: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EncodedExecutionCommand {
    cluster: ResourceId,
    run: RunSequence,
    node_instance: NodeInstanceId,
    execution: ExecutionId,
    dispatch_fence: DispatchFence,
    recovery_ref: RecoveryRef,
    target: ExecutionTargetRef,
    catalog_digest: CatalogDigest,
    profile_digest: ProfileDigest,
    registry_digest: RegistryDigest,
    workspace: WorkspaceAccessRef,
    input: ExecutionInput,
    #[serde(default)]
    session_scope: SessionScope,
    execution_deadline_ms: u64,
    session_deadline_ms: u64,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExecutionControl {
    cluster: ResourceId,
    run: RunSequence,
    node_instance: NodeInstanceId,
    execution: ExecutionId,
    dispatch_fence: DispatchFence,
    recovery_ref: RecoveryRef,
    target: ExecutionTargetRef,
    catalog_digest: CatalogDigest,
    profile_digest: ProfileDigest,
    registry_digest: RegistryDigest,
    #[serde(default)]
    session_scope: SessionScope,
    execution_deadline_ms: u64,
    session_deadline_ms: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ExecutionControlSpec {
    pub cluster: ResourceId,
    pub run: RunSequence,
    pub node_instance: NodeInstanceId,
    pub execution: ExecutionId,
    pub dispatch_fence: DispatchFence,
    pub recovery_ref: RecoveryRef,
    pub target: ExecutionTargetRef,
    pub catalog_digest: CatalogDigest,
    pub profile_digest: ProfileDigest,
    pub registry_digest: RegistryDigest,
    pub session_scope: SessionScope,
    pub execution_deadline_ms: u64,
    pub session_deadline_ms: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EncodedExecutionControl {
    cluster: ResourceId,
    run: RunSequence,
    node_instance: NodeInstanceId,
    execution: ExecutionId,
    dispatch_fence: DispatchFence,
    recovery_ref: RecoveryRef,
    target: ExecutionTargetRef,
    catalog_digest: CatalogDigest,
    profile_digest: ProfileDigest,
    registry_digest: RegistryDigest,
    #[serde(default)]
    session_scope: SessionScope,
    execution_deadline_ms: u64,
    session_deadline_ms: u64,
}

fn validate_deadlines(
    execution_deadline_ms: u64,
    session_deadline_ms: u64,
) -> Result<(), ExecutionContractError> {
    if execution_deadline_ms == 0 {
        return Err(contract_error(
            "execution deadline",
            "must be greater than zero",
        ));
    }
    if session_deadline_ms == 0 {
        return Err(contract_error(
            "session deadline",
            "must be greater than zero",
        ));
    }
    if session_deadline_ms > execution_deadline_ms {
        return Err(contract_error(
            "session deadline",
            "must be less than or equal to the execution deadline",
        ));
    }
    Ok(())
}

impl ExecutionCommand {
    pub fn new(spec: ExecutionCommandSpec) -> Result<Self, ExecutionContractError> {
        validate_deadlines(spec.execution_deadline_ms, spec.session_deadline_ms)?;
        let value = Self {
            cluster: spec.cluster,
            run: spec.run,
            node_instance: spec.node_instance,
            execution: spec.execution,
            dispatch_fence: spec.dispatch_fence,
            recovery_ref: spec.recovery_ref,
            target: spec.target,
            catalog_digest: spec.catalog_digest,
            profile_digest: spec.profile_digest,
            registry_digest: spec.registry_digest,
            workspace: spec.workspace,
            input: spec.input,
            session_scope: spec.session_scope,
            execution_deadline_ms: spec.execution_deadline_ms,
            session_deadline_ms: spec.session_deadline_ms,
        };
        validate_serialized_with_limit(
            &value,
            super::common::MAX_EXECUTION_SERIALIZED_BYTES,
            "execution command",
        )?;
        Ok(value)
    }

    #[must_use]
    pub fn control(&self) -> ExecutionControl {
        ExecutionControl::new(self.control_spec())
            .expect("validated execution command must produce valid execution control")
    }

    #[must_use]
    pub fn cluster(&self) -> &ResourceId {
        &self.cluster
    }

    #[must_use]
    pub const fn run(&self) -> RunSequence {
        self.run
    }

    #[must_use]
    pub const fn node_instance(&self) -> NodeInstanceId {
        self.node_instance
    }

    #[must_use]
    pub const fn execution(&self) -> ExecutionId {
        self.execution
    }

    #[must_use]
    pub const fn dispatch_fence(&self) -> DispatchFence {
        self.dispatch_fence
    }

    #[must_use]
    pub fn recovery_ref(&self) -> &RecoveryRef {
        &self.recovery_ref
    }

    #[must_use]
    pub fn target(&self) -> &ExecutionTargetRef {
        &self.target
    }

    #[must_use]
    pub fn workspace(&self) -> &WorkspaceAccessRef {
        &self.workspace
    }

    #[must_use]
    pub fn input(&self) -> &ExecutionInput {
        &self.input
    }

    #[must_use]
    pub const fn session_scope(&self) -> SessionScope {
        self.session_scope
    }
}

impl<'de> Deserialize<'de> for ExecutionCommand {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let encoded = EncodedExecutionCommand::deserialize(deserializer)?;
        Self::new(encoded.into()).map_err(serde::de::Error::custom)
    }
}

impl ExecutionControl {
    pub fn new(spec: ExecutionControlSpec) -> Result<Self, ExecutionContractError> {
        validate_deadlines(spec.execution_deadline_ms, spec.session_deadline_ms)?;
        let value = Self {
            cluster: spec.cluster,
            run: spec.run,
            node_instance: spec.node_instance,
            execution: spec.execution,
            dispatch_fence: spec.dispatch_fence,
            recovery_ref: spec.recovery_ref,
            target: spec.target,
            catalog_digest: spec.catalog_digest,
            profile_digest: spec.profile_digest,
            registry_digest: spec.registry_digest,
            session_scope: spec.session_scope,
            execution_deadline_ms: spec.execution_deadline_ms,
            session_deadline_ms: spec.session_deadline_ms,
        };
        validate_serialized_with_limit(&value, 65_536, "execution control")?;
        Ok(value)
    }

    #[must_use]
    pub fn cluster(&self) -> &ResourceId {
        &self.cluster
    }

    #[must_use]
    pub const fn run(&self) -> RunSequence {
        self.run
    }

    #[must_use]
    pub const fn node_instance(&self) -> NodeInstanceId {
        self.node_instance
    }

    #[must_use]
    pub const fn execution(&self) -> ExecutionId {
        self.execution
    }

    #[must_use]
    pub const fn dispatch_fence(&self) -> DispatchFence {
        self.dispatch_fence
    }

    #[must_use]
    pub fn recovery_ref(&self) -> &RecoveryRef {
        &self.recovery_ref
    }

    #[must_use]
    pub fn target(&self) -> &ExecutionTargetRef {
        &self.target
    }

    #[must_use]
    pub const fn session_scope(&self) -> SessionScope {
        self.session_scope
    }
}

impl<'de> Deserialize<'de> for ExecutionControl {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let encoded = EncodedExecutionControl::deserialize(deserializer)?;
        Self::new(encoded.into()).map_err(serde::de::Error::custom)
    }
}

impl ExecutionCommand {
    fn control_spec(&self) -> ExecutionControlSpec {
        ExecutionControlSpec {
            cluster: self.cluster.clone(),
            run: self.run,
            node_instance: self.node_instance,
            execution: self.execution,
            dispatch_fence: self.dispatch_fence,
            recovery_ref: self.recovery_ref.clone(),
            target: self.target.clone(),
            catalog_digest: self.catalog_digest.clone(),
            profile_digest: self.profile_digest.clone(),
            registry_digest: self.registry_digest.clone(),
            session_scope: self.session_scope,
            execution_deadline_ms: self.execution_deadline_ms,
            session_deadline_ms: self.session_deadline_ms,
        }
    }
}

impl From<EncodedExecutionCommand> for ExecutionCommandSpec {
    fn from(value: EncodedExecutionCommand) -> Self {
        Self {
            cluster: value.cluster,
            run: value.run,
            node_instance: value.node_instance,
            execution: value.execution,
            dispatch_fence: value.dispatch_fence,
            recovery_ref: value.recovery_ref,
            target: value.target,
            catalog_digest: value.catalog_digest,
            profile_digest: value.profile_digest,
            registry_digest: value.registry_digest,
            workspace: value.workspace,
            input: value.input,
            session_scope: value.session_scope,
            execution_deadline_ms: value.execution_deadline_ms,
            session_deadline_ms: value.session_deadline_ms,
        }
    }
}

impl From<EncodedExecutionControl> for ExecutionControlSpec {
    fn from(value: EncodedExecutionControl) -> Self {
        Self {
            cluster: value.cluster,
            run: value.run,
            node_instance: value.node_instance,
            execution: value.execution,
            dispatch_fence: value.dispatch_fence,
            recovery_ref: value.recovery_ref,
            target: value.target,
            catalog_digest: value.catalog_digest,
            profile_digest: value.profile_digest,
            registry_digest: value.registry_digest,
            session_scope: value.session_scope,
            execution_deadline_ms: value.execution_deadline_ms,
            session_deadline_ms: value.session_deadline_ms,
        }
    }
}
