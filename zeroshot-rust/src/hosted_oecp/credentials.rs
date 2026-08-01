use std::{path::Path, sync::Arc};

use axum::{
    extract::{DefaultBodyLimit, State},
    http::StatusCode,
    routing::put,
    Json, Router,
};
use serde::Deserialize;
use tokio::{fs, process::Command, sync::Mutex};

use super::backend::HostedBackend;

pub const CREDENTIAL_PORT: u16 = 8_084;
const MAX_SECRET_BYTES: usize = 16 * 1024;
const DEFAULT_MODEL: &str = "openai/gpt-5.4";
const RUNTIME_ROOT: &str = "/workspace/.zeroshot-runtime";
const REPOSITORY_ROOT: &str = "/workspace/repository";

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CredentialBundle {
    github_token: String,
    openrouter_api_key: String,
    repository: String,
    #[serde(default = "default_model")]
    model: String,
}

fn default_model() -> String {
    DEFAULT_MODEL.to_owned()
}

impl CredentialBundle {
    fn validate(&self) -> Result<(), &'static str> {
        if self.github_token.trim().is_empty() || self.github_token.len() > 4_096 {
            return Err("githubToken must be nonempty and at most 4096 bytes");
        }
        if self.openrouter_api_key.trim().is_empty() || self.openrouter_api_key.len() > 4_096 {
            return Err("openrouterApiKey must be nonempty and at most 4096 bytes");
        }
        if !valid_repository(&self.repository) {
            return Err("repository must have the form owner/name");
        }
        if !valid_model(&self.model) {
            return Err("model must be an exact provider/model slug");
        }
        Ok(())
    }

    pub fn apply_to(&self, command: &mut Command) {
        command
            .env("GH_TOKEN", &self.github_token)
            .env("GITHUB_TOKEN", &self.github_token)
            .env("OPENROUTER_API_KEY", &self.openrouter_api_key)
            .env("ZEROSHOT_HOSTED_CODEX_OPENROUTER", "1")
            .env("ZEROSHOT_HOSTED_MODEL", &self.model)
            .env("HOME", RUNTIME_ROOT)
            .env("CODEX_HOME", format!("{RUNTIME_ROOT}/codex"))
            .env("TMPDIR", format!("{RUNTIME_ROOT}/tmp"))
            .env("GIT_TERMINAL_PROMPT", "0");
    }

    pub async fn prepare_workspace(&self) -> Result<(), String> {
        write_runtime_files(&self.model).await?;
        if Path::new(&format!("{REPOSITORY_ROOT}/.git")).exists() {
            return Ok(());
        }
        if Path::new(REPOSITORY_ROOT).exists() {
            fs::remove_dir_all(REPOSITORY_ROOT)
                .await
                .map_err(|error| format!("remove incomplete repository clone: {error}"))?;
        }
        fs::create_dir_all("/workspace")
            .await
            .map_err(|error| format!("create workspace: {error}"))?;
        let mut command = Command::new("git");
        command.args([
            "clone",
            "--filter=blob:none",
            &format!("https://github.com/{}.git", self.repository),
            REPOSITORY_ROOT,
        ]);
        self.apply_to(&mut command);
        command.env("GIT_ASKPASS", format!("{RUNTIME_ROOT}/git-askpass.sh"));
        let output = command
            .output()
            .await
            .map_err(|error| format!("start git clone: {error}"))?;
        if output.status.success() {
            Ok(())
        } else {
            Err(format!(
                "git clone failed with status {}: {}",
                output.status,
                String::from_utf8_lossy(&output.stderr).trim()
            ))
        }
    }
}

fn valid_repository(value: &str) -> bool {
    let mut parts = value.split('/');
    let owner = parts.next().unwrap_or_default();
    let name = parts.next().unwrap_or_default();
    !owner.is_empty()
        && !name.is_empty()
        && !matches!(owner, "." | "..")
        && !matches!(name, "." | "..")
        && parts.next().is_none()
        && owner.bytes().all(valid_repo_byte)
        && name.bytes().all(valid_repo_byte)
}

fn valid_model(value: &str) -> bool {
    if value.len() > 256 {
        return false;
    }
    let Some((provider, model)) = value.split_once('/') else {
        return false;
    };
    provider
        .as_bytes()
        .first()
        .is_some_and(u8::is_ascii_alphanumeric)
        && model
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphanumeric)
        && !model.contains('/')
        && provider
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
        && model
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
}

