use std::collections::BTreeMap;
use std::sync::Arc;

use async_trait::async_trait;
use serde::Deserialize;
use serde_json::Value;
use tokio::process::Command;
use tokio::sync::Mutex;

use crate::execution::process::{MAX_PROCESS_ENV_BYTES, MAX_PROCESS_ENV_ITEMS};

use super::config::{
    valid_identifier, valid_repository, valid_revision, HostedAuthority, HostedAuthorityConfig,
};
use super::ports::{ISOLATION_PROFILE, PROVIDER_PROFILE, WORKSPACE_ROOT};

pub(super) const MAX_CREDENTIAL_BYTES: usize = 4 * 1024 * 1024;
pub(super) const RUNTIME_MOUNT_ROOT: &str = "/tmp/zeroshot-oecp";
pub(super) const RUNTIME_ROOT: &str = "/tmp/zeroshot-oecp/runtime";
pub(super) const EXECUTABLE_RUNTIME_ROOT: &str = "/workspace/.git/zeroshot-runtime";
pub(super) const SETTINGS_FILE: &str = "/tmp/zeroshot-oecp/runtime/settings.json";
const SETTINGS_RUNTIME_PATH: &str = "settings.json";
pub(super) const WORKER_UID: u32 = 10_002;
pub(super) const WORKER_GID: u32 = 10_002;
pub(super) const SHARED_MOUNT_MODE: u32 = 0o2770;
pub(super) const RUNTIME_DIRECTORY_MODE: u32 = 0o770;
pub(super) const RUNTIME_FILE_MODE: u32 = 0o660;
pub(super) const RUNTIME_EXECUTABLE_MODE: u32 = 0o770;
const DELIVERY_VERSION: &str = "zeroshot.delivery/v1";

#[derive(Deserialize)]
#[serde(transparent)]
pub(super) struct SecretString(String);

impl SecretString {
    pub(super) fn expose(&self) -> &str {
        &self.0
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(super) struct RuntimeConfig {
    pub(super) provider: String,
    pub(super) executable: String,
    pub(super) model: Option<String>,
    pub(super) command: Option<SecretString>,
    pub(super) setup_command: Option<SecretString>,
    pub(super) environment: BTreeMap<String, SecretString>,
    pub(super) files: BTreeMap<String, SecretString>,
    pub(super) settings: Value,
}

impl RuntimeConfig {
    fn validate(&self) -> Result<(), &'static str> {
        if !valid_identifier(&self.provider, 64) {
            return Err("runtime.provider must be a bounded runtime identifier");
        }
        if !valid_identifier(&self.executable, 128) {
            return Err("runtime.executable must be a bounded executable name");
        }
        if self
            .model
            .as_ref()
            .is_some_and(|model| model.trim().is_empty() || model.len() > 512)
        {
            return Err("runtime.model must be nonempty and at most 512 bytes");
        }
        validate_optional_command(
            &self.command,
            4_096,
            "runtime.command must be nonempty and at most 4096 bytes",
        )?;
        validate_optional_command(
            &self.setup_command,
            16 * 1_024,
            "runtime.setupCommand must be nonempty and at most 16384 bytes",
        )?;
        validate_runtime_environment(&self.environment)?;
        validate_runtime_files(&self.files)?;
        if !self.settings.is_object() {
            return Err("runtime.settings must be an object");
        }
        Ok(())
    }
}

fn validate_optional_command(
    value: &Option<SecretString>,
    maximum: usize,
    message: &'static str,
) -> Result<(), &'static str> {
    if value
        .as_ref()
        .is_some_and(|value| value.expose().trim().is_empty() || value.expose().len() > maximum)
    {
        return Err(message);
    }
    Ok(())
}

