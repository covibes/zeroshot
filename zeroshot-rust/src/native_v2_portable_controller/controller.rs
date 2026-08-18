#[path = "controller/backend.rs"]
mod backend;

use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use openengine_cluster_protocol::{NOT_FOUND, RunId, RunStatus, RunStatusParams, RunSubmitParams};
use openengine_cluster_server::BackendError;
use tokio::sync::{Mutex, watch};

use crate::native_v2_admission::NativeV2Admission;
use crate::native_v2_cloud::{
    AllocatedCapsule, CapsuleAllocationUnavailable, CapsuleAllocator, CapsuleCleanupUnavailable,
    CapsuleDestroyed, ControllerClaimUnavailable, ExclusiveControllerClaim,
    NativeV2CloudController,
};
use crate::native_v2_contract::AdmittedRun;
use crate::native_v2_supervisor::{RunEnvironment, RunRuntimeExit};
use crate::v2_run_ledger::RunLedger;
use crate::v2_run_ledger::sqlite::SqliteRunLedger;

use super::engine::PortableRuntime;
#[cfg(unix)]
use super::process::PortableControllerServer;
use super::process::{
    clear_stale_endpoint, require_absolute, validate_existing_ledger_path,
    validate_existing_storage, validate_ledger_path,
};
use super::{
    ControllerLease, PortableControllerBootstrap, PortableControllerError, PortableControllerPaths,
};

const WORKSPACE_MONITOR_INTERVAL: Duration = Duration::from_millis(100);

#[derive(Clone)]
pub struct PortableRunController {
    run_id: RunId,
    pub(super) inner: Arc<NativeV2CloudController>,
    paths: PortableControllerPaths,
    _lease: Arc<ControllerLease>,
    _workspace_lease: Option<Arc<ControllerLease>>,
}

struct PreparedRuntime {
    runtime: Option<PortableRuntime>,
    workspace_identity: Option<WorkspaceIdentity>,
    workspace_lease: Option<Arc<ControllerLease>>,
}

struct WorkspaceMonitor {
    workspace: PathBuf,
    identity: WorkspaceIdentity,
    controller_lease: std::sync::Weak<ControllerLease>,
    workspace_lease: std::sync::Weak<ControllerLease>,
}

struct PreparedControllerStart {
    admitted: AdmittedRun,
    environment: RunEnvironment,
    paths: PortableControllerPaths,
    lease: Arc<ControllerLease>,
    ledger: Arc<SqliteRunLedger>,
    existing: bool,
}

impl PortableRunController {
    /// Acquires a dead controller's lease and opens its durable one-run ledger for observation.
    /// Any nonterminal run is finalized as `runtime_lost`; no runtime factory is consulted and no
    /// node can be dispatched. The returned backend may be bound to the ordinary local socket.
    pub async fn open_observer(
        paths: PortableControllerPaths,
        run_id: RunId,
    ) -> Result<Self, PortableControllerError> {
        require_absolute(paths.storage())?;
        validate_existing_storage(paths.storage())?;
        validate_existing_ledger_path(&paths.ledger())?;
        let lease = Arc::new(ControllerLease::acquire(paths.lease())?);
        clear_stale_endpoint(&paths)?;
        let ledger = Arc::new(SqliteRunLedger::open(paths.ledger())?);
        if !validate_existing_run(ledger.as_ref(), &run_id).await? {
            return Err(PortableControllerError::DurableIdentity);
        }
        let allocator = Arc::new(SingleRunAllocator::new(run_id.clone(), None, lease.clone()));
        let inner = Arc::new(NativeV2CloudController::new(ledger, allocator).await?);
        Ok(Self {
            run_id,
            inner,
            paths,
            _lease: lease,
            _workspace_lease: None,
        })
    }

