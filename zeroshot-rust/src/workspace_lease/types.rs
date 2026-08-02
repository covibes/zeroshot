use std::fmt;
use std::fs::{self, File};
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::cluster_ledger::{ExecutionId, OwnerId, ResourceId, RunSequence};
use crate::execution::{WorkspaceAccessMode, WorkspaceAccessRef};
use crate::source_code_provider::{
    CanonicalRepository, SourceBranchId, SourceProfileId, SourceRevisionId,
};

use super::{WorkspaceLeaseError, WorkspaceLeaseErrorKind};

const MAX_WORKSPACE_VALUE_BYTES: usize = 512;

#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(transparent)]
pub struct WorkspaceLeaseId(ResourceId);

impl WorkspaceLeaseId {
    pub fn derive(key: &WorkspaceLeaseKey) -> Self {
        let mut digest = Sha256::new();
        digest.update(b"zeroshot.workspace-lease/v1\0");
        digest.update(key.cluster.as_str().as_bytes());
        digest.update(b"\0");
        digest.update(key.run.get().to_be_bytes());
        digest.update(b"\0");
        digest.update(key.logical_key.as_str().as_bytes());
        match key.isolation {
            WorkspaceIsolation::Shared => digest.update(b"\0shared"),
            WorkspaceIsolation::Execution(execution) => {
                digest.update(b"\0execution\0");
                digest.update(execution.get().to_be_bytes());
            }
        }
        let encoded = format!("workspace.{:x}", digest.finalize());
        Self(ResourceId::new(encoded).expect("derived workspace resource id is valid"))
    }

    #[must_use]
    pub fn resource_id(&self) -> &ResourceId {
        &self.0
    }

    #[must_use]
    pub fn into_resource_id(self) -> ResourceId {
        self.0
    }
}

impl<'de> Deserialize<'de> for WorkspaceLeaseId {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let resource = ResourceId::deserialize(deserializer)?;
        if !resource.as_str().starts_with("workspace.") {
            return Err(serde::de::Error::custom(
                "workspace lease id must use the workspace resource namespace",
            ));
        }
        Ok(Self(resource))
    }
}

