use std::io;

use tokio::process::Command;
use tokio::time::{Duration, Instant, sleep, timeout_at};

#[cfg(windows)]
use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE};
#[cfg(windows)]
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, TH32CS_SNAPTHREAD, THREADENTRY32, Thread32First, Thread32Next,
};
#[cfg(windows)]
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JobObjectBasicAccountingInformation, JobObjectExtendedLimitInformation,
    QueryInformationJobObject, SetInformationJobObject, TerminateJobObject,
};
#[cfg(windows)]
use windows_sys::Win32::System::Threading::{
    CREATE_SUSPENDED, OpenThread, ResumeThread, THREAD_SUSPEND_RESUME,
};

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

pub struct ProcessTreeRegistration {
    #[cfg(windows)]
    job: Option<usize>,
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
            close_job(job);
        }
    }
}

#[derive(Debug)]
pub struct ProcessTreeHandle {
    #[cfg(unix)]
    process_group_id: Option<i32>,
    #[cfg(windows)]
    job: usize,
}

#[cfg(windows)]
impl Drop for ProcessTreeHandle {
    fn drop(&mut self) {
        close_job(self.job);
    }
}

pub fn register_process_tree() -> Result<ProcessTreeRegistration, io::Error> {
    #[cfg(windows)]
    {
        return Ok(ProcessTreeRegistration {
            job: Some(create_kill_on_close_job()?),
        });
    }
    #[cfg(not(windows))]
    {
        Ok(ProcessTreeRegistration {})
    }
}

pub fn capture_process_tree(
    registration: ProcessTreeRegistration,
    child: &mut tokio::process::Child,
) -> Result<ProcessTreeHandle, io::Error> {
    #[cfg(unix)]
    {
        let _ = registration;
        Ok(ProcessTreeHandle {
            process_group_id: child.id().and_then(|value| i32::try_from(value).ok()),
        })
    }
    #[cfg(windows)]
    {
        let mut registration = registration;
        let process = child
            .raw_handle()
            .ok_or_else(|| io::Error::other("spawned process handle is unavailable"))?;
        let process_id = child
            .id()
            .ok_or_else(|| io::Error::other("spawned process id is unavailable"))?;
        let job = registration.job.expect("process job is registered");
        let mut calls = SystemWindowsContainmentCalls {
            job,
            process: process as HANDLE,
            process_id,
            child,
        };
        assign_suspended_process(&mut calls)?;
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

#[cfg(windows)]
trait WindowsContainmentCalls {
    fn assign(&mut self) -> Result<(), io::Error>;
    fn resume(&mut self) -> Result<(), io::Error>;
    fn terminate_failed_capture(&mut self);
}

#[cfg(windows)]
fn assign_suspended_process(calls: &mut impl WindowsContainmentCalls) -> Result<(), io::Error> {
    if let Err(error) = calls.assign() {
        calls.terminate_failed_capture();
        return Err(error);
    }
    if let Err(error) = calls.resume() {
        calls.terminate_failed_capture();
        return Err(error);
    }
    Ok(())
}

#[cfg(windows)]
struct SystemWindowsContainmentCalls<'a> {
    job: usize,
    process: HANDLE,
    process_id: u32,
    child: &'a mut tokio::process::Child,
}

#[cfg(all(test, windows))]
static WINDOWS_TEST_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
#[cfg(all(test, windows))]
static INJECT_ASSIGN_FAILURE: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);
#[cfg(all(test, windows))]
static INJECT_RESUME_FAILURE: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);
#[cfg(all(test, windows))]
static JOB_CLOSE_COUNT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

