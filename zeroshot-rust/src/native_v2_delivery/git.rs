use std::path::{Path, PathBuf};
use std::process::Stdio;

use tokio::process::Command;

use super::valid_revision;

const COMMIT_MESSAGE: &str = "feat: complete Zeroshot task";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum GitError {
    NoMutation,
    Command,
}

#[derive(Clone)]
pub(super) struct SystemGit {
    program: PathBuf,
}

impl SystemGit {
    pub(super) fn new(program: PathBuf) -> Self {
        Self { program }
    }

    pub(super) async fn prepare_revision(
        &self,
        workspace: &Path,
        base_revision: &str,
    ) -> Result<String, GitError> {
        self.require_success(workspace, &["add", "--all"]).await?;
        let staged = self
            .exit_code(workspace, &["diff", "--cached", "--quiet", "--exit-code"])
            .await?;
        match staged {
            0 => {}
            1 => {
                self.require_success(
                    workspace,
                    &[
                        "-c",
                        "user.name=Zeroshot",
                        "-c",
                        "user.email=delivery@zeroshot.invalid",
                        "commit",
                        "--no-verify",
                        "--message",
                        COMMIT_MESSAGE,
                    ],
                )
                .await?;
            }
            _ => return Err(GitError::Command),
        }
        let revision = self.capture(workspace, &["rev-parse", "HEAD"]).await?;
        let revision = revision.trim().to_owned();
        if !valid_revision(&revision) {
            return Err(GitError::Command);
        }
        if revision == base_revision {
            return Err(GitError::NoMutation);
        }
        Ok(revision)
    }

    async fn require_success(&self, workspace: &Path, arguments: &[&str]) -> Result<(), GitError> {
        (self.exit_code(workspace, arguments).await? == 0)
            .then_some(())
            .ok_or(GitError::Command)
    }

    async fn exit_code(&self, workspace: &Path, arguments: &[&str]) -> Result<i32, GitError> {
        self.command(workspace, arguments)
            .status()
            .await
            .map_err(|_| GitError::Command)?
            .code()
            .ok_or(GitError::Command)
    }

    async fn capture(&self, workspace: &Path, arguments: &[&str]) -> Result<String, GitError> {
        let output = self
            .command(workspace, arguments)
            .stdout(Stdio::piped())
            .output()
            .await
            .map_err(|_| GitError::Command)?;
        if !output.status.success() || output.stdout.len() > 4_096 {
            return Err(GitError::Command);
        }
        String::from_utf8(output.stdout).map_err(|_| GitError::Command)
    }

    fn command(&self, workspace: &Path, arguments: &[&str]) -> Command {
        let mut command = Command::new(&self.program);
        command
            .env_clear()
            .env("LANG", "C")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .arg("-c")
            .arg("core.hooksPath=/dev/null")
            .arg("-C")
            .arg(workspace)
            .args(arguments)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        command
    }
}
