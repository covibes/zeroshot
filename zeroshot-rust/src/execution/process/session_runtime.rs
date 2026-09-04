use std::sync::{Arc, Mutex};

use tokio::process::Child;
use tokio::sync::{mpsc, watch};
use tokio::task::JoinHandle;
use tokio::time::{Duration, Instant, sleep_until, timeout, timeout_at};

use crate::execution::driver::DriverCancellation;
use super::platform::{ProcessTreeHandle, process_tree_has_live_members, terminate_process_tree};
use super::session::ProcessSessionOutput;
use super::session_io::IoFailure;
use super::tail_buffer::TailBuffer;
use super::{
    PROCESS_FORCED_IO_DRAIN_TIMEOUT, PROCESS_RELEASE_WAIT_TIMEOUT, ProcessCleanupEvidence,
    ProcessLaunchEvidence, io_error_detail,
};

const PROCESS_IO_DRAIN_TIMEOUT: Duration = Duration::from_secs(10 * 60);

pub(super) struct SupervisorRequest {
    pub child: Child,
    pub process_tree: ProcessTreeHandle,
    pub cancellation: DriverCancellation,
    pub deadline: Instant,
    pub release: watch::Receiver<bool>,
    pub writer_stop: watch::Sender<bool>,
    pub io_failures: mpsc::UnboundedReceiver<IoFailure>,
    pub stdout_task: Option<JoinHandle<()>>,
    pub stderr_task: Option<JoinHandle<()>>,
    pub writer_task: Option<JoinHandle<()>>,
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
            Err(error) => self
                .errors
                .push(io_error_detail("process child wait failed", &error)),
        }
    }

    async fn terminate(&mut self, request: &mut SupervisorRequest, failure: &'static str) {
        let termination = terminate_process_tree(&request.process_tree, &mut request.child).await;
        self.cleanup = termination.cleanup;
        if self.exit_status.is_none() {
            self.exit_status = termination.exit_status;
        }
        if let Some(error) = termination.error {
            self.errors.push(format!("{failure}: {error}"));
        }
    }

    async fn release(&mut self, request: &mut SupervisorRequest) {
        request.writer_stop.send_replace(true);
        match timeout(PROCESS_RELEASE_WAIT_TIMEOUT, request.child.wait()).await {
            Ok(Ok(status)) => self.exit_status = Some(status),
            Ok(Err(error)) => self
                .errors
                .push(io_error_detail("process release wait failed", &error)),
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
    state.errors.push(failure.into_detail());
    state.terminate(request, "process I/O cleanup failed").await;
    true
}

async fn finish_supervision(request: &mut SupervisorRequest, state: &mut SessionState) {
    request.writer_stop.send_replace(true);
    let drain_timed_out = drain_io_tasks(request, state).await;
    drain_io_failures(
        &mut request.io_failures,
        &mut state.errors,
        *request.release.borrow(),
    );
    ensure_containment(request, state, drain_timed_out).await;
    let stderr_tail = request
        .stderr_tail
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .snapshot();
    let (exit_code, termination_signal, core_dumped) =
        exit_status_detail(state.exit_status.as_ref());
    let output = ProcessSessionOutput {
        launch_evidence: ProcessLaunchEvidence::MayHaveStarted,
        exit_code,
        termination_signal,
        core_dumped,
        stderr_tail: stderr_tail.bytes,
        stderr_tail_truncated: stderr_tail.truncated,
        cancelled: state.cancelled,
        timed_out: state.timed_out,
        cleanup: state.cleanup,
        post_launch_error: join_errors(std::mem::take(&mut state.errors)),
    };
    request.completion.send_replace(Some(Arc::new(output)));
}

fn drain_io_failures(
    failures: &mut mpsc::UnboundedReceiver<IoFailure>,
    errors: &mut Vec<String>,
    releasing: bool,
) {
    while let Ok(failure) = failures.try_recv() {
        if failure.should_report(releasing) {
            errors.push(failure.into_detail());
        }
    }
}

#[cfg(unix)]
fn exit_status_detail(
    status: Option<&std::process::ExitStatus>,
) -> (Option<i32>, Option<i32>, bool) {
    use std::os::unix::process::ExitStatusExt as _;

    status.map_or((None, None, false), |status| {
        (status.code(), status.signal(), status.core_dumped())
    })
}

#[cfg(not(unix))]
fn exit_status_detail(
    status: Option<&std::process::ExitStatus>,
) -> (Option<i32>, Option<i32>, bool) {
    (status.and_then(std::process::ExitStatus::code), None, false)
}

fn join_errors(errors: Vec<String>) -> Option<String> {
    (!errors.is_empty()).then(|| errors.join("; "))
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
        Err(error) => {
            errors.push(io_error_detail(
                "process containment inspection failed",
                &error,
            ));
            true
        }
    }
}

