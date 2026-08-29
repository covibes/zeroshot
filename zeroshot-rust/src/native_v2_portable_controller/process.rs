use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use openengine_cluster_client::NdjsonTransport;
use openengine_cluster_protocol::{RunConnectionValues, RunId, RunSubmission};
use openengine_cluster_server::admission::CancellationSignal;
use openengine_cluster_server::identity::{
    BindingAttributes, ConnectionBinding, ConnectionIdentity, ConnectionIdentityConfig,
    PrincipalId, StaticConnectionIdentityResolver, SystemConnectionTime, TenantId,
};
use serde::{Deserialize, Serialize};

use crate::execution::process::write_new_file;
use crate::native_v2_admission::DeliveryPolicy;
use crate::native_v2_supervisor::RunEnvironment;

use super::controller::PortableRunController;
use super::engine::PortableRuntime;
use super::{
    PortableControllerBootstrap, PortableControllerError, PortableControllerPaths,
    PortableControllerReady,
};

const BOOTSTRAP_MAX_BYTES: u64 = 4 * 1024 * 1024;
const READY_MAX_BYTES: u64 = 16 * 1024;
const READY_KIND: &str = "zeroshot.portable-controller-ready/v1";

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct PortableBootstrapDocument {
    run_id: RunId,
    submission: RunSubmission,
    connections: RunConnectionValues,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    github_token: Option<String>,
    workspace: PathBuf,
    workspace_lease: PathBuf,
    storage: PathBuf,
    delivery_policy: DeliveryPolicy,
}

impl PortableBootstrapDocument {
    fn validate(self) -> Result<PortableControllerBootstrap, PortableControllerError> {
        require_absolute(&self.workspace)?;
        require_absolute(&self.workspace_lease)?;
        require_absolute(&self.storage)?;
        let environment = RunEnvironment::exact(&self.submission.runtime, self.connections)?;
        Ok(PortableControllerBootstrap {
            run_id: self.run_id,
            submission: self.submission,
            environment,
            github_token: self.github_token,
            workspace: self.workspace,
            workspace_lease: self.workspace_lease,
            storage: self.storage,
            delivery_policy: self.delivery_policy,
        })
    }
}

#[cfg(unix)]
pub type PortableControllerTransport =
    NdjsonTransport<tokio::net::unix::OwnedReadHalf, tokio::net::unix::OwnedWriteHalf>;

#[cfg(unix)]
pub async fn connect_transport(
    paths: &PortableControllerPaths,
) -> Result<Arc<PortableControllerTransport>, PortableControllerError> {
    let ready = read_ready(paths)?;
    let stream = tokio::net::UnixStream::connect(&ready.socket)
        .await
        .map_err(PortableControllerError::Io)?;
    let (reader, writer) = stream.into_split();
    Ok(Arc::new(NdjsonTransport::new(reader, writer)))
}

pub fn read_ready(
    paths: &PortableControllerPaths,
) -> Result<PortableControllerReady, PortableControllerError> {
    let bytes = read_bounded_regular_file(&paths.ready(), READY_MAX_BYTES)?;
    let ready: PortableControllerReady =
        serde_json::from_slice(&bytes).map_err(|_| PortableControllerError::Readiness)?;
    if ready.kind != READY_KIND || ready.socket != paths.socket() {
        return Err(PortableControllerError::Readiness);
    }
    Ok(ready)
}

