use std::fs::{File, OpenOptions};
use std::io::{self, Read, Write};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

use super::{CredentialStorePreparation, TargetCredentialStore, credential_service};
use crate::native_v2_target::controller_authority::contract::authority_error;
use crate::native_v2_target::registry::{create_private_directory, encode_hex};
use crate::native_v2_target::TargetAuthorityError;

const CREDENTIAL_FILE_VERSION: u32 = 1;
const MAX_REFRESH_TOKEN_BYTES: usize = 16 * 1024;
const MAX_CREDENTIAL_FILE_BYTES: usize = MAX_REFRESH_TOKEN_BYTES * 2 + 256;

#[derive(Clone, Debug)]
pub(super) struct PrivateFileTargetCredentialStore {
    directory: PathBuf,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct CredentialFile {
    version: u32,
    refresh_token: String,
}

impl PrivateFileTargetCredentialStore {
    pub(super) const fn new(directory: PathBuf) -> Self {
        Self { directory }
    }

    pub(super) async fn read_backend(
        &self,
        target_id: &str,
    ) -> Result<Option<String>, TargetAuthorityError> {
        let path = self.backend_path(target_id)?;
        tokio::task::spawn_blocking(move || {
            read_private_file(&path).and_then(|value| {
                value
                    .map(String::from_utf8)
                    .transpose()
                    .map_err(|_| invalid_data())
            })
        })
        .await
        .map_err(|_| authority_error("target credential store task failed"))?
        .map_err(|_| authority_error("target credential store metadata read failed"))
    }

    pub(super) async fn remove_credential(
        &self,
        target_id: &str,
    ) -> Result<(), TargetAuthorityError> {
        let path = self.credential_path(target_id)?;
        tokio::task::spawn_blocking(move || remove_private_file(&path))
            .await
            .map_err(|_| authority_error("target credential store task failed"))?
            .map_err(|_| authority_error("private target credential store cleanup failed"))
    }

    pub(super) async fn write_backend(
        &self,
        target_id: &str,
        backend: &str,
    ) -> Result<(), TargetAuthorityError> {
        if !matches!(backend, "system\n" | "file\n") {
            return Err(authority_error(
                "target credential store selection is invalid",
            ));
        }
        let path = self.backend_path(target_id)?;
        let value = backend.as_bytes().to_vec();
        tokio::task::spawn_blocking(move || write_private_file(&path, &value))
            .await
            .map_err(|_| authority_error("target credential store task failed"))?
            .map_err(|_| authority_error("target credential store metadata write failed"))
    }

    fn credential_path(&self, target_id: &str) -> Result<PathBuf, TargetAuthorityError> {
        credential_service(target_id)?;
        Ok(self.directory.join(format!("{target_id}.json")))
    }

    fn backend_path(&self, target_id: &str) -> Result<PathBuf, TargetAuthorityError> {
        credential_service(target_id)?;
        Ok(self.directory.join(format!("{target_id}.store")))
    }
}

#[async_trait]
impl TargetCredentialStore for PrivateFileTargetCredentialStore {
    async fn prepare_for_login(
        &self,
        target_id: &str,
    ) -> Result<CredentialStorePreparation, TargetAuthorityError> {
        let path = self.credential_path(target_id)?;
        let prepared_path = path.clone();
        tokio::task::spawn_blocking(move || {
            let directory = path.parent().ok_or_else(invalid_data)?;
            prepare_private_directory(directory)?;
            read_credential(&path).map(|_| ())
        })
        .await
        .map_err(|_| authority_error("target credential store task failed"))?
        .map_err(|_| authority_error("private target credential store is unavailable"))?;
        Ok(CredentialStorePreparation::PrivateFile(prepared_path))
    }

    async fn get(&self, target_id: &str) -> Result<Option<String>, TargetAuthorityError> {
        let path = self.credential_path(target_id)?;
        tokio::task::spawn_blocking(move || read_credential(&path))
            .await
            .map_err(|_| authority_error("target credential store task failed"))?
            .map_err(|_| authority_error("private target credential store read failed"))
    }

