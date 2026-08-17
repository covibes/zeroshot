use std::collections::BTreeMap;
use std::fmt;
use std::sync::{Arc, Mutex};

use tokio::sync::{mpsc, oneshot, watch};
use tokio::time::Instant;

use crate::execution::driver::{DriverCancellation, WorkspaceCapability};

use super::platform::{ProcessContainment, capture_process_tree, register_process_tree_for};
use super::session_runtime::{
    SupervisorRequest, TailBuffer, WriterCommand, spawn_stderr_pump, spawn_stdout_pump,
    spawn_writer, supervise_session,
};
use super::spawn_recovery::{
    ChildCommandSpec, SpawnRecovery, build_child_command, validate_launch_fields,
};
use super::{LocalProcessRunner, ProcessCleanupEvidence, ProcessLaunchEvidence, ProcessRunnerError};

pub const PROCESS_STDOUT_CAPACITY: usize = 64;
pub const MAX_PROCESS_MESSAGE_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_PROCESS_FRAMING_OVERHEAD_BYTES: usize = 64 * 1024;
pub const MAX_PROCESS_FRAME_BYTES: usize =
    MAX_PROCESS_MESSAGE_BYTES + MAX_PROCESS_FRAMING_OVERHEAD_BYTES;

pub const PROCESS_STDIN_CAPACITY: usize = 64;

#[derive(Clone, Eq, PartialEq)]
pub struct ProcessSessionCommand {
    pub program: String,
    pub argv: Vec<String>,
    pub environment: BTreeMap<String, String>,
    pub workspace: WorkspaceCapability,
    pub deadline: Instant,
}

impl fmt::Debug for ProcessSessionCommand {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ProcessSessionCommand")
            .field("program", &self.program)
            .field("argv", &self.argv)
            .field(
                "environment_names",
                &self.environment.keys().collect::<Vec<_>>(),
            )
            .field("workspace", &self.workspace)
            .field("deadline", &self.deadline)
            .finish()
    }
}

