use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::process::{Child, ChildStderr, ChildStdin, ChildStdout};
use tokio::sync::{mpsc, oneshot, watch};
use tokio::task::JoinHandle;
use tokio::time::{Duration, Instant, sleep_until, timeout, timeout_at};

use crate::execution::driver::{DriverCancellation, WorkspaceCapability};

use super::platform::{
    ProcessTreeHandle, capture_process_tree, process_tree_has_live_members, register_process_tree,
    terminate_process_tree,
};
use super::{
    LocalProcessRunner, ProcessCleanupEvidence, ProcessLaunchEvidence, ProcessRunnerError,
    build_child_command, validate_launch_fields,
};

pub const PROCESS_STDOUT_CAPACITY: usize = 64;
pub const MAX_PROCESS_MESSAGE_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_PROCESS_FRAMING_OVERHEAD_BYTES: usize = 64 * 1024;
pub const MAX_PROCESS_FRAME_BYTES: usize =
    MAX_PROCESS_MESSAGE_BYTES + MAX_PROCESS_FRAMING_OVERHEAD_BYTES;

pub const PROCESS_STDIN_CAPACITY: usize = 64;
const PROCESS_OUTPUT_CHUNK_BYTES: usize = 64 * 1024;
const PROCESS_SESSION_DRAIN_TIMEOUT: Duration = Duration::from_secs(1);

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProcessSessionCommand {
    pub program: String,
    pub argv: Vec<String>,
    pub environment: BTreeMap<String, String>,
    pub workspace: WorkspaceCapability,
    pub deadline: Instant,
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

impl LocalProcessRunner {
    pub async fn open(
        &self,
        command: ProcessSessionCommand,
        cancellation: DriverCancellation,
    ) -> Result<ProcessSession, ProcessRunnerError> {
        command.validate()?;

        let process_tree_registration = register_process_tree().map_err(|_| {
            ProcessRunnerError::Launch("process containment registration failed".to_owned())
        })?;
        let mut recovery = SpawnRecovery::registered();
        let mut child_command = build_child_command(
            &command.program,
            &command.argv,
            &command.environment,
            &command.workspace,
        );
        child_command.kill_on_drop(true);
        let child = child_command.spawn().map_err(|_| {
            ProcessRunnerError::Launch("operating system rejected process launch".to_owned())
        })?;
        recovery.capture(child);
        let process_tree =
            match capture_process_tree(process_tree_registration, recovery.child_mut()) {
                Ok(process_tree) => process_tree,
                Err(_) => {
                    recovery.recover().await;
                    return Err(ProcessRunnerError::Io(
                        "process containment capture failed".to_owned(),
                    ));
                }
            };
        recovery.capture_process_tree(process_tree);
        let child = recovery.child_mut();
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
        let (child, process_tree) = recovery.disarm();
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

enum WriterCommand {
    Frame(Vec<u8>, oneshot::Sender<Result<(), &'static str>>),
    Close(oneshot::Sender<Result<(), &'static str>>),
}

#[derive(Clone, Copy)]
enum IoFailure {
    Stdout,
    Stderr,
    Stdin,
}

struct SupervisorRequest {
    child: Child,
    process_tree: ProcessTreeHandle,
    cancellation: DriverCancellation,
    deadline: Instant,
    release: watch::Receiver<bool>,
    writer_stop: watch::Sender<bool>,
    io_failures: mpsc::UnboundedReceiver<IoFailure>,
    stdout_task: JoinHandle<()>,
    stderr_task: JoinHandle<()>,
    writer_task: JoinHandle<()>,
    stderr_tail: Arc<Mutex<TailBuffer>>,
    completion: watch::Sender<Option<Arc<ProcessSessionOutput>>>,
}

async fn supervise_session(mut request: SupervisorRequest) {
    let mut cancelled = false;
    let mut timed_out = false;
    let mut cleanup = ProcessCleanupEvidence::NotRequired;
    let mut post_launch_errors = Vec::new();
    let mut exit_status = None;
    let deadline = sleep_until(request.deadline);
    tokio::pin!(deadline);

    loop {
        tokio::select! {
            biased;
            status = request.child.wait() => {
                match status {
                    Ok(status) => exit_status = Some(status),
                    Err(_) => post_launch_errors.push("process wait failed".to_owned()),
                }
                break;
            }
            _ = request.cancellation.cancelled() => {
                cancelled = true;
                let termination = terminate_process_tree(&request.process_tree, &mut request.child).await;
                cleanup = termination.cleanup;
                exit_status = termination.exit_status;
                if termination.error.is_some() {
                    post_launch_errors.push("process cancellation cleanup failed".to_owned());
                }
                break;
            }
            _ = &mut deadline => {
                timed_out = true;
                let termination = terminate_process_tree(&request.process_tree, &mut request.child).await;
                cleanup = termination.cleanup;
                exit_status = termination.exit_status;
                if termination.error.is_some() {
                    post_launch_errors.push("process deadline cleanup failed".to_owned());
                }
                break;
            }
            changed = request.release.changed() => {
                if changed.is_err() || *request.release.borrow() {
                    request.writer_stop.send_replace(true);
                    match timeout(PROCESS_SESSION_DRAIN_TIMEOUT, request.child.wait()).await {
                        Ok(Ok(status)) => exit_status = Some(status),
                        Ok(Err(_)) => post_launch_errors.push("process wait failed during release".to_owned()),
                        Err(_) => {
                            let termination = terminate_process_tree(&request.process_tree, &mut request.child).await;
                            cleanup = termination.cleanup;
                            exit_status = termination.exit_status;
                            if termination.error.is_some() {
                                post_launch_errors.push("process release cleanup failed".to_owned());
                            }
                        }
                    }
                    break;
                }
            }
            failure = request.io_failures.recv() => {
                let Some(failure) = failure else {
                    continue;
                };
                post_launch_errors.push(io_failure_message(failure).to_owned());
                let termination = terminate_process_tree(&request.process_tree, &mut request.child).await;
                cleanup = termination.cleanup;
                exit_status = termination.exit_status;
                if termination.error.is_some() {
                    post_launch_errors.push("process I/O cleanup failed".to_owned());
                }
                break;
            }
        }
    }

    request.writer_stop.send_replace(true);
    let drain_timed_out = drain_io_tasks(&mut request, &mut post_launch_errors).await;
    if cleanup == ProcessCleanupEvidence::NotRequired {
        let tree_has_live_members = match process_tree_has_live_members(&request.process_tree) {
            Ok(has_live_members) => has_live_members,
            Err(_) => {
                post_launch_errors.push("process containment inspection failed".to_owned());
                true
            }
        };
        if drain_timed_out || tree_has_live_members {
            let termination =
                terminate_process_tree(&request.process_tree, &mut request.child).await;
            cleanup = termination.cleanup;
            if exit_status.is_none() {
                exit_status = termination.exit_status;
            }
            if termination.error.is_some() {
                post_launch_errors.push("process final containment cleanup failed".to_owned());
            }
        }
    }
    let stderr_tail = request
        .stderr_tail
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .snapshot();
    let output = ProcessSessionOutput {
        launch_evidence: ProcessLaunchEvidence::MayHaveStarted,
        exit_code: exit_status.and_then(|status| status.code()),
        stderr_tail,
        cancelled,
        timed_out,
        cleanup,
        post_launch_error: super::io::join_errors(post_launch_errors),
    };
    request.completion.send_replace(Some(Arc::new(output)));
}

async fn drain_io_tasks(request: &mut SupervisorRequest, errors: &mut Vec<String>) -> bool {
    let deadline = Instant::now() + PROCESS_SESSION_DRAIN_TIMEOUT;
    let mut timed_out = false;
    timed_out |= drain_io_task(
        &mut request.stdout_task,
        deadline,
        "stdout task stopped unexpectedly",
        errors,
    )
    .await;
    timed_out |= drain_io_task(
        &mut request.stderr_task,
        deadline,
        "stderr task stopped unexpectedly",
        errors,
    )
    .await;
    timed_out |= drain_io_task(
        &mut request.writer_task,
        deadline,
        "stdin task stopped unexpectedly",
        errors,
    )
    .await;
    if timed_out {
        errors.push("process I/O drain timed out".to_owned());
    }
    timed_out
}

async fn drain_io_task(
    task: &mut JoinHandle<()>,
    deadline: Instant,
    failure: &'static str,
    errors: &mut Vec<String>,
) -> bool {
    match timeout_at(deadline, &mut *task).await {
        Ok(Ok(())) => false,
        Ok(Err(_)) => {
            errors.push(failure.to_owned());
            false
        }
        Err(_) => {
            task.abort();
            let _ = task.await;
            true
        }
    }
}

fn spawn_stdout_pump(
    stdout: Option<ChildStdout>,
    output: mpsc::Sender<ProcessOutputChunk>,
    failures: mpsc::UnboundedSender<IoFailure>,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        let Some(mut stdout) = stdout else {
            let _ = failures.send(IoFailure::Stdout);
            return;
        };
        let mut chunk = vec![0_u8; PROCESS_OUTPUT_CHUNK_BYTES];
        loop {
            match stdout.read(&mut chunk).await {
                Ok(0) => return,
                Ok(read) => {
                    if output
                        .send(ProcessOutputChunk(chunk[..read].to_vec()))
                        .await
                        .is_err()
                    {
                        let _ = failures.send(IoFailure::Stdout);
                        return;
                    }
                }
                Err(_) => {
                    let _ = failures.send(IoFailure::Stdout);
                    return;
                }
            }
        }
    })
}

fn spawn_stderr_pump(
    stderr: Option<ChildStderr>,
    tail: Arc<Mutex<TailBuffer>>,
    failures: mpsc::UnboundedSender<IoFailure>,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        let Some(stderr) = stderr else {
            let _ = failures.send(IoFailure::Stderr);
            return;
        };
        if read_stderr(stderr, tail).await.is_err() {
            let _ = failures.send(IoFailure::Stderr);
        }
    })
}

async fn read_stderr<R>(mut stderr: R, tail: Arc<Mutex<TailBuffer>>) -> Result<(), ()>
where
    R: AsyncRead + Unpin,
{
    let mut chunk = [0_u8; 8192];
    loop {
        let read = stderr.read(&mut chunk).await.map_err(|_| ())?;
        if read == 0 {
            return Ok(());
        }
        tail.lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .append(&chunk[..read]);
    }
}

fn spawn_writer(
    stdin: Option<ChildStdin>,
    mut commands: mpsc::Receiver<WriterCommand>,
    mut stop: watch::Receiver<bool>,
    failures: mpsc::UnboundedSender<IoFailure>,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        let Some(mut stdin) = stdin else {
            let _ = failures.send(IoFailure::Stdin);
            return;
        };
        loop {
            tokio::select! {
                biased;
                changed = stop.changed() => {
                    if changed.is_err() || *stop.borrow() {
                        return;
                    }
                }
                command = commands.recv() => {
                    match command {
                        Some(WriterCommand::Frame(frame, acknowledge)) => {
                            let result = tokio::select! {
                                biased;
                                changed = stop.changed() => {
                                    let _ = changed;
                                    Err("process stdin writer stopped")
                                }
                                result = stdin.write_all(&frame) => {
                                    result.map_err(|_| "process stdin write failed")
                                }
                            };
                            let failed = result.is_err();
                            let _ = acknowledge.send(result);
                            if failed {
                                let _ = failures.send(IoFailure::Stdin);
                                return;
                            }
                        }
                        Some(WriterCommand::Close(acknowledge)) => {
                            let result = stdin
                                .shutdown()
                                .await
                                .map_err(|_| "process stdin close failed");
                            let failed = result.is_err();
                            let _ = acknowledge.send(result);
                            if failed {
                                let _ = failures.send(IoFailure::Stdin);
                            }
                            return;
                        }
                        None => {
                            let _ = stdin.shutdown().await;
                            return;
                        }
                    }
                }
            }
        }
    })
}

