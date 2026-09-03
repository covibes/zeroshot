use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};

use super::NativeV2CliError;

pub const VERSION: &str = concat!("zeroshot-rust ", env!("CARGO_PKG_VERSION"), "\n");

pub(super) fn nonempty_environment(name: &str) -> Option<std::ffi::OsString> {
    std::env::var_os(name).filter(|value| !value.is_empty())
}

pub(super) fn absolute_user_path(
    path: impl Into<PathBuf>,
    invalid_message: &'static str,
) -> Result<PathBuf, NativeV2CliError> {
    let path = path.into();
    if path.is_absolute() && !path.as_os_str().is_empty() {
        Ok(path)
    } else {
        Err(NativeV2CliError::Local(invalid_message.to_owned()))
    }
}

pub(super) fn cleanup_temporary<T>(
    result: Result<T, NativeV2CliError>,
    path: &std::path::Path,
) -> Result<T, NativeV2CliError> {
    if result.is_err() {
        let _ = std::fs::remove_file(path);
    }
    result
}

pub(super) struct CommitPaths<'a> {
    pub(super) temporary: &'a Path,
    pub(super) destination: &'a Path,
    pub(super) parent: &'a Path,
}

pub(super) fn write_and_commit(
    file: File,
    contents: &[u8],
    paths: CommitPaths<'_>,
) -> Result<(), NativeV2CliError> {
    let mut writer = BufWriter::new(file);
    writer.write_all(contents).map_err(local_io)?;
    writer.flush().map_err(local_io)?;
    writer.get_ref().sync_all().map_err(local_io)?;
    std::fs::rename(paths.temporary, paths.destination).map_err(local_io)?;
    File::open(paths.parent)
        .and_then(|directory| directory.sync_all())
        .map_err(local_io)
}

fn local_io(error: std::io::Error) -> NativeV2CliError {
    NativeV2CliError::Local(error.to_string())
}
