use std::io;

use tokio::process::Command;
use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, TH32CS_SNAPTHREAD, THREADENTRY32, Thread32First, Thread32Next,
};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JobObjectBasicAccountingInformation, JobObjectExtendedLimitInformation,
    QueryInformationJobObject, SetInformationJobObject, TerminateJobObject,
};
use windows_sys::Win32::System::Threading::{
    CREATE_SUSPENDED, OpenThread, ResumeThread, THREAD_SUSPEND_RESUME,
};

trait WindowsContainmentCalls {
    fn assign(&mut self) -> Result<(), io::Error>;
    fn resume(&mut self) -> Result<(), io::Error>;
    fn terminate_failed_capture(&mut self);
}

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

struct SystemWindowsContainmentCalls<'a> {
    job: usize,
    process: HANDLE,
    process_id: u32,
    child: &'a mut tokio::process::Child,
}

#[cfg(test)]
static WINDOWS_TEST_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
#[cfg(test)]
static INJECT_ASSIGN_FAILURE: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);
#[cfg(test)]
static INJECT_RESUME_FAILURE: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);
#[cfg(test)]
static JOB_CLOSE_COUNT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

impl WindowsContainmentCalls for SystemWindowsContainmentCalls<'_> {
    fn assign(&mut self) -> Result<(), io::Error> {
        #[cfg(test)]
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
        #[cfg(test)]
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

pub(super) fn assign_process_tree(
    job: usize,
    child: &mut tokio::process::Child,
) -> Result<(), io::Error> {
    let process = child
        .raw_handle()
        .ok_or_else(|| io::Error::other("spawned process handle is unavailable"))?;
    let process_id = child
        .id()
        .ok_or_else(|| io::Error::other("spawned process id is unavailable"))?;
    let mut calls = SystemWindowsContainmentCalls {
        job,
        process: process as HANDLE,
        process_id,
        child,
    };
    assign_suspended_process(&mut calls)
}

pub(super) fn configure_process_group(command: &mut Command) {
    command.creation_flags(CREATE_SUSPENDED);
}

pub(super) fn kill_process_tree(job: usize, child: &mut tokio::process::Child) -> Vec<String> {
    let terminated = unsafe { TerminateJobObject(job as HANDLE, 1) };
    if terminated != 0 {
        return Vec::new();
    }
    let termination_error = io::Error::last_os_error();
    let mut errors = vec![super::io_error_detail(
        "Windows job termination failed",
        &termination_error,
    )];
    if let Err(error) = child.start_kill() {
        errors.push(super::io_error_detail(
            "root process termination fallback failed",
            &error,
        ));
    }
    errors
}

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

pub(super) fn create_kill_on_close_job() -> Result<usize, io::Error> {
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

pub(super) fn job_has_live_members(job: usize) -> Result<bool, io::Error> {
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

pub(super) fn close_job(job: usize) {
    #[cfg(test)]
    JOB_CLOSE_COUNT.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    unsafe {
        CloseHandle(job as HANDLE);
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::process::Stdio;
    use std::sync::atomic::Ordering;

    use tokio::time::{Duration, Instant, timeout};

    use super::{INJECT_ASSIGN_FAILURE, INJECT_RESUME_FAILURE, JOB_CLOSE_COUNT, WINDOWS_TEST_LOCK};
    use super::super::platform::{
        ProcessCleanupEvidence, ProcessContainment, ProcessTreeRegistration, capture_process_tree,
        configure_process, register_process_tree_for, terminate_process_tree,
    };

    fn spawn_suspended_sentinel(
        name: &str,
    ) -> (ProcessTreeRegistration, tokio::process::Child, PathBuf) {
        let registration = register_process_tree_for(ProcessContainment::ProcessGroup).unwrap();
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
        configure_process(&mut command, ProcessContainment::ProcessGroup);
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
