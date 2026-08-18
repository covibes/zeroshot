use std::collections::{BTreeMap, BTreeSet};
use std::fs::{File, OpenOptions};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Weak};
use std::time::Duration;

use async_trait::async_trait;
use fs2::FileExt;
use openengine_cluster_protocol::RunId;
use sha2::{Digest, Sha256};
use tokio::sync::{Mutex, watch};

use crate::execution::process::HostedProcessPool;
use crate::native_v2_candidate::{
    NativeV2CandidateConfig, NativeV2HarnessConfig, build_native_v2_candidate,
};
use crate::native_v2_capsule::{
    CapsuleFilesystem, CapsuleFilesystemSpec, NativeCapsuleNodeEndpoint, RemoteCapsuleNodeRunner,
    prepare_capsule_filesystem,
};
use crate::native_v2_claude::{ClaudeAdapterConfig, ClaudeProcessEnvironment};
use crate::native_v2_cloud::{
    AllocatedCapsule, CapsuleAllocationUnavailable, CapsuleAllocator, CapsuleCleanup,
    CapsuleCleanupUnavailable, CapsuleDestroyed, ControllerClaimUnavailable,
    ExclusiveControllerClaim,
};
use crate::native_v2_codex::NativeV2CodexConfig;
use crate::native_v2_contract::{AdmittedRun, EnvironmentVariableName, RuntimePlan};
use crate::native_v2_delivery::{GhCliAuthorityConfig, GhCliDeliveryAuthority, NativeV2DeliveryConfig};
use crate::native_v2_portable_controller::WorkspaceIdentity;
use crate::native_v2_supervisor::RunRuntimeExit;
use crate::native_v2_target_authority::TargetBase;

use super::ProductionHostingError;
use super::repository::{RepositoryInstall, install_repository, production_source, repository_token};

pub(super) struct ProductionCapsuleConfig {
    pub storage_root: PathBuf,
    pub environment: BTreeMap<EnvironmentVariableName, String>,
    pub codex_executable: PathBuf,
    pub claude_executable: String,
    pub claude_prefix_arguments: Vec<String>,
    pub claude_process_environment: ClaudeProcessEnvironment,
    pub executable_search_path: String,
    pub git_program: PathBuf,
    pub gh_program: PathBuf,
    pub process_pool: HostedProcessPool,
    pub claude_turn_timeout: Duration,
}

type FilesystemPreparer =
    fn(&Path, &Path, HostedProcessPool) -> Result<CapsuleFilesystem, CapsuleAllocationUnavailable>;

pub(super) struct ProductionCapsuleAllocator {
    config: Arc<ProductionCapsuleConfig>,
    active: Arc<Mutex<BTreeMap<RunId, Arc<ProductionCapsuleState>>>>,
    allocated: Mutex<BTreeSet<RunId>>,
    allocation_turn: Mutex<()>,
    prepare_filesystem: FilesystemPreparer,
    #[cfg(test)]
    source_override: Option<PathBuf>,
}

impl ProductionCapsuleAllocator {
    pub fn new(config: ProductionCapsuleConfig) -> Result<Self, ProductionHostingError> {
        if config.codex_executable.as_os_str().is_empty()
            || config.claude_executable.is_empty()
            || config.git_program.as_os_str().is_empty()
            || config.gh_program.as_os_str().is_empty()
        {
            return Err(ProductionHostingError::CapsuleConfiguration);
        }
        Ok(Self {
            config: Arc::new(config),
            active: Arc::new(Mutex::new(BTreeMap::new())),
            allocated: Mutex::new(BTreeSet::new()),
            allocation_turn: Mutex::new(()),
            prepare_filesystem: production_filesystem,
            #[cfg(test)]
            source_override: None,
        })
    }

    async fn allocate_one(
        &self,
        run_id: &RunId,
        admitted: &AdmittedRun,
    ) -> Result<AllocatedCapsule, CapsuleAllocationUnavailable> {
        let run_root = run_directory(&self.config.storage_root, run_id);
        std::fs::create_dir(&run_root).map_err(|_| CapsuleAllocationUnavailable)?;
        let allocation = self.build_capsule(run_id, admitted, &run_root).await;
        if allocation.is_err() {
            let _ = remove_run_directory(&run_root);
        }
        allocation
    }

