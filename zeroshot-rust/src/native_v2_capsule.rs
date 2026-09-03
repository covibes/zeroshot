//! Private controller-to-capsule node execution boundary for native v2.
//!
//! The public OECP protocol remains run-oriented. This transport-neutral seam is deliberately
//! private to the allocated capsule: one start produces a safe output stream and exactly one
//! normalized terminal event. A broken stream is terminal and is never retried or replaced.

use std::fs;
use std::future::Future;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use openengine_cluster_protocol::{RunId, UnixTimestampMillis};
use serde::{Deserialize, Serialize};
use tokio::sync::{Mutex, mpsc, oneshot, watch};

use crate::execution::process::{
    CONTAINED_PROCESS_CLEANUP_BUDGET, HostedProcessPool, HostedProcessScope,
};
use crate::native_v2_contract::{ExecutionRef, NodeCompletion, TokenUsageDelta};
use crate::native_v2_runner::{
    DURABLE_OUTPUT_CAPACITY, DurableNodeEvent, LiveOutput, LiveOutputStream, NodeHandle,
    NodeRunRequest, NodeRunner, NodeRunnerError, RemoteNodeHandleBridge, remote_node_handle,
};

const CONTROL_RPC_TIMEOUT: Duration = Duration::from_secs(5);
const CLOSE_RPC_TRANSPORT_MARGIN: Duration = Duration::from_secs(60);
const CLOSE_RPC_TIMEOUT: Duration =
    CONTAINED_PROCESS_CLEANUP_BUDGET.saturating_add(CLOSE_RPC_TRANSPORT_MARGIN);

#[cfg(test)]
#[derive(Clone)]
struct StartReadinessPause {
    sent: watch::Sender<bool>,
    release: watch::Sender<bool>,
}

#[cfg(test)]
impl Default for StartReadinessPause {
    fn default() -> Self {
        let (sent, _) = watch::channel(false);
        let (release, _) = watch::channel(false);
        Self { sent, release }
    }
}

#[cfg(test)]
impl StartReadinessPause {
    fn mark_sent(&self) {
        self.sent.send_replace(true);
    }

    async fn pause_before_receive(&self) {
        wait_for_signal(&mut self.sent.subscribe()).await;
        wait_for_signal(&mut self.release.subscribe()).await;
    }

    async fn wait_until_sent(&self) {
        wait_for_signal(&mut self.sent.subscribe()).await;
    }

    fn release(&self) {
        self.release.send_replace(true);
    }
}

#[cfg(test)]
trait WithStartReadinessPause: Sized {
    fn start_readiness_pause(&mut self) -> &mut Option<StartReadinessPause>;

    fn with_start_readiness_pause(mut self, pause: StartReadinessPause) -> Self {
        *self.start_readiness_pause() = Some(pause);
        self
    }
}

#[cfg(test)]
fn mark_start_readiness_sent(pause: Option<&StartReadinessPause>) {
    if let Some(pause) = pause {
        pause.mark_sent();
    }
}

#[cfg(test)]
async fn pause_before_start_readiness(pause: Option<&StartReadinessPause>) {
    if let Some(pause) = pause {
        pause.pause_before_receive().await;
    }
}

async fn wait_for_signal(signal: &mut watch::Receiver<bool>) {
    while !*signal.borrow_and_update() {
        if signal.changed().await.is_err() {
            return;
        }
    }
}

