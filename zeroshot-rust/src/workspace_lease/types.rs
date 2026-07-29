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
#[serde(rename_all = "snake_case", tag = "kind", content = "value")]
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

#[derive(Clone)]
pub struct WorkspaceProductRoots {
    worktree_directory: Arc<File>,
    docker_mount_directory: Arc<File>,
}

#[derive(Clone)]
pub(crate) struct PinnedWorktree {
    container: Arc<File>,
    workspace: Option<Arc<File>>,
}

impl PinnedWorktree {
    pub(crate) fn workspace(&self) -> Option<&Arc<File>> {
        self.workspace.as_ref()
    }
}

impl WorkspaceProductRoots {
    pub fn new(base: CanonicalWorkspaceRoot) -> Result<Self, WorkspaceLeaseError> {
        #[cfg(not(target_os = "linux"))]
        {
            let _ = base;
            return Err(WorkspaceLeaseError::invalid(
                "owned workspace roots require Linux descriptor-relative filesystem support",
            ));
        }
        #[cfg(target_os = "linux")]
        {
            let base_path = base.as_path();
            validate_private_product_base(base_path)?;
            let base_directory = open_directory_no_follow(base_path)?;
            validate_private_product_base_descriptor(&base_directory)?;
            let worktree_directory = open_pinned_product_child(&base_directory, "worktrees")?;
            let docker_mount_directory = open_pinned_product_child(&base_directory, "mounts")?;
            Ok(Self {
                worktree_directory: Arc::new(worktree_directory),
                docker_mount_directory: Arc::new(docker_mount_directory),
            })
        }
    }

    pub(crate) fn inspect_worktree(
        &self,
        name: &WorkspaceName,
    ) -> Result<Option<PinnedWorktree>, WorkspaceLeaseError> {
        let Some(container) =
            open_existing_pinned_product_child(&self.worktree_directory, name.as_str())?
        else {
            return Ok(None);
        };
        let workspace = open_existing_pinned_product_child(&container, "workspace")?;
        Ok(Some(PinnedWorktree {
            container: Arc::new(container),
            workspace: workspace.map(Arc::new),
        }))
    }

    pub(crate) fn create_worktree(
        &self,
        name: &WorkspaceName,
        lease: &WorkspaceLeaseRecord,
    ) -> Result<PinnedWorktree, WorkspaceLeaseError> {
        let (container, created) =
            open_pinned_product_child_with_status(&self.worktree_directory, name.as_str())?;
        if created {
            set_worktree_owner(&container, lease)?;
        } else if !worktree_owner_matches(&container, lease)? {
            return Err(WorkspaceLeaseError::new(
                WorkspaceLeaseErrorKind::ResourceMismatch,
                "workspace worktree owner marker does not match durable intent",
            ));
        }
        let workspace = open_pinned_product_child(&container, "workspace")?;
        Ok(PinnedWorktree {
            container: Arc::new(container),
            workspace: Some(Arc::new(workspace)),
        })
    }

    pub(crate) fn remove_worktree(
        &self,
        name: &WorkspaceName,
        worktree: &PinnedWorktree,
        lease: &WorkspaceLeaseRecord,
    ) -> Result<(), WorkspaceLeaseError> {
        if let Some(workspace) = worktree.workspace() {
            remove_pinned_product_child(&worktree.container, "workspace", workspace)?;
        }
        remove_worktree_owner(&worktree.container)?;
        if let Err(error) = remove_pinned_product_child(
            &self.worktree_directory,
            name.as_str(),
            &worktree.container,
        ) {
            let _ = set_worktree_owner(&worktree.container, lease);
            return Err(error);
        }
        Ok(())
    }

    pub(crate) fn worktree_owned_by(
        &self,
        worktree: &PinnedWorktree,
        lease: &WorkspaceLeaseRecord,
    ) -> Result<bool, WorkspaceLeaseError> {
        worktree_owner_matches(&worktree.container, lease)
    }