fn valid_repo_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.')
}

async fn write_runtime_files(model: &str) -> Result<(), String> {
    fs::create_dir_all(format!("{RUNTIME_ROOT}/codex"))
        .await
        .map_err(|error| format!("create Codex runtime directory: {error}"))?;
    fs::create_dir_all(format!("{RUNTIME_ROOT}/tmp"))
        .await
        .map_err(|error| format!("create temporary runtime directory: {error}"))?;
    let escaped_model = model.replace('\\', "\\\\").replace('"', "\\\"");
    let config = format!(
        "model_provider = \"openrouter\"\nmodel = \"{escaped_model}\"\n\
         model_reasoning_effort = \"high\"\napproval_policy = \"never\"\n\
         sandbox_mode = \"danger-full-access\"\nweb_search = \"disabled\"\n\n\
         [model_providers.openrouter]\nname = \"OpenRouter\"\n\
         base_url = \"https://openrouter.ai/api/v1\"\nenv_key = \"OPENROUTER_API_KEY\"\n\
         wire_api = \"responses\"\n\n[projects.\"{REPOSITORY_ROOT}\"]\ntrust_level = \"trusted\"\n"
    );
    fs::write(format!("{RUNTIME_ROOT}/codex/config.toml"), config)
        .await
        .map_err(|error| format!("write Codex runtime config: {error}"))?;
    fs::write(
        format!("{RUNTIME_ROOT}/git-askpass.sh"),
        "#!/bin/sh\ncase \"$1\" in\n  *Username*) printf '%s\\n' x-access-token ;;\n  *) printf '%s\\n' \"$GH_TOKEN\" ;;\nesac\n",
    )
    .await
    .map_err(|error| format!("write git credential helper: {error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(
            format!("{RUNTIME_ROOT}/git-askpass.sh"),
            std::fs::Permissions::from_mode(0o700),
        )
        .await
        .map_err(|error| format!("protect git credential helper: {error}"))?;
    }
    Ok(())
}

pub fn router(backend: Arc<HostedBackend>) -> Router {
    Router::new()
        .route("/internal/credentials", put(install))
        .layer(DefaultBodyLimit::max(MAX_SECRET_BYTES))
        .with_state(backend)
}

async fn install(
    State(backend): State<Arc<HostedBackend>>,
    Json(bundle): Json<CredentialBundle>,
) -> Result<StatusCode, (StatusCode, &'static str)> {
    bundle
        .validate()
        .map_err(|message| (StatusCode::BAD_REQUEST, message))?;
    backend
        .install_credentials(bundle)
        .await
        .map_err(|message| (StatusCode::CONFLICT, message))?;
    Ok(StatusCode::NO_CONTENT)
}

pub type CredentialSlot = Arc<Mutex<Option<CredentialBundle>>>;

#[cfg(test)]
mod tests {
    use super::CredentialBundle;
    use crate::hosted_oecp::HostedBackend;

    fn bundle() -> CredentialBundle {
        CredentialBundle {
            github_token: "github".to_owned(),
            openrouter_api_key: "openrouter".to_owned(),
            repository: "the-open-engine/zeroshot".to_owned(),
            model: "openai/gpt-5.4".to_owned(),
        }
    }

    #[test]
    fn credential_contract_is_closed_and_bounded() {
        assert!(bundle().validate().is_ok());
        let mut invalid = bundle();
        invalid.repository = "owner/repo/extra".to_owned();
        assert!(invalid.validate().is_err());
        let mut invalid = bundle();
        invalid.repository = "../repo".to_owned();
        assert!(invalid.validate().is_err());
        let mut invalid = bundle();
        invalid.repository = "owner/..".to_owned();
        assert!(invalid.validate().is_err());
        let mut invalid = bundle();
        invalid.model = "model-without-provider".to_owned();
        assert!(invalid.validate().is_err());
        let mut invalid = bundle();
        invalid.model = "openai/gpt-5.4\napproval_policy = \"never\"".to_owned();
        assert!(invalid.validate().is_err());
    }

    #[tokio::test]
    async fn credentials_can_only_be_installed_once() {
        let backend = HostedBackend::new();
        assert!(backend.install_credentials(bundle()).await.is_ok());
        assert_eq!(
            backend.install_credentials(bundle()).await,
            Err("credentials are already installed")
        );
    }
}