    pub async fn start<F, E>(
        bootstrap: PortableControllerBootstrap,
        runtime_factory: F,
    ) -> Result<Self, PortableControllerError>
    where
        F: FnOnce(&AdmittedRun) -> Result<PortableRuntime, E>,
        E: std::error::Error + Send + Sync + 'static,
    {
        let prepared = prepare_controller_start(&bootstrap).await?;
        let prepared_runtime = prepare_runtime(&prepared, &bootstrap, runtime_factory)?;
        let allocator = Arc::new(SingleRunAllocator::new(
            bootstrap.run_id.clone(),
            prepared_runtime.runtime,
            prepared.lease.clone(),
        ));
        let inner = Arc::new(
            NativeV2CloudController::new_with_delivery_policy(
                prepared.ledger,
                allocator.clone(),
                bootstrap.delivery_policy,
            )
            .await?,
        );
        let receipt = inner
            .submit_with_exact_environment(
                RunSubmitParams {
                    run_id: bootstrap.run_id.clone(),
                    submission: bootstrap.submission,
                },
                prepared.environment,
            )
            .await?;
        if receipt.run_id != bootstrap.run_id {
            return Err(PortableControllerError::DurableIdentity);
        }
        if !prepared.existing {
            monitor_workspace_and_lease(
                WorkspaceMonitor {
                    workspace: bootstrap.workspace,
                    identity: prepared_runtime
                        .workspace_identity
                        .ok_or(PortableControllerError::Workspace)?,
                    controller_lease: Arc::downgrade(&prepared.lease),
                    workspace_lease: Arc::downgrade(
                        prepared_runtime
                            .workspace_lease
                            .as_ref()
                            .ok_or(PortableControllerError::Workspace)?,
                    ),
                },
                allocator.loss_sender(),
            );
        }
        Ok(Self {
            run_id: bootstrap.run_id,
            inner,
            paths: prepared.paths,
            _lease: prepared.lease,
            _workspace_lease: prepared_runtime.workspace_lease,
        })
    }

    /// Reopens a durable one-run controller after its owning process exited. No runtime is
    /// reconstructed: a nonterminal row is reconciled to `runtime_lost`, while terminal truth is
    /// served unchanged.
    pub async fn reopen(
        bootstrap: PortableControllerBootstrap,
    ) -> Result<Self, PortableControllerError> {
        Self::start(bootstrap, |_| {
            Err(io::Error::other(
                "reopen cannot construct a replacement runtime",
            ))
        })
        .await
    }

    #[must_use]
    pub fn run_id(&self) -> &RunId {
        &self.run_id
    }

    #[must_use]
    pub fn paths(&self) -> &PortableControllerPaths {
        &self.paths
    }

