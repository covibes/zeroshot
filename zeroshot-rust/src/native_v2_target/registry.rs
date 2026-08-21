use std::collections::BTreeMap;
use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use fs2::FileExt;
use serde::{Deserialize, Serialize};

use super::contract::{normalize_origin, validate_target_name};
use super::{TargetAccess, TargetConnectorError, TargetRecord};
use openengine_cluster_protocol::{SourceBranchId, SourceRepositoryId};

const REGISTRY_VERSION: u32 = 4;
const MAX_REGISTRY_BYTES: u64 = 1024 * 1024;

pub trait TargetRegistry: Send + Sync {
    fn insert(&self, target: TargetRecord) -> Result<(), TargetConnectorError>;
    fn get(&self, name: &str) -> Result<TargetRecord, TargetConnectorError>;
    fn setup(
        &self,
        name: &str,
        repository: String,
        default_branch: Option<String>,
    ) -> Result<(), TargetConnectorError>;
}

#[derive(Clone, Debug)]
pub struct FileTargetRegistry {
    path: PathBuf,
}

impl FileTargetRegistry {
    #[must_use]
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }

    fn with_state<T>(
        &self,
        mutate: bool,
        operation: impl FnOnce(&mut RegistryState) -> Result<T, TargetConnectorError>,
    ) -> Result<T, TargetConnectorError> {
        let parent = self
            .path
            .parent()
            .ok_or(TargetConnectorError::RegistryPath("path has no parent"))?;
        create_private_directory(parent)?;
        let lock = open_lock(&self.path.with_extension("lock"))?;
        lock_registry(&lock, mutate)?;
        let mut state = read_registry(&self.path)?;
        let result = operation(&mut state)?;
        if mutate {
            write_registry(&self.path, &state)?;
        }
        Ok(result)
    }
}

impl TargetRegistry for FileTargetRegistry {
    fn insert(&self, target: TargetRecord) -> Result<(), TargetConnectorError> {
        self.with_state(true, |state| {
            if state.targets.contains_key(&target.name) {
                return Err(TargetConnectorError::AlreadyExists(target.name));
            }
            state.targets.insert(target.name.clone(), target);
            Ok(())
        })
    }

    fn get(&self, name: &str) -> Result<TargetRecord, TargetConnectorError> {
        self.with_state(false, |state| {
            state
                .targets
                .get(name)
                .cloned()
                .ok_or_else(|| TargetConnectorError::NotFound(name.to_owned()))
        })
    }

