use std::io;

use tokio::process::Command;
use tokio::time::{Duration, Instant, sleep, timeout_at};

const PROCESS_TREE_CLEANUP_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum ProcessCleanupEvidence {
    #[default]
    NotRequired,
    Reaped,
    TimedOut,
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

#[derive(Clone, Copy, Debug, Default)]
pub struct ProcessTreeHandle {
    #[cfg(unix)]
    process_group_id: Option<i32>,
}

pub fn capture_process_tree(child: &tokio::process::Child) -> ProcessTreeHandle {
    #[cfg(unix)]
    {
        ProcessTreeHandle {
            process_group_id: child.id().and_then(|value| i32::try_from(value).ok()),
        }
    }
    #[cfg(not(unix))]
    {
        let _ = child;
        ProcessTreeHandle
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
pub fn configure_process_group(command: &mut Command) {
    // Put the child in its own process group so timeout/cancel can reap descendants.
    unsafe {
        command.pre_exec(|| {
            if libc::setpgid(0, 0) == 0 {
                Ok(())
            } else {
                Err(io::Error::last_os_error())
            }
        });
    }
}

#[cfg(not(unix))]
pub fn configure_process_group(_command: &mut Command) {}

#[cfg(unix)]
fn kill_process_tree(handle: &ProcessTreeHandle, child: &mut tokio::process::Child) {
    let Some(process_group_id) = handle.process_group_id else {
        let _ = child.start_kill();
        return;
    };
    if let Err(error) = kill_process_group(process_group_id) {
        if error.raw_os_error() != Some(libc::ESRCH) {
            let _ = child.start_kill();
        }
    }
}

#[cfg(unix)]
fn kill_process_group(process_group_id: i32) -> Result<(), io::Error> {
    unsafe {
        if libc::killpg(process_group_id, libc::SIGKILL) == 0 {
            Ok(())
        } else {
            Err(io::Error::last_os_error())
        }
    }
}

#[cfg(not(unix))]
fn kill_process_tree(_handle: &ProcessTreeHandle, child: &mut tokio::process::Child) {
    let _ = child.start_kill();
}

#[cfg(unix)]
fn process_group_exists(process_group_id: i32) -> Result<bool, io::Error> {
    unsafe {
        if libc::killpg(process_group_id, 0) == 0 {
            Ok(true)
        } else {
            let error = io::Error::last_os_error();
            if error.raw_os_error() == Some(libc::ESRCH) {
                Ok(false)
            } else {
                Err(error)
            }
        }
    }
}

#[cfg(unix)]
async fn await_group_exit(handle: &ProcessTreeHandle, deadline: Instant) -> CleanupOutcome {
    let Some(process_group_id) = handle.process_group_id else {
        return CleanupOutcome {
            cleanup: ProcessCleanupEvidence::Reaped,
            error: None,
        };
    };
    await_process_group_exit(process_group_id, deadline).await
}

#[cfg(not(unix))]
async fn await_group_exit(_handle: &ProcessTreeHandle, _deadline: Instant) -> CleanupOutcome {
    CleanupOutcome {
        cleanup: ProcessCleanupEvidence::Reaped,
        error: None,
    }
}

#[cfg(unix)]
async fn await_process_group_exit(process_group_id: i32, deadline: Instant) -> CleanupOutcome {
    loop {
        match process_group_has_live_members(process_group_id) {
            Ok(false) => {
                return CleanupOutcome {
                    cleanup: ProcessCleanupEvidence::Reaped,
                    error: None,
                };
            }
            Ok(true) => {}
            Err(error) => {
                return CleanupOutcome {
                    cleanup: ProcessCleanupEvidence::TimedOut,
                    error: Some(format!("process cleanup failed: {error}")),
                };
            }
        }
        if Instant::now() >= deadline {
            return CleanupOutcome {
                cleanup: ProcessCleanupEvidence::TimedOut,
                error: Some("process cleanup timed out".to_owned()),
            };
        }
        sleep(Duration::from_millis(10)).await;
    }
}

#[cfg(unix)]
fn process_group_has_live_members(process_group_id: i32) -> Result<bool, io::Error> {
    let output = std::process::Command::new("ps")
        .args(["-o", "state=", "-g", &process_group_id.to_string()])
        .output()?;
    if !output.status.success() {
        return process_group_exists(process_group_id);
    }
    Ok(String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .filter(|state| !state.is_empty())
        .any(|state| !state.starts_with('Z')))
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
