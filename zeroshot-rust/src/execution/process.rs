mod io;
mod platform;

use std::collections::BTreeMap;
use std::path::PathBuf;

use thiserror::Error;
use tokio::process::Command;
use tokio::sync::mpsc;
use tokio::time::{Instant, sleep_until};

use super::driver::{DriverCancellation, WorkspaceCapability};
use io::{
    ProcessEvent, collect_remaining_events, join_errors, record_process_event, spawn_reader_task,
    spawn_stdin_task,
};
use platform::{capture_process_tree, terminate_process_tree};

pub const MAX_PROCESS_DIAGNOSTIC_BYTES: usize = 64 * 1024;
pub const MAX_PROCESS_ARGV_ITEMS: usize = 256;
pub const MAX_PROCESS_ARGV_BYTES: usize = 64 * 1024;
pub const MAX_PROCESS_ENV_ITEMS: usize = 256;
pub const MAX_PROCESS_ENV_BYTES: usize = 64 * 1024;
pub const MAX_PROCESS_STDIN_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_PROCESS_STDIO_BYTES: usize = 8 * 1024 * 1024;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProcessCommand {
    pub program: String,
    pub argv: Vec<String>,
    pub environment: BTreeMap<String, String>,
    pub workspace: WorkspaceCapability,
    pub stdin: ProcessInput,
    pub deadline: Instant,
}

impl ProcessCommand {
    pub fn validate(&self) -> Result<(), ProcessRunnerError> {
        validate_program(&self.program)?;
        validate_collection(
            CollectionLimit::new("argv", MAX_PROCESS_ARGV_ITEMS, MAX_PROCESS_ARGV_BYTES),
            self.argv.len(),
            format_arg_bytes(&self.program, &self.argv)?,
        )?;
        validate_collection(
            CollectionLimit::new("environment", MAX_PROCESS_ENV_ITEMS, MAX_PROCESS_ENV_BYTES),
            self.environment.len(),
            total_env_bytes(&self.environment)?,
        )?;
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

#[derive(Clone, Copy, Debug, Default)]
pub struct LocalProcessRunner;

impl LocalProcessRunner {
    #[must_use]
    pub const fn new() -> Self {
        Self
    }

    pub async fn run(
        &self,
        command: ProcessCommand,
        mut cancellation: DriverCancellation,
    ) -> Result<ProcessRunOutput, ProcessRunnerError> {
        command.validate()?;

        let mut child = build_child_command(&command)
            .spawn()
            .map_err(|error| ProcessRunnerError::Launch(error.to_string()))?;
        let process_tree = capture_process_tree(&child);
        let (event_tx, mut event_rx) = mpsc::unbounded_channel();
        spawn_stdin_task(
            child.stdin.take(),
            command.stdin.into_inner(),
            event_tx.clone(),
        );
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
            event_tx.clone(),
        );
        drop(event_tx);

        let mut state = RunState::default();
        let deadline = sleep_until(command.deadline);
        tokio::pin!(deadline);

        while state.exit_status.is_none() {
            tokio::select! {
                status = child.wait() => handle_wait(status, &mut state).await,
                _ = cancellation.cancelled() => cancel_child(&process_tree, &mut child, &mut state).await,
                _ = &mut deadline => timeout_child(&process_tree, &mut child, &mut state).await,
                event = event_rx.recv() => {
                    let Some(event) = event else {
                        break;
                    };
                    handle_event(event, &process_tree, &mut child, &mut state).await;
                }
            }
        }

        collect_remaining_events(
            &mut event_rx,
            io::PendingIo::new(
                &mut state.stdin_done,
                &mut state.stdout,
                &mut state.stderr,
                &mut state.post_launch_errors,
            ),
        )
        .await;
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

struct CollectionLimit {
    label: &'static str,
    max_items: usize,
    max_bytes: usize,
}

impl CollectionLimit {
    const fn new(label: &'static str, max_items: usize, max_bytes: usize) -> Self {
        Self {
            label,
            max_items,
            max_bytes,
        }
    }
}

fn build_child_command(command: &ProcessCommand) -> Command {
    let mut child = Command::new(&command.program);
    child.args(&command.argv);
    child.current_dir(PathBuf::from(&command.workspace.current_dir));
    child.env_clear();
    child.envs(command.environment.iter());
    child.stdin(std::process::Stdio::piped());
    child.stdout(std::process::Stdio::piped());
    child.stderr(std::process::Stdio::piped());
    platform::configure_process_group(&mut child);
    child
}

fn validate_program(program: &str) -> Result<(), ProcessRunnerError> {
    if program.is_empty() {
        return Err(ProcessRunnerError::InvalidCommand(
            "program must not be empty".to_owned(),
        ));
    }
    Ok(())
}

fn validate_collection(
    limit: CollectionLimit,
    items: usize,
    bytes: usize,
) -> Result<(), ProcessRunnerError> {
    if items > limit.max_items {
        return Err(ProcessRunnerError::InvalidCommand(format!(
            "{} has {} items; maximum is {}",
            limit.label, items, limit.max_items
        )));
    }
    if bytes > limit.max_bytes {
        return Err(ProcessRunnerError::InvalidCommand(format!(
            "{} is {} bytes; maximum is {}",
            limit.label, bytes, limit.max_bytes
        )));
    }
    Ok(())
}

fn validate_stdin(stdin: &[u8]) -> Result<(), ProcessRunnerError> {
    if stdin.len() > MAX_PROCESS_STDIN_BYTES {
        return Err(ProcessRunnerError::InvalidCommand(format!(
            "stdin is {} bytes; maximum is {}",
            stdin.len(),
            MAX_PROCESS_STDIN_BYTES
        )));
    }
    Ok(())
}

fn format_arg_bytes(program: &str, argv: &[String]) -> Result<usize, ProcessRunnerError> {
    argv.iter()
        .map(String::as_str)
        .chain(std::iter::once(program))
        .try_fold(0usize, |total, value| {
            total
                .checked_add(c_string_storage_bytes(value))
                .ok_or_else(|| {
                    ProcessRunnerError::InvalidCommand("argv byte count overflowed".to_owned())
                })
        })
}

fn total_env_bytes(environment: &BTreeMap<String, String>) -> Result<usize, ProcessRunnerError> {
    environment.iter().try_fold(0usize, |total, (key, value)| {
        total
            .checked_add(c_string_storage_bytes(key))
            .and_then(|subtotal| subtotal.checked_add(value.len()))
            .and_then(|subtotal| subtotal.checked_add(1))
            .ok_or_else(|| {
                ProcessRunnerError::InvalidCommand("environment byte count overflowed".to_owned())
            })
    })
}

fn c_string_storage_bytes(value: &str) -> usize {
    value.len() + 1
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
