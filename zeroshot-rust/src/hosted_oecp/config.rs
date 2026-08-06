use std::env;
use std::io;
use std::process::Stdio;

use tokio::process::Command;
use tokio::time::{timeout, Duration};
use url::Url;

pub const HOSTED_CREDENTIALS_ENV: &str = "ZEROSHOT_HOSTED_CREDENTIALS_JSON";
pub(super) const HOSTED_REPOSITORY_ENV: &str = "ZEROSHOT_HOSTED_REPOSITORY";
pub(super) const HOSTED_BASE_REVISION_ENV: &str = "ZEROSHOT_HOSTED_BASE_REVISION";
pub(super) const HOSTED_PROVIDER_ENV: &str = "ZEROSHOT_HOSTED_PROVIDER";
pub(super) const HOSTED_MODEL_LEVEL_ENV: &str = "ZEROSHOT_HOSTED_MODEL_LEVEL";
pub(super) const HOSTED_PROVIDER_ENDPOINT_ENV: &str = "OPENAI_BASE_URL";
const NODE_PROGRAM: &str = "/usr/local/bin/node";
const CONFIG_CHECK_PROGRAM: &str = "/opt/zeroshot/zeroshot-rust/hosted-node/config-check.js";
const CONFIG_CHECK_DEADLINE: Duration = Duration::from_secs(10);
const HOSTED_PATH: &str = "/opt/zeroshot/node_modules/.bin:/usr/local/bin:/usr/bin:/bin";

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HostedAuthorityConfig {
    pub repository: String,
    pub base_revision: String,
    pub provider: String,
    pub model_level: String,
    pub provider_endpoint: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HostedAuthority {
    repository: String,
    base_revision: String,
    provider: String,
    model_level: String,
    provider_endpoint: String,
}

impl HostedAuthority {
    pub fn from_environment() -> io::Result<Self> {
        Self::new(HostedAuthorityConfig {
            repository: required_environment(HOSTED_REPOSITORY_ENV)?,
            base_revision: required_environment(HOSTED_BASE_REVISION_ENV)?,
            provider: required_environment(HOSTED_PROVIDER_ENV)?,
            model_level: required_environment(HOSTED_MODEL_LEVEL_ENV)?,
            provider_endpoint: required_environment(HOSTED_PROVIDER_ENDPOINT_ENV)?,
        })
    }

    pub fn new(config: HostedAuthorityConfig) -> io::Result<Self> {
        let HostedAuthorityConfig {
            repository,
            base_revision,
            provider,
            model_level,
            provider_endpoint,
        } = config;
        if !valid_repository(&repository)
            || !valid_revision(&base_revision)
            || !valid_provider(&provider)
            || !matches!(model_level.as_str(), "level1" | "level2" | "level3")
            || !valid_provider_endpoint(&provider_endpoint)
        {
            return Err(invalid_configuration());
        }
        Ok(Self {
            repository,
            base_revision,
            provider,
            model_level,
            provider_endpoint,
        })
    }

    pub async fn verify_worker_configuration(&self) -> io::Result<()> {
        let mut command = Command::new(NODE_PROGRAM);
        command
            .arg(CONFIG_CHECK_PROGRAM)
            .env_clear()
            .env(HOSTED_REPOSITORY_ENV, &self.repository)
            .env(HOSTED_BASE_REVISION_ENV, &self.base_revision)
            .env(HOSTED_PROVIDER_ENV, &self.provider)
            .env(HOSTED_MODEL_LEVEL_ENV, &self.model_level)
            .env(HOSTED_PROVIDER_ENDPOINT_ENV, &self.provider_endpoint)
            .env("PATH", HOSTED_PATH)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        if let Ok(credentials) = env::var(HOSTED_CREDENTIALS_ENV) {
            command.env(HOSTED_CREDENTIALS_ENV, credentials);
        }
        let mut child = command.spawn().map_err(|_| invalid_configuration())?;
        let status = timeout(CONFIG_CHECK_DEADLINE, child.wait())
            .await
            .map_err(|_| invalid_configuration())?
            .map_err(|_| invalid_configuration())?;
        if status.success() {
            Ok(())
        } else {
            Err(invalid_configuration())
        }
    }

    #[must_use]
    pub fn repository(&self) -> &str {
        &self.repository
    }

    #[must_use]
    pub fn base_revision(&self) -> &str {
        &self.base_revision
    }

    #[must_use]
    pub fn provider(&self) -> &str {
        &self.provider
    }

    #[must_use]
    pub fn model_level(&self) -> &str {
        &self.model_level
    }

    #[must_use]
    pub fn provider_endpoint(&self) -> &str {
        &self.provider_endpoint
    }
}

fn required_environment(name: &str) -> io::Result<String> {
    env::var(name)
        .ok()
        .filter(|value| !value.is_empty())
        .ok_or_else(invalid_configuration)
}

fn invalid_configuration() -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidInput,
        "hosted runtime configuration is invalid",
    )
}

