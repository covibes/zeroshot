use std::io;

use tokio::process::Command;

pub(super) fn register_process_tree(worker_uid: Option<u32>) -> Result<(), io::Error> {
    #[cfg(target_os = "linux")]
    {
        register_linux_subreaper()?;
        if let Some(worker_uid) = worker_uid {
            validate_linux_worker_boundary(worker_uid)?;
        }
    }
    #[cfg(not(target_os = "linux"))]
    let _ = worker_uid;
    Ok(())
}

pub(super) fn configure_process(command: &mut Command, worker_identity: Option<(u32, u32)>) {
    unsafe {
        command.pre_exec(move || {
            if libc::setpgid(0, 0) != 0 {
                return Err(io::Error::last_os_error());
            }
            #[cfg(target_os = "linux")]
            if let Some((uid, gid)) = worker_identity {
                configure_linux_worker(uid, gid)?;
            }
            #[cfg(not(target_os = "linux"))]
            if worker_identity.is_some() {
                return Err(io::Error::new(
                    io::ErrorKind::Unsupported,
                    "dedicated worker identity requires Linux",
                ));
            }
            Ok(())
        });
    }
}

pub(super) fn kill_process_tree(
    process_group_id: Option<i32>,
    worker_uid: Option<u32>,
    child: &mut tokio::process::Child,
) {
    #[cfg(target_os = "linux")]
    if let Some(worker_uid) = worker_uid {
        let _ = kill_linux_uid_processes(worker_uid);
    }
    #[cfg(not(target_os = "linux"))]
    let _ = worker_uid;
    let Some(process_group_id) = process_group_id else {
        let _ = child.start_kill();
        return;
    };
    if let Err(error) = kill_process_group(process_group_id) {
        if error.raw_os_error() != Some(libc::ESRCH) {
            let _ = child.start_kill();
        }
    }
}

fn kill_process_group(process_group_id: i32) -> Result<(), io::Error> {
    unsafe {
        if libc::killpg(process_group_id, libc::SIGKILL) == 0 {
            Ok(())
        } else {
            Err(io::Error::last_os_error())
        }
    }
}

#[cfg(all(unix, not(target_os = "linux")))]
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

#[cfg(target_os = "linux")]
pub(super) fn reap_process_group_children(process_group_id: i32) -> Result<(), io::Error> {
    loop {
        let result =
            unsafe { libc::waitpid(-process_group_id, std::ptr::null_mut(), libc::WNOHANG) };
        if result > 0 {
            continue;
        }
        if result == 0 {
            return Ok(());
        }
        let error = io::Error::last_os_error();
        match error.raw_os_error() {
            Some(libc::ECHILD) => return Ok(()),
            Some(libc::EINTR) => {}
            _ => return Err(error),
        }
    }
}

#[cfg(target_os = "linux")]
pub(super) fn reap_and_kill_worker_uid_processes(worker_uid: u32) -> Result<bool, io::Error> {
    let pids = linux_uid_processes(worker_uid)?;
    for pid in &pids {
        if unsafe { libc::kill(*pid, libc::SIGKILL) } != 0 {
            let error = io::Error::last_os_error();
            if error.raw_os_error() != Some(libc::ESRCH) {
                return Err(error);
            }
        }
    }
    for pid in &pids {
        reap_linux_child(*pid)?;
    }
    Ok(!pids.is_empty())
}

#[cfg(target_os = "linux")]
pub(super) fn worker_uid_has_live_members(worker_uid: u32) -> Result<bool, io::Error> {
    Ok(!linux_uid_processes(worker_uid)?.is_empty())
}

#[cfg(target_os = "linux")]
pub(super) fn process_group_has_live_members(process_group_id: i32) -> Result<bool, io::Error> {
    for entry in std::fs::read_dir("/proc")? {
        if linux_entry_process_group(entry?)? == Some(process_group_id) {
            return Ok(true);
        }
    }
    Ok(false)
}