    pub(super) async fn wait_terminal(&self) -> Result<(), PortableControllerError> {
        loop {
            let status = self
                .inner
                .status(RunStatusParams {
                    run_id: self.run_id.clone(),
                })
                .await?;
            if matches!(status.status, RunStatus::Finished { .. }) {
                return Ok(());
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    }

    #[cfg(unix)]
    pub async fn bind(
        self: Arc<Self>,
    ) -> Result<PortableControllerServer, PortableControllerError> {
        PortableControllerServer::bind(self).await
    }

    fn require_run(&self, run_id: &RunId) -> Result<(), BackendError> {
        if run_id == &self.run_id {
            Ok(())
        } else {
            Err(BackendError::application(
                NOT_FOUND,
                "run was not found",
                None,
            ))
        }
    }
}

async fn prepare_controller_start(
    bootstrap: &PortableControllerBootstrap,
) -> Result<PreparedControllerStart, PortableControllerError> {
    require_absolute(&bootstrap.workspace)?;
    let admitted = NativeV2Admission
        .admit_with_policy(bootstrap.submission.clone(), bootstrap.delivery_policy)
        .await?;
    let environment = bootstrap.environment.for_runtime(&admitted.runtime)?;
    let (paths, lease, ledger) = open_controller_storage(&bootstrap.storage)?;
    let existing = validate_existing_run(ledger.as_ref(), &bootstrap.run_id).await?;
    Ok(PreparedControllerStart {
        admitted,
        environment,
        paths,
        lease,
        ledger,
        existing,
    })
}

fn open_controller_storage(
    storage: &Path,
) -> Result<
    (
        PortableControllerPaths,
        Arc<ControllerLease>,
        Arc<SqliteRunLedger>,
    ),
    PortableControllerError,
> {
    require_absolute(storage)?;
    let paths = PortableControllerPaths::new(storage);
    let lease = Arc::new(ControllerLease::acquire(paths.lease())?);
    clear_stale_endpoint(&paths)?;
    validate_ledger_path(&paths.ledger())?;
    let ledger = Arc::new(SqliteRunLedger::open(paths.ledger())?);
    Ok((paths, lease, ledger))
}

fn prepare_runtime<F, E>(
    prepared: &PreparedControllerStart,
    bootstrap: &PortableControllerBootstrap,
    runtime_factory: F,
) -> Result<PreparedRuntime, PortableControllerError>
where
    F: FnOnce(&AdmittedRun) -> Result<PortableRuntime, E>,
    E: std::error::Error + Send + Sync + 'static,
{
    if prepared.existing {
        return Ok(PreparedRuntime {
            runtime: None,
            workspace_identity: None,
            workspace_lease: None,
        });
    }
    let workspace_identity = WorkspaceIdentity::capture(&bootstrap.workspace)?;
    let workspace_lease = Arc::new(ControllerLease::acquire(&bootstrap.workspace_lease)?);
    if !workspace_identity.is_current(&bootstrap.workspace) {
        return Err(PortableControllerError::Workspace);
    }
    let runtime = runtime_factory(&prepared.admitted)
        .map_err(|_| PortableControllerError::RuntimeUnavailable)?;
    Ok(PreparedRuntime {
        runtime: Some(runtime),
        workspace_identity: Some(workspace_identity),
        workspace_lease: Some(workspace_lease),
    })
}

struct SingleRunAllocator {
    run_id: RunId,
    runtime: Mutex<Option<PortableRuntime>>,
    lease: Arc<ControllerLease>,
    loss_sender: watch::Sender<bool>,
    loss_receiver: watch::Receiver<bool>,
}

impl SingleRunAllocator {
    fn new(run_id: RunId, runtime: Option<PortableRuntime>, lease: Arc<ControllerLease>) -> Self {
        let (loss_sender, loss_receiver) = watch::channel(false);
        Self {
            run_id,
            runtime: Mutex::new(runtime),
            lease,
            loss_sender,
            loss_receiver,
        }
    }

    fn loss_sender(&self) -> watch::Sender<bool> {
        self.loss_sender.clone()
    }

    fn require_run(&self, run_id: &RunId) -> Result<(), CapsuleAllocationUnavailable> {
        (run_id == &self.run_id)
            .then_some(())
            .ok_or(CapsuleAllocationUnavailable)
    }
}

#[async_trait]
impl CapsuleAllocator for SingleRunAllocator {
    async fn claim_controller(
        &self,
        run_id: &RunId,
    ) -> Result<Arc<dyn ExclusiveControllerClaim>, ControllerClaimUnavailable> {
        if run_id != &self.run_id || !self.lease.is_intact() {
            return Err(ControllerClaimUnavailable);
        }
        Ok(Arc::new(PortableControllerClaim(self.lease.clone())))
    }

    async fn allocate(
        &self,
        run_id: &RunId,
        _admitted: &AdmittedRun,
    ) -> Result<AllocatedCapsule, CapsuleAllocationUnavailable> {
        self.require_run(run_id)?;
        let runtime = self
            .runtime
            .lock()
            .await
            .take()
            .ok_or(CapsuleAllocationUnavailable)?;
        Ok(AllocatedCapsule {
            runner: runtime.runner,
            loss: self.loss_receiver.clone(),
            cleanup: runtime.cleanup,
        })
    }

    async fn destroy_or_confirm_absent(
        &self,
        run_id: &RunId,
        exit: RunRuntimeExit,
    ) -> Result<CapsuleDestroyed, CapsuleCleanupUnavailable> {
        if run_id != &self.run_id {
            return Err(CapsuleCleanupUnavailable);
        }
        if let Some(runtime) = self.runtime.lock().await.take() {
            runtime.cleanup.destroy_or_confirm_absent(exit).await?;
        }
        Ok(CapsuleDestroyed::confirmed())
    }
}

struct PortableControllerClaim(Arc<ControllerLease>);

impl ExclusiveControllerClaim for PortableControllerClaim {}

impl Drop for PortableControllerClaim {
    fn drop(&mut self) {
        let _ = self.0.is_intact();
    }
}

fn monitor_workspace_and_lease(monitor: WorkspaceMonitor, loss: watch::Sender<bool>) {
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(WORKSPACE_MONITOR_INTERVAL).await;
            let Some(controller_lease) = monitor.controller_lease.upgrade() else {
                return;
            };
            let Some(workspace_lease) = monitor.workspace_lease.upgrade() else {
                return;
            };
            if !monitor.identity.is_current(&monitor.workspace)
                || !workspace_lease.is_intact()
                || !controller_lease.is_intact()
            {
                loss.send_replace(true);
                return;
            }
        }
    });
}