fn valid_repository(value: &str) -> bool {
    let Some((owner, repository)) = value.split_once('/') else {
        return false;
    };
    !owner.is_empty()
        && owner.len() <= 39
        && !repository.is_empty()
        && repository.len() <= 100
        && !repository.ends_with(".git")
        && !repository.contains('/')
        && valid_component(owner, false)
        && valid_component(repository, true)
}

fn valid_component(value: &str, repository: bool) -> bool {
    value.bytes().enumerate().all(|(index, byte)| {
        byte.is_ascii_lowercase()
            || byte.is_ascii_digit()
            || (byte == b'-' && index > 0 && index + 1 < value.len())
            || (repository && matches!(byte, b'.' | b'_') && index > 0)
    })
}

fn valid_revision(value: &str) -> bool {
    value.len() == 40
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn valid_provider(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_lowercase() || (index > 0 && (byte.is_ascii_digit() || byte == b'-'))
        })
}

fn valid_provider_endpoint(value: &str) -> bool {
    let Ok(endpoint) = Url::parse(value) else {
        return false;
    };
    endpoint.scheme() == "https"
        && endpoint.host_str().is_some()
        && endpoint.username().is_empty()
        && endpoint.password().is_none()
        && endpoint.query().is_none()
        && endpoint.fragment().is_none()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn authority() -> HostedAuthority {
        HostedAuthority::new(HostedAuthorityConfig {
            repository: "the-open-engine/zeroshot".to_owned(),
            base_revision: "a".repeat(40),
            provider: "codex".to_owned(),
            model_level: "level2".to_owned(),
            provider_endpoint: "https://openrouter.ai/api/v1".to_owned(),
        })
        .unwrap()
    }

    #[test]
    fn accepts_canonical_fixed_authority() {
        let authority = authority();
        assert_eq!(authority.repository(), "the-open-engine/zeroshot");
        assert_eq!(authority.base_revision(), "a".repeat(40));
        assert_eq!(authority.provider(), "codex");
        assert_eq!(authority.model_level(), "level2");
        assert_eq!(
            authority.provider_endpoint(),
            "https://openrouter.ai/api/v1"
        );
    }

    #[test]
    fn rejects_noncanonical_fixed_authority() {
        for (repository, revision, provider, level, endpoint) in [
            (
                "Owner/repo",
                "a".repeat(40),
                "codex",
                "level2",
                "https://openrouter.ai/api/v1",
            ),
            (
                "github.com/owner/repo",
                "a".repeat(40),
                "codex",
                "level2",
                "https://openrouter.ai/api/v1",
            ),
            (
                "owner/repo.git",
                "a".repeat(40),
                "codex",
                "level2",
                "https://openrouter.ai/api/v1",
            ),
            (
                "owner/repo",
                "abc".to_owned(),
                "codex",
                "level2",
                "https://openrouter.ai/api/v1",
            ),
            (
                "owner/repo",
                "a".repeat(40),
                "Codex",
                "level2",
                "https://openrouter.ai/api/v1",
            ),
            (
                "owner/repo",
                "a".repeat(40),
                "codex",
                "level4",
                "https://openrouter.ai/api/v1",
            ),
            (
                "owner/repo",
                "a".repeat(40),
                "codex",
                "level2",
                "http://openrouter.ai/api/v1",
            ),
            (
                "owner/repo",
                "a".repeat(40),
                "codex",
                "level2",
                "https://token@openrouter.ai/api/v1",
            ),
            (
                "owner/repo",
                "a".repeat(40),
                "codex",
                "level2",
                "https://openrouter.ai/api/v1?model=other",
            ),
        ] {
            assert!(
                HostedAuthority::new(HostedAuthorityConfig {
                    repository: repository.to_owned(),
                    base_revision: revision,
                    provider: provider.to_owned(),
                    model_level: level.to_owned(),
                    provider_endpoint: endpoint.to_owned(),
                })
                .is_err()
            );
        }
    }
}