#[cfg(target_os = "linux")]
fn linux_entry_process_group(entry: std::fs::DirEntry) -> Result<Option<i32>, io::Error> {
    let Some(pid) = linux_entry_pid(&entry) else {
        return Ok(None);
    };
    let stat = match std::fs::read_to_string(entry.path().join("stat")) {
        Ok(stat) => stat,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    linux_process_group(&stat).map(Some).ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("invalid Linux process stat for {pid}"),
        )
    })
}

#[cfg(target_os = "linux")]
fn validate_linux_worker_boundary(worker_uid: u32) -> Result<(), io::Error> {
    if unsafe { libc::geteuid() } != 0 {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "hosted worker containment requires a root supervisor",
        ));
    }
    if worker_uid == 0 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "hosted worker UID must be unprivileged",
        ));
    }
    if !linux_uid_processes(worker_uid)?.is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            "hosted worker UID is already in use",
        ));
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn register_linux_subreaper() -> Result<(), io::Error> {
    if unsafe { libc::prctl(libc::PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) } != 0 {
        return Err(io::Error::last_os_error());
    }
    let mut enabled: libc::c_int = 0;
    if unsafe { libc::prctl(libc::PR_GET_CHILD_SUBREAPER, &mut enabled, 0, 0, 0) } != 0 {
        return Err(io::Error::last_os_error());
    }
    if enabled != 1 {
        return Err(io::Error::other(
            "Linux child subreaper could not be verified",
        ));
    }
    Ok(())
}

#[cfg(target_os = "linux")]
#[repr(C)]
struct CapabilityHeader {
    version: u32,
    pid: i32,
}

#[cfg(target_os = "linux")]
#[repr(C)]
struct CapabilityData {
    effective: u32,
    permitted: u32,
    inheritable: u32,
}

#[cfg(target_os = "linux")]
fn configure_linux_worker(uid: u32, gid: u32) -> Result<(), io::Error> {
    close_control_descriptors()?;
    drop_linux_identity(uid, gid)?;
    clear_linux_privileges()?;
    verify_linux_identity(uid, gid)
}

#[cfg(target_os = "linux")]
fn close_control_descriptors() -> Result<(), io::Error> {
    const CLOSE_RANGE_CLOEXEC: libc::c_uint = 1 << 2;
    // SAFETY: close_range only changes descriptor flags in the post-fork child.
    let result = unsafe {
        libc::syscall(
            libc::SYS_close_range,
            3 as libc::c_uint,
            libc::c_uint::MAX,
            CLOSE_RANGE_CLOEXEC,
        )
    };
    zero_result(result)
}

#[cfg(target_os = "linux")]
fn drop_linux_identity(uid: u32, gid: u32) -> Result<(), io::Error> {
    const PR_CAP_AMBIENT: libc::c_int = 47;
    const PR_CAP_AMBIENT_CLEAR_ALL: libc::c_ulong = 4;
    // SAFETY: the child is single-threaded after fork; IDs are validated fixed integers and the
    // empty group pointer is valid for a zero-length setgroups call.
    let failed = unsafe {
        libc::setgroups(0, std::ptr::null()) != 0
            || libc::setresgid(gid, gid, gid) != 0
            || libc::setresuid(uid, uid, uid) != 0
            || libc::prctl(
                PR_CAP_AMBIENT,
                PR_CAP_AMBIENT_CLEAR_ALL,
                0 as libc::c_ulong,
                0 as libc::c_ulong,
                0 as libc::c_ulong,
            ) != 0
    };
    boolean_result(failed)
}

#[cfg(target_os = "linux")]
fn clear_linux_privileges() -> Result<(), io::Error> {
    const LINUX_CAPABILITY_VERSION_3: u32 = 0x2008_0522;
    let header = CapabilityHeader {
        version: LINUX_CAPABILITY_VERSION_3,
        pid: 0,
    };
    let data = [
        CapabilityData {
            effective: 0,
            permitted: 0,
            inheritable: 0,
        },
        CapabilityData {
            effective: 0,
            permitted: 0,
            inheritable: 0,
        },
    ];
    // SAFETY: header and both version-3 data entries remain valid for the syscall duration; prctl
    // mutates only the post-fork child credentials.
    let failed = unsafe {
        libc::syscall(libc::SYS_capset, &header, data.as_ptr()) != 0
            || libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0
    };
    boolean_result(failed)
}