pub async fn wait_ready(
    paths: &PortableControllerPaths,
    run_id: &RunId,
    deadline: Duration,
) -> Result<PortableControllerReady, PortableControllerError> {
    tokio::time::timeout(deadline, async {
        loop {
            if let Ok(ready) = read_ready(paths) {
                if &ready.run_id == run_id {
                    return ready;
                }
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .map_err(|_| PortableControllerError::Readiness)
}

/// Runs the private one-run controller child used by the shipped executable's re-exec path.
/// The bootstrap is consumed before any durable controller effect and is never retained.
#[cfg(unix)]
pub async fn run_controller_process(bootstrap_path: &Path) -> Result<(), PortableControllerError> {
    let bootstrap = load_bootstrap_file(bootstrap_path)?;
    let workspace = bootstrap.workspace.clone();
    let storage = bootstrap.storage.clone();
    let github_token = bootstrap.github_token.clone();
    let controller = Arc::new(
        PortableRunController::start(bootstrap, move |admitted| {
            crate::native_v2_local::build_local_process_candidate(
                admitted,
                &workspace,
                &storage,
                github_token,
            )
            .map(PortableRuntime::new)
        })
        .await?,
    );
    controller.bind().await?.serve_until_terminal().await
}

pub fn load_bootstrap_file(
    path: &Path,
) -> Result<PortableControllerBootstrap, PortableControllerError> {
    validate_private_bootstrap(path)?;
    let bytes = read_bounded_regular_file(path, BOOTSTRAP_MAX_BYTES)?;
    let parsed = serde_json::from_slice::<PortableBootstrapDocument>(&bytes)
        .map_err(|_| PortableControllerError::Bootstrap)
        .and_then(PortableBootstrapDocument::validate);
    std::fs::remove_file(path).map_err(|_| PortableControllerError::BootstrapCleanup)?;
    parsed
}

pub fn write_bootstrap_file(
    path: &Path,
    bootstrap: &PortableControllerBootstrap,
) -> Result<(), PortableControllerError> {
    let bytes = encode_bootstrap(bootstrap)?;
    prepare_bootstrap_parent(path)?;
    write_private_new_file(path, &bytes)
}

fn encode_bootstrap(
    bootstrap: &PortableControllerBootstrap,
) -> Result<Vec<u8>, PortableControllerError> {
    require_absolute(&bootstrap.workspace)?;
    require_absolute(&bootstrap.workspace_lease)?;
    require_absolute(&bootstrap.storage)?;
    let environment = bootstrap
        .environment
        .for_runtime(&bootstrap.submission.runtime)?;
    let document = PortableBootstrapDocument {
        run_id: bootstrap.run_id.clone(),
        submission: bootstrap.submission.clone(),
        connections: environment.bootstrap_values(),
        github_token: bootstrap.github_token.clone(),
        workspace: bootstrap.workspace.clone(),
        workspace_lease: bootstrap.workspace_lease.clone(),
        storage: bootstrap.storage.clone(),
        delivery_policy: bootstrap.delivery_policy,
    };
    let bytes = serde_json::to_vec(&document).map_err(|_| PortableControllerError::Bootstrap)?;
    if bytes.len() as u64 > BOOTSTRAP_MAX_BYTES {
        return Err(PortableControllerError::Bootstrap);
    }
    Ok(bytes)
}

fn prepare_bootstrap_parent(path: &Path) -> Result<(), PortableControllerError> {
    require_absolute(path)?;
    let parent = path.parent().ok_or(PortableControllerError::Path)?;
    std::fs::create_dir_all(parent).map_err(PortableControllerError::Io)?;
    let metadata = std::fs::symlink_metadata(parent).map_err(PortableControllerError::Io)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(PortableControllerError::Bootstrap);
    }
    Ok(())
}

#[cfg(unix)]
pub struct PortableControllerServer {
    controller: Arc<PortableRunController>,
    listener: tokio::net::UnixListener,
}

#[cfg(unix)]
impl PortableControllerServer {
    pub(super) async fn bind(
        controller: Arc<PortableRunController>,
    ) -> Result<Self, PortableControllerError> {
        let socket = controller.paths().socket();
        remove_existing_socket(&socket)?;
        let listener =
            tokio::net::UnixListener::bind(&socket).map_err(PortableControllerError::Io)?;
        set_private_socket_permissions(&socket)?;
        write_ready(&controller)?;
        Ok(Self {
            controller,
            listener,
        })
    }

    pub async fn serve(self) -> io::Result<()> {
        loop {
            self.accept().await?;
        }
    }

    /// Serves one active local run until its durable terminal result exists. If a very short run
    /// finishes before the submitting CLI reaches the socket, one connection is still accepted so
    /// readiness cannot race normal startup. Later observation reopens the durable ledger.
    async fn serve_until_terminal(self) -> Result<(), PortableControllerError> {
        let mut accepted = false;
        let mut terminal = false;
        loop {
            if accepted && terminal {
                return Ok(());
            }
            tokio::select! {
                result = self.accept() => {
                    result.map_err(PortableControllerError::Io)?;
                    accepted = true;
                }
                result = self.controller.wait_terminal(), if !terminal => {
                    result?;
                    terminal = true;
                }
            }
        }
    }

    async fn accept(&self) -> io::Result<()> {
        let (stream, _) = self.listener.accept().await?;
        let controller = self.controller.clone();
        tokio::spawn(async move {
            let (reader, writer) = stream.into_split();
            let binding = local_binding(controller);
            let _ = openengine_cluster_server::stdio::serve_ndjson(
                binding,
                openengine_cluster_server::stdio::NdjsonIo::new(reader, writer, tokio::io::sink()),
            )
            .await;
        });
        Ok(())
    }
}

#[cfg(unix)]
fn local_binding(
    controller: Arc<PortableRunController>,
) -> ConnectionBinding<PortableRunController, StaticConnectionIdentityResolver, SystemConnectionTime>
{
    let identity = ConnectionIdentity::new(ConnectionIdentityConfig {
        principal: PrincipalId::new("local-controller"),
        tenant: TenantId::new("local-run"),
        issued_at_ms: None,
        expires_at_ms: u64::MAX,
        binding_attributes: BindingAttributes::default(),
    });
    ConnectionBinding::new(
        controller,
        StaticConnectionIdentityResolver::new(identity),
        SystemConnectionTime,
        CancellationSignal::default(),
    )
}

pub(super) fn require_absolute(path: &Path) -> Result<(), PortableControllerError> {
    (path.is_absolute() && !path.as_os_str().is_empty())
        .then_some(())
        .ok_or(PortableControllerError::Path)
}

pub(super) fn validate_ledger_path(path: &Path) -> Result<(), PortableControllerError> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => Ok(()),
        Ok(_) => Err(PortableControllerError::LedgerPath),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(PortableControllerError::LedgerPath),
    }
}

pub(super) fn validate_existing_storage(path: &Path) -> Result<(), PortableControllerError> {
    validate_existing_path(path, std::fs::Metadata::is_dir)
}

pub(super) fn validate_existing_ledger_path(path: &Path) -> Result<(), PortableControllerError> {
    validate_existing_path(path, std::fs::Metadata::is_file)
}

fn validate_existing_path(
    path: &Path,
    expected: fn(&std::fs::Metadata) -> bool,
) -> Result<(), PortableControllerError> {
    let metadata = std::fs::symlink_metadata(path).map_err(PortableControllerError::Io)?;
    if expected(&metadata) && !metadata.file_type().is_symlink() {
        Ok(())
    } else {
        Err(PortableControllerError::LedgerPath)
    }
}

pub(super) fn clear_stale_endpoint(
    paths: &PortableControllerPaths,
) -> Result<(), PortableControllerError> {
    remove_existing_socket(&paths.socket())?;
    remove_existing_regular_file(&paths.ready())
}

#[cfg(unix)]
fn remove_existing_socket(path: &Path) -> Result<(), PortableControllerError> {
    use std::os::unix::fs::FileTypeExt as _;

    remove_existing_endpoint(path, |file_type| file_type.is_socket())
}

#[cfg(not(unix))]
fn remove_existing_socket(_path: &Path) -> Result<(), PortableControllerError> {
    Ok(())
}

fn remove_existing_regular_file(path: &Path) -> Result<(), PortableControllerError> {
    remove_existing_endpoint(path, std::fs::FileType::is_file)
}

fn remove_existing_endpoint(
    path: &Path,
    expected: impl FnOnce(&std::fs::FileType) -> bool,
) -> Result<(), PortableControllerError> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if expected(&metadata.file_type()) => {
            std::fs::remove_file(path).map_err(PortableControllerError::Io)
        }
        Ok(_) => Err(PortableControllerError::EndpointPath),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(PortableControllerError::Io(error)),
    }
}

