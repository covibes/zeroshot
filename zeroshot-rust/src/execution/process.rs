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
    use super::ProcessSecretEnvironment;

    #[test]
    fn debug_output_redacts_secret_material() {
        let secret = ProcessSecretEnvironment::single("TOKEN", b"sensitive-value").unwrap();
        let debug = format!("{secret:?}");
        assert!(debug.contains("[redacted]"));
        assert!(!debug.contains("sensitive-value"));
    }
}