fn validate_runtime_environment(
    environment: &BTreeMap<String, SecretString>,
) -> Result<(), &'static str> {
    let invalid = environment.len() > MAX_PROCESS_ENV_ITEMS
        || environment.iter().any(|(name, value)| {
            !valid_environment_name(name)
                || reserved_environment_name(name)
                || value.expose().len() > MAX_PROCESS_ENV_BYTES
        });
    (!invalid)
        .then_some(())
        .ok_or("runtime.environment exceeds its name, count, or value bounds")
}

fn validate_runtime_files(files: &BTreeMap<String, SecretString>) -> Result<(), &'static str> {
    let invalid = files.len() > 128
        || files
            .iter()
            .any(|(name, value)| !valid_runtime_path(name) || value.expose().len() > 512 * 1_024);
    (!invalid)
        .then_some(())
        .ok_or("runtime.files exceeds its path, count, or value bounds")
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(super) struct CredentialBundle {
    pub(super) github_token: SecretString,
    pub(super) repository: String,
    pub(super) base_revision: String,
    delivery: DeliveryRequest,
    pub(super) runtime: RuntimeConfig,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
enum DeliveryMode {
    Pr,
    Ship,
}

impl DeliveryMode {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Pr => "pr",
            Self::Ship => "ship",
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct DeliveryRequest {
    version: String,
    mode: DeliveryMode,
    repository: String,
    target_branch: String,
    base_revision: String,
}

impl DeliveryRequest {
    fn validate_for(&self, repository: &str, base_revision: &str) -> Result<(), &'static str> {
        if self.version != DELIVERY_VERSION
            || self.repository != repository
            || self.base_revision != base_revision
            || !valid_branch(&self.target_branch)
        {
            return Err("delivery must be a matching zeroshot.delivery/v1 request");
        }
        Ok(())
    }
}

impl CredentialBundle {
    fn validate(&self) -> Result<(), &'static str> {
        if self.github_token.expose().trim().is_empty() || self.github_token.expose().len() > 4_096
        {
            return Err("githubToken must be nonempty and at most 4096 bytes");
        }
        if !valid_repository(&self.repository) {
            return Err("repository must have the form owner/name");
        }
        if !valid_revision(&self.base_revision) {
            return Err("baseRevision must be a lowercase 40-character commit");
        }
        self.delivery
            .validate_for(&self.repository, &self.base_revision)?;
        self.runtime.validate()?;
        validate_worker_environment_bounds(&self.worker_environment())
    }

    pub(super) fn authority(&self) -> HostedAuthority {
        HostedAuthority::new(HostedAuthorityConfig {
            repository: self.repository.clone(),
            base_revision: self.base_revision.clone(),
            provider: self.runtime.provider.clone(),
        })
        .expect("validated credential bundle has valid authority")
    }

    pub(super) fn worker_environment(&self) -> BTreeMap<String, String> {
        let mut environment = self
            .runtime
            .environment
            .iter()
            .map(|(name, value)| (name.clone(), value.expose().to_owned()))
            .collect::<BTreeMap<_, _>>();
        environment.extend(common_environment());
        environment.extend([
            ("GH_TOKEN".to_owned(), self.github_token.expose().to_owned()),
            (
                "GITHUB_TOKEN".to_owned(),
                self.github_token.expose().to_owned(),
            ),
            (
                "ZEROSHOT_HOSTED_REPOSITORY".to_owned(),
                self.repository.clone(),
            ),
            (
                "ZEROSHOT_HOSTED_BASE_REVISION".to_owned(),
                self.base_revision.clone(),
            ),
            (
                "ZEROSHOT_HOSTED_DELIVERY_MODE".to_owned(),
                self.delivery.mode.as_str().to_owned(),
            ),
            (
                "ZEROSHOT_HOSTED_DELIVERY_TARGET".to_owned(),
                self.delivery.target_branch.clone(),
            ),
            (
                "ZEROSHOT_HOSTED_DELIVERY_VERSION".to_owned(),
                DELIVERY_VERSION.to_owned(),
            ),
            (
                "ZEROSHOT_HOSTED_EXECUTABLE".to_owned(),
                self.runtime.executable.clone(),
            ),
            (
                "ZEROSHOT_HOSTED_PROVIDER".to_owned(),
                self.runtime.provider.clone(),
            ),
        ]);
        if let Some(model) = &self.runtime.model {
            environment.insert("ZEROSHOT_HOSTED_MODEL".to_owned(), model.clone());
        }
        environment.extend([
            (
                "ZEROSHOT_ISOLATION_PROFILE".to_owned(),
                ISOLATION_PROFILE.to_owned(),
            ),
            (
                "ZEROSHOT_PROVIDER_PROFILE".to_owned(),
                PROVIDER_PROFILE.to_owned(),
            ),
        ]);
        environment
    }

    pub(super) fn apply_setup_to(&self, command: &mut Command) {
        apply_uncredentialed_worker_to(command);
        for (name, value) in &self.runtime.environment {
            command.env(name, value.expose());
        }
    }

    pub(super) fn apply_git_to(&self, command: &mut Command) {
        command.env_clear();
        command
            .envs(common_environment())
            .env("GH_TOKEN", self.github_token.expose())
            .env("GITHUB_TOKEN", self.github_token.expose())
            .env(
                "GIT_ASKPASS",
                "/opt/zeroshot/zeroshot-rust/hosted-node/git-askpass.js",
            )
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_TERMINAL_PROMPT", "0");
        configure_worker_identity(command);
    }
}