async fn receive_start_acceptance(
    acceptance: &mut Option<oneshot::Receiver<()>>,
) -> Result<(), oneshot::error::RecvError> {
    match acceptance {
        Some(acceptance) => acceptance.await,
        None => std::future::pending().await,
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CapsuleOutputStream {
    Output,
    Error,
    System,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CapsuleOutput {
    pub stream: CapsuleOutputStream,
    pub text: String,
}

impl CapsuleOutput {
    fn into_live(self) -> Result<LiveOutput, NodeRunnerError> {
        let stream = match self.stream {
            CapsuleOutputStream::Output => LiveOutputStream::Output,
            CapsuleOutputStream::Error => LiveOutputStream::Error,
            CapsuleOutputStream::System => LiveOutputStream::System,
        };
        LiveOutput::new(stream, self.text)
    }
}

impl From<LiveOutput> for CapsuleOutput {
    fn from(value: LiveOutput) -> Self {
        let stream = match value.stream {
            LiveOutputStream::Output => CapsuleOutputStream::Output,
            LiveOutputStream::Error => CapsuleOutputStream::Error,
            LiveOutputStream::System => CapsuleOutputStream::System,
        };
        Self {
            stream,
            text: value.text,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CapsuleNodeFailure {
    Cancelled,
    SessionLost,
    RunClosed,
    ExecutionActive,
    ExecutionFailed,
}

impl CapsuleNodeFailure {
    fn from_runner(error: &NodeRunnerError) -> Self {
        match error {
            NodeRunnerError::Cancelled => Self::Cancelled,
            NodeRunnerError::SessionLost => Self::SessionLost,
            NodeRunnerError::RunClosed => Self::RunClosed,
            NodeRunnerError::ExecutionActive => Self::ExecutionActive,
            NodeRunnerError::Driver | NodeRunnerError::DriverDetail(_) => Self::ExecutionFailed,
            _ => Self::ExecutionFailed,
        }
    }

    fn into_runner(self) -> NodeRunnerError {
        match self {
            Self::Cancelled => NodeRunnerError::Cancelled,
            Self::SessionLost => NodeRunnerError::SessionLost,
            Self::RunClosed => NodeRunnerError::RunClosed,
            Self::ExecutionActive => NodeRunnerError::ExecutionActive,
            Self::ExecutionFailed => NodeRunnerError::Driver,
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields, tag = "kind", rename_all = "snake_case")]
pub enum CapsuleNodeEvent {
    Output {
        output: CapsuleOutput,
        timestamp: UnixTimestampMillis,
    },
    TokenUsage {
        usage: Option<TokenUsageDelta>,
    },
    Completed {
        completion: NodeCompletion,
    },
    Failed {
        failure: CapsuleNodeFailure,
    },
}

pub struct CapsuleExecutionStream {
    events: mpsc::Receiver<CapsuleNodeEvent>,
    terminal: Option<oneshot::Receiver<Vec<CapsuleNodeEvent>>>,
    terminal_events: std::vec::IntoIter<CapsuleNodeEvent>,
}

impl CapsuleExecutionStream {
    #[must_use]
    pub fn from_receiver(events: mpsc::Receiver<CapsuleNodeEvent>) -> Self {
        Self {
            events,
            terminal: None,
            terminal_events: Vec::new().into_iter(),
        }
    }

    fn from_bounded_receiver(
        events: mpsc::Receiver<CapsuleNodeEvent>,
        terminal: oneshot::Receiver<Vec<CapsuleNodeEvent>>,
    ) -> Self {
        Self {
            events,
            terminal: Some(terminal),
            terminal_events: Vec::new().into_iter(),
        }
    }

    pub async fn recv(&mut self) -> Option<CapsuleNodeEvent> {
        if let Some(event) = self.terminal_events.next() {
            return Some(event);
        }
        let event = self.events.recv().await;
        if event.is_some() {
            return event;
        }
        let terminal = self.terminal.as_mut()?.await.ok()?;
        self.terminal = None;
        self.terminal_events = terminal.into_iter();
        self.terminal_events.next()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
pub enum CapsuleConnectionError {
    #[error("the capsule connection was lost")]
    Lost,
    #[error("the capsule rejected node execution")]
    Rejected(CapsuleNodeFailure),
}

#[async_trait]
pub trait CapsuleNodeChannel: Send + Sync {
    async fn start(
        &self,
        request: NodeRunRequest,
    ) -> Result<CapsuleExecutionStream, CapsuleConnectionError>;

    async fn cancel(&self, reference: &ExecutionRef) -> Result<(), CapsuleConnectionError>;

    /// Closes the run and returns only after capsule-side node cleanup has completed.
    async fn close_run(&self, run_id: &RunId) -> Result<(), CapsuleConnectionError>;

    fn connection_loss(&self) -> watch::Receiver<bool>;
}

mod endpoint;
pub(crate) mod provider_json_lines;
pub(crate) mod provider_process;
mod remote;

pub use endpoint::NativeCapsuleNodeEndpoint;
pub use remote::RemoteCapsuleNodeRunner;

pub struct CapsuleFilesystemSpec<'a> {
    pub workspace: &'a Path,
    pub runtime_home: &'a Path,
    pub process_pool: HostedProcessPool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CapsuleFilesystem {
    pub workspace: PathBuf,
    pub runtime_home: PathBuf,
}

/// Establishes the capsule's role-aware Linux filesystem boundary.
///
/// The single writer owns the shared workspace. Distinct verifier UIDs receive read/traverse but
/// no mutation authority. The runtime root remains root-owned and non-writable; provider-specific
/// private homes are created beneath it by [`HostedProcessPool`] identities.
pub fn prepare_capsule_filesystem(
    specification: CapsuleFilesystemSpec<'_>,
) -> Result<CapsuleFilesystem, CapsuleFilesystemError> {
    if specification.workspace == specification.runtime_home {
        return Err(CapsuleFilesystemError::InvalidLayout);
    }
    prepare_directory(specification.workspace)?;
    prepare_directory(specification.runtime_home)?;
    let workspace =
        fs::canonicalize(specification.workspace).map_err(CapsuleFilesystemError::Prepare)?;
    let runtime_home =
        fs::canonicalize(specification.runtime_home).map_err(CapsuleFilesystemError::Prepare)?;
    if paths_overlap(&workspace, &runtime_home) {
        return Err(CapsuleFilesystemError::InvalidLayout);
    }
    let writer = specification
        .process_pool
        .identity(HostedProcessScope::Writer)
        .map_err(|_| CapsuleFilesystemError::InvalidIdentity)?;
    set_directory_boundary(&workspace, 0o755, writer.uid(), writer.gid())?;
    set_directory_boundary(&runtime_home, 0o711, 0, 0)?;
    Ok(CapsuleFilesystem {
        workspace,
        runtime_home,
    })
}

fn paths_overlap(left: &Path, right: &Path) -> bool {
    left.starts_with(right) || right.starts_with(left)
}

#[derive(Debug, thiserror::Error)]
pub enum CapsuleFilesystemError {
    #[error("capsule filesystem paths must be disjoint directories")]
    InvalidLayout,
    #[error("capsule process identities are invalid")]
    InvalidIdentity,
    #[error("capsule filesystem boundary could not be prepared")]
    Prepare(#[source] io::Error),
    #[error("capsule filesystem preparation requires Linux")]
    Unsupported,
}

fn prepare_directory(path: &Path) -> Result<(), CapsuleFilesystemError> {
    match fs::create_dir(path) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(CapsuleFilesystemError::Prepare(error)),
    }
    let metadata = fs::symlink_metadata(path).map_err(CapsuleFilesystemError::Prepare)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(CapsuleFilesystemError::InvalidLayout);
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn set_directory_boundary(
    path: &Path,
    mode: u32,
    uid: u32,
    gid: u32,
) -> Result<(), CapsuleFilesystemError> {
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::fs::PermissionsExt;

    fs::set_permissions(path, fs::Permissions::from_mode(mode))
        .map_err(CapsuleFilesystemError::Prepare)?;
    let path = std::ffi::CString::new(path.as_os_str().as_bytes())
        .map_err(|_| CapsuleFilesystemError::InvalidLayout)?;
    // SAFETY: `path` is a live NUL-free C string and the IDs come from the validated pool.
    if unsafe { libc::chown(path.as_ptr(), uid, gid) } != 0 {
        return Err(CapsuleFilesystemError::Prepare(io::Error::last_os_error()));
    }
    Ok(())
}

#[cfg(not(target_os = "linux"))]
fn set_directory_boundary(
    _path: &Path,
    _mode: u32,
    _uid: u32,
    _gid: u32,
) -> Result<(), CapsuleFilesystemError> {
    Err(CapsuleFilesystemError::Unsupported)
}

#[cfg(test)]
#[path = "native_v2_capsule/tests.rs"]
mod tests;