    pub(crate) fn worktree_destination(
        &self,
        worktree: &PinnedWorktree,
    ) -> Result<PathBuf, WorkspaceLeaseError> {
        descriptor_path(
            worktree
                .workspace()
                .ok_or_else(|| WorkspaceLeaseError::invalid("workspace root is absent"))?,
        )
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
fn validate_private_product_base(path: &Path) -> Result<(), WorkspaceLeaseError> {
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
    validate_private_product_base_descriptor(&directory)
}

#[cfg(target_os = "linux")]
fn validate_private_product_base_descriptor(directory: &File) -> Result<(), WorkspaceLeaseError> {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};

    let metadata = directory.metadata().map_err(|_| {
        WorkspaceLeaseError::new(
            WorkspaceLeaseErrorKind::ResourceUnavailable,
            "workspace product base could not be inspected",
        )
    })?;
    if !metadata.is_dir()
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.permissions().mode() & 0o777 != 0o700
    {
        return Err(WorkspaceLeaseError::invalid(
            "workspace product base must be an owned private directory",
        ));
    }
    Ok(())
}

#[cfg(not(target_os = "linux"))]
fn validate_private_product_base(_path: &Path) -> Result<(), WorkspaceLeaseError> {
    Err(WorkspaceLeaseError::invalid(
        "owned workspace roots require Linux descriptor-relative filesystem support",
    ))
}

#[cfg(not(target_os = "linux"))]
fn validate_private_product_base_descriptor(_directory: &File) -> Result<(), WorkspaceLeaseError> {
    Err(WorkspaceLeaseError::invalid(
        "owned workspace roots require Linux descriptor-relative filesystem support",
    ))
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

#[cfg(not(target_os = "linux"))]
fn open_pinned_product_child(_parent: &File, _child: &str) -> Result<File, WorkspaceLeaseError> {
    Err(WorkspaceLeaseError::invalid(
        "owned workspace roots require Linux descriptor-relative filesystem support",
    ))
}

#[cfg(target_os = "linux")]
const WORKTREE_OWNER_MARKER: &str = ".zeroshot-owner";

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
        return Err(WorkspaceLeaseError::new(
            WorkspaceLeaseErrorKind::ResourceUnavailable,
            "workspace owner marker could not be persisted",
        ));
    }
    let mut file = unsafe { File::from_raw_fd(descriptor) };
    file.write_all(&worktree_owner_bytes(lease))
        .and_then(|()| file.sync_all())
        .map_err(|_| {
            WorkspaceLeaseError::new(
                WorkspaceLeaseErrorKind::ResourceUnavailable,
                "workspace owner marker could not be persisted",
            )
        })
}

#[cfg(not(target_os = "linux"))]
fn set_worktree_owner(
    _directory: &File,
    _lease: &WorkspaceLeaseRecord,
) -> Result<(), WorkspaceLeaseError> {
    Err(WorkspaceLeaseError::invalid(
        "owned workspace roots require Linux descriptor-relative filesystem support",
    ))
}

#[cfg(target_os = "linux")]
fn worktree_owner_matches(
    directory: &File,
    lease: &WorkspaceLeaseRecord,
) -> Result<bool, WorkspaceLeaseError> {
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
            return Ok(false);
        }
        return Err(WorkspaceLeaseError::new(
            WorkspaceLeaseErrorKind::ResourceUnavailable,
            "workspace owner marker could not be inspected",
        ));
    }
    let file = unsafe { File::from_raw_fd(descriptor) };
    let mut value = Vec::new();
    file.take(1025).read_to_end(&mut value).map_err(|_| {
        WorkspaceLeaseError::new(
            WorkspaceLeaseErrorKind::ResourceUnavailable,
            "workspace owner marker could not be inspected",
        )
    })?;
    Ok(value.len() <= 1024 && value == worktree_owner_bytes(lease))
}

#[cfg(not(target_os = "linux"))]
fn worktree_owner_matches(
    _directory: &File,
    _lease: &WorkspaceLeaseRecord,
) -> Result<bool, WorkspaceLeaseError> {
    Err(WorkspaceLeaseError::invalid(
        "owned workspace roots require Linux descriptor-relative filesystem support",
    ))
}