    async fn build_capsule(
        &self,
        run_id: &RunId,
        admitted: &AdmittedRun,
        run_root: &Path,
    ) -> Result<AllocatedCapsule, CapsuleAllocationUnavailable> {
        let workspace = run_root.join("workspace");
        let runtime_home = run_root.join("runtime");
        let filesystem =
            (self.prepare_filesystem)(&workspace, &runtime_home, self.config.process_pool)?;
        let repository = admitted.source.repository.as_str();
        let base = TargetBase::Revision {
            revision: admitted.source.base_revision.as_str().to_owned(),
            target_branch: admitted.source.target_branch.as_str().to_owned(),
        };
        let source = self.repository_source(repository);
        let target = install_repository(RepositoryInstall {
            git_program: &self.config.git_program,
            source: &source,
            repository,
            base: &base,
            workspace: &filesystem.workspace,
            process_pool: self.config.process_pool,
            github_token: repository_token(&self.config.environment),
        })
        .await
        .map_err(|_| CapsuleAllocationUnavailable)?;
        let github_config = GhCliAuthorityConfig {
            git_program: self.config.git_program.clone(),
            gh_program: self.config.gh_program.clone(),
            ..GhCliAuthorityConfig::hosted()
        };
        let candidate = build_native_v2_candidate(
            admitted,
            NativeV2CandidateConfig {
                harness: self.harness(admitted, &filesystem)?,
                delivery: NativeV2DeliveryConfig::for_hosted_workspace(
                    filesystem.workspace.clone(),
                    target,
                ),
                github: Arc::new(GhCliDeliveryAuthority::new(github_config)),
            },
        )
        .map_err(|_| CapsuleAllocationUnavailable)?;
        let workspace_identity = WorkspaceIdentity::capture(&filesystem.workspace)
            .map_err(|_| CapsuleAllocationUnavailable)?;
        let endpoint = Arc::new(NativeCapsuleNodeEndpoint::new(Arc::new(candidate)));
        let runner = Arc::new(RemoteCapsuleNodeRunner::new(endpoint.clone()));
        let (loss_sender, loss) = watch::channel(false);
        let state = Arc::new(ProductionCapsuleState {
            endpoint,
            run_root: run_root.to_owned(),
            _loss_sender: loss_sender.clone(),
            cleanup_turn: Mutex::new(false),
        });
        let replaced = self
            .active
            .lock()
            .await
            .insert(run_id.clone(), state.clone());
        if replaced.is_some() {
            return Err(CapsuleAllocationUnavailable);
        }
        monitor_workspace_identity(filesystem.workspace, workspace_identity, loss_sender);
        let cleanup = Arc::new(ProductionCapsuleCleanup {
            run_id: run_id.clone(),
            state,
            active: Arc::downgrade(&self.active),
        });
        Ok(AllocatedCapsule {
            runner,
            loss,
            cleanup,
        })
    }

    fn harness(
        &self,
        admitted: &AdmittedRun,
        filesystem: &CapsuleFilesystem,
    ) -> Result<NativeV2HarnessConfig, CapsuleAllocationUnavailable> {
        match &admitted.runtime {
            RuntimePlan::Codex { provider, .. } => {
                Ok(NativeV2HarnessConfig::Codex(NativeV2CodexConfig {
                    provider: *provider,
                    executable: self.config.codex_executable.clone(),
                    workspace: filesystem.workspace.clone(),
                    runtime_home: filesystem.runtime_home.clone(),
                    local_user: None,
                    search_path: self.config.executable_search_path.clone(),
                    process_pool: self.config.process_pool,
                }))
            }
            RuntimePlan::Claude { provider, .. } => {
                let base_environment = self
                    .config
                    .claude_process_environment
                    .for_capsule(
                        &filesystem.runtime_home,
                        &self.config.executable_search_path,
                    )
                    .map_err(|_| CapsuleAllocationUnavailable)?;
                Ok(NativeV2HarnessConfig::Claude(ClaudeAdapterConfig {
                    provider: *provider,
                    executable: self.config.claude_executable.clone(),
                    prefix_arguments: self.config.claude_prefix_arguments.clone(),
                    workspace: filesystem.workspace.clone(),
                    runtime_home: filesystem.runtime_home.clone(),
                    local_user_home: None,
                    base_environment,
                    turn_timeout: self.config.claude_turn_timeout,
                    process_pool: self.config.process_pool,
                }))
            }
        }
    }

    fn repository_source(&self, repository: &str) -> std::ffi::OsString {
        #[cfg(test)]
        if let Some(path) = &self.source_override {
            return super::repository::path_source(path);
        }
        production_source(repository)
    }
}

#[async_trait]
impl CapsuleAllocator for ProductionCapsuleAllocator {
    async fn claim_controller(
        &self,
        run_id: &RunId,
    ) -> Result<Arc<dyn ExclusiveControllerClaim>, ControllerClaimUnavailable> {
        let lock_path = controller_lock_path(&self.config.storage_root, run_id);
        let file = OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .truncate(false)
            .open(lock_path)
            .map_err(|_| ControllerClaimUnavailable)?;
        file.try_lock_exclusive()
            .map_err(|_| ControllerClaimUnavailable)?;
        Ok(Arc::new(ProductionControllerClaim { _file: file }))
    }

