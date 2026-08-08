use std::collections::BTreeMap;
use std::path::Path;
use std::process::Stdio;

use tokio::fs;
use tokio::process::Command;
use tokio::time::{timeout, Duration};

use super::credentials::{
    apply_uncredentialed_worker_to, CredentialBundle, RuntimeConfig, SecretString,
    EXECUTABLE_RUNTIME_ROOT, RUNTIME_DIRECTORY_MODE, RUNTIME_EXECUTABLE_MODE, RUNTIME_FILE_MODE,
    RUNTIME_MOUNT_ROOT, RUNTIME_ROOT, SETTINGS_FILE, SHARED_MOUNT_MODE, WORKER_GID, WORKER_UID,
};
use super::ports::WORKSPACE_ROOT;

const SETUP_COMMAND_TIMEOUT: Duration = Duration::from_secs(10 * 60);

impl CredentialBundle {
    pub(super) async fn prepare_workspace(&self) -> Result<(), String> {
        prepare_shared_mounts().await?;
        write_runtime_files(&self.runtime).await?;
        clone_exact_repository(self).await?;
        prepare_executable_runtime_directories().await?;
        write_runtime_wrapper(&self.runtime).await?;
        if let Some(setup_command) = &self.runtime.setup_command {
            let mut command = Command::new("/bin/sh");
            command.args(["-c", setup_command.expose()]);
            self.apply_setup_to(&mut command);
            run_bounded(&mut command, "runtime setup", SETUP_COMMAND_TIMEOUT).await?;
        }
        verify_prepared_repository(self).await
    }
}

#[cfg(unix)]
async fn prepare_shared_mounts() -> Result<(), String> {
    for root in [Path::new(WORKSPACE_ROOT), Path::new(RUNTIME_MOUNT_ROOT)] {
        prepare_shared_mount(root, WORKER_GID).await?;
    }
    Ok(())
}

#[cfg(not(unix))]
async fn prepare_shared_mounts() -> Result<(), String> {
    Ok(())
}

#[cfg(unix)]
pub(super) async fn prepare_shared_mount(path: &Path, worker_gid: u32) -> Result<(), String> {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};

    fs::create_dir_all(path)
        .await
        .map_err(|error| format!("create shared mount root: {error}"))?;
    let initial = fs::metadata(path)
        .await
        .map_err(|error| format!("inspect shared mount: {error}"))?;
    ensure_shared_mount_group(path, initial.gid(), worker_gid).await?;
    ensure_shared_mount_mode(path, initial.uid(), initial.permissions().mode() & 0o7777).await?;
    let metadata = fs::metadata(path)
        .await
        .map_err(|error| format!("verify shared mount: {error}"))?;
    if metadata.gid() != worker_gid || metadata.permissions().mode() & 0o7777 != SHARED_MOUNT_MODE {
        return Err("shared mount ownership or mode was not applied".to_owned());
    }
    Ok(())
}

#[cfg(unix)]
async fn ensure_shared_mount_group(
    path: &Path,
    current_gid: u32,
    worker_gid: u32,
) -> Result<(), String> {
    if current_gid == worker_gid {
        return Ok(());
    }
    let mut group = Command::new("/bin/chgrp");
    group
        .env_clear()
        .current_dir("/")
        .arg(worker_gid.to_string())
        .arg(path);
    run(&mut group, "set shared mount group").await.map(|_| ())
}

#[cfg(unix)]
async fn ensure_shared_mount_mode(
    path: &Path,
    current_uid: u32,
    current_mode: u32,
) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;

    if current_mode == SHARED_MOUNT_MODE {
        return Ok(());
    }
    let mode = std::fs::Permissions::from_mode(SHARED_MOUNT_MODE);
    if let Err(error) = fs::set_permissions(path, mode).await {
        if current_uid != WORKER_UID {
            return Err(format!("protect shared mount: {error}"));
        }
        let mut protect = Command::new("/bin/chmod");
        protect.arg("2770").arg(path);
        apply_uncredentialed_worker_to(&mut protect);
        run(&mut protect, "protect worker-owned shared mount").await?;
    }
    Ok(())
}

