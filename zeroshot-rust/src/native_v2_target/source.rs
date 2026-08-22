use std::path::PathBuf;
use std::time::Duration;

use async_trait::async_trait;
use openengine_cluster_protocol::{
    ResolvedSource, SourceBranchId, SourceRepositoryId, SourceRevisionId,
};
use tokio::process::Command;

use zeroshot_engine::native_v2_delivery::git_auth::encode_basic_credential;
use super::TargetConnectorError;

const SOURCE_RESOLUTION_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const MAX_GIT_OUTPUT_BYTES: usize = 4_096;

#[async_trait]
pub trait TargetSourceResolver: Send + Sync {
    async fn resolve(
        &self,
        repository: &str,
        branch: Option<&str>,
        github_token: Option<&str>,
    ) -> Result<ResolvedSource, TargetConnectorError>;
}

#[derive(Clone, Debug)]
pub struct GitHubTargetSourceResolver {
    git_program: PathBuf,
}

impl GitHubTargetSourceResolver {
    #[must_use]
    pub fn production() -> Self {
        Self {
            git_program: std::env::var_os("ZEROSHOT_RUST_TARGET_GIT_PROGRAM")
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from("git")),
        }
    }
}

#[async_trait]
impl TargetSourceResolver for GitHubTargetSourceResolver {
    async fn resolve(
        &self,
        repository: &str,
        branch: Option<&str>,
        github_token: Option<&str>,
    ) -> Result<ResolvedSource, TargetConnectorError> {
        let repository = SourceRepositoryId::new(repository)
            .map_err(|_| TargetConnectorError::InvalidRepository)?;
        let source = format!("https://github.com/{}.git", repository.as_str());
        let output = git_ls_remote(&self.git_program, &source, branch, github_token).await?;
        let (branch, revision) = match branch {
            Some(branch) => {
                let branch = SourceBranchId::new(branch)
                    .map_err(|_| TargetConnectorError::SourceResolution)?;
                let reference = format!("refs/heads/{}", branch.as_str());
                let revision = remote_revision(&output, &reference)?;
                (branch, revision)
            }
            None => {
                let branch = output
                    .lines()
                    .find_map(|line| {
                        line.strip_prefix("ref: refs/heads/")?
                            .strip_suffix("\tHEAD")
                    })
                    .ok_or(TargetConnectorError::SourceResolution)?;
                let branch = SourceBranchId::new(branch)
                    .map_err(|_| TargetConnectorError::SourceResolution)?;
                let revision = remote_revision(&output, "HEAD")?;
                (branch, revision)
            }
        };
        Ok(ResolvedSource {
            repository,
            branch,
            revision,
        })
    }
}

async fn git_ls_remote(
    program: &PathBuf,
    source: &str,
    branch: Option<&str>,
    github_token: Option<&str>,
) -> Result<String, TargetConnectorError> {
    let mut command = Command::new(program);
    command
        .kill_on_drop(true)
        .env_clear()
        .env("LANG", "C")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_TERMINAL_PROMPT", "0")
        .arg("-c")
        .arg("core.hooksPath=/dev/null")
        .arg("ls-remote");
    if branch.is_none() {
        command.arg("--symref");
    }
    command.arg(source);
    if let Some(branch) = branch {
        command.arg(format!("refs/heads/{branch}"));
    } else {
        command.arg("HEAD");
    }
    if let Some(token) = github_token {
        command
            .env("GIT_CONFIG_COUNT", "2")
            .env("GIT_CONFIG_KEY_0", "credential.helper")
            .env("GIT_CONFIG_VALUE_0", "")
            .env("GIT_CONFIG_KEY_1", "http.https://github.com/.extraheader")
            .env(
                "GIT_CONFIG_VALUE_1",
                format!("AUTHORIZATION: basic {}", encode_basic_credential(token)),
            );
    }
    let output = tokio::time::timeout(SOURCE_RESOLUTION_TIMEOUT, command.output())
        .await
        .map_err(|_| TargetConnectorError::SourceResolution)?
        .map_err(|_| TargetConnectorError::SourceResolution)?;
    if !output.status.success() || output.stdout.len() > MAX_GIT_OUTPUT_BYTES {
        return Err(TargetConnectorError::SourceResolution);
    }
    String::from_utf8(output.stdout).map_err(|_| TargetConnectorError::SourceResolution)
}

fn remote_revision(
    output: &str,
    reference: &str,
) -> Result<SourceRevisionId, TargetConnectorError> {
    let expected = format!("\t{reference}");
    let mut revisions = output
        .lines()
        .filter_map(|line| line.strip_suffix(&expected))
        .filter_map(|revision| SourceRevisionId::new(revision).ok());
    let revision = revisions
        .next()
        .ok_or(TargetConnectorError::SourceResolution)?;
    if revisions.next().is_some() {
        return Err(TargetConnectorError::SourceResolution);
    }
    Ok(revision)
}

#[cfg(test)]
mod tests {
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;

    use super::*;

    #[test]
    fn parses_exact_remote_revision_without_accepting_ambiguity() {
        let revision = "0123456789abcdef0123456789abcdef01234567";
        let parsed = remote_revision(&format!("{revision}\trefs/heads/main\n"), "refs/heads/main");
        assert!(
            parsed
                .as_ref()
                .is_ok_and(|parsed| parsed.as_str() == revision)
        );
        assert!(
            remote_revision(
                &format!("{revision}\trefs/heads/main\n{revision}\trefs/heads/main\n"),
                "refs/heads/main"
            )
            .is_err()
        );
    }

    #[test]
    fn basic_git_credential_matches_the_github_shape() {
        assert_eq!(
            encode_basic_credential("test-token"),
            "eC1hY2Nlc3MtdG9rZW46dGVzdC10b2tlbg=="
        );
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn git_credential_uses_private_environment_and_never_argv() {
        let root = std::env::temp_dir().join(format!(
            "zeroshot-source-resolver-{}-{}",
            std::process::id(),
            uuid::Uuid::now_v7()
        ));
        assert!(std::fs::create_dir(&root).is_ok());
        let program = root.join("git-fixture");
        assert!(
            std::fs::write(
                &program,
                concat!(
                    "#!/bin/sh\n",
                    "case \" $* \" in *test-token*) exit 71;; esac\n",
                    "test \"$GIT_CONFIG_VALUE_1\" = ",
                    "'AUTHORIZATION: basic eC1hY2Nlc3MtdG9rZW46dGVzdC10b2tlbg==' || exit 72\n",
                    "printf '0123456789abcdef0123456789abcdef01234567\\trefs/heads/main\\n'\n",
                ),
            )
            .is_ok()
        );
        assert!(std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o700)).is_ok());

        let output = git_ls_remote(
            &program,
            "https://github.com/openai/example.git",
            Some("main"),
            Some("test-token"),
        )
        .await;
        assert!(output.is_ok());
        let Ok(output) = output else {
            let _ = std::fs::remove_dir_all(root);
            return;
        };
        assert!(output.ends_with("\trefs/heads/main\n"));

        assert!(std::fs::remove_dir_all(root).is_ok());
    }
}