    async fn allocate(
        &self,
        run_id: &RunId,
        admitted: &AdmittedRun,
    ) -> Result<AllocatedCapsule, CapsuleAllocationUnavailable> {
        let _turn = self.allocation_turn.lock().await;
        if !self.allocated.lock().await.insert(run_id.clone()) {
            return Err(CapsuleAllocationUnavailable);
        }
        self.allocate_one(run_id, admitted).await
    }

    async fn destroy_or_confirm_absent(
        &self,
        run_id: &RunId,
        _exit: RunRuntimeExit,
    ) -> Result<CapsuleDestroyed, CapsuleCleanupUnavailable> {
        let _turn = self.allocation_turn.lock().await;
        if let Some(state) = self.active.lock().await.get(run_id).cloned() {
            cleanup_state(run_id, &state, &self.active).await?;
        } else {
            remove_run_directory(&run_directory(&self.config.storage_root, run_id))?;
        }
        Ok(CapsuleDestroyed::confirmed())
    }
}

struct ProductionControllerClaim {
    _file: File,
}

impl ExclusiveControllerClaim for ProductionControllerClaim {}

struct ProductionCapsuleState {
    endpoint: Arc<NativeCapsuleNodeEndpoint>,
    run_root: PathBuf,
    // Keeps the controller-side loss receiver live during intentional cleanup. A whole-host loss
    // is observed on restart through durable reconciliation, never by allocating a replacement.
    _loss_sender: watch::Sender<bool>,
    cleanup_turn: Mutex<bool>,
}

pub(super) fn monitor_workspace_identity(
    workspace: PathBuf,
    identity: WorkspaceIdentity,
    loss: watch::Sender<bool>,
) {
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_millis(100)).await;
            if !identity.is_current(&workspace) {
                loss.send_replace(true);
                return;
            }
        }
    });
}

struct ProductionCapsuleCleanup {
    run_id: RunId,
    state: Arc<ProductionCapsuleState>,
    active: Weak<Mutex<BTreeMap<RunId, Arc<ProductionCapsuleState>>>>,
}

#[async_trait]
impl CapsuleCleanup for ProductionCapsuleCleanup {
    async fn destroy_or_confirm_absent(
        &self,
        _exit: RunRuntimeExit,
    ) -> Result<CapsuleDestroyed, CapsuleCleanupUnavailable> {
        let Some(active) = self.active.upgrade() else {
            return Err(CapsuleCleanupUnavailable);
        };
        cleanup_state(&self.run_id, &self.state, &active).await?;
        Ok(CapsuleDestroyed::confirmed())
    }
}

async fn cleanup_state(
    run_id: &RunId,
    state: &ProductionCapsuleState,
    active: &Mutex<BTreeMap<RunId, Arc<ProductionCapsuleState>>>,
) -> Result<(), CapsuleCleanupUnavailable> {
    let mut cleaned = state.cleanup_turn.lock().await;
    if *cleaned {
        return Ok(());
    }
    state.endpoint.disconnect().await;
    remove_run_directory(&state.run_root)?;
    active.lock().await.remove(run_id);
    *cleaned = true;
    Ok(())
}

fn production_filesystem(
    workspace: &Path,
    runtime_home: &Path,
    process_pool: HostedProcessPool,
) -> Result<CapsuleFilesystem, CapsuleAllocationUnavailable> {
    prepare_capsule_filesystem(CapsuleFilesystemSpec {
        workspace,
        runtime_home,
        process_pool,
    })
    .map_err(|_| CapsuleAllocationUnavailable)
}

fn run_directory(root: &Path, run_id: &RunId) -> PathBuf {
    let mut digest = Sha256::new();
    digest.update(b"zeroshot/native-v2/workspace/v1\0");
    digest.update(run_id.as_str().as_bytes());
    root.join("runs").join(format!("{:x}", digest.finalize()))
}

fn controller_lock_path(root: &Path, run_id: &RunId) -> PathBuf {
    let mut digest = Sha256::new();
    digest.update(b"zeroshot/native-v2/controller-lease/v1\0");
    digest.update(run_id.as_str().as_bytes());
    root.join(format!("controller-{:x}.lock", digest.finalize()))
}

fn remove_run_directory(path: &Path) -> Result<(), CapsuleCleanupUnavailable> {
    let metadata = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(_) => return Err(CapsuleCleanupUnavailable),
    };
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(CapsuleCleanupUnavailable);
    }
    std::fs::remove_dir_all(path).map_err(|_| CapsuleCleanupUnavailable)
}

#[cfg(test)]
impl ProductionCapsuleAllocator {
    pub(super) fn with_test_filesystem_and_source(
        mut self,
        source: PathBuf,
        prepare: FilesystemPreparer,
    ) -> Self {
        self.source_override = Some(source);
        self.prepare_filesystem = prepare;
        self
    }

    pub(super) fn run_path(&self, run_id: &RunId) -> PathBuf {
        run_directory(&self.config.storage_root, run_id)
    }
}