fn io_failure_message(failure: IoFailure) -> &'static str {
    match failure {
        IoFailure::Stdout => "process stdout stream failed",
        IoFailure::Stderr => "process stderr stream failed",
        IoFailure::Stdin => "process stdin stream failed",
    }
}

struct TailBuffer {
    bytes: Vec<u8>,
    capacity: usize,
}

impl TailBuffer {
    fn new(capacity: usize) -> Self {
        Self {
            bytes: Vec::with_capacity(capacity),
            capacity,
        }
    }

    fn append(&mut self, value: &[u8]) {
        if value.len() >= self.capacity {
            self.bytes.clear();
            self.bytes
                .extend_from_slice(&value[value.len() - self.capacity..]);
            return;
        }
        let required = self.bytes.len() + value.len();
        if required > self.capacity {
            let discard = required - self.capacity;
            self.bytes.copy_within(discard.., 0);
            self.bytes.truncate(self.bytes.len() - discard);
        }
        self.bytes.extend_from_slice(value);
    }

    fn snapshot(&self) -> Vec<u8> {
        self.bytes.clone()
    }
}

struct SpawnRecovery {
    child: Option<Child>,
    process_tree: Option<ProcessTreeHandle>,
}

impl SpawnRecovery {
    const fn registered() -> Self {
        Self {
            child: None,
            process_tree: None,
        }
    }