pub(super) fn apply_uncredentialed_worker_to(command: &mut Command) {
    command
        .env_clear()
        .envs(common_environment())
        .current_dir(WORKSPACE_ROOT);
    configure_worker_identity(command);
}

fn common_environment() -> BTreeMap<String, String> {
    let inherited_path =
        std::env::var("PATH").unwrap_or_else(|_| "/usr/local/bin:/usr/bin:/bin".to_owned());
    BTreeMap::from([
        ("HOME".to_owned(), RUNTIME_ROOT.to_owned()),
        ("LANG".to_owned(), "C.UTF-8".to_owned()),
        ("NODE_ENV".to_owned(), "production".to_owned()),
        (
            "PATH".to_owned(),
            format!(
                "{EXECUTABLE_RUNTIME_ROOT}/.local/bin:{EXECUTABLE_RUNTIME_ROOT}/bin:{inherited_path}"
            ),
        ),
        ("TMPDIR".to_owned(), format!("{RUNTIME_ROOT}/tmp")),
        (
            "ZEROSHOT_HOSTED_EXEC_ROOT".to_owned(),
            EXECUTABLE_RUNTIME_ROOT.to_owned(),
        ),
        (
            "ZEROSHOT_SETTINGS_FILE".to_owned(),
            SETTINGS_FILE.to_owned(),
        ),
    ])
}

struct InstalledCredentials {
    exact_bytes: Vec<u8>,
    bundle: Arc<CredentialBundle>,
}

#[derive(Clone, Default)]
pub(super) struct CredentialStore {
    installed: Arc<Mutex<Option<InstalledCredentials>>>,
}

impl CredentialStore {
    pub(super) async fn is_exact_replay(&self, bytes: &[u8]) -> bool {
        self.installed
            .lock()
            .await
            .as_ref()
            .is_some_and(|installed| installed.exact_bytes == bytes)
    }

    pub(super) async fn install(&self, bytes: Vec<u8>) -> Result<(), CredentialInstallError> {
        let mut installed = self.installed.lock().await;
        if let Some(existing) = installed.as_ref() {
            return if existing.exact_bytes == bytes {
                Ok(())
            } else {
                Err(CredentialInstallError::Conflict)
            };
        }
        let bundle: CredentialBundle =
            serde_json::from_slice(&bytes).map_err(|_| CredentialInstallError::Invalid)?;
        bundle
            .validate()
            .map_err(|_| CredentialInstallError::Invalid)?;
        *installed = Some(InstalledCredentials {
            exact_bytes: bytes,
            bundle: Arc::new(bundle),
        });
        Ok(())
    }