async fn clone_exact_repository(credentials: &CredentialBundle) -> Result<(), String> {
    let workspace = Path::new(WORKSPACE_ROOT);
    let mut entries = fs::read_dir(workspace)
        .await
        .map_err(|error| format!("inspect workspace: {error}"))?;
    let empty = entries
        .next_entry()
        .await
        .map_err(|error| format!("inspect workspace: {error}"))?
        .is_none();
    if !empty {
        return verify_prepared_repository(credentials).await;
    }
    let remote = format!("https://github.com/{}.git", credentials.repository);
    let mut clone = Command::new("/usr/bin/git");
    apply_fixed_git_arguments(&mut clone);
    clone.args([
        "clone",
        "--no-checkout",
        "--origin",
        "origin",
        &remote,
        WORKSPACE_ROOT,
    ]);
    credentials.apply_git_to(&mut clone);
    run(&mut clone, "git clone").await?;

    let mut checkout = Command::new("/usr/bin/git");
    apply_fixed_git_arguments(&mut checkout);
    checkout.args(["-C", WORKSPACE_ROOT, "checkout", "--detach"]);
    checkout.arg(&credentials.base_revision);
    credentials.apply_git_to(&mut checkout);
    run(&mut checkout, "exact base checkout").await?;
    verify_prepared_repository(credentials).await
}

async fn verify_prepared_repository(credentials: &CredentialBundle) -> Result<(), String> {
    let head = git_output(credentials, ["rev-parse", "HEAD"], "repository HEAD").await?;
    let remote = git_output(
        credentials,
        ["remote", "get-url", "origin"],
        "repository remote",
    )
    .await?;
    let status = git_output(
        credentials,
        ["status", "--porcelain=v1", "-z"],
        "repository status",
    )
    .await?;
    let expected_remote = format!("https://github.com/{}", credentials.repository);
    let actual_remote = remote.trim();
    let valid_remote =
        actual_remote == expected_remote || actual_remote == format!("{expected_remote}.git");
    if head.trim() != credentials.base_revision || !valid_remote || !status.is_empty() {
        return Err("prepared repository does not match installed authority".to_owned());
    }
    Ok(())
}

async fn git_output<const N: usize>(
    credentials: &CredentialBundle,
    args: [&str; N],
    operation: &str,
) -> Result<String, String> {
    let mut command = Command::new("/usr/bin/git");
    apply_fixed_git_arguments(&mut command);
    command.arg("-C").arg(WORKSPACE_ROOT).args(args);
    credentials.apply_git_to(&mut command);
    run(&mut command, operation)
        .await
        .map(|output| String::from_utf8_lossy(&output).into_owned())
}

pub(super) fn apply_fixed_git_arguments(command: &mut Command) {
    command
        .args(["-c", "credential.helper=", "-c", "core.hooksPath=/dev/null"])
        .args(["-c", "safe.directory=/workspace"]);
}

async fn write_runtime_files(runtime: &RuntimeConfig) -> Result<(), String> {
    prepare_runtime_directories().await?;
    write_runtime_settings(&runtime.settings).await?;
    write_runtime_payload_files(&runtime.files).await
}

async fn prepare_runtime_directories() -> Result<(), String> {
    for directory in [
        RUNTIME_ROOT.to_owned(),
        format!("{RUNTIME_ROOT}/tmp"),
        format!("{RUNTIME_ROOT}/bin"),
        format!("{RUNTIME_ROOT}/.local"),
        format!("{RUNTIME_ROOT}/.local/bin"),
    ] {
        fs::create_dir_all(&directory)
            .await
            .map_err(|error| format!("create runtime directory: {error}"))?;
        set_runtime_access(&directory, RUNTIME_DIRECTORY_MODE).await?;
    }
    Ok(())
}

async fn prepare_executable_runtime_directories() -> Result<(), String> {
    let directories = [
        EXECUTABLE_RUNTIME_ROOT.to_owned(),
        format!("{EXECUTABLE_RUNTIME_ROOT}/tmp"),
        format!("{EXECUTABLE_RUNTIME_ROOT}/bin"),
        format!("{EXECUTABLE_RUNTIME_ROOT}/.local"),
        format!("{EXECUTABLE_RUNTIME_ROOT}/.local/bin"),
    ];
    let mut create = Command::new("/bin/mkdir");
    create.args(["--parents", "--mode=0770"]).args(&directories);
    apply_uncredentialed_worker_to(&mut create);
    run(&mut create, "create executable runtime directories").await?;

    let mut protect = Command::new("/bin/chmod");
    protect.arg("0770").args(&directories);
    apply_uncredentialed_worker_to(&mut protect);
    run(&mut protect, "protect executable runtime directories")
        .await
        .map(|_| ())
}

