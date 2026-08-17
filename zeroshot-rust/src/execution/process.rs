mod io;
mod platform;
#[cfg(unix)]
mod platform_unix;
#[cfg(windows)]
mod platform_windows;
mod session;
mod session_runtime;
mod spawn_recovery;

use std::collections::BTreeMap;
use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{compiler_fence, Ordering};

use thiserror::Error;
use tokio::sync::mpsc;
use tokio::time::{Instant, sleep_until};

use super::driver::{DriverCancellation, WorkspaceCapability};
use io::{
    ProcessEvent, collect_remaining_events, join_errors, record_process_event, spawn_reader_task,
    spawn_stdin_task,
};
use platform::{
    ProcessContainment, capture_process_tree, process_tree_has_live_members,
    register_process_tree_for, terminate_process_tree,
};
use spawn_recovery::{ChildCommandSpec, build_child_command, validate_launch_fields, validate_stdin};
pub use session::{
    MAX_PROCESS_FRAME_BYTES, MAX_PROCESS_FRAMING_OVERHEAD_BYTES, MAX_PROCESS_MESSAGE_BYTES,
    PROCESS_STDIN_CAPACITY, PROCESS_STDOUT_CAPACITY, ProcessFrame, ProcessOutputChunk,
    ProcessSession, ProcessSessionCommand, ProcessSessionOutput,
};

pub const MAX_PROCESS_DIAGNOSTIC_BYTES: usize = 64 * 1024;
pub const MAX_PROCESS_ARGV_ITEMS: usize = 256;
pub const MAX_PROCESS_ARGV_BYTES: usize = 64 * 1024;
pub const MAX_PROCESS_ENV_ITEMS: usize = 256;
pub const MAX_PROCESS_ENV_BYTES: usize = 64 * 1024;
pub const MAX_PROCESS_STDIN_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_PROCESS_STDIO_BYTES: usize = 8 * 1024 * 1024;
pub const HOSTED_WORKER_UID: u32 = 10_002;
pub const HOSTED_WORKER_GID: u32 = 10_002;

/// One-run Linux identity allocation for contained provider turns.
///
/// Workers reuse one identity because the workspace gate serializes them. Verifiers derive stable,
/// disjoint identities from their session scope so parallel cleanup cannot affect peers.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct HostedProcessPool {
    writer_uid: u32,
    writer_gid: u32,
    verifier_uid_base: u32,
    verifier_gid: u32,
}

/// Stable containment and runtime-home scope for one provider session.
///
/// Node-instance scopes survive authored loop revisits. Execution scopes are deliberately fresh.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum HostedProcessScope {
    Writer,
    WriterNodeInstance(u64),
    WriterExecution(u64),
    VerifierNodeInstance(u64),
    VerifierExecution(u64),
}

impl HostedProcessScope {
    #[must_use]
    pub fn private_home(self, root: &Path) -> PathBuf {
        let leaf = match self {
            Self::Writer => "writer".to_owned(),
            Self::WriterNodeInstance(identity) => format!("writer-node-instance-{identity}"),
            Self::WriterExecution(identity) => format!("writer-execution-{identity}"),
            Self::VerifierNodeInstance(identity) => {
                format!("verifier-node-instance-{identity}")
            }
            Self::VerifierExecution(identity) => format!("verifier-execution-{identity}"),
        };
        root.join(leaf)
    }

    fn verifier_identity(self) -> Option<(u64, u32)> {
        match self {
            Self::Writer | Self::WriterNodeInstance(_) | Self::WriterExecution(_) => None,
            Self::VerifierNodeInstance(identity) => Some((identity, 0)),
            Self::VerifierExecution(identity) => Some((identity, 1)),
        }
    }

    fn validate(self) -> Result<(), ProcessRunnerError> {
        let identity = match self {
            Self::Writer => None,
            Self::WriterNodeInstance(identity)
            | Self::WriterExecution(identity)
            | Self::VerifierNodeInstance(identity)
            | Self::VerifierExecution(identity) => Some(identity),
        };
        if identity == Some(0) {
            return Err(ProcessRunnerError::InvalidCommand(
                "provider process identity must be greater than zero".to_owned(),
            ));
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug)]
pub struct HostedProcessIdentity {
    runner: LocalProcessRunner,
    uid: u32,
    gid: u32,
    scope: HostedProcessScope,
}

impl HostedProcessIdentity {
    #[must_use]
    pub const fn runner(self) -> LocalProcessRunner {
        self.runner
    }