async fn drain_io_tasks(request: &mut SupervisorRequest, state: &mut SessionState) -> bool {
    let forced = state.cancelled || state.timed_out || *request.release.borrow();
    if forced {
        return drain_io_tasks_until(
            request,
            &mut state.errors,
            Instant::now() + PROCESS_FORCED_IO_DRAIN_TIMEOUT,
        )
        .await;
    }

    let io_cap = Instant::now() + PROCESS_IO_DRAIN_TIMEOUT;
    let command_deadline_wins = request.deadline <= io_cap;
    let drain_deadline = std::cmp::min(request.deadline, io_cap);
    let mut cancellation = request.cancellation.clone();
    let mut release = request.release.clone();
    enum DrainResult {
        Complete(bool),
        Cancelled,
        Released,
    }
    let result = {
        let drain = drain_io_tasks_until(request, &mut state.errors, drain_deadline);
        tokio::pin!(drain);
        tokio::select! {
            biased;
            _ = cancellation.cancelled() => DrainResult::Cancelled,
            _ = release.changed() => DrainResult::Released,
            result = &mut drain => DrainResult::Complete(result),
        }
    };
    match result {
        DrainResult::Complete(timed_out) => {
            state.timed_out |= timed_out && command_deadline_wins;
            timed_out
        }
        DrainResult::Cancelled => {
            state.cancelled = true;
            drain_io_tasks_until(
                request,
                &mut state.errors,
                Instant::now() + PROCESS_FORCED_IO_DRAIN_TIMEOUT,
            )
            .await
        }
        DrainResult::Released => {
            drain_io_tasks_until(
                request,
                &mut state.errors,
                Instant::now() + PROCESS_FORCED_IO_DRAIN_TIMEOUT,
            )
            .await
        }
    }
}

async fn drain_io_tasks_until(
    request: &mut SupervisorRequest,
    errors: &mut Vec<String>,
    deadline: Instant,
) -> bool {
    let stdout = drain_io_task(
        &mut request.stdout_task,
        deadline,
        "process stdout task failed",
        errors,
    )
    .await;
    let stderr = drain_io_task(
        &mut request.stderr_task,
        deadline,
        "process stderr task failed",
        errors,
    )
    .await;
    let writer = drain_io_task(
        &mut request.writer_task,
        deadline,
        "process stdin task failed",
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
    task: &mut Option<JoinHandle<()>>,
    deadline: Instant,
    operation: &'static str,
    errors: &mut Vec<String>,
) -> bool {
    let Some(handle) = task.as_mut() else {
        return false;
    };
    let result = timeout_at(deadline, handle).await;
    match result {
        Ok(joined) => {
            task.take();
            if let Err(error) = joined {
                errors.push(super::diagnostic::task_join_detail(operation, &error));
            }
            false
        }
        Err(_) => {
            if let Some(handle) = task.take() {
                handle.abort();
                let _ = handle.await;
            }
            true
        }
    }
}

#[cfg(test)]
#[path = "session_runtime/tests.rs"]
mod tests;