#[cfg(windows)]
impl WindowsContainmentCalls for SystemWindowsContainmentCalls<'_> {
    fn assign(&mut self) -> Result<(), io::Error> {
        #[cfg(all(test, windows))]
        if INJECT_ASSIGN_FAILURE.swap(false, std::sync::atomic::Ordering::SeqCst) {
            return Err(io::Error::other("injected assignment failure"));
        }
        let assigned = unsafe { AssignProcessToJobObject(self.job as HANDLE, self.process) };
        if assigned == 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(())
        }
    }

    fn resume(&mut self) -> Result<(), io::Error> {
        #[cfg(all(test, windows))]
        if INJECT_RESUME_FAILURE.swap(false, std::sync::atomic::Ordering::SeqCst) {
            return Err(io::Error::other("injected resume failure"));
        }
        resume_suspended_process(self.process_id)
    }

    fn terminate_failed_capture(&mut self) {
        unsafe {
            TerminateJobObject(self.job as HANDLE, 1);
        }
        let _ = self.child.start_kill();
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

#[cfg(windows)]
pub fn configure_process_group(command: &mut Command) {
    command.creation_flags(CREATE_SUSPENDED);
}

#[cfg(all(not(unix), not(windows)))]
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

#[cfg(windows)]
fn kill_process_tree(handle: &ProcessTreeHandle, child: &mut tokio::process::Child) {
    let terminated = unsafe { TerminateJobObject(handle.job as HANDLE, 1) };
    if terminated == 0 {
        let _ = child.start_kill();
    }
}

#[cfg(all(not(unix), not(windows)))]
fn kill_process_tree(_handle: &ProcessTreeHandle, child: &mut tokio::process::Child) {
    let _ = child.start_kill();
}

pub fn process_tree_has_live_members(handle: &ProcessTreeHandle) -> Result<bool, io::Error> {
    #[cfg(unix)]
    {
        let Some(process_group_id) = handle.process_group_id else {
            return Ok(false);
        };
        process_group_has_live_members(process_group_id)
    }
    #[cfg(windows)]
    {
        windows_job_has_live_members(handle.job)
    }
    #[cfg(all(not(unix), not(windows)))]
    {
        let _ = handle;
        Ok(false)
    }
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
        match process_group_has_live_members(process_group_id) {
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

#[cfg(windows)]
fn resume_suspended_process(process_id: u32) -> Result<(), io::Error> {
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    let mut entry = THREADENTRY32 {
        dwSize: u32::try_from(std::mem::size_of::<THREADENTRY32>())
            .expect("thread entry fits in u32"),
        ..THREADENTRY32::default()
    };
    let mut has_entry = unsafe { Thread32First(snapshot, &mut entry) } != 0;
    while has_entry {
        if entry.th32OwnerProcessID == process_id {
            let thread = unsafe { OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID) };
            if thread.is_null() {
                let error = io::Error::last_os_error();
                unsafe {
                    CloseHandle(snapshot);
                }
                return Err(error);
            }
            let resumed = unsafe { ResumeThread(thread) };
            unsafe {
                CloseHandle(thread);
                CloseHandle(snapshot);
            }
            return if resumed == u32::MAX {
                Err(io::Error::last_os_error())
            } else {
                Ok(())
            };
        }
        has_entry = unsafe { Thread32Next(snapshot, &mut entry) } != 0;
    }
    unsafe {
        CloseHandle(snapshot);
    }
    Err(io::Error::other(
        "spawned process suspended thread is unavailable",
    ))
}

#[cfg(windows)]
fn create_kill_on_close_job() -> Result<usize, io::Error> {
    let job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
    if job.is_null() {
        return Err(io::Error::last_os_error());
    }
    let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    let configured = unsafe {
        SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            std::ptr::from_ref(&limits).cast(),
            u32::try_from(std::mem::size_of_val(&limits)).expect("job limits fit in u32"),
        )
    };
    if configured == 0 {
        let error = io::Error::last_os_error();
        unsafe {
            CloseHandle(job);
        }
        return Err(error);
    }
    Ok(job as usize)
}

#[cfg(windows)]
fn windows_job_has_live_members(job: usize) -> Result<bool, io::Error> {
    let mut accounting = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
    let queried = unsafe {
        QueryInformationJobObject(
            job as HANDLE,
            JobObjectBasicAccountingInformation,
            std::ptr::from_mut(&mut accounting).cast(),
            u32::try_from(std::mem::size_of_val(&accounting)).expect("job accounting fits in u32"),
            std::ptr::null_mut(),
        )
    };
    if queried == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(accounting.ActiveProcesses != 0)
    }
}