async fn validate_existing_run(
    ledger: &dyn RunLedger,
    run_id: &RunId,
) -> Result<bool, PortableControllerError> {
    let runs = ledger.list().await?;
    if runs.len() > 1 || runs.first().is_some_and(|run| &run.run_id != run_id) {
        return Err(PortableControllerError::DurableIdentity);
    }
    Ok(!runs.is_empty())
}

#[derive(Clone, Debug)]
pub(crate) struct WorkspaceIdentity {
    #[cfg(unix)]
    // Pins the admitted inode so an immediate replacement cannot reuse its identity between polls.
    _handle: Arc<std::fs::File>,
    #[cfg(unix)]
    device: u64,
    #[cfg(unix)]
    inode: u64,
    #[cfg(not(unix))]
    canonical_path: PathBuf,
}

impl WorkspaceIdentity {
    pub(crate) fn capture(path: &Path) -> Result<Self, PortableControllerError> {
        #[cfg(unix)]
        {
            use std::os::unix::fs::{MetadataExt as _, OpenOptionsExt as _};

            let mut options = std::fs::OpenOptions::new();
            options
                .read(true)
                .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW);
            let handle = options
                .open(path)
                .map_err(|_| PortableControllerError::Workspace)?;
            let metadata = handle
                .metadata()
                .map_err(|_| PortableControllerError::Workspace)?;
            if !metadata.is_dir() {
                return Err(PortableControllerError::Workspace);
            }
            Ok(Self {
                _handle: Arc::new(handle),
                device: metadata.dev(),
                inode: metadata.ino(),
            })
        }
        #[cfg(not(unix))]
        {
            let metadata =
                std::fs::symlink_metadata(path).map_err(|_| PortableControllerError::Workspace)?;
            if !metadata.is_dir() || metadata.file_type().is_symlink() {
                return Err(PortableControllerError::Workspace);
            }
            let canonical_path =
                std::fs::canonicalize(path).map_err(|_| PortableControllerError::Workspace)?;
            Ok(Self { canonical_path })
        }
    }

    pub(crate) fn is_current(&self, path: &Path) -> bool {
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt as _;

            let Ok(metadata) = std::fs::symlink_metadata(path) else {
                return false;
            };
            metadata.is_dir()
                && !metadata.file_type().is_symlink()
                && metadata.dev() == self.device
                && metadata.ino() == self.inode
        }
        #[cfg(not(unix))]
        {
            let Ok(metadata) = std::fs::symlink_metadata(path) else {
                return false;
            };
            metadata.is_dir()
                && !metadata.file_type().is_symlink()
                && std::fs::canonicalize(path).is_ok_and(|current| current == self.canonical_path)
        }
    }
}