fn read_bounded_regular_file(
    path: &Path,
    maximum: u64,
) -> Result<Vec<u8>, PortableControllerError> {
    let metadata = std::fs::symlink_metadata(path).map_err(PortableControllerError::Io)?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > maximum {
        return Err(PortableControllerError::Bootstrap);
    }
    let mut bytes = Vec::with_capacity(usize::try_from(metadata.len()).unwrap_or(0));
    std::fs::File::open(path)
        .map_err(PortableControllerError::Io)?
        .take(maximum + 1)
        .read_to_end(&mut bytes)
        .map_err(PortableControllerError::Io)?;
    if bytes.len() as u64 > maximum {
        return Err(PortableControllerError::Bootstrap);
    }
    Ok(bytes)
}

fn validate_private_bootstrap(path: &Path) -> Result<(), PortableControllerError> {
    require_absolute(path)?;
    let metadata = std::fs::symlink_metadata(path).map_err(PortableControllerError::Io)?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(PortableControllerError::Bootstrap);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt as _, PermissionsExt as _};

        if metadata.uid() != unsafe { libc::geteuid() }
            || metadata.permissions().mode() & 0o077 != 0
        {
            return Err(PortableControllerError::BootstrapPermissions);
        }
    }
    Ok(())
}

fn write_private_new_file(path: &Path, bytes: &[u8]) -> Result<(), PortableControllerError> {
    write_new_file(path, bytes, 0o600).map_err(PortableControllerError::Io)
}

#[cfg(unix)]
fn set_private_socket_permissions(path: &Path) -> Result<(), PortableControllerError> {
    use std::os::unix::fs::PermissionsExt as _;

    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
        .map_err(PortableControllerError::Io)
}

#[cfg(unix)]
fn write_ready(controller: &PortableRunController) -> Result<(), PortableControllerError> {
    use std::os::unix::fs::OpenOptionsExt as _;

    let ready = PortableControllerReady {
        kind: READY_KIND.to_owned(),
        run_id: controller.run_id().clone(),
        socket: controller.paths().socket(),
        pid: std::process::id(),
    };
    let bytes = serde_json::to_vec(&ready).map_err(|_| PortableControllerError::Readiness)?;
    let mut random = [0_u8; 8];
    getrandom::fill(&mut random).map_err(|_| PortableControllerError::Readiness)?;
    let suffix = random
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let temporary = controller
        .paths()
        .storage()
        .join(format!(".controller.ready-{suffix}.tmp"));
    let result = (|| {
        let mut file = std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .mode(0o600)
            .open(&temporary)
            .map_err(PortableControllerError::Io)?;
        file.write_all(&bytes)
            .map_err(PortableControllerError::Io)?;
        file.sync_all().map_err(PortableControllerError::Io)?;
        std::fs::rename(&temporary, controller.paths().ready()).map_err(PortableControllerError::Io)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(temporary);
    }
    result
}
