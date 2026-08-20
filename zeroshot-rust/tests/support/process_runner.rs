use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use tokio::sync::watch;
use tokio::time::{Duration, Instant};
use zeroshot_engine::execution::driver::DriverCancellation;

pub fn cancellation_pair() -> (watch::Sender<bool>, DriverCancellation) {
    let (sender, receiver) = watch::channel(false);
    (sender, DriverCancellation::new(receiver))
}

pub fn unique_temp_path(name: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .assert_value()
        .as_nanos();
    std::env::temp_dir().join(format!("{name}-{nanos}"))
}

pub fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

pub async fn wait_for_child_pid(path: &PathBuf) -> i32 {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if let Ok(contents) = fs::read_to_string(path) {
            if let Ok(pid) = contents.trim().parse::<i32>() {
                return pid;
            }
        }
        assert!(Instant::now() < deadline, "child pid file was not written");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

pub async fn wait_for_process_exit(pid: i32) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while process_exists(pid) {
        assert!(Instant::now() < deadline, "process {pid} did not exit");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

#[cfg(unix)]
pub fn process_exists(pid: i32) -> bool {
    // SAFETY: signal zero performs only an existence/permission check for the supplied PID.
    unsafe {
        if libc::kill(pid, 0) == 0 {
            true
        } else {
            std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
        }
    }
}

#[cfg(windows)]
pub fn process_exists(pid: i32) -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, STILL_ACTIVE};
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    let Ok(pid) = u32::try_from(pid) else {
        return false;
    };
    // SAFETY: OpenProcess receives a validated PID and requests query-only access.
    let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if process.is_null() {
        return false;
    }
    let mut exit_code = 0;
    // SAFETY: exit_code is writable for the call and process is a live owned handle.
    let queried = unsafe { GetExitCodeProcess(process, &mut exit_code) };
    // SAFETY: process was returned by OpenProcess and is closed exactly once here.
    unsafe {
        CloseHandle(process);
    }
    queried != 0 && exit_code == STILL_ACTIVE as u32
}

use openengine_cluster_testkit::assertions::{AssertValue};