#[cfg(target_os = "linux")]
fn remove_worktree_owner(directory: &File) -> Result<(), WorkspaceLeaseError> {
    use std::ffi::CString;
    use std::os::fd::AsRawFd;

    let marker = CString::new(WORKTREE_OWNER_MARKER).expect("static marker contains no NUL");
    if unsafe { libc::unlinkat(directory.as_raw_fd(), marker.as_ptr(), 0) } != 0 {
        return Err(WorkspaceLeaseError::new(
            WorkspaceLeaseErrorKind::ResourceUnavailable,
            "workspace owner marker could not be removed",
        ));
    }
    Ok(())
}

#[cfg(not(target_os = "linux"))]
fn remove_worktree_owner(_directory: &File) -> Result<(), WorkspaceLeaseError> {
    Err(WorkspaceLeaseError::invalid(
        "owned workspace roots require Linux descriptor-relative filesystem support",
    ))
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
fn remove_pinned_product_child(
    parent: &File,
    child: &str,
    expected: &File,
) -> Result<(), WorkspaceLeaseError> {
    use std::ffi::CString;
    use std::os::fd::AsRawFd;
    use std::os::unix::fs::MetadataExt;

    let quarantine = CString::new(format!(".{child}.cleanup"))
        .map_err(|_| WorkspaceLeaseError::invalid("workspace quarantine contains a NUL byte"))?;
    let child = CString::new(child)
        .map_err(|_| WorkspaceLeaseError::invalid("workspace handle contains a NUL byte"))?;
    let renamed = unsafe {
        libc::renameat2(
            parent.as_raw_fd(),
            child.as_ptr(),
            parent.as_raw_fd(),
            quarantine.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    };
    if renamed != 0 {
        return Err(WorkspaceLeaseError::new(
            WorkspaceLeaseErrorKind::ResourceUnavailable,
            "workspace product directory could not be quarantined",
        ));
    }

    let quarantined = open_existing_pinned_product_child(
        parent,
        quarantine.to_str().expect("generated quarantine is UTF-8"),
    );
    let expected_metadata = expected.metadata().map_err(|_| {
        WorkspaceLeaseError::new(
            WorkspaceLeaseErrorKind::ResourceUnavailable,
            "workspace product directory identity became unavailable",
        )
    })?;
    let matches = quarantined
        .as_ref()
        .ok()
        .and_then(Option::as_ref)
        .and_then(|directory| directory.metadata().ok())
        .is_some_and(|metadata| {
            metadata.dev() == expected_metadata.dev() && metadata.ino() == expected_metadata.ino()
        });
    if !matches {
        restore_quarantined_child(parent, &quarantine, &child)?;
        return Err(WorkspaceLeaseError::new(
            WorkspaceLeaseErrorKind::ResourceMismatch,
            "workspace cleanup target changed before removal",
        ));
    }

    if unsafe { libc::unlinkat(parent.as_raw_fd(), quarantine.as_ptr(), libc::AT_REMOVEDIR) } != 0 {
        restore_quarantined_child(parent, &quarantine, &child)?;
        return Err(WorkspaceLeaseError::new(
            WorkspaceLeaseErrorKind::ResourceUnavailable,
            "workspace product directory could not be removed",
        ));
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn restore_quarantined_child(
    parent: &File,
    quarantine: &std::ffi::CStr,
    child: &std::ffi::CStr,
) -> Result<(), WorkspaceLeaseError> {
    use std::os::fd::AsRawFd;

    if unsafe {
        libc::renameat2(
            parent.as_raw_fd(),
            quarantine.as_ptr(),
            parent.as_raw_fd(),
            child.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    } != 0
    {
        return Err(WorkspaceLeaseError::new(
            WorkspaceLeaseErrorKind::ResourceUnavailable,
            "workspace quarantined directory could not be restored",
        ));
    }
    Ok(())
}

#[cfg(not(target_os = "linux"))]
fn remove_pinned_product_child(
    _parent: &File,
    _child: &str,
    _expected: &File,
) -> Result<(), WorkspaceLeaseError> {
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