    #[must_use]
    pub const fn uid(self) -> u32 {
        self.uid
    }

    #[must_use]
    pub const fn gid(self) -> u32 {
        self.gid
    }

    /// Creates or reclaims the provider-private leaf under a supervisor-owned runtime root.
    ///
    /// The root must already exist and be traversable by the configured provider identity. It must
    /// not be writable by provider processes; only the generated leaf is handed to the child.
    pub fn prepare_private_home(self, root: &Path) -> Result<PathBuf, ProcessRunnerError> {
        let home = self.scope.private_home(root);
        prepare_private_directory(&home, Some((self.uid, self.gid)))?;
        Ok(home)
    }
}

impl HostedProcessPool {
    pub fn new(
        writer_uid: u32,
        writer_gid: u32,
        verifier_uid_base: u32,
        verifier_gid: u32,
    ) -> Result<Self, ProcessRunnerError> {
        if writer_uid == 0
            || writer_gid == 0
            || verifier_uid_base == 0
            || verifier_gid == 0
            || verifier_uid_base == u32::MAX
            || writer_uid >= verifier_uid_base
        {
            return Err(ProcessRunnerError::InvalidCommand(
                "hosted provider identities are invalid".to_owned(),
            ));
        }
        Ok(Self {
            writer_uid,
            writer_gid,
            verifier_uid_base,
            verifier_gid,
        })
    }

    pub fn writer(self) -> Result<LocalProcessRunner, ProcessRunnerError> {
        self.identity(HostedProcessScope::Writer)
            .map(HostedProcessIdentity::runner)
    }

    pub fn verifier(self, execution: u64) -> Result<LocalProcessRunner, ProcessRunnerError> {
        self.identity(HostedProcessScope::VerifierExecution(execution))
            .map(HostedProcessIdentity::runner)
    }

    pub fn identity(
        self,
        scope: HostedProcessScope,
    ) -> Result<HostedProcessIdentity, ProcessRunnerError> {
        scope.validate()?;
        let (uid, gid) = match scope.verifier_identity() {
            None => (self.writer_uid, self.writer_gid),
            Some((identity, discriminator)) => {
                let index = identity.checked_sub(1).ok_or_else(|| {
                    ProcessRunnerError::InvalidCommand(
                        "provider process identity must be greater than zero".to_owned(),
                    )
                })?;
                let offset = index
                    .checked_mul(2)
                    .and_then(|value| value.checked_add(u64::from(discriminator)))
                    .and_then(|value| u32::try_from(value).ok())
                    .ok_or_else(|| {
                        ProcessRunnerError::InvalidCommand(
                            "verifier identity range is exhausted".to_owned(),
                        )
                    })?;
                let uid = self.verifier_uid_base.checked_add(offset).ok_or_else(|| {
                    ProcessRunnerError::InvalidCommand(
                        "verifier identity range is exhausted".to_owned(),
                    )
                })?;
                (uid, self.verifier_gid)
            }
        };
        let runner = LocalProcessRunner::hosted_worker_identity(uid, gid)?;
        Ok(HostedProcessIdentity {
            runner,
            uid,
            gid,
            scope,
        })
    }
}

pub fn prepare_local_private_home(
    root: &Path,
    scope: HostedProcessScope,
) -> Result<PathBuf, ProcessRunnerError> {
    scope.validate()?;
    let home = scope.private_home(root);
    prepare_private_directory(&home, None)?;
    Ok(home)
}

fn prepare_private_directory(
    path: &Path,
    owner: Option<(u32, u32)>,
) -> Result<(), ProcessRunnerError> {
    create_private_directory(path)?;
    validate_private_directory(path)?;
    set_private_directory_mode(path)?;
    set_private_directory_owner(path, owner)
}

fn create_private_directory(path: &Path) -> Result<(), ProcessRunnerError> {
    match std::fs::create_dir(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
        Err(_) => Err(ProcessRunnerError::Launch(
            "provider private home could not be created".to_owned(),
        )),
    }
}

fn validate_private_directory(path: &Path) -> Result<(), ProcessRunnerError> {
    let metadata = std::fs::symlink_metadata(path).map_err(|_| {
        ProcessRunnerError::Launch("provider private home could not be inspected".to_owned())
    })?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(ProcessRunnerError::InvalidCommand(
            "provider private home is not a directory".to_owned(),
        ));
    }
    Ok(())
}