impl ProcessSessionCommand {
    pub fn validate(&self) -> Result<(), ProcessRunnerError> {
        validate_launch_fields(&self.program, &self.argv, &self.environment)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProcessFrame(Vec<u8>);

impl ProcessFrame {
    pub fn new(message: Vec<u8>) -> Result<Self, ProcessRunnerError> {
        let message_bytes = message.len();
        Self::with_framing(message, message_bytes)
    }

    pub fn with_framing(frame: Vec<u8>, message_bytes: usize) -> Result<Self, ProcessRunnerError> {
        if message_bytes > frame.len() {
            return Err(ProcessRunnerError::InvalidCommand(
                "process frame message length exceeds frame length".to_owned(),
            ));
        }
        if message_bytes > MAX_PROCESS_MESSAGE_BYTES {
            return Err(ProcessRunnerError::InvalidCommand(format!(
                "process message is {message_bytes} bytes; maximum is {MAX_PROCESS_MESSAGE_BYTES}"
            )));
        }
        let framing_bytes = frame.len() - message_bytes;
        if framing_bytes > MAX_PROCESS_FRAMING_OVERHEAD_BYTES {
            return Err(ProcessRunnerError::InvalidCommand(format!(
                "process framing overhead is {framing_bytes} bytes; maximum is {MAX_PROCESS_FRAMING_OVERHEAD_BYTES}"
            )));
        }
        Ok(Self(frame))
    }

    #[must_use]
    pub fn into_inner(self) -> Vec<u8> {
        self.0
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProcessOutputChunk(Vec<u8>);

impl ProcessOutputChunk {
    pub(super) fn from_bytes(bytes: Vec<u8>) -> Self {
        Self(bytes)
    }
    #[must_use]
    pub fn as_slice(&self) -> &[u8] {
        &self.0
    }

    #[must_use]
    pub fn into_inner(self) -> Vec<u8> {
        self.0
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProcessSessionOutput {
    pub launch_evidence: ProcessLaunchEvidence,
    pub exit_code: Option<i32>,
    pub stderr_tail: Vec<u8>,
    pub cancelled: bool,
    pub timed_out: bool,
    pub cleanup: ProcessCleanupEvidence,
    pub post_launch_error: Option<String>,
}

pub struct ProcessSession {
    stdout: mpsc::Receiver<ProcessOutputChunk>,
    stdin: mpsc::Sender<WriterCommand>,
    release: watch::Sender<bool>,
    completion: watch::Receiver<Option<Arc<ProcessSessionOutput>>>,
    stdin_closed: bool,
}

impl ProcessSession {
    #[must_use]
    pub fn stdout_queue_capacity(&self) -> usize {
        self.stdout.max_capacity()
    }

    #[must_use]
    pub fn stdin_queue_capacity(&self) -> usize {
        self.stdin.max_capacity()
    }

    pub async fn send(&self, frame: ProcessFrame) -> Result<(), ProcessRunnerError> {
        if self.stdin_closed {
            return Err(ProcessRunnerError::Io(
                "process stdin is already closed".to_owned(),
            ));
        }
        if self.completion.borrow().is_some() {
            return Err(ProcessRunnerError::Io(
                "process session is no longer running".to_owned(),
            ));
        }
        let (acknowledge, acknowledged) = oneshot::channel();
        self.stdin
            .send(WriterCommand::Frame(frame.into_inner(), acknowledge))
            .await
            .map_err(|_| {
                ProcessRunnerError::Io("process stdin is no longer available".to_owned())
            })?;
        acknowledged
            .await
            .map_err(|_| ProcessRunnerError::Io("process stdin writer stopped".to_owned()))?
            .map_err(|message| ProcessRunnerError::Io(message.to_owned()))
    }

    pub async fn close_stdin(&mut self) -> Result<(), ProcessRunnerError> {
        if self.stdin_closed {
            return Ok(());
        }
        self.stdin_closed = true;
        if self.completion.borrow().is_some() {
            return Ok(());
        }
        let (acknowledge, acknowledged) = oneshot::channel();
        if self
            .stdin
            .send(WriterCommand::Close(acknowledge))
            .await
            .is_err()
        {
            return if self.completion.borrow().is_some() {
                Ok(())
            } else {
                Err(ProcessRunnerError::Io(
                    "process stdin is no longer available".to_owned(),
                ))
            };
        }
        acknowledged
            .await
            .map_err(|_| ProcessRunnerError::Io("process stdin writer stopped".to_owned()))?
            .map_err(|message| ProcessRunnerError::Io(message.to_owned()))
    }

    pub async fn recv_stdout(&mut self) -> Option<ProcessOutputChunk> {
        self.stdout.recv().await
    }

    /// Waits for process completion without consuming the bounded stdout queue.
    ///
    /// Callers that need complete stdout must drain [`Self::recv_stdout`] to `None` before
    /// calling this method. Waiting with unread stdout can fill the queue, trigger the bounded
    /// I/O-drain timeout, and discard output that the stdout pump could not enqueue.
    pub async fn wait(&mut self) -> Result<ProcessSessionOutput, ProcessRunnerError> {
        await_completion(&mut self.completion).await
    }

    pub async fn release(&mut self) -> Result<ProcessSessionOutput, ProcessRunnerError> {
        self.stdin_closed = true;
        self.release.send_replace(true);
        await_completion(&mut self.completion).await
    }
}

impl Drop for ProcessSession {
    fn drop(&mut self) {
        self.release.send_replace(true);
    }
}

async fn spawn_contained_process(
    command: &ProcessSessionCommand,
    containment: ProcessContainment,
) -> Result<SpawnRecovery, ProcessRunnerError> {
    let process_tree_registration = register_process_tree_for(containment).map_err(|_| {
        ProcessRunnerError::Launch("process containment registration failed".to_owned())
    })?;
    let mut recovery = SpawnRecovery::registered();
    let mut child_command = build_child_command(
        ChildCommandSpec {
            program: &command.program,
            argv: &command.argv,
            environment: &command.environment,
            workspace: &command.workspace,
        },
        containment,
    );
    child_command.kill_on_drop(true);
    let child = child_command.spawn().map_err(|_| {
        ProcessRunnerError::Launch("operating system rejected process launch".to_owned())
    })?;
    recovery.capture(child);
    let Some(recovery_child) = recovery.child_mut() else {
        return Err(ProcessRunnerError::Launch(
            "launched process was not retained".to_owned(),
        ));
    };
    let process_tree = match capture_process_tree(process_tree_registration, recovery_child) {
        Ok(process_tree) => process_tree,
        Err(_) => {
            recovery.recover().await;
            return Err(ProcessRunnerError::Io(
                "process containment capture failed".to_owned(),
            ));
        }
    };
    recovery.capture_process_tree(process_tree);
    Ok(recovery)
}

impl LocalProcessRunner {
    pub async fn open(
        &self,
        command: ProcessSessionCommand,
        cancellation: DriverCancellation,
    ) -> Result<ProcessSession, ProcessRunnerError> {
        command.validate()?;

        let mut recovery = spawn_contained_process(&command, self.containment).await?;
        let Some(child) = recovery.child_mut() else {
            recovery.recover().await;
            return Err(ProcessRunnerError::Io(
                "contained process was not retained".to_owned(),
            ));
        };
        let stdin = child.stdin.take();
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();

        let (stdout_tx, stdout_rx) = mpsc::channel(PROCESS_STDOUT_CAPACITY);
        let (stdin_tx, stdin_rx) = mpsc::channel(PROCESS_STDIN_CAPACITY);
        let (release_tx, release_rx) = watch::channel(false);
        let (writer_stop_tx, writer_stop_rx) = watch::channel(false);
        let (completion_tx, completion_rx) = watch::channel(None);
        let (io_failure_tx, io_failure_rx) = mpsc::unbounded_channel();
        let stderr_tail = Arc::new(Mutex::new(TailBuffer::new(
            super::MAX_PROCESS_DIAGNOSTIC_BYTES,
        )));

        let stdout_task = spawn_stdout_pump(stdout, stdout_tx, io_failure_tx.clone());
        let stderr_task =
            spawn_stderr_pump(stderr, Arc::clone(&stderr_tail), io_failure_tx.clone());
        let writer_task = spawn_writer(stdin, stdin_rx, writer_stop_rx, io_failure_tx);
        let (child, process_tree) = recovery.disarm().ok_or_else(|| {
            ProcessRunnerError::Io("process recovery state was incomplete".to_owned())
        })?;
        tokio::spawn(supervise_session(SupervisorRequest {
            child,
            process_tree,
            cancellation,
            deadline: command.deadline,
            release: release_rx,
            writer_stop: writer_stop_tx,
            io_failures: io_failure_rx,
            stdout_task,
            stderr_task,
            writer_task,
            stderr_tail,
            completion: completion_tx,
        }));

        Ok(ProcessSession {
            stdout: stdout_rx,
            stdin: stdin_tx,
            release: release_tx,
            completion: completion_rx,
            stdin_closed: false,
        })
    }
}

async fn await_completion(
    completion: &mut watch::Receiver<Option<Arc<ProcessSessionOutput>>>,
) -> Result<ProcessSessionOutput, ProcessRunnerError> {
    loop {
        if let Some(output) = completion.borrow().as_ref() {
            return Ok(output.as_ref().clone());
        }
        completion.changed().await.map_err(|_| {
            ProcessRunnerError::Io("process session supervisor stopped unexpectedly".to_owned())
        })?;
    }
}
