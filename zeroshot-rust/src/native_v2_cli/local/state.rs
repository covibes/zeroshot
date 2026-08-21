use std::ffi::OsString;
use std::path::{Path, PathBuf};

use openengine_cluster_protocol::{RunId, is_canonical_uuid_v7};
use tokio::process::Command;

use super::{NativeV2CliError, local_io, local_message};

pub(super) fn validate_local_run_id(run_id: &RunId) -> Result<(), NativeV2CliError> {
    is_canonical_uuid_v7(run_id)
        .then_some(())
        .ok_or_else(|| local_message("run ID is not a local controller identity"))
}

pub(super) fn local_run_id_from_entry(entry: std::fs::DirEntry) -> Option<RunId> {
    let file_type = entry.file_type().ok()?;
    if !file_type.is_dir() || file_type.is_symlink() {
        return None;
    }
    let name = entry.file_name().to_str()?.to_owned();
    let run_id = RunId::new(name);
    validate_local_run_id(&run_id).ok().map(|()| run_id)
}

pub(super) fn validate_local_socket_path(path: &Path) -> Result<(), NativeV2CliError> {
    use std::os::unix::ffi::OsStrExt as _;

    let bytes = path.as_os_str().as_bytes();
    if bytes.contains(&0) {
        return Err(local_message(
            "controller socket path cannot contain a null byte",
        ));
    }
    if bytes.len() >= local_socket_path_capacity() {
        return Err(local_message(
            "controller socket path is too long; set ZEROSHOT_RUST_STATE_DIR to a shorter absolute directory",
        ));
    }
    Ok(())
}

fn local_socket_path_capacity() -> usize {
    let address: libc::sockaddr_un = unsafe { std::mem::zeroed() };
    address.sun_path.len()
}

pub(super) fn copy_minimal_process_environment(command: &mut Command) {
    for name in [
        "PATH",
        "LANG",
        "LC_ALL",
        "TERM",
        "TMPDIR",
        "HOME",
        "CODEX_HOME",
    ] {
        if let Some(value) = std::env::var_os(name).filter(|value| !value.is_empty()) {
            command.env(name, value);
        }
    }
}

pub(super) fn prepare_private_directory(path: &Path) -> Result<(), NativeV2CliError> {
    private_directory_builder().create(path).map_err(local_io)?;
    validate_private_directory(path)
}

pub(super) fn private_directory_builder() -> std::fs::DirBuilder {
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    use std::os::unix::fs::DirBuilderExt as _;
    builder.mode(0o700);
    builder
}

pub(super) fn validate_private_directory(path: &Path) -> Result<(), NativeV2CliError> {
    use std::os::unix::fs::PermissionsExt as _;

    let metadata = std::fs::symlink_metadata(path).map_err(local_io)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(local_message("controller state path is not a directory"));
    }
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).map_err(local_io)
}

pub(super) fn require_existing_ledger(path: &Path) -> Result<bool, NativeV2CliError> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => Ok(true),
        Ok(_) => Err(local_message("run ledger path is not a regular file")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(local_io(error)),
    }
}

pub(super) fn remove_private_bootstrap(path: &Path) {
    if std::fs::symlink_metadata(path)
        .is_ok_and(|metadata| metadata.is_file() && !metadata.file_type().is_symlink())
    {
        let _ = std::fs::remove_file(path);
    }
}

pub(super) fn default_local_state_root() -> Result<PathBuf, NativeV2CliError> {
    if let Some(path) = nonempty_environment("ZEROSHOT_RUST_STATE_DIR") {
        return absolute_path(path);
    }
    if let Some(path) = nonempty_environment("XDG_STATE_HOME") {
        return absolute_path(PathBuf::from(path).join("zeroshot-rust"));
    }
    let home = nonempty_environment("HOME")
        .ok_or_else(|| local_message("HOME and XDG_STATE_HOME are unavailable"))?;
    absolute_path(
        PathBuf::from(home)
            .join(".local")
            .join("state")
            .join("zeroshot-rust"),
    )
}

fn absolute_path(path: impl Into<PathBuf>) -> Result<PathBuf, NativeV2CliError> {
    let path = path.into();
    if path.is_absolute() && !path.as_os_str().is_empty() {
        Ok(path)
    } else {
        Err(local_message("controller state path must be absolute"))
    }
}

fn nonempty_environment(name: &str) -> Option<OsString> {
    std::env::var_os(name).filter(|value| !value.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_socket_paths_that_cannot_fit_the_platform_address() {
        let capacity = local_socket_path_capacity();
        assert!(validate_local_socket_path(Path::new(&"x".repeat(capacity - 1))).is_ok());
        assert!(
            validate_local_socket_path(Path::new(&"x".repeat(capacity)))
                .is_err_and(|error| error.to_string().contains("ZEROSHOT_RUST_STATE_DIR"))
        );
    }

    #[test]
    fn local_controller_inherits_current_user_cli_home_paths() {
        let mut command = Command::new("true");
        command.env_clear();
        copy_minimal_process_environment(&mut command);
        let environment = command
            .as_std()
            .get_envs()
            .filter_map(|(name, value)| value.map(|value| (name.to_owned(), value.to_owned())))
            .collect::<std::collections::BTreeMap<_, _>>();

        for name in ["HOME", "CODEX_HOME"] {
            let expected = std::env::var_os(name).filter(|value| !value.is_empty());
            assert_eq!(
                environment.get(std::ffi::OsStr::new(name)),
                expected.as_ref()
            );
        }
    }
}