#[cfg(windows)]
fn close_job(job: usize) {
    #[cfg(all(test, windows))]
    JOB_CLOSE_COUNT.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    unsafe {
        CloseHandle(job as HANDLE);
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

#[cfg(all(test, windows))]
mod windows_containment_tests {
    use std::path::PathBuf;
    use std::process::Stdio;
    use std::sync::atomic::Ordering;

    use tokio::time::{Duration, Instant, timeout};

    use super::{
        INJECT_ASSIGN_FAILURE, INJECT_RESUME_FAILURE, JOB_CLOSE_COUNT, ProcessCleanupEvidence,
        WINDOWS_TEST_LOCK, capture_process_tree, configure_process_group, register_process_tree,
        terminate_process_tree,
    };

    fn spawn_suspended_sentinel(
        name: &str,
    ) -> (
        super::ProcessTreeRegistration,
        tokio::process::Child,
        PathBuf,
    ) {
        let registration = register_process_tree().unwrap();
        let system_root = std::env::var("SystemRoot").expect("Windows has SystemRoot");
        let program = PathBuf::from(&system_root).join("System32").join("cmd.exe");
        let sentinel = std::env::temp_dir().join(format!("{name}-{}.txt", std::process::id()));
        let _ = std::fs::remove_file(&sentinel);
        let script = format!(
            "echo first>\"{}\" & ping -n 31 127.0.0.1 >NUL",
            sentinel.display()
        );
        let mut command = tokio::process::Command::new(program);
        command.args(["/D", "/S", "/C", &script]);
        command.current_dir(std::env::temp_dir());
        command.env_clear();
        command.env("SystemRoot", system_root);
        command.stdin(Stdio::null());
        command.stdout(Stdio::null());
        command.stderr(Stdio::null());
        command.kill_on_drop(true);
        configure_process_group(&mut command);
        let child = command.spawn().unwrap();
        (registration, child, sentinel)
    }

    async fn assert_still_suspended(sentinel: &PathBuf) {
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(
            !sentinel.exists(),
            "first instruction ran before Job assignment"
        );
    }

    async fn wait_for_sentinel(sentinel: &PathBuf) {
        let deadline = Instant::now() + Duration::from_secs(2);
        while !sentinel.exists() {
            assert!(
                Instant::now() < deadline,
                "resumed process did not run its first instruction"
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    fn reset_injections() {
        INJECT_ASSIGN_FAILURE.store(false, Ordering::SeqCst);
        INJECT_RESUME_FAILURE.store(false, Ordering::SeqCst);
        JOB_CLOSE_COUNT.store(0, Ordering::SeqCst);
    }

    #[tokio::test]
    async fn real_suspended_spawn_cannot_run_before_assignment() {
        let _serial = WINDOWS_TEST_LOCK.lock().await;
        reset_injections();
        let (registration, mut child, sentinel) =
            spawn_suspended_sentinel("zeroshot-windows-contained");
        assert_still_suspended(&sentinel).await;
        let process_tree = capture_process_tree(registration, &mut child).unwrap();
        wait_for_sentinel(&sentinel).await;
        let termination = terminate_process_tree(&process_tree, &mut child).await;
        assert_eq!(termination.cleanup, ProcessCleanupEvidence::Reaped);
        drop(process_tree);
        assert_eq!(JOB_CLOSE_COUNT.load(Ordering::SeqCst), 1);
        let _ = std::fs::remove_file(sentinel);
    }

    #[tokio::test]
    async fn assignment_failure_terminates_and_reaps_without_first_instruction() {
        let _serial = WINDOWS_TEST_LOCK.lock().await;
        reset_injections();
        let (registration, mut child, sentinel) =
            spawn_suspended_sentinel("zeroshot-windows-assign-failure");
        assert_still_suspended(&sentinel).await;
        INJECT_ASSIGN_FAILURE.store(true, Ordering::SeqCst);
        assert!(capture_process_tree(registration, &mut child).is_err());
        timeout(Duration::from_secs(5), child.wait())
            .await
            .expect("failed assignment root was not reaped")
            .unwrap();
        assert!(!sentinel.exists());
        assert_eq!(JOB_CLOSE_COUNT.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn resume_failure_terminates_and_reaps_without_first_instruction() {
        let _serial = WINDOWS_TEST_LOCK.lock().await;
        reset_injections();
        let (registration, mut child, sentinel) =
            spawn_suspended_sentinel("zeroshot-windows-resume-failure");
        assert_still_suspended(&sentinel).await;
        INJECT_RESUME_FAILURE.store(true, Ordering::SeqCst);
        assert!(capture_process_tree(registration, &mut child).is_err());
        timeout(Duration::from_secs(5), child.wait())
            .await
            .expect("failed resume root was not reaped")
            .unwrap();
        assert!(!sentinel.exists());
        assert_eq!(JOB_CLOSE_COUNT.load(Ordering::SeqCst), 1);
    }
}