    async fn set(&self, target_id: &str, refresh_token: &str) -> Result<(), TargetAuthorityError> {
        if !valid_refresh_token(refresh_token) {
            return Err(authority_error("refresh token is malformed"));
        }
        let path = self.credential_path(target_id)?;
        let bytes = serde_json::to_vec(&CredentialFile {
            version: CREDENTIAL_FILE_VERSION,
            refresh_token: refresh_token.to_owned(),
        })
        .map_err(|_| authority_error("private target credential could not be encoded"))?;
        tokio::task::spawn_blocking(move || write_private_file(&path, &bytes))
            .await
            .map_err(|_| authority_error("target credential store task failed"))?
            .map_err(|_| authority_error("private target credential store write failed"))
    }
}

fn read_credential(path: &Path) -> io::Result<Option<String>> {
    let Some(bytes) = read_private_file(path)? else {
        return Ok(None);
    };
    let credential: CredentialFile = serde_json::from_slice(&bytes).map_err(|_| invalid_data())?;
    if credential.version != CREDENTIAL_FILE_VERSION
        || !valid_refresh_token(&credential.refresh_token)
    {
        return Err(invalid_data());
    }
    Ok(Some(credential.refresh_token))
}

fn valid_refresh_token(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_REFRESH_TOKEN_BYTES
        && !value.bytes().any(|byte| byte.is_ascii_control())
}

fn read_private_file(path: &Path) -> io::Result<Option<Vec<u8>>> {
    let Some(file) = open_private_file(path)? else {
        return Ok(None);
    };
    read_bounded_file(file).map(Some)
}

fn open_private_file(path: &Path) -> io::Result<Option<File>> {
    let directory = path.parent().ok_or_else(invalid_data)?;
    prepare_private_directory(directory)?;
    let mut options = OpenOptions::new();
    options
        .read(true)
        .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW | libc::O_NONBLOCK);
    match options.open(path) {
        Ok(file) => Ok(Some(file)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

fn read_bounded_file(file: File) -> io::Result<Vec<u8>> {
    let metadata = file.metadata()?;
    let file_len = usize::try_from(metadata.len()).map_err(|_| invalid_data())?;
    if !metadata.file_type().is_file()
        || !private_owner_and_mode(&metadata)
        || file_len > MAX_CREDENTIAL_FILE_BYTES
    {
        return Err(invalid_data());
    }
    let limit = u64::try_from(MAX_CREDENTIAL_FILE_BYTES)
        .map_err(|_| invalid_data())?
        .saturating_add(1);
    let mut bytes = Vec::with_capacity(file_len);
    file.take(limit).read_to_end(&mut bytes)?;
    if bytes.len() > MAX_CREDENTIAL_FILE_BYTES {
        return Err(invalid_data());
    }
    Ok(bytes)
}

fn remove_private_file(path: &Path) -> io::Result<()> {
    let Some(file) = open_private_file(path)? else {
        return Ok(());
    };
    let metadata = file.metadata()?;
    if !metadata.file_type().is_file() || !private_owner_and_mode(&metadata) {
        return Err(invalid_data());
    }
    drop(file);
    std::fs::remove_file(path)?;
    sync_directory(path.parent().ok_or_else(invalid_data)?)
}

fn write_private_file(path: &Path, bytes: &[u8]) -> io::Result<()> {
    if bytes.len() > MAX_CREDENTIAL_FILE_BYTES {
        return Err(invalid_data());
    }
    let directory = path.parent().ok_or_else(invalid_data)?;
    prepare_private_directory(directory)?;
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(invalid_data)?;
    let mut suffix = [0_u8; 8];
    getrandom::fill(&mut suffix).map_err(|_| invalid_data())?;
    let temporary = directory.join(format!(".{file_name}.tmp-{}", encode_hex(&suffix)));
    let mut options = OpenOptions::new();
    options
        .create_new(true)
        .write(true)
        .mode(0o600)
        .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW);
    let result = (|| {
        let mut file = options.open(&temporary)?;
        let metadata = file.metadata()?;
        if !metadata.file_type().is_file() || !private_owner_and_mode(&metadata) {
            return Err(invalid_data());
        }
        file.write_all(bytes)?;
        file.sync_all()?;
        std::fs::rename(&temporary, path)?;
        sync_directory(directory)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result
}

fn prepare_private_directory(path: &Path) -> io::Result<()> {
    create_private_directory(path).map_err(|_| invalid_data())?;
    let metadata = std::fs::symlink_metadata(path)?;
    if metadata.file_type().is_dir() && private_owner_and_mode(&metadata) {
        Ok(())
    } else {
        Err(invalid_data())
    }
}

fn private_owner_and_mode(metadata: &std::fs::Metadata) -> bool {
    metadata.uid() == unsafe { libc::geteuid() } && metadata.mode() & 0o077 == 0
}

fn sync_directory(path: &Path) -> io::Result<()> {
    let mut options = OpenOptions::new();
    options
        .read(true)
        .custom_flags(libc::O_CLOEXEC | libc::O_DIRECTORY | libc::O_NOFOLLOW);
    options.open(path)?.sync_all()
}

fn invalid_data() -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        "invalid private credential storage",
    )
}