#[cfg(unix)]
fn set_private_directory_mode(path: &Path) -> Result<(), ProcessRunnerError> {
    use std::os::unix::fs::PermissionsExt;

    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).map_err(|_| {
        ProcessRunnerError::Launch("provider private home mode could not be set".to_owned())
    })
}

#[cfg(not(unix))]
fn set_private_directory_mode(_path: &Path) -> Result<(), ProcessRunnerError> {
    Ok(())
}

#[cfg(target_os = "linux")]
fn set_private_directory_owner(
    path: &Path,
    owner: Option<(u32, u32)>,
) -> Result<(), ProcessRunnerError> {
    use std::os::unix::ffi::OsStrExt;

    if let Some((uid, gid)) = owner {
        let path = std::ffi::CString::new(path.as_os_str().as_bytes()).map_err(|_| {
            ProcessRunnerError::InvalidCommand("provider private home path is invalid".to_owned())
        })?;
        // SAFETY: the path is a live NUL-free C string and the caller supplied fixed numeric IDs.
        if unsafe { libc::chown(path.as_ptr(), uid, gid) } != 0 {
            return Err(ProcessRunnerError::Launch(
                "provider private home ownership could not be set".to_owned(),
            ));
        }
    }
    Ok(())
}

#[cfg(not(target_os = "linux"))]
fn set_private_directory_owner(
    _path: &Path,
    owner: Option<(u32, u32)>,
) -> Result<(), ProcessRunnerError> {
    let _ = owner;
    Ok(())
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProcessCommand {
    pub program: String,
    pub argv: Vec<String>,
    pub environment: BTreeMap<String, String>,
    pub workspace: WorkspaceCapability,
    pub stdin: ProcessInput,
    pub deadline: Instant,
}

/// One consumed environment value for a process launch. The value is never cloneable or
/// included in command debug output and is zeroed when the launch attempt has consumed it.
pub(crate) struct ProcessSecretEnvironment {
    name: &'static str,
    value: Vec<u8>,
}

impl ProcessSecretEnvironment {
    pub(crate) fn single(name: &'static str, value: &[u8]) -> Result<Self, ProcessRunnerError> {
        if name.is_empty()
            || value.is_empty()
            || name.as_bytes().contains(&0)
            || value.contains(&0)
            || std::str::from_utf8(value).is_err()
            || name.len().saturating_add(value.len()) > MAX_PROCESS_ENV_BYTES
        {
            return Err(ProcessRunnerError::InvalidCommand(
                "secret process environment is invalid".to_owned(),
            ));
        }
        Ok(Self {
            name,
            value: value.to_vec(),
        })
    }

    fn apply(&self, command: &mut tokio::process::Command) {
        let value = std::str::from_utf8(&self.value)
            .expect("validated secret process environment is UTF-8");
        command.env(self.name, value);
    }
}

impl fmt::Debug for ProcessSecretEnvironment {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ProcessSecretEnvironment")
            .field("name", &self.name)
            .field("value", &"[redacted]")
            .finish()
    }
}

impl Drop for ProcessSecretEnvironment {
    fn drop(&mut self) {
        for byte in &mut self.value {
            // SAFETY: `byte` is a valid mutable pointer into the exclusively owned value.
            unsafe {
                std::ptr::write_volatile(byte, 0);
            }
        }
        compiler_fence(Ordering::SeqCst);
    }
}

impl ProcessCommand {
    pub fn validate(&self) -> Result<(), ProcessRunnerError> {
        validate_launch_fields(&self.program, &self.argv, &self.environment)?;
        self.stdin.validate()?;
        Ok(())
    }
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct ProcessInput(Vec<u8>);

impl ProcessInput {
    pub fn new(stdin: Vec<u8>) -> Result<Self, ProcessRunnerError> {
        validate_stdin(&stdin)?;
        Ok(Self(stdin))
    }

    #[must_use]
    pub const fn empty() -> Self {
        Self(Vec::new())
    }

    fn validate(&self) -> Result<(), ProcessRunnerError> {
        validate_stdin(&self.0)
    }