    pub(super) async fn resolve(&self) -> Result<Arc<CredentialBundle>, CredentialInstallError> {
        self.installed
            .lock()
            .await
            .as_ref()
            .map(|installed| Arc::clone(&installed.bundle))
            .ok_or(CredentialInstallError::Missing)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum CredentialInstallError {
    Invalid,
    Missing,
    Conflict,
}

#[async_trait]
pub(super) trait CredentialInstaller: Send + Sync {
    async fn install_credentials(&self, bytes: Vec<u8>) -> Result<(), CredentialInstallError>;
}

fn valid_environment_name(value: &str) -> bool {
    value.len() <= 256
        && value
            .as_bytes()
            .first()
            .is_some_and(|byte| byte.is_ascii_alphabetic() || *byte == b'_')
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
}

fn validate_worker_environment_bounds(
    environment: &BTreeMap<String, String>,
) -> Result<(), &'static str> {
    let bytes = environment.iter().try_fold(0usize, |total, (name, value)| {
        total
            .checked_add(name.len())
            .and_then(|subtotal| subtotal.checked_add(value.len()))
            .and_then(|subtotal| subtotal.checked_add(2))
    });
    if environment.len() > MAX_PROCESS_ENV_ITEMS
        || bytes.is_none_or(|bytes| bytes > MAX_PROCESS_ENV_BYTES)
    {
        return Err("runtime.environment exceeds the worker process bounds");
    }
    Ok(())
}

fn reserved_environment_name(value: &str) -> bool {
    matches!(
        value,
        "GH_TOKEN"
            | "GITHUB_TOKEN"
            | "GIT_ASKPASS"
            | "GIT_CONFIG_GLOBAL"
            | "GIT_CONFIG_NOSYSTEM"
            | "GIT_TERMINAL_PROMPT"
            | "HOME"
            | "LANG"
            | "LD_AUDIT"
            | "LD_LIBRARY_PATH"
            | "LD_PRELOAD"
            | "NODE_ENV"
            | "NODE_OPTIONS"
            | "PATH"
            | "TMPDIR"
            | "ZEROSHOT_HOSTED_BASE_REVISION"
            | "ZEROSHOT_HOSTED_DELIVERY_MODE"
            | "ZEROSHOT_HOSTED_DELIVERY_TARGET"
            | "ZEROSHOT_HOSTED_DELIVERY_VERSION"
            | "ZEROSHOT_HOSTED_EXECUTABLE"
            | "ZEROSHOT_HOSTED_EXEC_ROOT"
            | "ZEROSHOT_HOSTED_MODEL"
            | "ZEROSHOT_HOSTED_PROVIDER"
            | "ZEROSHOT_HOSTED_REPOSITORY"
            | "ZEROSHOT_ISOLATION_PROFILE"
            | "ZEROSHOT_PROVIDER_PROFILE"
            | "ZEROSHOT_SETTINGS_FILE"
    )
}

fn valid_branch(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 255
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'/' | b'-'))
        && value
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphanumeric)
        && !value.contains("..")
        && !value.contains("@{")
        && !value.contains("//")
        && !value.ends_with(['.', '/'])
}

fn valid_runtime_path(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 512
        && !value.starts_with('/')
        && !value.contains('\\')
        && value != SETTINGS_RUNTIME_PATH
        && !value
            .strip_prefix(SETTINGS_RUNTIME_PATH)
            .is_some_and(|suffix| suffix.starts_with('/'))
        && value
            .split('/')
            .all(|segment| !segment.is_empty() && !matches!(segment, "." | ".."))
}

#[cfg(unix)]
fn configure_worker_identity(command: &mut Command) {
    command.uid(WORKER_UID).gid(WORKER_GID);
}

#[cfg(not(unix))]
fn configure_worker_identity(_command: &mut Command) {}