    fn setup(
        &self,
        name: &str,
        repository: String,
        default_branch: Option<String>,
    ) -> Result<(), TargetConnectorError> {
        self.with_state(true, |state| {
            let target = state
                .targets
                .get_mut(name)
                .ok_or_else(|| TargetConnectorError::NotFound(name.to_owned()))?;
            target.repository = Some(repository);
            target.default_branch = default_branch;
            Ok(())
        })
    }
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct RegistryState {
    version: u32,
    targets: BTreeMap<String, TargetRecord>,
}

impl Default for RegistryState {
    fn default() -> Self {
        Self {
            version: REGISTRY_VERSION,
            targets: BTreeMap::new(),
        }
    }
}

pub fn default_target_registry_path() -> Result<PathBuf, TargetConnectorError> {
    if let Some(path) = nonempty_env("ZEROSHOT_RUST_CONFIG_DIR") {
        return Ok(PathBuf::from(path).join("targets.json"));
    }
    platform_config_root().map(|root| root.join("zeroshot-rust").join("targets.json"))
}

pub(super) fn open_lock(path: &Path) -> Result<File, TargetConnectorError> {
    let mut options = OpenOptions::new();
    options.create(true).read(true).write(true);
    set_private_file_mode(&mut options);
    options.open(path).map_err(TargetConnectorError::RegistryIo)
}

pub(super) fn lock_registry(lock: &File, exclusive: bool) -> Result<(), TargetConnectorError> {
    if exclusive {
        lock.lock_exclusive()
            .map_err(TargetConnectorError::RegistryIo)
    } else {
        FileExt::lock_shared(lock).map_err(TargetConnectorError::RegistryIo)
    }
}

fn read_registry(path: &Path) -> Result<RegistryState, TargetConnectorError> {
    let Some(mut file) = open_registry(path)? else {
        return Ok(RegistryState::default());
    };
    let metadata = file.metadata().map_err(TargetConnectorError::RegistryIo)?;
    if metadata.len() > MAX_REGISTRY_BYTES {
        return Err(TargetConnectorError::RegistryTooLarge);
    }
    let capacity =
        usize::try_from(metadata.len()).map_err(|_| TargetConnectorError::RegistryTooLarge)?;
    let mut bytes = Vec::with_capacity(capacity);
    file.read_to_end(&mut bytes)
        .map_err(TargetConnectorError::RegistryIo)?;
    let state: RegistryState =
        serde_json::from_slice(&bytes).map_err(TargetConnectorError::RegistryJson)?;
    validate_registry_state(&state)?;
    Ok(state)
}

fn open_registry(path: &Path) -> Result<Option<File>, TargetConnectorError> {
    match File::open(path) {
        Ok(file) => Ok(Some(file)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(TargetConnectorError::RegistryIo(error)),
    }
}

fn validate_registry_state(state: &RegistryState) -> Result<(), TargetConnectorError> {
    if state.version != REGISTRY_VERSION {
        return Err(malformed_registry("unsupported target registry version"));
    }
    for (name, target) in &state.targets {
        if name != &target.name
            || validate_target_name(name).is_err()
            || !matches!(normalize_origin(&target.origin), Ok(origin) if origin == target.origin)
            || !valid_uuid(&target.id)
            || !valid_target_access(&target.access)
            || !valid_target_source(target)
        {
            return Err(malformed_registry("invalid stored target record"));
        }
    }
    Ok(())
}

fn valid_target_source(target: &TargetRecord) -> bool {
    match &target.repository {
        None => target.default_branch.is_none(),
        Some(repository) => {
            SourceRepositoryId::new(repository).is_ok()
                && target
                    .default_branch
                    .as_deref()
                    .is_none_or(|branch| SourceBranchId::new(branch).is_ok())
        }
    }
}

fn valid_target_access(access: &TargetAccess) -> bool {
    match access {
        TargetAccess::Hosted { device_token } => valid_uuid(device_token),
        TargetAccess::Direct => true,
    }
}

fn valid_uuid(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(index, byte)| {
            if matches!(index, 8 | 13 | 18 | 23) {
                byte == b'-'
            } else {
                byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()
            }
        })
}

fn malformed_registry(message: &'static str) -> TargetConnectorError {
    TargetConnectorError::RegistryJson(serde_json::Error::io(std::io::Error::other(message)))
}

fn write_registry(path: &Path, state: &RegistryState) -> Result<(), TargetConnectorError> {
    let bytes = serde_json::to_vec_pretty(state).map_err(TargetConnectorError::RegistryJson)?;
    if bytes.len() as u64 > MAX_REGISTRY_BYTES {
        return Err(TargetConnectorError::RegistryTooLarge);
    }
    let mut suffix = [0_u8; 8];
    getrandom::fill(&mut suffix).map_err(|_| {
        TargetConnectorError::RegistryIo(std::io::Error::other(
            "target registry randomness unavailable",
        ))
    })?;
    let temporary = path.with_extension(format!("tmp-{}", encode_hex(&suffix)));
    let mut options = OpenOptions::new();
    options.create_new(true).write(true);
    set_private_file_mode(&mut options);
    let result = (|| {
        let mut file = options
            .open(&temporary)
            .map_err(TargetConnectorError::RegistryIo)?;
        file.write_all(&bytes)
            .map_err(TargetConnectorError::RegistryIo)?;
        file.sync_all().map_err(TargetConnectorError::RegistryIo)?;
        std::fs::rename(&temporary, path).map_err(TargetConnectorError::RegistryIo)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result
}

pub(super) fn encode_hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    let mut result = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        let _ = write!(&mut result, "{byte:02x}");
    }
    result
}

pub(super) fn create_private_directory(path: &Path) -> Result<(), TargetConnectorError> {
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    set_private_directory_mode(&mut builder);
    builder
        .create(path)
        .map_err(TargetConnectorError::RegistryIo)
}

#[cfg(unix)]
fn set_private_file_mode(options: &mut OpenOptions) {
    use std::os::unix::fs::OpenOptionsExt;
    options.mode(0o600);
}

#[cfg(not(unix))]
fn set_private_file_mode(_options: &mut OpenOptions) {}

#[cfg(unix)]
fn set_private_directory_mode(builder: &mut std::fs::DirBuilder) {
    use std::os::unix::fs::DirBuilderExt;
    builder.mode(0o700);
}

#[cfg(not(unix))]
fn set_private_directory_mode(_builder: &mut std::fs::DirBuilder) {}

fn nonempty_env(name: &str) -> Option<std::ffi::OsString> {
    std::env::var_os(name).filter(|value| !value.is_empty())
}

#[cfg(target_os = "windows")]
fn platform_config_root() -> Result<PathBuf, TargetConnectorError> {
    nonempty_env("LOCALAPPDATA")
        .map(PathBuf::from)
        .ok_or(TargetConnectorError::RegistryPath(
            "LOCALAPPDATA is unavailable",
        ))
}

#[cfg(target_os = "macos")]
fn platform_config_root() -> Result<PathBuf, TargetConnectorError> {
    nonempty_env("HOME")
        .map(|home| {
            PathBuf::from(home)
                .join("Library")
                .join("Application Support")
        })
        .ok_or(TargetConnectorError::RegistryPath("HOME is unavailable"))
}

#[cfg(all(unix, not(target_os = "macos")))]
fn platform_config_root() -> Result<PathBuf, TargetConnectorError> {
    if let Some(path) = nonempty_env("XDG_CONFIG_HOME") {
        return Ok(PathBuf::from(path));
    }
    nonempty_env("HOME")
        .map(|home| PathBuf::from(home).join(".config"))
        .ok_or(TargetConnectorError::RegistryPath("HOME is unavailable"))
}