    fn capture(&mut self, child: Child) {
        self.child = Some(child);
    }

    fn capture_process_tree(&mut self, process_tree: ProcessTreeHandle) {
        self.process_tree = Some(process_tree);
    }

    fn child_mut(&mut self) -> &mut Child {
        self.child.as_mut().expect("spawn recovery owns child")
    }

    async fn recover(mut self) {
        let Some(mut child) = self.child.take() else {
            return;
        };
        if let Some(process_tree) = self.process_tree.take() {
            let _ = terminate_process_tree(&process_tree, &mut child).await;
        } else {
            let _ = child.start_kill();
            let _ = child.wait().await;
        }
    }

    fn disarm(mut self) -> (Child, ProcessTreeHandle) {
        (
            self.child.take().expect("spawn recovery owns child"),
            self.process_tree
                .take()
                .expect("spawn recovery captured tree"),
        )
    }
}

impl Drop for SpawnRecovery {
    fn drop(&mut self) {
        let Some(mut child) = self.child.take() else {
            return;
        };
        let process_tree = self.process_tree.take();
        tokio::spawn(async move {
            if let Some(process_tree) = process_tree {
                let _ = terminate_process_tree(&process_tree, &mut child).await;
            } else {
                let _ = child.start_kill();
                let _ = child.wait().await;
            }
        });
    }
}
