use std::sync::{Arc, Mutex};

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::process::{Child, ChildStderr, ChildStdin, ChildStdout};
use tokio::sync::{mpsc, oneshot, watch};
use tokio::task::JoinHandle;
use tokio::time::{Duration, Instant, sleep_until, timeout, timeout_at};

use crate::execution::driver::DriverCancellation;
use super::platform::{ProcessTreeHandle, process_tree_has_live_members, terminate_process_tree};
use super::session::{ProcessOutputChunk, ProcessSessionOutput};
use super::{ProcessCleanupEvidence, ProcessLaunchEvidence};

const PROCESS_OUTPUT_CHUNK_BYTES: usize = 64 * 1024;
const PROCESS_SESSION_DRAIN_TIMEOUT: Duration = Duration::from_secs(1);

pub(super) enum WriterCommand {
    Frame(Vec<u8>, oneshot::Sender<Result<(), &'static str>>),
    Close(oneshot::Sender<Result<(), &'static str>>),
}

#[derive(Clone, Copy)]
pub(super) enum IoFailure {
    Stdout,
    Stderr,
    Stdin,
}

pub(super) struct SupervisorRequest {
    pub child: Child,
    pub process_tree: ProcessTreeHandle,
    pub cancellation: DriverCancellation,
    pub deadline: Instant,
    pub release: watch::Receiver<bool>,
    pub writer_stop: watch::Sender<bool>,
    pub io_failures: mpsc::UnboundedReceiver<IoFailure>,
    pub stdout_task: JoinHandle<()>,
    pub stderr_task: JoinHandle<()>,
    pub writer_task: JoinHandle<()>,
    pub stderr_tail: Arc<Mutex<TailBuffer>>,
    pub completion: watch::Sender<Option<Arc<ProcessSessionOutput>>>,
}

#[derive(Default)]
struct SessionState {
    cancelled: bool,
    timed_out: bool,
    cleanup: ProcessCleanupEvidence,
    errors: Vec<String>,
    exit_status: Option<std::process::ExitStatus>,
}

impl SessionState {
    fn record_wait(&mut self, status: Result<std::process::ExitStatus, std::io::Error>) {
        match status {
            Ok(status) => self.exit_status = Some(status),
            Err(_) => self.errors.push("process wait failed".to_owned()),
        }
    }

    async fn terminate(&mut self, request: &mut SupervisorRequest, failure: &'static str) {
        let termination = terminate_process_tree(&request.process_tree, &mut request.child).await;
        self.cleanup = termination.cleanup;
        if self.exit_status.is_none() {
            self.exit_status = termination.exit_status;
        }
        if termination.error.is_some() {
            self.errors.push(failure.to_owned());
        }
    }

    async fn release(&mut self, request: &mut SupervisorRequest) {
        request.writer_stop.send_replace(true);
        match timeout(PROCESS_SESSION_DRAIN_TIMEOUT, request.child.wait()).await {
            Ok(Ok(status)) => self.exit_status = Some(status),
            Ok(Err(_)) => self
                .errors
                .push("process wait failed during release".to_owned()),
            Err(_) => {
                self.terminate(request, "process release cleanup failed")
                    .await;
            }
        }
    }
}

pub(super) async fn supervise_session(mut request: SupervisorRequest) {
    let mut state = SessionState::default();
    let deadline = sleep_until(request.deadline);
    tokio::pin!(deadline);
    loop {
        tokio::select! {
            biased;
            status = request.child.wait() => {
                state.record_wait(status);
                break;
            }
            _ = request.cancellation.cancelled() => {
                state.cancelled = true;
                state.terminate(&mut request, "process cancellation cleanup failed").await;
                break;
            }
            _ = &mut deadline => {
                state.timed_out = true;
                state.terminate(&mut request, "process deadline cleanup failed").await;
                break;
            }
            changed = request.release.changed() => {
                if release_requested(changed, &request.release) {
                    state.release(&mut request).await;
                    break;
                }
            }
            failure = request.io_failures.recv() => {
                if handle_io_failure(failure, &mut request, &mut state).await {
                    break;
                }
            }
        }
    }
    finish_supervision(&mut request, &mut state).await;
}

fn release_requested(
    changed: Result<(), watch::error::RecvError>,
    release: &watch::Receiver<bool>,
) -> bool {
    changed.is_err() || *release.borrow()
}

async fn handle_io_failure(
    failure: Option<IoFailure>,
    request: &mut SupervisorRequest,
    state: &mut SessionState,
) -> bool {
    let Some(failure) = failure else {
        return false;
    };
    state.errors.push(io_failure_message(failure).to_owned());
    state.terminate(request, "process I/O cleanup failed").await;
    true
}

async fn finish_supervision(request: &mut SupervisorRequest, state: &mut SessionState) {
    request.writer_stop.send_replace(true);
    let drain_timed_out = drain_io_tasks(request, &mut state.errors).await;
    ensure_containment(request, state, drain_timed_out).await;
    let stderr_tail = request
        .stderr_tail
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .snapshot();
    let output = ProcessSessionOutput {
        launch_evidence: ProcessLaunchEvidence::MayHaveStarted,
        exit_code: state.exit_status.and_then(|status| status.code()),
        stderr_tail,
        cancelled: state.cancelled,
        timed_out: state.timed_out,
        cleanup: state.cleanup,
        post_launch_error: super::io::join_errors(std::mem::take(&mut state.errors)),
    };
    request.completion.send_replace(Some(Arc::new(output)));
}

async fn ensure_containment(
    request: &mut SupervisorRequest,
    state: &mut SessionState,
    drain_timed_out: bool,
) {
    if state.cleanup != ProcessCleanupEvidence::NotRequired {
        return;
    }
    let tree_has_live_members = inspect_tree(&request.process_tree, &mut state.errors);
    if drain_timed_out || tree_has_live_members {
        state
            .terminate(request, "process final containment cleanup failed")
            .await;
    } else if request.process_tree.requires_explicit_cleanup_evidence() {
        state.cleanup = ProcessCleanupEvidence::Reaped;
    }
}

fn inspect_tree(process_tree: &ProcessTreeHandle, errors: &mut Vec<String>) -> bool {
    match process_tree_has_live_members(process_tree) {
        Ok(has_live_members) => has_live_members,
        Err(_) => {
            errors.push("process containment inspection failed".to_owned());
            true
        }
    }
}

async fn drain_io_tasks(request: &mut SupervisorRequest, errors: &mut Vec<String>) -> bool {
    let deadline = Instant::now() + PROCESS_SESSION_DRAIN_TIMEOUT;
    let stdout = drain_io_task(
        &mut request.stdout_task,
        deadline,
        "stdout task stopped unexpectedly",
        errors,
    )
    .await;
    let stderr = drain_io_task(
        &mut request.stderr_task,
        deadline,
        "stderr task stopped unexpectedly",
        errors,
    )
    .await;
    let writer = drain_io_task(
        &mut request.writer_task,
        deadline,
        "stdin task stopped unexpectedly",
        errors,
    )
    .await;
    let timed_out = stdout || stderr || writer;
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

pub(super) fn spawn_stdout_pump(
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
                        .send(ProcessOutputChunk::from_bytes(chunk[..read].to_vec()))
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

pub(super) fn spawn_stderr_pump(
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

pub(super) fn spawn_writer(
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

pub(super) struct TailBuffer {
    bytes: Vec<u8>,
    capacity: usize,
}

impl TailBuffer {
    pub(super) fn new(capacity: usize) -> Self {
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
