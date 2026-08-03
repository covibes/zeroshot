use std::io;

use tokio::process::Command;
use tokio::time::{Duration, Instant, sleep, timeout_at};

const PROCESS_TREE_CLEANUP_TIMEOUT: Duration = Duration::from_secs(5);
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProcessContainment {
    ProcessGroup,
    #[cfg(target_os = "linux")]
    WorkerUid {
        uid: u32,
        gid: u32,
    },
}

impl ProcessContainment {
    #[cfg(unix)]
    #[must_use]
    const fn worker_uid(self) -> Option<u32> {
        #[cfg(target_os = "linux")]
        if let Self::WorkerUid { uid, .. } = self {
            return Some(uid);
        }
        None
    }

    #[cfg(unix)]
    #[must_use]
    const fn worker_identity(self) -> Option<(u32, u32)> {
        #[cfg(target_os = "linux")]
        if let Self::WorkerUid { uid, gid } = self {
            return Some((uid, gid));
        }
        None
    }
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum ProcessCleanupEvidence {
    #[default]
    NotRequired,
    Reaped,
    TimedOut,
}

impl ProcessCleanupEvidence {
    #[must_use]
    pub const fn proves_tree_empty(self) -> bool {
        matches!(self, Self::NotRequired | Self::Reaped)
    }
}

pub struct TerminationOutcome {
    pub exit_status: Option<std::process::ExitStatus>,
    pub cleanup: ProcessCleanupEvidence,
    pub error: Option<String>,
}

pub struct CleanupOutcome {
    pub cleanup: ProcessCleanupEvidence,
    pub error: Option<String>,
}

pub struct ProcessTreeRegistration {
    #[cfg(windows)]
    job: Option<usize>,
    #[cfg(target_os = "linux")]
    worker_uid: Option<u32>,
}

impl ProcessTreeRegistration {
    #[cfg(windows)]
    fn take_job(&mut self) -> usize {
        self.job.take().expect("process job is registered")
    }
}

#[cfg(windows)]
impl Drop for ProcessTreeRegistration {
    fn drop(&mut self) {
        if let Some(job) = self.job.take() {
            super::platform_windows::close_job(job);
        }
    }
}

#[derive(Debug)]
pub struct ProcessTreeHandle {
    #[cfg(unix)]
    process_group_id: Option<i32>,
    #[cfg(target_os = "linux")]
    worker_uid: Option<u32>,