impl fmt::Display for WorkspaceLeaseId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(formatter)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WorkspaceIsolation {
    Shared,
    Execution(ExecutionId),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkspaceLeaseKey {
    pub cluster: ResourceId,
    pub run: RunSequence,
    pub logical_key: ResourceId,
    pub isolation: WorkspaceIsolation,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceLeaseState {
    CreatePending,
    Ready,
    CleanupRequired,
    Cleaned,
}

macro_rules! workspace_text {
    ($name:ident, $label:literal) => {
        #[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
        #[serde(transparent)]
        pub struct $name(String);

        impl $name {
            pub fn new(value: impl Into<String>) -> Result<Self, WorkspaceLeaseError> {
                let value = value.into();
                validate_text(&value, $label)?;
                Ok(Self(value))
            }

            #[must_use]
            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
            where
                D: serde::Deserializer<'de>,
            {
                let value = String::deserialize(deserializer)?;
                Self::new(value).map_err(serde::de::Error::custom)
            }
        }
    };
}

workspace_text!(WorkspaceProfile, "workspace profile");
workspace_text!(WorkspaceMaterializationId, "workspace materialization id");
workspace_text!(DockerResourceId, "Docker resource id");

#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(transparent)]
pub struct WorkspaceFingerprint(String);

impl WorkspaceFingerprint {
    pub fn new(value: impl Into<String>) -> Result<Self, WorkspaceLeaseError> {
        let value = value.into();
        if !is_lower_hex(&value, 64) {
            return Err(WorkspaceLeaseError::invalid(
                "workspace fingerprint must be 64 lowercase hexadecimal characters",
            ));
        }
        Ok(Self(value))
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl<'de> Deserialize<'de> for WorkspaceFingerprint {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        Self::new(String::deserialize(deserializer)?).map_err(serde::de::Error::custom)
    }
}

#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(transparent)]
pub struct DockerImageDigest(String);

impl DockerImageDigest {
    pub fn new(value: impl Into<String>) -> Result<Self, WorkspaceLeaseError> {
        let value = value.into();
        if !value
            .strip_prefix("sha256:")
            .is_some_and(|digest| is_lower_hex(digest, 64))
        {
            return Err(WorkspaceLeaseError::invalid(
                "Docker image digest must use canonical sha256:<64 lowercase hex>",
            ));
        }
        Ok(Self(value))
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl<'de> Deserialize<'de> for DockerImageDigest {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        Self::new(String::deserialize(deserializer)?).map_err(serde::de::Error::custom)
    }
}

#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(transparent)]
pub struct DockerMountHandleId(String);

impl DockerMountHandleId {
    pub fn new(value: impl Into<String>) -> Result<Self, WorkspaceLeaseError> {
        let value = value.into();
        validate_path_component(&value, "Docker mount handle id")?;
        if value == "docker.sock" || value.ends_with(".sock") {
            return Err(WorkspaceLeaseError::invalid(
                "Docker mount handles cannot name a host socket",
            ));
        }
        Ok(Self(value))
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl<'de> Deserialize<'de> for DockerMountHandleId {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        Self::new(String::deserialize(deserializer)?).map_err(serde::de::Error::custom)
    }
}

#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(transparent)]
pub struct WorkspaceName(String);

impl WorkspaceName {
    pub fn new(value: impl Into<String>) -> Result<Self, WorkspaceLeaseError> {
        let value = value.into();
        validate_text(&value, "workspace name")?;
        let valid = value != "."
            && value != ".."
            && value.bytes().all(|byte| {
                byte.is_ascii_lowercase() || byte.is_ascii_digit() || b"._-".contains(&byte)
            });
        if !valid {
            return Err(WorkspaceLeaseError::invalid(
                "workspace name must use lowercase ASCII letters, digits, '.', '_' or '-'",
            ));
        }
        Ok(Self(value))
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl<'de> Deserialize<'de> for WorkspaceName {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        Self::new(String::deserialize(deserializer)?).map_err(serde::de::Error::custom)
    }
}

#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(transparent)]
pub struct CanonicalWorkspaceRoot(String);

impl CanonicalWorkspaceRoot {
    pub fn new(value: impl Into<String>) -> Result<Self, WorkspaceLeaseError> {
        let value = value.into();
        validate_text(&value, "canonical workspace root")?;
        let path = Path::new(&value);
        if !path.is_absolute()
            || path
                .components()
                .any(|component| matches!(component, Component::CurDir | Component::ParentDir))
            || (value.len() > 1 && value.ends_with(std::path::MAIN_SEPARATOR))
        {
            return Err(WorkspaceLeaseError::invalid(
                "canonical workspace root must be an absolute normalized path",
            ));
        }
        Ok(Self(value))
    }

    #[must_use]
    pub fn as_path(&self) -> &Path {
        Path::new(&self.0)
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl<'de> Deserialize<'de> for CanonicalWorkspaceRoot {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        Self::new(String::deserialize(deserializer)?).map_err(serde::de::Error::custom)
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BorrowedWorkspace {
    pub canonical_root: CanonicalWorkspaceRoot,
    pub fingerprint: WorkspaceFingerprint,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorktreeWorkspace {
    pub repository: CanonicalRepository,
    pub revision: SourceRevisionId,
    pub source_profile: SourceProfileId,
    pub name: WorkspaceName,
    pub branch: SourceBranchId,
    pub profile: WorkspaceProfile,
    pub materialization: WorkspaceMaterializationId,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(try_from = "DockerWorkspaceWire")]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DockerWorkspace {
    image_digest: DockerImageDigest,
    resource: DockerResourceId,
    mount_handles: Vec<DockerMountHandleId>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DockerWorkspaceWire {
    image_digest: DockerImageDigest,
    resource: DockerResourceId,
    mount_handles: Vec<DockerMountHandleId>,
}

impl TryFrom<DockerWorkspaceWire> for DockerWorkspace {
    type Error = WorkspaceLeaseError;

    fn try_from(value: DockerWorkspaceWire) -> Result<Self, Self::Error> {
        Self::new(value.image_digest, value.resource, value.mount_handles)
    }
}

impl DockerWorkspace {
    pub fn new(
        image_digest: DockerImageDigest,
        resource: DockerResourceId,
        mount_handles: Vec<DockerMountHandleId>,
    ) -> Result<Self, WorkspaceLeaseError> {
        if mount_handles.is_empty() || mount_handles.len() > 16 {
            return Err(WorkspaceLeaseError::invalid(
                "Docker workspace requires between one and sixteen mount handles",
            ));
        }
        let mut canonical = mount_handles.clone();
        canonical.sort();
        canonical.dedup();
        if canonical != mount_handles {
            return Err(WorkspaceLeaseError::invalid(
                "Docker mount handles must be sorted and unique",
            ));
        }
        Ok(Self {
            image_digest,
            resource,
            mount_handles,
        })
    }

    #[must_use]
    pub fn image_digest(&self) -> &DockerImageDigest {
        &self.image_digest
    }

    #[must_use]
    pub fn resource(&self) -> &DockerResourceId {
        &self.resource
    }

    #[must_use]
    pub fn mount_handles(&self) -> &[DockerMountHandleId] {
        &self.mount_handles
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(
    rename_all = "snake_case",
    tag = "kind",
    content = "value",
    deny_unknown_fields
)]
pub enum WorkspaceMode {
    Borrowed(BorrowedWorkspace),
    Worktree(WorktreeWorkspace),
    Docker(DockerWorkspace),
}

impl WorkspaceMode {
    #[must_use]
    pub const fn is_owned(&self) -> bool {
        !matches!(self, Self::Borrowed(_))
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceLeaseRecord {
    pub id: WorkspaceLeaseId,
    pub owner: OwnerId,
    pub access_mode: WorkspaceAccessMode,
    pub mode: WorkspaceMode,
    pub state: WorkspaceLeaseState,
    pub revision: u64,
}

impl WorkspaceLeaseRecord {
    pub(crate) fn pending(request: &PrepareWorkspaceRequest) -> Self {
        Self {
            id: WorkspaceLeaseId::derive(&request.key),
            owner: request.owner.clone(),
            access_mode: request.access_mode,
            mode: request.mode.clone(),
            state: WorkspaceLeaseState::CreatePending,
            revision: 0,
        }
    }

    #[must_use]
    pub fn access(&self) -> WorkspaceAccessRef {
        WorkspaceAccessRef::new(self.id.0.clone(), self.access_mode)
            .expect("persisted workspace access is valid")
    }
}

#[derive(Clone, Debug)]
pub struct PrepareWorkspaceRequest {
    pub key: WorkspaceLeaseKey,
    pub owner: OwnerId,
    pub access_mode: WorkspaceAccessMode,
    pub mode: WorkspaceMode,
}

#[derive(Clone, Default)]
pub struct WorkspaceProductRootHooks {
    pub after_base_open: Option<Arc<dyn Fn() + Send + Sync>>,
    pub fail_after_staging_directory: Option<Arc<dyn Fn() -> bool + Send + Sync>>,
    pub fail_after_owner_marker_create: Option<Arc<dyn Fn() -> bool + Send + Sync>>,
    pub fail_after_owner_marker_sync: Option<Arc<dyn Fn() -> bool + Send + Sync>>,
    pub fail_after_inner_quarantine: Option<Arc<dyn Fn() -> bool + Send + Sync>>,
    pub fail_after_staging_quarantine: Option<Arc<dyn Fn() -> bool + Send + Sync>>,
    pub fail_after_outer_quarantine: Option<Arc<dyn Fn() -> bool + Send + Sync>>,
    pub fail_after_owner_marker_removal: Option<Arc<dyn Fn() -> bool + Send + Sync>>,
}

#[derive(Clone)]
pub struct WorkspaceProductRoots {
    worktree_directory: Arc<File>,
    docker_mount_directory: Arc<File>,
    hooks: WorkspaceProductRootHooks,
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum WorktreeContainerLocation {
    Public,
    Staging,
    PublicQuarantine,
    StagingQuarantine,
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum WorktreeWorkspaceLocation {
    Public,
    Staging,
    PublicQuarantine,
    StagingQuarantine,
}

#[derive(Clone)]
pub(crate) struct PinnedWorktree {
    container: Arc<File>,
    container_location: WorktreeContainerLocation,
    workspace: Option<Arc<File>>,
    workspace_location: Option<WorktreeWorkspaceLocation>,
}

struct FinishContainerQuarantineRequest<'a> {
    parent: &'a File,
    child: &'a str,
    expected: &'a File,
    lease: &'a WorkspaceLeaseRecord,
    fail_after_owner_marker_removal: &'a Option<Arc<dyn Fn() -> bool + Send + Sync>>,
}

impl PinnedWorktree {
    pub(crate) fn workspace(&self) -> Option<&Arc<File>> {
        self.workspace.as_ref()
    }

    pub(crate) fn workspace_for_inspect_effect(&self) -> Option<&Arc<File>> {
        (self.container_location == WorktreeContainerLocation::Public
            && self.workspace_location == Some(WorktreeWorkspaceLocation::Public))
        .then_some(())
        .and(self.workspace.as_ref())
    }

    pub(crate) fn workspace_for_create_effect(&self) -> Option<&Arc<File>> {
        (self.container_location == WorktreeContainerLocation::Staging
            && self.workspace_location == Some(WorktreeWorkspaceLocation::Staging))
        .then_some(())
        .and(self.workspace.as_ref())
    }

    pub(crate) fn workspace_for_cleanup_effect(&self) -> Option<&Arc<File>> {
        matches!(
            self.workspace_location,
            Some(WorktreeWorkspaceLocation::Public | WorktreeWorkspaceLocation::Staging)
        )
        .then_some(())
        .and(self.workspace.as_ref())
    }
}

impl WorkspaceProductRoots {
    pub fn new(base: CanonicalWorkspaceRoot) -> Result<Self, WorkspaceLeaseError> {
        Self::new_with_hooks(base, WorkspaceProductRootHooks::default())
    }

    pub fn new_with_hooks(
        base: CanonicalWorkspaceRoot,
        hooks: WorkspaceProductRootHooks,
    ) -> Result<Self, WorkspaceLeaseError> {
        #[cfg(not(target_os = "linux"))]
        {
            let _ = (base, hooks);
            return Err(WorkspaceLeaseError::invalid(
                "owned workspace roots require Linux descriptor-relative filesystem support",
            ));
        }
        #[cfg(target_os = "linux")]
        {
            let base_directory = open_validated_product_base(base.as_path(), &hooks)?;
            let worktree_directory = open_pinned_product_child(&base_directory, "worktrees")?;
            let docker_mount_directory = open_pinned_product_child(&base_directory, "mounts")?;
            Ok(Self {
                worktree_directory: Arc::new(worktree_directory),
                docker_mount_directory: Arc::new(docker_mount_directory),
                hooks,
            })
        }
    }

    pub(crate) fn inspect_worktree(
        &self,
        name: &WorkspaceName,
        lease: &WorkspaceLeaseRecord,
    ) -> Result<Option<PinnedWorktree>, WorkspaceLeaseError> {
        let staging_name = worktree_staging_name(name);
        let quarantine_name = cleanup_name(name.as_str());
        let staging_quarantine_name = cleanup_name(&staging_name);
        let public = inspect_recognized_worktree_child(&self.worktree_directory, name.as_str())?;
        let staging = inspect_recognized_worktree_child(&self.worktree_directory, &staging_name)?;
        let quarantine =
            inspect_recognized_worktree_child(&self.worktree_directory, &quarantine_name)?;
        let staging_quarantine =
            inspect_recognized_worktree_child(&self.worktree_directory, &staging_quarantine_name)?;
        let present = usize::from(public.is_some())
            + usize::from(staging.is_some())
            + usize::from(quarantine.is_some())
            + usize::from(staging_quarantine.is_some());
        if present > 1 {
            return Err(worktree_mismatch(
                "workspace public, staging, and quarantine names conflict",
            ));
        }
        let (container, container_location, owner_status) = if let Some(container) = public {
            let owner_status = worktree_owner_status(&container, lease)?;
            if owner_status != WorktreeOwnerStatus::Matching {
                return Err(worktree_mismatch(
                    "workspace worktree owner marker does not match durable intent",
                ));
            }
            (container, WorktreeContainerLocation::Public, owner_status)
        } else if let Some(container) = staging {
            let owner_status = worktree_owner_status(&container, lease)?;
            if owner_status == WorktreeOwnerStatus::Foreign {
                return Err(worktree_mismatch(
                    "workspace staging owner marker does not match durable intent",
                ));
            }
            (container, WorktreeContainerLocation::Staging, owner_status)
        } else if let Some(container) = quarantine {
            let owner_status = worktree_owner_status(&container, lease)?;
            if owner_status == WorktreeOwnerStatus::Foreign {
                return Err(worktree_mismatch(
                    "workspace quarantine owner marker does not match durable intent",
                ));
            }
            (
                container,
                WorktreeContainerLocation::PublicQuarantine,
                owner_status,
            )
        } else if let Some(container) = staging_quarantine {
            let owner_status = worktree_owner_status(&container, lease)?;
            if owner_status == WorktreeOwnerStatus::Foreign {
                return Err(worktree_mismatch(
                    "workspace staging quarantine owner marker does not match durable intent",
                ));
            }
            (
                container,
                WorktreeContainerLocation::StagingQuarantine,
                owner_status,
            )
        } else {
            return Ok(None);
        };
        validate_worktree_container_shape(&container, container_location, owner_status)?;

        let workspace_name = "workspace";
        let workspace_staging_name = workspace_staging_name();
        let workspace_quarantine_name = cleanup_name(workspace_name);
        let workspace_staging_quarantine_name = cleanup_name(workspace_staging_name);
        let workspace = inspect_recognized_worktree_child(&container, workspace_name)?;
        let workspace_staging =
            inspect_recognized_worktree_child(&container, workspace_staging_name)?;
        let workspace_quarantine =
            inspect_recognized_worktree_child(&container, &workspace_quarantine_name)?;
        let workspace_staging_quarantine =
            inspect_recognized_worktree_child(&container, &workspace_staging_quarantine_name)?;
        let present = usize::from(workspace.is_some())
            + usize::from(workspace_staging.is_some())
            + usize::from(workspace_quarantine.is_some())
            + usize::from(workspace_staging_quarantine.is_some());
        if present > 1 {
            return Err(worktree_mismatch(
                "workspace child and recovery names conflict",
            ));
        }
        let (workspace, workspace_location) = if let Some(workspace) = workspace {
            (
                Some(Arc::new(workspace)),
                Some(WorktreeWorkspaceLocation::Public),
            )
        } else if let Some(workspace) = workspace_staging {
            (
                Some(Arc::new(workspace)),
                Some(WorktreeWorkspaceLocation::Staging),
            )
        } else if let Some(workspace) = workspace_quarantine {
            (
                Some(Arc::new(workspace)),
                Some(WorktreeWorkspaceLocation::PublicQuarantine),
            )
        } else if let Some(workspace) = workspace_staging_quarantine {
            (
                Some(Arc::new(workspace)),
                Some(WorktreeWorkspaceLocation::StagingQuarantine),
            )
        } else {
            (None, None)
        };
        Ok(Some(PinnedWorktree {
            container: Arc::new(container),
            container_location,
            workspace,
            workspace_location,
        }))
    }

    pub(crate) fn create_worktree(
        &self,
        name: &WorkspaceName,
        lease: &WorkspaceLeaseRecord,
    ) -> Result<PinnedWorktree, WorkspaceLeaseError> {
        let staging_name = worktree_staging_name(name);
        if inspect_recognized_worktree_child(&self.worktree_directory, name.as_str())?.is_some()
            || inspect_recognized_worktree_child(
                &self.worktree_directory,
                &cleanup_name(name.as_str()),
            )?
            .is_some()
            || inspect_recognized_worktree_child(
                &self.worktree_directory,
                &cleanup_name(&staging_name),
            )?
            .is_some()
        {
            return Err(worktree_mismatch(
                "workspace public or quarantine name appeared before create",
            ));
        }
        let (staging, created) =
            open_pinned_product_child_with_status(&self.worktree_directory, &staging_name)?;
        if created && hook_fails(&self.hooks.fail_after_staging_directory) {
            return Err(injected_root_failure(
                "workspace staging interrupted after directory creation",
            ));
        }
        let owner_status = worktree_owner_status(&staging, lease)?;
        match owner_status {
            WorktreeOwnerStatus::Matching => {}
            WorktreeOwnerStatus::Recoverable => {
                remove_worktree_owner_if_present(&staging)?;
                set_worktree_owner(&staging, lease, &self.hooks.fail_after_owner_marker_create)?;
            }
            WorktreeOwnerStatus::Foreign => {
                return Err(worktree_mismatch(
                    "workspace staging owner marker does not match durable intent",
                ));
            }
        }
        staging.sync_all().map_err(|_| {
            WorkspaceLeaseError::new(
                WorkspaceLeaseErrorKind::ResourceUnavailable,
                "workspace staging directory could not be synchronized",
            )
        })?;
        validate_worktree_container_shape(
            &staging,
            WorktreeContainerLocation::Staging,
            WorktreeOwnerStatus::Matching,
        )?;
        if hook_fails(&self.hooks.fail_after_owner_marker_sync) {
            return Err(injected_root_failure(
                "workspace staging interrupted after owner marker synchronization",
            ));
        }
        let workspace = open_pinned_product_child(&staging, workspace_staging_name())?;
        Ok(PinnedWorktree {
            container: Arc::new(staging),
            container_location: WorktreeContainerLocation::Staging,
            workspace: Some(Arc::new(workspace)),
            workspace_location: Some(WorktreeWorkspaceLocation::Staging),
        })
    }

    pub(crate) fn publish_worktree(
        &self,
        name: &WorkspaceName,
        worktree: &PinnedWorktree,
        lease: &WorkspaceLeaseRecord,
    ) -> Result<(), WorkspaceLeaseError> {
        if worktree.container_location != WorktreeContainerLocation::Staging
            || worktree.workspace_location != Some(WorktreeWorkspaceLocation::Staging)
            || !named_child_matches(
                &self.worktree_directory,
                &worktree_staging_name(name),
                &worktree.container,
            )?
        {
            return Err(worktree_mismatch(
                "workspace staging identity changed before publication",
            ));
        }
        let workspace = worktree
            .workspace()
            .ok_or_else(|| worktree_mismatch("workspace source staging is absent"))?;
        if !named_child_matches(&worktree.container, workspace_staging_name(), workspace)? {
            return Err(worktree_mismatch(
                "workspace source staging identity changed before publication",
            ));
        }
        if worktree_owner_status(&worktree.container, lease)? != WorktreeOwnerStatus::Matching {
            return Err(worktree_mismatch(
                "workspace staging owner marker changed before publication",
            ));
        }
        validate_worktree_container_shape(
            &worktree.container,
            WorktreeContainerLocation::Staging,
            WorktreeOwnerStatus::Matching,
        )?;
        rename_product_child(&worktree.container, workspace_staging_name(), "workspace")?;
        worktree.container.sync_all().map_err(|_| {
            injected_root_failure("workspace source publication could not be synchronized")
        })?;
        rename_product_child(
            &self.worktree_directory,
            &worktree_staging_name(name),
            name.as_str(),
        )?;
        self.worktree_directory.sync_all().map_err(|_| {
            injected_root_failure("workspace worktree publication could not be synchronized")
        })?;
        let published =
            open_existing_pinned_product_child(&self.worktree_directory, name.as_str())?
                .ok_or_else(|| {
                    injected_root_failure("workspace worktree publication disappeared")
                })?;
        if !named_child_matches(&published, "workspace", workspace)?
            || worktree_owner_status(&published, lease)? != WorktreeOwnerStatus::Matching
        {
            return Err(worktree_mismatch("published workspace identity changed"));
        }
        validate_worktree_container_shape(
            &published,
            WorktreeContainerLocation::Public,
            WorktreeOwnerStatus::Matching,
        )
    }

    pub(crate) fn remove_worktree(
        &self,
        name: &WorkspaceName,
        worktree: &PinnedWorktree,
        lease: &WorkspaceLeaseRecord,
    ) -> Result<(), WorkspaceLeaseError> {
        if let (Some(workspace), Some(location)) =
            (worktree.workspace(), worktree.workspace_location)
        {
            match location {
                WorktreeWorkspaceLocation::Public => quarantine_and_remove_product_child(
                    &worktree.container,
                    "workspace",
                    workspace,
                    &self.hooks.fail_after_inner_quarantine,
                )?,
                WorktreeWorkspaceLocation::Staging => quarantine_and_remove_product_child(
                    &worktree.container,
                    workspace_staging_name(),
                    workspace,
                    &self.hooks.fail_after_inner_quarantine,
                )?,
                WorktreeWorkspaceLocation::PublicQuarantine => {
                    remove_quarantined_product_child(&worktree.container, "workspace", workspace)?
                }
                WorktreeWorkspaceLocation::StagingQuarantine => remove_quarantined_product_child(
                    &worktree.container,
                    workspace_staging_name(),
                    workspace,
                )?,
            }
        }
        match worktree.container_location {
            WorktreeContainerLocation::Public => {
                quarantine_product_child(
                    &self.worktree_directory,
                    name.as_str(),
                    &worktree.container,
                )?;
                if hook_fails(&self.hooks.fail_after_outer_quarantine) {
                    return Err(injected_root_failure(
                        "workspace cleanup interrupted after outer quarantine",
                    ));
                }
                finish_container_quarantine(FinishContainerQuarantineRequest {
                    parent: &self.worktree_directory,
                    child: name.as_str(),
                    expected: &worktree.container,
                    lease,
                    fail_after_owner_marker_removal: &self.hooks.fail_after_owner_marker_removal,
                })
            }
            WorktreeContainerLocation::Staging => {
                let staging_name = worktree_staging_name(name);
                quarantine_product_child(
                    &self.worktree_directory,
                    &staging_name,
                    &worktree.container,
                )?;
                if hook_fails(&self.hooks.fail_after_staging_quarantine) {
                    return Err(injected_root_failure(
                        "workspace staging cleanup interrupted after quarantine",
                    ));
                }
                finish_container_quarantine(FinishContainerQuarantineRequest {
                    parent: &self.worktree_directory,
                    child: &staging_name,
                    expected: &worktree.container,
                    lease,
                    fail_after_owner_marker_removal: &self.hooks.fail_after_owner_marker_removal,
                })
            }
            WorktreeContainerLocation::PublicQuarantine => {
                finish_container_quarantine(FinishContainerQuarantineRequest {
                    parent: &self.worktree_directory,
                    child: name.as_str(),
                    expected: &worktree.container,
                    lease,
                    fail_after_owner_marker_removal: &self.hooks.fail_after_owner_marker_removal,
                })
            }
            WorktreeContainerLocation::StagingQuarantine => {
                let staging_name = worktree_staging_name(name);
                finish_container_quarantine(FinishContainerQuarantineRequest {
                    parent: &self.worktree_directory,
                    child: &staging_name,
                    expected: &worktree.container,
                    lease,
                    fail_after_owner_marker_removal: &self.hooks.fail_after_owner_marker_removal,
                })
            }
        }
    }

    fn docker_mount(
        &self,
        handle: &DockerMountHandleId,
        container_path: PathBuf,
    ) -> Result<DockerMount, WorkspaceLeaseError> {
        let source_directory =
            open_pinned_product_child(&self.docker_mount_directory, handle.as_str())?;
        Ok(DockerMount {
            handle: handle.clone(),
            source_directory: Arc::new(source_directory),
            container_path,
            read_only: false,
        })
    }

    pub fn default_docker_mounts(
        &self,
        mode: &DockerWorkspace,
    ) -> Result<Vec<DockerMount>, WorkspaceLeaseError> {
        mode.mount_handles
            .iter()
            .enumerate()
            .map(|(index, handle)| {
                self.docker_mount(
                    handle,
                    if index == 0 {
                        PathBuf::from("/workspace")
                    } else {
                        PathBuf::from(format!("/workspace/mount-{index}"))
                    },
                )
            })
            .collect()
    }
}

#[derive(Clone)]
pub struct DockerMount {
    pub handle: DockerMountHandleId,
    source_directory: Arc<File>,
    pub container_path: PathBuf,
    pub read_only: bool,
}

impl DockerMount {
    #[must_use]
    pub fn source_directory(&self) -> &File {
        &self.source_directory
    }
}

#[cfg(target_os = "linux")]
fn open_validated_product_base(
    path: &Path,
    hooks: &WorkspaceProductRootHooks,
) -> Result<File, WorkspaceLeaseError> {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};

    let canonical = fs::canonicalize(path).map_err(|_| {
        WorkspaceLeaseError::new(
            WorkspaceLeaseErrorKind::ResourceUnavailable,
            "workspace product base must already exist",
        )
    })?;
    let mut names = path.iter().rev();
    if canonical != path
        || names.next() != Some(std::ffi::OsStr::new("workspaces"))
        || names.next() != Some(std::ffi::OsStr::new("zeroshot"))
    {
        return Err(WorkspaceLeaseError::invalid(
            "workspace product base must be a canonical zeroshot/workspaces directory",
        ));
    }
    let directory = open_directory_no_follow(path)?;
    let descriptor_metadata = directory.metadata().map_err(|_| {
        WorkspaceLeaseError::new(
            WorkspaceLeaseErrorKind::ResourceUnavailable,
            "workspace product base could not be inspected",
        )
    })?;
    if let Some(hook) = &hooks.after_base_open {
        hook();
    }
    let canonical_after = fs::canonicalize(path).map_err(|_| {
        WorkspaceLeaseError::new(
            WorkspaceLeaseErrorKind::ResourceUnavailable,
            "workspace product base identity changed",
        )
    })?;
    let path_metadata = fs::symlink_metadata(path).map_err(|_| {
        WorkspaceLeaseError::new(
            WorkspaceLeaseErrorKind::ResourceUnavailable,
            "workspace product base identity changed",
        )
    })?;
    if canonical_after != path
        || path_metadata.file_type().is_symlink()
        || path_metadata.dev() != descriptor_metadata.dev()
        || path_metadata.ino() != descriptor_metadata.ino()
    {
        return Err(WorkspaceLeaseError::new(
            WorkspaceLeaseErrorKind::ResourceMismatch,
            "workspace product base changed during validation",
        ));
    }
    if !descriptor_metadata.is_dir()
        || descriptor_metadata.uid() != unsafe { libc::geteuid() }
        || descriptor_metadata.permissions().mode() & 0o777 != 0o700
    {
        return Err(WorkspaceLeaseError::invalid(
            "workspace product base must be an owned private directory",
        ));
    }
    Ok(directory)
}

#[cfg(target_os = "linux")]
fn open_directory_no_follow(path: &Path) -> Result<File, WorkspaceLeaseError> {
    use std::os::unix::fs::OpenOptionsExt;
    fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)
        .map_err(|_| {
            WorkspaceLeaseError::invalid(
                "workspace product directory must be an existing non-symlink directory",
            )
        })
}

#[cfg(not(target_os = "linux"))]
fn open_directory_no_follow(_path: &Path) -> Result<File, WorkspaceLeaseError> {
    Err(WorkspaceLeaseError::invalid(
        "owned workspace roots require Linux descriptor-relative filesystem support",
    ))
}

#[cfg(target_os = "linux")]
fn open_pinned_product_child(parent: &File, child: &str) -> Result<File, WorkspaceLeaseError> {
    open_pinned_product_child_with_status(parent, child).map(|(directory, _)| directory)
}

#[cfg(target_os = "linux")]
fn open_pinned_product_child_with_status(
    parent: &File,
    child: &str,
) -> Result<(File, bool), WorkspaceLeaseError> {
    use std::ffi::CString;
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::os::unix::fs::{MetadataExt, PermissionsExt};

    let child = CString::new(child)
        .map_err(|_| WorkspaceLeaseError::invalid("workspace handle contains a NUL byte"))?;
    let created = unsafe { libc::mkdirat(parent.as_raw_fd(), child.as_ptr(), 0o700) };
    let created = if created == 0 {
        true
    } else {
        let error = std::io::Error::last_os_error();
        if error.kind() != std::io::ErrorKind::AlreadyExists {
            return Err(WorkspaceLeaseError::new(
                WorkspaceLeaseErrorKind::ResourceUnavailable,
                "workspace product directory could not be established",
            ));
        }
        false
    };
    let descriptor = unsafe {
        libc::openat(
            parent.as_raw_fd(),
            child.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if descriptor < 0 {
        return Err(WorkspaceLeaseError::invalid(
            "workspace product child must remain a non-symlink directory",
        ));
    }
    let directory = unsafe { File::from_raw_fd(descriptor) };
    let metadata = directory.metadata().map_err(|_| {
        WorkspaceLeaseError::new(
            WorkspaceLeaseErrorKind::ResourceUnavailable,
            "workspace product directory could not be inspected",
        )
    })?;
    if metadata.uid() != unsafe { libc::geteuid() }
        || metadata.permissions().mode() & 0o777 != 0o700
    {
        return Err(WorkspaceLeaseError::invalid(
            "workspace product child must be an owned private directory",
        ));
    }
    Ok((directory, created))
}

#[cfg(not(target_os = "linux"))]
fn open_pinned_product_child(_parent: &File, _child: &str) -> Result<File, WorkspaceLeaseError> {
    Err(WorkspaceLeaseError::invalid(
        "owned workspace roots require Linux descriptor-relative filesystem support",
    ))
}

#[cfg(not(target_os = "linux"))]
fn open_pinned_product_child_with_status(
    _parent: &File,
    _child: &str,
) -> Result<(File, bool), WorkspaceLeaseError> {
    Err(WorkspaceLeaseError::invalid(
        "owned workspace roots require Linux descriptor-relative filesystem support",
    ))
}

#[cfg(target_os = "linux")]
const WORKTREE_OWNER_MARKER: &str = ".zeroshot-owner";

#[derive(Clone, Copy, Eq, PartialEq)]
enum WorktreeOwnerStatus {
    Matching,
    Recoverable,
    Foreign,
}

#[cfg(target_os = "linux")]
fn worktree_owner_bytes(lease: &WorkspaceLeaseRecord) -> Vec<u8> {
    format!(
        "zeroshot.workspace-worktree/v1\n{}\n{}\n",
        lease.id.resource_id().as_str(),
        lease.owner.as_str()
    )
    .into_bytes()
}

#[cfg(target_os = "linux")]
fn set_worktree_owner(
    directory: &File,
    lease: &WorkspaceLeaseRecord,
    fail_after_create: &Option<Arc<dyn Fn() -> bool + Send + Sync>>,
) -> Result<(), WorkspaceLeaseError> {
    use std::ffi::CString;
    use std::io::Write;
    use std::os::fd::{AsRawFd, FromRawFd};

    let marker = CString::new(WORKTREE_OWNER_MARKER).expect("static marker contains no NUL");
    let descriptor = unsafe {
        libc::openat(
            directory.as_raw_fd(),
            marker.as_ptr(),
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            0o600,
        )
    };
    if descriptor < 0 {
        return Err(injected_root_failure(
            "workspace owner marker could not be created",
        ));
    }
    let mut file = unsafe { File::from_raw_fd(descriptor) };
    if hook_fails(fail_after_create) {
        return Err(injected_root_failure(
            "workspace owner marker persistence was interrupted",
        ));
    }
    file.write_all(&worktree_owner_bytes(lease))
        .and_then(|()| file.sync_all())
        .and_then(|()| directory.sync_all())
        .map_err(|_| injected_root_failure("workspace owner marker could not be persisted"))
}

#[cfg(not(target_os = "linux"))]
fn set_worktree_owner(
    _directory: &File,
    _lease: &WorkspaceLeaseRecord,
    _fail_after_create: &Option<Arc<dyn Fn() -> bool + Send + Sync>>,
) -> Result<(), WorkspaceLeaseError> {
    Err(WorkspaceLeaseError::invalid(
        "owned workspace roots require Linux descriptor-relative filesystem support",
    ))
}

#[cfg(target_os = "linux")]
fn read_worktree_owner(directory: &File) -> Result<Option<Vec<u8>>, WorkspaceLeaseError> {
    use std::ffi::CString;
    use std::io::Read;
    use std::os::fd::{AsRawFd, FromRawFd};

    let marker = CString::new(WORKTREE_OWNER_MARKER).expect("static marker contains no NUL");
    let descriptor = unsafe {
        libc::openat(
            directory.as_raw_fd(),
            marker.as_ptr(),
            libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if descriptor < 0 {
        let error = std::io::Error::last_os_error();
        if error.kind() == std::io::ErrorKind::NotFound {
            return Ok(None);
        }
        return Err(injected_root_failure(
            "workspace owner marker could not be inspected",
        ));
    }
    let file = unsafe { File::from_raw_fd(descriptor) };
    let mut value = Vec::new();
    file.take(1025)
        .read_to_end(&mut value)
        .map_err(|_| injected_root_failure("workspace owner marker could not be inspected"))?;
    Ok(Some(value))
}

#[cfg(target_os = "linux")]
fn worktree_owner_status(
    directory: &File,
    lease: &WorkspaceLeaseRecord,
) -> Result<WorktreeOwnerStatus, WorkspaceLeaseError> {
    let expected = worktree_owner_bytes(lease);
    let marker = read_worktree_owner(directory)?;
    if marker.as_deref() == Some(expected.as_slice()) {
        return Ok(WorktreeOwnerStatus::Matching);
    }
    let descriptor = descriptor_path(directory)?;
    let mut names = fs::read_dir(descriptor)
        .map_err(|_| injected_root_failure("workspace scaffold could not be inspected"))?
        .map(|entry| entry.map(|entry| entry.file_name()))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| injected_root_failure("workspace scaffold could not be inspected"))?;
    names.sort();
    let only_recoverable_marker = names.is_empty()
        || (names == [std::ffi::OsString::from(WORKTREE_OWNER_MARKER)]
            && marker
                .as_ref()
                .is_some_and(|value| expected.starts_with(value)));
    Ok(if only_recoverable_marker {
        WorktreeOwnerStatus::Recoverable
    } else {
        WorktreeOwnerStatus::Foreign
    })
}

#[cfg(not(target_os = "linux"))]
fn worktree_owner_status(
    _directory: &File,
    _lease: &WorkspaceLeaseRecord,
) -> Result<WorktreeOwnerStatus, WorkspaceLeaseError> {
    Err(WorkspaceLeaseError::invalid(
        "owned workspace roots require Linux descriptor-relative filesystem support",
    ))
}

#[cfg(target_os = "linux")]
fn remove_worktree_owner_if_present(directory: &File) -> Result<(), WorkspaceLeaseError> {
    use std::ffi::CString;
    use std::os::fd::AsRawFd;

    let marker = CString::new(WORKTREE_OWNER_MARKER).expect("static marker contains no NUL");
    if unsafe { libc::unlinkat(directory.as_raw_fd(), marker.as_ptr(), 0) } != 0 {
        let error = std::io::Error::last_os_error();
        if error.kind() != std::io::ErrorKind::NotFound {
            return Err(injected_root_failure(
                "workspace owner marker could not be removed",
            ));
        }
    }
    directory
        .sync_all()
        .map_err(|_| injected_root_failure("workspace owner removal could not be synchronized"))
}

#[cfg(not(target_os = "linux"))]
fn remove_worktree_owner_if_present(_directory: &File) -> Result<(), WorkspaceLeaseError> {
    Err(WorkspaceLeaseError::invalid(
        "owned workspace roots require Linux descriptor-relative filesystem support",
    ))
}

fn worktree_staging_name(name: &WorkspaceName) -> String {
    format!(".{}.create-pending", name.as_str())
}

fn workspace_staging_name() -> &'static str {
    ".workspace.create-pending"
}

fn cleanup_name(child: &str) -> String {
    format!(".{child}.cleanup")
}

#[cfg(target_os = "linux")]
fn validate_worktree_container_shape(
    directory: &File,
    location: WorktreeContainerLocation,
    owner_status: WorktreeOwnerStatus,
) -> Result<(), WorkspaceLeaseError> {
    use std::ffi::OsStr;

    if owner_status == WorktreeOwnerStatus::Foreign
        || (location == WorktreeContainerLocation::Public
            && owner_status != WorktreeOwnerStatus::Matching)
    {
        return Err(worktree_mismatch(
            "workspace container owner marker does not match durable intent",
        ));
    }
    let descriptor = descriptor_path(directory)?;
    for entry in fs::read_dir(descriptor)
        .map_err(|_| injected_root_failure("workspace container could not be inspected"))?
    {
        let name = entry
            .map_err(|_| injected_root_failure("workspace container could not be inspected"))?
            .file_name();
        let recognized = name == OsStr::new(WORKTREE_OWNER_MARKER)
            || match location {
                WorktreeContainerLocation::Public => {
                    name == OsStr::new("workspace")
                        || name == OsStr::new(&cleanup_name("workspace"))
                }
                WorktreeContainerLocation::Staging => {
                    name == OsStr::new("workspace")
                        || name == OsStr::new(workspace_staging_name())
                        || name == OsStr::new(&cleanup_name("workspace"))
                        || name == OsStr::new(&cleanup_name(workspace_staging_name()))
                }
                WorktreeContainerLocation::PublicQuarantine
                | WorktreeContainerLocation::StagingQuarantine => false,
            };
        if !recognized {
            return Err(worktree_mismatch(
                "workspace container contains conflicting content",
            ));
        }
    }
    Ok(())
}

#[cfg(not(target_os = "linux"))]
fn validate_worktree_container_shape(
    _directory: &File,
    _location: WorktreeContainerLocation,
    _owner_status: WorktreeOwnerStatus,
) -> Result<(), WorkspaceLeaseError> {
    Err(WorkspaceLeaseError::invalid(
        "owned workspace roots require Linux descriptor-relative filesystem support",
    ))
}

fn inspect_recognized_worktree_child(
    parent: &File,
    child: &str,
) -> Result<Option<File>, WorkspaceLeaseError> {
    open_existing_pinned_product_child(parent, child)
        .map_err(|_| worktree_mismatch("recognized workspace child is not a private directory"))
}

fn hook_fails(hook: &Option<Arc<dyn Fn() -> bool + Send + Sync>>) -> bool {
    hook.as_ref().is_some_and(|hook| hook())
}

fn injected_root_failure(message: &'static str) -> WorkspaceLeaseError {
    WorkspaceLeaseError::new(WorkspaceLeaseErrorKind::ResourceUnavailable, message)
}

fn worktree_mismatch(message: &'static str) -> WorkspaceLeaseError {
    WorkspaceLeaseError::new(WorkspaceLeaseErrorKind::ResourceMismatch, message)
}

#[cfg(target_os = "linux")]
fn open_existing_pinned_product_child(
    parent: &File,
    child: &str,
) -> Result<Option<File>, WorkspaceLeaseError> {
    use std::ffi::CString;
    use std::os::fd::{AsRawFd, FromRawFd};

    let child = CString::new(child)
        .map_err(|_| WorkspaceLeaseError::invalid("workspace handle contains a NUL byte"))?;
    let descriptor = unsafe {
        libc::openat(
            parent.as_raw_fd(),
            child.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if descriptor < 0 {
        let error = std::io::Error::last_os_error();
        if error.kind() == std::io::ErrorKind::NotFound {
            return Ok(None);
        }
        return Err(WorkspaceLeaseError::invalid(
            "workspace product child must remain a non-symlink directory",
        ));
    }
    Ok(Some(unsafe { File::from_raw_fd(descriptor) }))
}

#[cfg(not(target_os = "linux"))]
fn open_existing_pinned_product_child(
    _parent: &File,
    _child: &str,
) -> Result<Option<File>, WorkspaceLeaseError> {
    Err(WorkspaceLeaseError::invalid(
        "owned workspace roots require Linux descriptor-relative filesystem support",
    ))
}

#[cfg(target_os = "linux")]
fn rename_product_child(parent: &File, from: &str, to: &str) -> Result<(), WorkspaceLeaseError> {
    use std::ffi::CString;
    use std::os::fd::AsRawFd;

    let from = CString::new(from)
        .map_err(|_| WorkspaceLeaseError::invalid("workspace handle contains a NUL byte"))?;
    let to = CString::new(to)
        .map_err(|_| WorkspaceLeaseError::invalid("workspace handle contains a NUL byte"))?;
    if unsafe {
        libc::syscall(
            libc::SYS_renameat2,
            parent.as_raw_fd(),
            from.as_ptr(),
            parent.as_raw_fd(),
            to.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    } != 0
    {
        return Err(injected_root_failure(
            "workspace directory could not be atomically published",
        ));
    }
    Ok(())
}

#[cfg(not(target_os = "linux"))]
fn rename_product_child(_parent: &File, _from: &str, _to: &str) -> Result<(), WorkspaceLeaseError> {
    Err(WorkspaceLeaseError::invalid(
        "owned workspace roots require Linux descriptor-relative filesystem support",
    ))
}

#[cfg(target_os = "linux")]
fn quarantine_product_child(
    parent: &File,
    child: &str,
    expected: &File,
) -> Result<(), WorkspaceLeaseError> {
    rename_product_child(parent, child, &cleanup_name(child))?;
    if !named_child_matches(parent, &cleanup_name(child), expected)? {
        rename_product_child(parent, &cleanup_name(child), child)?;
        return Err(worktree_mismatch(
            "workspace cleanup target changed before removal",
        ));
    }
    parent
        .sync_all()
        .map_err(|_| injected_root_failure("workspace quarantine rename could not be synchronized"))
}

#[cfg(not(target_os = "linux"))]
fn quarantine_product_child(
    _parent: &File,
    _child: &str,
    _expected: &File,
) -> Result<(), WorkspaceLeaseError> {
    Err(WorkspaceLeaseError::invalid(
        "owned workspace roots require Linux descriptor-relative filesystem support",
    ))
}

fn quarantine_and_remove_product_child(
    parent: &File,
    child: &str,
    expected: &File,
    fail_after_quarantine: &Option<Arc<dyn Fn() -> bool + Send + Sync>>,
) -> Result<(), WorkspaceLeaseError> {
    quarantine_product_child(parent, child, expected)?;
    if hook_fails(fail_after_quarantine) {
        return Err(injected_root_failure(
            "workspace cleanup interrupted after inner quarantine",
        ));
    }
    remove_quarantined_product_child(parent, child, expected)
}

#[cfg(target_os = "linux")]
fn remove_quarantined_product_child(
    parent: &File,
    child: &str,
    expected: &File,
) -> Result<(), WorkspaceLeaseError> {
    use std::ffi::CString;
    use std::os::fd::AsRawFd;

    let quarantine_name = cleanup_name(child);
    if !named_child_matches(parent, &quarantine_name, expected)? {
        return Err(worktree_mismatch(
            "workspace cleanup quarantine identity changed",
        ));
    }
    let quarantine = CString::new(quarantine_name)
        .map_err(|_| WorkspaceLeaseError::invalid("workspace quarantine contains a NUL byte"))?;
    // Linux has no identity-conditional directory unlink: unlinkat(AT_EMPTY_PATH) rejects
    // directories, while unlinkat(parent, name, AT_REMOVEDIR) cannot bind the final removal to
    // `expected`. The private 0700 product root and the lease operation fence serialize supported
    // manager writers; this immediate name/inode recheck fails closed for their recovery races.
    // Uncooperative mutation by another process with the same uid is the local trust boundary.
    if unsafe { libc::unlinkat(parent.as_raw_fd(), quarantine.as_ptr(), libc::AT_REMOVEDIR) } != 0 {
        return Err(injected_root_failure(
            "workspace quarantined directory could not be removed",
        ));
    }
    parent.sync_all().map_err(|_| {
        injected_root_failure("workspace quarantine removal could not be synchronized")
    })
}

#[cfg(not(target_os = "linux"))]
fn remove_quarantined_product_child(
    _parent: &File,
    _child: &str,
    _expected: &File,
) -> Result<(), WorkspaceLeaseError> {
    Err(WorkspaceLeaseError::invalid(
        "owned workspace roots require Linux descriptor-relative filesystem support",
    ))
}

#[cfg(target_os = "linux")]
fn finish_container_quarantine(
    request: FinishContainerQuarantineRequest<'_>,
) -> Result<(), WorkspaceLeaseError> {
    if !named_child_matches(
        request.parent,
        &cleanup_name(request.child),
        request.expected,
    )? {
        return Err(worktree_mismatch(
            "workspace container quarantine identity changed",
        ));
    }
    if worktree_owner_status(request.expected, request.lease)? == WorktreeOwnerStatus::Foreign {
        return Err(worktree_mismatch(
            "workspace container quarantine owner marker changed",
        ));
    }
    remove_worktree_owner_if_present(request.expected)?;
    if hook_fails(request.fail_after_owner_marker_removal) {
        return Err(injected_root_failure(
            "workspace cleanup interrupted after owner marker removal",
        ));
    }
    if let Err(error) =
        remove_quarantined_product_child(request.parent, request.child, request.expected)
    {
        let no_hook: Option<Arc<dyn Fn() -> bool + Send + Sync>> = None;
        if read_worktree_owner(request.expected)?.is_none() {
            let _ = set_worktree_owner(request.expected, request.lease, &no_hook);
        }
        return Err(error);
    }
    Ok(())
}

#[cfg(not(target_os = "linux"))]
fn finish_container_quarantine(
    _request: FinishContainerQuarantineRequest<'_>,
) -> Result<(), WorkspaceLeaseError> {
    Err(WorkspaceLeaseError::invalid(
        "owned workspace roots require Linux descriptor-relative filesystem support",
    ))
}

#[cfg(target_os = "linux")]
fn named_child_matches(
    parent: &File,
    child: &str,
    expected: &File,
) -> Result<bool, WorkspaceLeaseError> {
    use std::os::unix::fs::MetadataExt;

    let Some(current) = open_existing_pinned_product_child(parent, child)? else {
        return Ok(false);
    };
    let current = current
        .metadata()
        .map_err(|_| injected_root_failure("workspace directory identity became unavailable"))?;
    let expected = expected
        .metadata()
        .map_err(|_| injected_root_failure("workspace directory identity became unavailable"))?;
    Ok(current.dev() == expected.dev() && current.ino() == expected.ino())
}

#[cfg(not(target_os = "linux"))]
fn named_child_matches(
    _parent: &File,
    _child: &str,
    _expected: &File,
) -> Result<bool, WorkspaceLeaseError> {
    Err(WorkspaceLeaseError::invalid(
        "owned workspace roots require Linux descriptor-relative filesystem support",
    ))
}

#[cfg(target_os = "linux")]
fn descriptor_path(directory: &File) -> Result<PathBuf, WorkspaceLeaseError> {
    use std::os::fd::AsRawFd;
    Ok(PathBuf::from(format!(
        "/proc/self/fd/{}",
        directory.as_raw_fd()
    )))
}

#[cfg(not(target_os = "linux"))]
fn descriptor_path(_directory: &File) -> Result<PathBuf, WorkspaceLeaseError> {
    Err(WorkspaceLeaseError::invalid(
        "owned workspace roots require Linux descriptor-relative filesystem support",
    ))
}

fn is_lower_hex(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}

fn validate_path_component(value: &str, label: &'static str) -> Result<(), WorkspaceLeaseError> {
    validate_text(value, label)?;
    if value == "."
        || value == ".."
        || !value.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'.' | b'_' | b'-')
        })
    {
        return Err(WorkspaceLeaseError::invalid(format!(
            "{label} must be one lowercase safe path component"
        )));
    }
    Ok(())
}

fn validate_text(value: &str, label: &'static str) -> Result<(), WorkspaceLeaseError> {
    if value.is_empty()
        || value.len() > MAX_WORKSPACE_VALUE_BYTES
        || value.chars().any(char::is_control)
    {
        return Err(WorkspaceLeaseError {
            kind: WorkspaceLeaseErrorKind::InvalidInput,
            message: format!(
                "{label} must be non-empty, bounded, and contain no control characters"
            ),
        });
    }
    Ok(())
}