    #[must_use]
    pub fn into_inner(self) -> Vec<u8> {
        self.0
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProcessLaunchEvidence {
    DefinitelyNotStarted,
    MayHaveStarted,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProcessRunOutput {
    pub launch_evidence: ProcessLaunchEvidence,
    pub exit_code: Option<i32>,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub cancelled: bool,
    pub timed_out: bool,
    pub cleanup: ProcessCleanupEvidence,
    pub post_launch_error: Option<String>,
}

#[derive(Debug, Error)]
pub enum ProcessRunnerError {
    #[error("invalid process command: {0}")]
    InvalidCommand(String),
    #[error("process launch failed before start: {0}")]
    Launch(String),
    #[error("process I/O failed after launch: {0}")]
    Io(String),
}

impl ProcessRunnerError {
    #[must_use]
    pub const fn launch_evidence(&self) -> ProcessLaunchEvidence {
        match self {
            Self::InvalidCommand(_) | Self::Launch(_) => {
                ProcessLaunchEvidence::DefinitelyNotStarted
            }
            Self::Io(_) => ProcessLaunchEvidence::MayHaveStarted,
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct LocalProcessRunner {
    containment: ProcessContainment,
}

impl Default for LocalProcessRunner {
    fn default() -> Self {
        Self::new()
    }
}

impl LocalProcessRunner {
    #[must_use]
    pub const fn new() -> Self {
        Self {
            containment: ProcessContainment::ProcessGroup,
        }
    }

    pub fn hosted_worker() -> Result<Self, ProcessRunnerError> {
        #[cfg(target_os = "linux")]
        {
            Ok(Self {
                containment: ProcessContainment::WorkerUid {
                    uid: HOSTED_WORKER_UID,
                    gid: HOSTED_WORKER_GID,
                },
            })
        }
        #[cfg(not(target_os = "linux"))]
        {
            Err(ProcessRunnerError::Launch(
                "hosted worker containment requires Linux".to_owned(),
            ))
        }
    }

    pub fn hosted_worker_identity(uid: u32, gid: u32) -> Result<Self, ProcessRunnerError> {
        #[cfg(target_os = "linux")]
        {
            if uid == 0 || gid == 0 {
                return Err(ProcessRunnerError::InvalidCommand(
                    "hosted worker identity must be unprivileged".to_owned(),
                ));
            }
            Ok(Self {
                containment: ProcessContainment::WorkerUid { uid, gid },
            })
        }
        #[cfg(not(target_os = "linux"))]
        {
            let _ = (uid, gid);
            Err(ProcessRunnerError::Launch(
                "hosted worker containment requires Linux".to_owned(),
            ))
        }
    }

    pub async fn run(
        &self,
        command: ProcessCommand,
        cancellation: DriverCancellation,
    ) -> Result<ProcessRunOutput, ProcessRunnerError> {
        self.run_inner(command, None, cancellation).await
    }

    pub(crate) async fn run_with_secrets(
        &self,
        command: ProcessCommand,
        secrets: ProcessSecretEnvironment,
        cancellation: DriverCancellation,
    ) -> Result<ProcessRunOutput, ProcessRunnerError> {
        self.run_inner(command, Some(secrets), cancellation).await
    }

    async fn run_inner(
        &self,
        command: ProcessCommand,
        secrets: Option<ProcessSecretEnvironment>,
        cancellation: DriverCancellation,
    ) -> Result<ProcessRunOutput, ProcessRunnerError> {
        command.validate()?;
        let launched = launch_contained_child(&command, secrets.as_ref(), self.containment).await;
        drop(secrets);
        let (process_tree, mut child) = launched?;
        let mut event_rx = spawn_process_io(&mut child, command.stdin.into_inner());
        let state = drive_run(
            &process_tree,
            &mut child,
            &mut event_rx,
            RunControls {
                cancellation,
                deadline: command.deadline,
            },
        )
        .await;
        finalize_run(&process_tree, &mut child, &mut event_rx, state).await
    }
}

fn spawn_process_io(
    child: &mut tokio::process::Child,
    stdin: Vec<u8>,
) -> mpsc::UnboundedReceiver<ProcessEvent> {
    let (event_tx, event_rx) = mpsc::unbounded_channel();
    spawn_stdin_task(child.stdin.take(), stdin, event_tx.clone());
    spawn_reader_task(
        child.stdout.take(),
        MAX_PROCESS_STDIO_BYTES,
        io::ProcessStream::Stdout,
        event_tx.clone(),
    );
    spawn_reader_task(
        child.stderr.take(),
        MAX_PROCESS_DIAGNOSTIC_BYTES,
        io::ProcessStream::Stderr,
        event_tx,
    );
    event_rx
}

struct RunControls {
    cancellation: DriverCancellation,
    deadline: Instant,
}

async fn drive_run(
    process_tree: &platform::ProcessTreeHandle,
    child: &mut tokio::process::Child,
    event_rx: &mut mpsc::UnboundedReceiver<ProcessEvent>,
    mut controls: RunControls,
) -> RunState {
    let mut state = RunState::default();
    let mut io_events_open = true;
    let deadline = sleep_until(controls.deadline);
    tokio::pin!(deadline);
    while state.exit_status.is_none() {
        tokio::select! {
            status = child.wait() => handle_wait(status, &mut state).await,
            _ = controls.cancellation.cancelled() => cancel_child(process_tree, child, &mut state).await,
            _ = &mut deadline => timeout_child(process_tree, child, &mut state).await,
            event = event_rx.recv(), if io_events_open => {
                if let Some(event) = event {
                    handle_event(event, process_tree, child, &mut state).await;
                } else {
                    io_events_open = false;
                }
            }
        }
    }
    state
}

async fn finalize_run(
    process_tree: &platform::ProcessTreeHandle,
    child: &mut tokio::process::Child,
    event_rx: &mut mpsc::UnboundedReceiver<ProcessEvent>,
    mut state: RunState,
) -> Result<ProcessRunOutput, ProcessRunnerError> {
    let prior_errors = state.post_launch_errors.len();
    collect_remaining_events(
        event_rx,
        io::PendingIo::new(
            &mut state.stdin_done,
            &mut state.stdout,
            &mut state.stderr,
            &mut state.post_launch_errors,
        ),
    )
    .await;
    ensure_run_containment(process_tree, child, &mut state, prior_errors).await;
    Ok(ProcessRunOutput {
        launch_evidence: ProcessLaunchEvidence::MayHaveStarted,
        exit_code: state.exit_status.and_then(|status| status.code()),
        stdout: state.stdout.map_or_else(Vec::new, |outcome| outcome.output),
        stderr: state.stderr.map_or_else(Vec::new, |outcome| outcome.output),
        cancelled: state.cancelled,
        timed_out: state.timed_out,
        cleanup: state.cleanup,
        post_launch_error: join_errors(state.post_launch_errors),
    })
}

async fn ensure_run_containment(
    process_tree: &platform::ProcessTreeHandle,
    child: &mut tokio::process::Child,
    state: &mut RunState,
    prior_errors: usize,
) {
    if state.cleanup != ProcessCleanupEvidence::NotRequired {
        return;
    }
    let tree_has_live_members = inspect_process_tree(process_tree, &mut state.post_launch_errors);
    if state.post_launch_errors.len() > prior_errors || tree_has_live_members {
        apply_termination(process_tree, child, state).await;
    } else if process_tree.requires_explicit_cleanup_evidence() {
        state.cleanup = ProcessCleanupEvidence::Reaped;
    }
}

fn inspect_process_tree(
    process_tree: &platform::ProcessTreeHandle,
    errors: &mut Vec<String>,
) -> bool {
    match process_tree_has_live_members(process_tree) {
        Ok(has_live_members) => has_live_members,
        Err(_) => {
            errors.push("process containment inspection failed".to_owned());
            true
        }
    }
}
async fn launch_contained_child(
    command: &ProcessCommand,
    secrets: Option<&ProcessSecretEnvironment>,
    containment: ProcessContainment,
) -> Result<(platform::ProcessTreeHandle, tokio::process::Child), ProcessRunnerError> {
    let process_tree_registration = register_process_tree_for(containment).map_err(|_| {
        ProcessRunnerError::Launch("process containment registration failed".to_owned())
    })?;
    let mut child_command = build_child_command(
        ChildCommandSpec {
            program: &command.program,
            argv: &command.argv,
            environment: &command.environment,
            workspace: &command.workspace,
        },
        containment,
    );
    if let Some(secrets) = secrets {
        secrets.apply(&mut child_command);
    }
    let mut child = child_command
        .spawn()
        .map_err(|error| ProcessRunnerError::Launch(error.to_string()))?;
    match capture_process_tree(process_tree_registration, &mut child) {
        Ok(process_tree) => Ok((process_tree, child)),
        Err(_) => {
            let _ = child.start_kill();
            let _ = child.wait().await;
            Err(ProcessRunnerError::Io(
                "process containment capture failed".to_owned(),
            ))
        }
    }
}

#[derive(Default)]
struct RunState {
    stdout: Option<io::ReaderOutcome>,
    stderr: Option<io::ReaderOutcome>,
    stdin_done: bool,
    post_launch_errors: Vec<String>,
    exit_status: Option<std::process::ExitStatus>,
    cancelled: bool,
    timed_out: bool,
    cleanup: ProcessCleanupEvidence,
}

async fn handle_wait(
    status: Result<std::process::ExitStatus, std::io::Error>,
    state: &mut RunState,
) {
    match status {
        Ok(status) => state.exit_status = Some(status),
        Err(error) => state
            .post_launch_errors
            .push(format!("wait failed: {error}")),
    }
}

async fn cancel_child(
    process_tree: &platform::ProcessTreeHandle,
    child: &mut tokio::process::Child,
    state: &mut RunState,
) {
    state.cancelled = true;
    apply_termination(process_tree, child, state).await;
}

async fn timeout_child(
    process_tree: &platform::ProcessTreeHandle,
    child: &mut tokio::process::Child,
    state: &mut RunState,
) {
    state.timed_out = true;
    apply_termination(process_tree, child, state).await;
}

async fn handle_event(
    event: ProcessEvent,
    process_tree: &platform::ProcessTreeHandle,
    child: &mut tokio::process::Child,
    state: &mut RunState,
) {
    if let Some(error) = record_process_event(
        event,
        &mut state.stdin_done,
        &mut state.stdout,
        &mut state.stderr,
    ) {
        state.post_launch_errors.push(error);
        apply_termination(process_tree, child, state).await;
    }
}

async fn apply_termination(
    process_tree: &platform::ProcessTreeHandle,
    child: &mut tokio::process::Child,
    state: &mut RunState,
) {
    let termination = terminate_process_tree(process_tree, child).await;
    state.cleanup = termination.cleanup;
    state.exit_status = termination.exit_status;
    if let Some(error) = termination.error {
        state.post_launch_errors.push(error);
    }
}

pub use platform::ProcessCleanupEvidence;

#[cfg(test)]
mod secret_environment_tests {
    use std::path::Path;

    use super::{HostedProcessPool, HostedProcessScope, ProcessSecretEnvironment};

    #[test]
    fn debug_output_redacts_secret_material() {
        let secret = ProcessSecretEnvironment::single("TOKEN", b"sensitive-value").unwrap();
        let debug = format!("{secret:?}");
        assert!(debug.contains("[redacted]"));
        assert!(!debug.contains("sensitive-value"));
    }

    #[test]
    fn hosted_scopes_keep_loop_sessions_stable_and_executions_disjoint() {
        let pool = HostedProcessPool::new(10_002, 10_002, 20_000, 20_000).unwrap();
        let loop_scope = HostedProcessScope::VerifierNodeInstance(7);
        let repeated = pool.identity(loop_scope).unwrap();
        let first_execution = pool
            .identity(HostedProcessScope::VerifierExecution(7))
            .unwrap();
        let second_execution = pool
            .identity(HostedProcessScope::VerifierExecution(8))
            .unwrap();

        assert_eq!(pool.identity(loop_scope).unwrap().uid(), repeated.uid());
        assert_ne!(repeated.uid(), first_execution.uid());
        assert_ne!(first_execution.uid(), second_execution.uid());
        assert_eq!(
            loop_scope.private_home(Path::new("/runtime")),
            Path::new("/runtime/verifier-node-instance-7")
        );
        assert_eq!(
            HostedProcessScope::VerifierExecution(7).private_home(Path::new("/runtime")),
            Path::new("/runtime/verifier-execution-7")
        );
        assert!(
            pool.identity(HostedProcessScope::VerifierExecution(0))
                .is_err()
        );
    }
}