async fn write_runtime_settings(settings: &serde_json::Value) -> Result<(), String> {
    let settings = serde_json::to_vec(settings)
        .map_err(|error| format!("serialize runtime settings: {error}"))?;
    fs::write(SETTINGS_FILE, settings)
        .await
        .map_err(|error| format!("write runtime settings: {error}"))?;
    set_runtime_access(SETTINGS_FILE, RUNTIME_FILE_MODE).await
}

async fn write_runtime_payload_files(files: &BTreeMap<String, SecretString>) -> Result<(), String> {
    for (filename, contents) in files {
        let destination = format!("{RUNTIME_ROOT}/{filename}");
        if let Some(parent) = Path::new(&destination).parent() {
            fs::create_dir_all(parent)
                .await
                .map_err(|error| format!("create runtime file parent: {error}"))?;
            set_runtime_access_path(parent, RUNTIME_DIRECTORY_MODE).await?;
        }
        fs::write(&destination, contents.expose())
            .await
            .map_err(|error| format!("write runtime file: {error}"))?;
        set_runtime_access(&destination, RUNTIME_FILE_MODE).await?;
    }
    Ok(())
}

async fn write_runtime_wrapper(runtime: &RuntimeConfig) -> Result<(), String> {
    if let Some(provider_command) = &runtime.command {
        let wrapper = format!("{EXECUTABLE_RUNTIME_ROOT}/bin/{}", runtime.executable);
        fs::write(
            &wrapper,
            format!("#!/bin/sh\nexec {} \"$@\"\n", provider_command.expose()),
        )
        .await
        .map_err(|error| format!("write runtime command wrapper: {error}"))?;
        set_runtime_access(&wrapper, RUNTIME_EXECUTABLE_MODE).await?;
    }
    Ok(())
}

async fn run(command: &mut Command, operation: &str) -> Result<Vec<u8>, String> {
    let output = command
        .output()
        .await
        .map_err(|error| format!("start {operation}: {error}"))?;
    if output.status.success() {
        Ok(output.stdout)
    } else {
        Err(format!("{operation} failed with status {}", output.status))
    }
}

pub(super) async fn run_bounded(
    command: &mut Command,
    operation: &str,
    deadline: Duration,
) -> Result<Vec<u8>, String> {
    command
        .kill_on_drop(true)
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(unix)]
    command.process_group(0);
    let mut child = command
        .spawn()
        .map_err(|error| format!("start {operation}: {error}"))?;
    let status = match timeout(deadline, child.wait()).await {
        Ok(result) => result.map_err(|error| format!("wait for {operation}: {error}"))?,
        Err(_) => {
            terminate_bounded_process(&mut child).await;
            return Err(format!("{operation} exceeded its fixed deadline"));
        }
    };
    if status.success() {
        Ok(Vec::new())
    } else {
        Err(format!("{operation} failed with status {status}"))
    }
}

async fn terminate_bounded_process(child: &mut tokio::process::Child) {
    #[cfg(unix)]
    if let Some(pid) = child.id() {
        // SAFETY: the child was spawned as the leader of its own process group above.
        unsafe {
            libc::kill(-(pid as i32), libc::SIGKILL);
        }
    }
    let _ = child.kill().await;
    let _ = child.wait().await;
}

#[cfg(unix)]
async fn set_runtime_access(path: &str, mode: u32) -> Result<(), String> {
    set_runtime_access_path(Path::new(path), mode).await
}

#[cfg(unix)]
async fn set_runtime_access_path(path: &Path, mode: u32) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;

    fs::set_permissions(path, std::fs::Permissions::from_mode(mode))
        .await
        .map_err(|error| format!("protect runtime path: {error}"))
}

#[cfg(not(unix))]
async fn set_runtime_access(_path: &str, _mode: u32) -> Result<(), String> {
    Ok(())
}

#[cfg(not(unix))]
async fn set_runtime_access_path(_path: &Path, _mode: u32) -> Result<(), String> {
    Ok(())
}