    #[cfg(windows)]
    job: usize,
}
impl ProcessTreeHandle {
    #[must_use]
    pub const fn requires_explicit_cleanup_evidence(&self) -> bool {
        #[cfg(target_os = "linux")]
        {
            self.worker_uid.is_some()
        }
        #[cfg(not(target_os = "linux"))]
        {
            false
        }
    }
}

#[cfg(windows)]
impl Drop for ProcessTreeHandle {
    fn drop(&mut self) {
        super::platform_windows::close_job(self.job);
    }
}

pub fn register_process_tree_for(
    containment: ProcessContainment,
) -> Result<ProcessTreeRegistration, io::Error> {
    #[cfg(unix)]
    super::platform_unix::register_process_tree(containment.worker_uid())?;
    #[cfg(not(unix))]
    let _ = containment;
    #[cfg(windows)]
    {
        return Ok(ProcessTreeRegistration {
            job: Some(super::platform_windows::create_kill_on_close_job()?),
        });
    }
    #[cfg(not(windows))]
    {
        Ok(ProcessTreeRegistration {
            #[cfg(target_os = "linux")]
            worker_uid: containment.worker_uid(),
        })
    }
}

pub fn capture_process_tree(
    registration: ProcessTreeRegistration,
    child: &mut tokio::process::Child,
) -> Result<ProcessTreeHandle, io::Error> {
    #[cfg(unix)]
    {
        #[cfg(not(target_os = "linux"))]
        let _ = registration;
        Ok(ProcessTreeHandle {
            process_group_id: child.id().and_then(|value| i32::try_from(value).ok()),
            #[cfg(target_os = "linux")]
            worker_uid: registration.worker_uid,
        })
    }

    #[cfg(windows)]
    {
        let mut registration = registration;
        let job = registration.job.expect("process job is registered");
        super::platform_windows::assign_process_tree(job, child)?;
        Ok(ProcessTreeHandle {
            job: registration.take_job(),
        })
    }
    #[cfg(all(not(unix), not(windows)))]
    {
        let _ = registration;
        let _ = child;
        Ok(ProcessTreeHandle {})
    }
}

pub async fn terminate_process_tree(
    handle: &ProcessTreeHandle,
    child: &mut tokio::process::Child,
) -> TerminationOutcome {
    kill_process_tree(handle, child);
    let cleanup_deadline = Instant::now() + PROCESS_TREE_CLEANUP_TIMEOUT;
    match timeout_at(cleanup_deadline, child.wait()).await {
        Ok(Ok(status)) => {
            let cleanup = await_group_exit(handle, cleanup_deadline).await;
            TerminationOutcome {
                exit_status: Some(status),
                cleanup: cleanup.cleanup,
                error: cleanup.error,
            }
        }
        Ok(Err(error)) => termination_without_status(handle, cleanup_deadline, Some(error)).await,
        Err(_) => termination_without_status(handle, cleanup_deadline, None).await,
    }
}

#[cfg(unix)]
pub fn configure_process(command: &mut Command, containment: ProcessContainment) {
    super::platform_unix::configure_process(command, containment.worker_identity());
}
#[cfg(windows)]
pub fn configure_process(command: &mut Command, _containment: ProcessContainment) {
    super::platform_windows::configure_process_group(command);
}

#[cfg(all(not(unix), not(windows)))]
pub fn configure_process(_command: &mut Command, _containment: ProcessContainment) {}

#[cfg(unix)]
fn kill_process_tree(handle: &ProcessTreeHandle, child: &mut tokio::process::Child) {
    super::platform_unix::kill_process_tree(
        handle.process_group_id,
        {
            #[cfg(target_os = "linux")]
            {
                handle.worker_uid
            }
            #[cfg(not(target_os = "linux"))]
            {
                None
            }
        },
        child,
    );
}

#[cfg(windows)]
fn kill_process_tree(handle: &ProcessTreeHandle, child: &mut tokio::process::Child) {
    super::platform_windows::kill_process_tree(handle.job, child);
}

#[cfg(all(not(unix), not(windows)))]
fn kill_process_tree(_handle: &ProcessTreeHandle, child: &mut tokio::process::Child) {
    let _ = child.start_kill();
}

pub fn process_tree_has_live_members(handle: &ProcessTreeHandle) -> Result<bool, io::Error> {
    #[cfg(unix)]
    {
        #[cfg(target_os = "linux")]
        if let Some(worker_uid) = handle.worker_uid {
            return super::platform_unix::worker_uid_has_live_members(worker_uid);
        }
        let Some(process_group_id) = handle.process_group_id else {
            return Ok(false);
        };
        super::platform_unix::process_group_has_live_members(process_group_id)
    }

    #[cfg(windows)]
    {
        super::platform_windows::job_has_live_members(handle.job)
    }
    #[cfg(all(not(unix), not(windows)))]
    {
        let _ = handle;
        Ok(false)
    }
}

#[cfg(unix)]
async fn await_group_exit(handle: &ProcessTreeHandle, deadline: Instant) -> CleanupOutcome {
    #[cfg(target_os = "linux")]
    if let Some(worker_uid) = handle.worker_uid {
        return await_worker_uid_exit(worker_uid, deadline).await;
    }
    let Some(process_group_id) = handle.process_group_id else {
        return CleanupOutcome {
            cleanup: ProcessCleanupEvidence::Reaped,
            error: None,
        };
    };
    await_process_group_exit(process_group_id, deadline).await
}

#[cfg(windows)]
async fn await_group_exit(handle: &ProcessTreeHandle, deadline: Instant) -> CleanupOutcome {
    await_process_tree_exit(handle, deadline).await
}

#[cfg(all(not(unix), not(windows)))]
async fn await_group_exit(_handle: &ProcessTreeHandle, _deadline: Instant) -> CleanupOutcome {
    CleanupOutcome {
        cleanup: ProcessCleanupEvidence::Reaped,
        error: None,
    }
}

#[cfg(unix)]
async fn await_process_group_exit(process_group_id: i32, deadline: Instant) -> CleanupOutcome {
    loop {
        #[cfg(target_os = "linux")]
        if let Err(error) = super::platform_unix::reap_process_group_children(process_group_id) {
            return cleanup_failure(error);
        }
        match super::platform_unix::process_group_has_live_members(process_group_id) {
            Ok(false) => {
                return CleanupOutcome {
                    cleanup: ProcessCleanupEvidence::Reaped,
                    error: None,
                };
            }
            Ok(true) => {}
            Err(error) => return cleanup_failure(error),
        }
        if Instant::now() >= deadline {
            return cleanup_timeout();
        }
        sleep(Duration::from_millis(10)).await;
    }
}
#[cfg(target_os = "linux")]
async fn await_worker_uid_exit(worker_uid: u32, deadline: Instant) -> CleanupOutcome {
    loop {
        match super::platform_unix::reap_and_kill_worker_uid_processes(worker_uid) {
            Ok(false) => {
                return CleanupOutcome {
                    cleanup: ProcessCleanupEvidence::Reaped,
                    error: None,
                };
            }
            Ok(true) => {}
            Err(error) => return cleanup_failure(error),
        }
        if Instant::now() >= deadline {
            return cleanup_timeout();
        }
        sleep(Duration::from_millis(10)).await;
    }
}

#[cfg(windows)]
async fn await_process_tree_exit(handle: &ProcessTreeHandle, deadline: Instant) -> CleanupOutcome {
    loop {
        match process_tree_has_live_members(handle) {
            Ok(false) => {
                return CleanupOutcome {
                    cleanup: ProcessCleanupEvidence::Reaped,
                    error: None,
                };
            }
            Ok(true) => {}
            Err(error) => return cleanup_failure(error),
        }
        if Instant::now() >= deadline {
            return cleanup_timeout();
        }
        sleep(Duration::from_millis(10)).await;
    }
}

fn cleanup_failure(error: io::Error) -> CleanupOutcome {
    CleanupOutcome {
        cleanup: ProcessCleanupEvidence::TimedOut,
        error: Some(format!("process cleanup failed: {error}")),
    }
}

fn cleanup_timeout() -> CleanupOutcome {
    CleanupOutcome {
        cleanup: ProcessCleanupEvidence::TimedOut,
        error: Some("process cleanup timed out".to_owned()),
    }
}

async fn termination_without_status(
    handle: &ProcessTreeHandle,
    cleanup_deadline: Instant,
    wait_error: Option<io::Error>,
) -> TerminationOutcome {
    let cleanup = await_group_exit(handle, cleanup_deadline).await;
    let error = match (wait_error, cleanup.error) {
        (Some(wait_error), Some(cleanup_error)) => Some(format!(
            "process cleanup wait failed: {wait_error}; {cleanup_error}"
        )),
        (Some(wait_error), None) => Some(format!("process cleanup wait failed: {wait_error}")),
        (None, Some(cleanup_error)) => Some(cleanup_error),
        (None, None) => Some("process cleanup timed out".to_owned()),
    };
    TerminationOutcome {
        exit_status: None,
        cleanup: cleanup.cleanup,
        error,
    }
}