#[cfg(target_os = "linux")]
fn verify_linux_identity(uid: u32, gid: u32) -> Result<(), io::Error> {
    // SAFETY: these calls only inspect the post-fork child credentials.
    let valid = unsafe {
        libc::getuid() == uid
            && libc::geteuid() == uid
            && libc::getgid() == gid
            && libc::getegid() == gid
            && libc::getgroups(0, std::ptr::null_mut()) == 0
    };
    if valid {
        Ok(())
    } else {
        Err(io::Error::other(
            "worker identity drop could not be verified",
        ))
    }
}

#[cfg(target_os = "linux")]
fn zero_result(result: libc::c_long) -> Result<(), io::Error> {
    boolean_result(result != 0)
}

#[cfg(target_os = "linux")]
fn boolean_result(failed: bool) -> Result<(), io::Error> {
    if failed {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(target_os = "linux")]
fn kill_linux_uid_processes(worker_uid: u32) -> Result<(), io::Error> {
    for pid in linux_uid_processes(worker_uid)? {
        if unsafe { libc::kill(pid, libc::SIGKILL) } != 0 {
            let error = io::Error::last_os_error();
            if error.raw_os_error() != Some(libc::ESRCH) {
                return Err(error);
            }
        }
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn reap_linux_child(pid: i32) -> Result<(), io::Error> {
    loop {
        let result = unsafe { libc::waitpid(pid, std::ptr::null_mut(), libc::WNOHANG) };
        if result >= 0 {
            return Ok(());
        }
        let error = io::Error::last_os_error();
        match error.raw_os_error() {
            Some(libc::ECHILD) | Some(libc::ESRCH) => return Ok(()),
            Some(libc::EINTR) => {}
            _ => return Err(error),
        }
    }
}

#[cfg(target_os = "linux")]
fn linux_uid_processes(worker_uid: u32) -> Result<Vec<i32>, io::Error> {
    let mut pids = Vec::new();
    for entry in std::fs::read_dir("/proc")? {
        let entry = entry?;
        let Some(pid) = linux_entry_pid(&entry) else {
            continue;
        };
        let status = match std::fs::read_to_string(entry.path().join("status")) {
            Ok(status) => status,
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error),
        };
        let effective_uid = linux_effective_uid(&status).ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                format!("invalid Linux process status for {pid}"),
            )
        })?;
        if effective_uid == worker_uid {
            pids.push(pid);
        }
    }
    Ok(pids)
}

#[cfg(target_os = "linux")]
fn linux_entry_pid(entry: &std::fs::DirEntry) -> Option<i32> {
    let name = entry.file_name();
    let name = name.to_str()?;
    if name.is_empty() || !name.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    name.parse().ok()
}

#[cfg(target_os = "linux")]
fn linux_effective_uid(status: &str) -> Option<u32> {
    let values = status.lines().find_map(|line| line.strip_prefix("Uid:"))?;
    values.split_whitespace().nth(1)?.parse().ok()
}

#[cfg(target_os = "linux")]
fn linux_process_group(stat: &str) -> Option<i32> {
    let after_name = stat.rsplit_once(") ")?.1;
    let mut fields = after_name.split_whitespace();
    let _state = fields.next()?;
    let _parent = fields.next()?;
    fields.next()?.parse().ok()
}

#[cfg(all(unix, not(target_os = "linux")))]
pub(super) fn process_group_has_live_members(process_group_id: i32) -> Result<bool, io::Error> {
    let output = std::process::Command::new("ps")
        .args(["-o", "state=", "-g", &process_group_id.to_string()])
        .output()?;
    if !output.status.success() {
        return process_group_exists(process_group_id);
    }
    Ok(String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .any(|state| !state.is_empty()))
}
