use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Arc;

use async_trait::async_trait;
use serde::Deserialize;
use serde_json::Value;
use tokio::fs;
use tokio::process::Command;
use tokio::sync::Mutex;

use super::config::{
    valid_identifier, valid_repository, valid_revision, HostedAuthority, HostedAuthorityConfig,
};
use super::ports::WORKSPACE_ROOT;

pub(super) const MAX_CREDENTIAL_BYTES: usize = 4 * 1024 * 1024;
const RUNTIME_ROOT: &str = "/tmp/zeroshot-oecp/runtime";
const SETTINGS_FILE: &str = "/tmp/zeroshot-oecp/runtime/settings.json";
const SETTINGS_RUNTIME_PATH: &str = "settings.json";
const WORKER_UID: u32 = 10_002;
const WORKER_GID: u32 = 10_002;
const RUNTIME_DIRECTORY_MODE: u32 = 0o770;
const RUNTIME_FILE_MODE: u32 = 0o660;
const RUNTIME_EXECUTABLE_MODE: u32 = 0o770;

#[derive(Deserialize)]
#[serde(transparent)]
struct SecretString(String);

impl SecretString {
    fn expose(&self) -> &str {
        &self.0
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct RuntimeConfig {
    provider: String,
    executable: String,
    model: Option<String>,
    command: Option<SecretString>,
    setup_command: Option<SecretString>,
    environment: BTreeMap<String, SecretString>,
    files: BTreeMap<String, SecretString>,
    settings: Value,
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
    let invalid = environment.len() > 256
        || environment.iter().any(|(name, value)| {
            !valid_environment_name(name)
                || reserved_environment_name(name)
                || value.expose().len() > 64 * 1_024
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
    github_token: SecretString,
    repository: String,
    base_revision: String,
    runtime: RuntimeConfig,
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
        self.runtime.validate()
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
        environment
    }

    pub(super) async fn prepare_workspace(&self) -> Result<(), String> {
        write_runtime_files(&self.runtime).await?;
        if let Some(setup_command) = &self.runtime.setup_command {
            let mut command = Command::new("sh");
            command.args(["-c", setup_command.expose()]);
            self.apply_setup_to(&mut command);
            run(&mut command, "runtime setup").await?;
        }
        clone_exact_repository(self).await
    }

    fn apply_setup_to(&self, command: &mut Command) {
        command.env_clear();
        for (name, value) in &self.runtime.environment {
            command.env(name, value.expose());
        }
        command.envs(common_environment());
        configure_worker_identity(command);
    }

    fn apply_git_to(&self, command: &mut Command) {
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

fn common_environment() -> BTreeMap<String, String> {
    let inherited_path =
        std::env::var("PATH").unwrap_or_else(|_| "/usr/local/bin:/usr/bin:/bin".to_owned());
    BTreeMap::from([
        ("HOME".to_owned(), RUNTIME_ROOT.to_owned()),
        ("LANG".to_owned(), "C.UTF-8".to_owned()),
        ("NODE_ENV".to_owned(), "production".to_owned()),
        (
            "PATH".to_owned(),
            format!("{RUNTIME_ROOT}/.local/bin:{RUNTIME_ROOT}/bin:{inherited_path}"),
        ),
        ("TMPDIR".to_owned(), format!("{RUNTIME_ROOT}/tmp")),
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
    let mut clone = Command::new("git");
    clone.args([
        "-c",
        "credential.helper=",
        "-c",
        "core.hooksPath=/dev/null",
        "clone",
        "--no-checkout",
        "--origin",
        "origin",
        &remote,
        WORKSPACE_ROOT,
    ]);
    credentials.apply_git_to(&mut clone);
    run(&mut clone, "git clone").await?;

    let mut checkout = Command::new("git");
    checkout.args([
        "-c",
        "credential.helper=",
        "-c",
        "core.hooksPath=/dev/null",
        "-C",
        WORKSPACE_ROOT,
        "checkout",
        "--detach",
        &credentials.base_revision,
    ]);
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
    let mut command = Command::new("git");
    command
        .args(["-c", "credential.helper=", "-c", "core.hooksPath=/dev/null"])
        .arg("-C")
        .arg(WORKSPACE_ROOT)
        .args(args);
    credentials.apply_git_to(&mut command);
    run(&mut command, operation)
        .await
        .map(|output| String::from_utf8_lossy(&output).into_owned())
}

async fn write_runtime_files(runtime: &RuntimeConfig) -> Result<(), String> {
    prepare_runtime_directories().await?;
    write_runtime_settings(&runtime.settings).await?;
    write_runtime_payload_files(&runtime.files).await?;
    write_runtime_wrapper(runtime).await
}

async fn prepare_runtime_directories() -> Result<(), String> {
    let directories = [
        RUNTIME_ROOT.to_owned(),
        format!("{RUNTIME_ROOT}/tmp"),
        format!("{RUNTIME_ROOT}/bin"),
        format!("{RUNTIME_ROOT}/.local"),
        format!("{RUNTIME_ROOT}/.local/bin"),
    ];
    for directory in directories {
        fs::create_dir_all(&directory)
            .await
            .map_err(|error| format!("create runtime directory: {error}"))?;
        set_runtime_access(&directory, RUNTIME_DIRECTORY_MODE).await?;
    }
    Ok(())
}

async fn write_runtime_settings(settings: &Value) -> Result<(), String> {
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
        let wrapper = format!("{RUNTIME_ROOT}/bin/{}", runtime.executable);
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
            | "NODE_ENV"
            | "PATH"
            | "TMPDIR"
            | "ZEROSHOT_HOSTED_BASE_REVISION"
            | "ZEROSHOT_HOSTED_EXECUTABLE"
            | "ZEROSHOT_HOSTED_MODEL"
            | "ZEROSHOT_HOSTED_PROVIDER"
            | "ZEROSHOT_HOSTED_REPOSITORY"
            | "ZEROSHOT_ISOLATION_PROFILE"
            | "ZEROSHOT_PROVIDER_PROFILE"
            | "ZEROSHOT_SETTINGS_FILE"
    )
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

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::{
        CredentialInstallError, CredentialStore, RUNTIME_DIRECTORY_MODE, RUNTIME_EXECUTABLE_MODE,
        RUNTIME_FILE_MODE,
    };
    use serde_json::json;

    fn bundle(provider: &str, environment: serde_json::Value) -> Vec<u8> {
        serde_json::to_vec(&json!({
            "githubToken": "github-canary",
            "repository": "the-open-engine/zeroshot",
            "baseRevision": "a".repeat(40),
            "runtime": {
                "provider": provider,
                "executable": "future-cli",
                "model": "future/model",
                "command": "future-cli-wrapper",
                "setupCommand": "future-cli --version",
                "environment": environment,
                "files": {".config/future/config.json": "{\"enabled\":true}"},
                "settings": {"defaultProvider": provider}
            }
        }))
        .unwrap()
    }

    fn command_environment(command: &tokio::process::Command) -> BTreeMap<String, Option<String>> {
        command
            .as_std()
            .get_envs()
            .filter_map(|(key, value)| {
                Some((
                    key.to_str()?.to_owned(),
                    value.and_then(|item| item.to_str()).map(str::to_owned),
                ))
            })
            .collect()
    }

    #[tokio::test]
    async fn install_is_provider_neutral_bounded_and_exact_replay_idempotent() {
        let store = CredentialStore::default();
        let bytes = bundle(
            "future-provider",
            json!({
                "FUTURE_PROVIDER_TOKEN": "provider-canary",
                "FUTURE_PROVIDER_ENDPOINT": "https://models.example"
            }),
        );
        store.install(bytes.clone()).await.unwrap();
        store.install(bytes.clone()).await.unwrap();
        assert!(store.is_exact_replay(&bytes).await);
        assert_eq!(
            store
                .install(bundle("another-provider", json!({"OTHER_TOKEN": "secret"})))
                .await,
            Err(CredentialInstallError::Conflict)
        );

        let installed = store.resolve().await.unwrap();
        let environment = installed.worker_environment();
        assert_eq!(
            environment.get("FUTURE_PROVIDER_TOKEN").map(String::as_str),
            Some("provider-canary")
        );
        assert_eq!(installed.authority().provider(), "future-provider");
        assert_eq!(
            environment
                .get("ZEROSHOT_HOSTED_EXECUTABLE")
                .map(String::as_str),
            Some("future-cli")
        );
    }

    #[test]
    fn runtime_access_is_private_to_the_supervisor_and_worker_group() {
        assert_eq!(RUNTIME_DIRECTORY_MODE, 0o770);
        assert_eq!(RUNTIME_FILE_MODE, 0o660);
        assert_eq!(RUNTIME_EXECUTABLE_MODE, 0o770);
        assert_eq!(RUNTIME_DIRECTORY_MODE & 0o007, 0);
        assert_eq!(RUNTIME_FILE_MODE & 0o007, 0);
        assert_eq!(RUNTIME_EXECUTABLE_MODE & 0o007, 0);
    }

    #[tokio::test]
    async fn git_setup_and_worker_receive_only_their_owned_credentials() {
        let store = CredentialStore::default();
        store
            .install(bundle(
                "future-provider",
                json!({"FUTURE_PROVIDER_TOKEN": "provider-canary"}),
            ))
            .await
            .unwrap();
        let installed = store.resolve().await.unwrap();

        let mut git = tokio::process::Command::new("true");
        installed.apply_git_to(&mut git);
        let git_environment = command_environment(&git);
        assert_eq!(
            git_environment.get("GH_TOKEN"),
            Some(&Some("github-canary".to_owned()))
        );
        assert!(!git_environment.contains_key("FUTURE_PROVIDER_TOKEN"));

        let mut setup = tokio::process::Command::new("true");
        installed.apply_setup_to(&mut setup);
        let setup_environment = command_environment(&setup);
        assert_eq!(
            setup_environment.get("FUTURE_PROVIDER_TOKEN"),
            Some(&Some("provider-canary".to_owned()))
        );
        assert!(!setup_environment.contains_key("GH_TOKEN"));

        assert_eq!(
            installed
                .worker_environment()
                .get("FUTURE_PROVIDER_TOKEN")
                .map(String::as_str),
            Some("provider-canary")
        );
    }

    #[tokio::test]
    async fn install_rejects_reserved_environment_and_path_escape() {
        for environment_name in [
            "GH_TOKEN",
            "GITHUB_TOKEN",
            "GIT_ASKPASS",
            "GIT_CONFIG_GLOBAL",
            "GIT_CONFIG_NOSYSTEM",
            "GIT_TERMINAL_PROMPT",
            "HOME",
            "LANG",
            "NODE_ENV",
            "PATH",
            "TMPDIR",
            "ZEROSHOT_HOSTED_BASE_REVISION",
            "ZEROSHOT_HOSTED_EXECUTABLE",
            "ZEROSHOT_HOSTED_MODEL",
            "ZEROSHOT_HOSTED_PROVIDER",
            "ZEROSHOT_HOSTED_REPOSITORY",
            "ZEROSHOT_ISOLATION_PROFILE",
            "ZEROSHOT_PROVIDER_PROFILE",
            "ZEROSHOT_SETTINGS_FILE",
        ] {
            assert_eq!(
                CredentialStore::default()
                    .install(bundle(
                        "future-provider",
                        json!({(environment_name): "/untrusted"}),
                    ))
                    .await,
                Err(CredentialInstallError::Invalid)
            );
        }

        for filename in ["../escape", "settings.json", "settings.json/nested"] {
            let bytes = serde_json::to_vec(&json!({
                "githubToken": "github",
                "repository": "the-open-engine/zeroshot",
                "baseRevision": "a".repeat(40),
                "runtime": {
                    "provider": "future-provider",
                    "executable": "future-cli",
                    "environment": {},
                    "files": {(filename): "secret"},
                    "settings": {}
                }
            }))
            .unwrap();
            assert_eq!(
                CredentialStore::default().install(bytes).await,
                Err(CredentialInstallError::Invalid)
            );
        }
    }
}
