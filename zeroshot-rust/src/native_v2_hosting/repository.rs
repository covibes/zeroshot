use std::ffi::{OsStr, OsString};
use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use tokio::process::Command;
use tokio::time::timeout;

use crate::execution::process::{HostedProcessPool, HostedProcessScope};
use crate::native_v2_delivery::DeliveryTarget;
use crate::native_v2_delivery::git_auth::encode_basic_credential;
use crate::native_v2_contract::{ResolvedSource, SourceBranchId, SourceRepositoryId, SourceRevisionId};

const GIT_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const MAX_GIT_OUTPUT_BYTES: usize = 4_096;

pub(super) struct RepositoryInstall<'a> {
    pub git_program: &'a Path,
    pub source: &'a OsStr,
    pub resolved: &'a ResolvedSource,
    pub workspace: &'a Path,
    pub process_pool: HostedProcessPool,
    pub github_token: Option<&'a str>,
}

pub(super) struct SourceResolution<'a> {
    pub git_program: &'a Path,
    pub source: &'a OsStr,
    pub repository: &'a str,
    pub branch: Option<&'a str>,
    pub process_pool: HostedProcessPool,
    pub github_token: Option<&'a str>,
}

pub(super) async fn install_repository(
    request: RepositoryInstall<'_>,
) -> Result<DeliveryTarget, RepositoryInstallError> {
    let writer = request
        .process_pool
        .identity(HostedProcessScope::Writer)
        .map_err(|_| RepositoryInstallError)?;
    let git = GitProcess {
        program: request.git_program,
        token: request.github_token,
        uid: writer.uid(),
        gid: writer.gid(),
    };
    git.run(None, &clone_arguments(&request)).await?;
    checkout_revision(&git, request.workspace, request.resolved.revision.as_str()).await?;
    let revision = git
        .capture(
            request.workspace,
            &[OsString::from("rev-parse"), OsString::from("HEAD")],
        )
        .await?;
    if revision.trim() != request.resolved.revision.as_str() {
        return Err(RepositoryInstallError);
    }
    DeliveryTarget::new(
        request.resolved.repository.as_str(),
        request.resolved.branch.as_str(),
        revision.trim(),
    )
    .map_err(|_| RepositoryInstallError)
}

pub(super) async fn resolve_source(
    request: SourceResolution<'_>,
) -> Result<ResolvedSource, RepositoryInstallError> {
    let writer = request
        .process_pool
        .identity(HostedProcessScope::Writer)
        .map_err(|_| RepositoryInstallError)?;
    let git = GitProcess {
        program: request.git_program,
        token: request.github_token,
        uid: writer.uid(),
        gid: writer.gid(),
    };
    let (branch, revision) = match request.branch {
        None => resolve_default_source(&git, request.source).await?,
        Some(branch) => (
            branch.to_owned(),
            resolve_remote_revision(&git, request.source, &format!("refs/heads/{branch}")).await?,
        ),
    };
    Ok(ResolvedSource {
        repository: SourceRepositoryId::new(request.repository)
            .map_err(|_| RepositoryInstallError)?,
        branch: SourceBranchId::new(branch).map_err(|_| RepositoryInstallError)?,
        revision,
    })
}

async fn resolve_default_source(
    git: &GitProcess<'_>,
    source: &OsStr,
) -> Result<(String, SourceRevisionId), RepositoryInstallError> {
    let output = git
        .capture_without_workspace(&[
            OsString::from("ls-remote"),
            OsString::from("--symref"),
            source.to_owned(),
            OsString::from("HEAD"),
        ])
        .await?;
    let branch = output
        .lines()
        .find_map(|line| {
            line.strip_prefix("ref: refs/heads/")?
                .strip_suffix("\tHEAD")
        })
        .ok_or(RepositoryInstallError)?;
    let revision = remote_revision_from_output(&output, "HEAD")?;
    Ok((branch.to_owned(), revision))
}

async fn resolve_remote_revision(
    git: &GitProcess<'_>,
    source: &OsStr,
    reference: &str,
) -> Result<SourceRevisionId, RepositoryInstallError> {
    let output = git
        .capture_without_workspace(&[
            OsString::from("ls-remote"),
            source.to_owned(),
            OsString::from(reference),
        ])
        .await?;
    remote_revision_from_output(&output, reference)
}

fn remote_revision_from_output(
    output: &str,
    reference: &str,
) -> Result<SourceRevisionId, RepositoryInstallError> {
    let expected = format!("\t{reference}");
    let mut matches = output
        .lines()
        .filter_map(|line| line.strip_suffix(&expected))
        .filter_map(|revision| SourceRevisionId::new(revision).ok());
    let revision = matches.next().ok_or(RepositoryInstallError)?;
    if matches.next().is_some() {
        return Err(RepositoryInstallError);
    }
    Ok(revision)
}

fn clone_arguments(request: &RepositoryInstall<'_>) -> Vec<OsString> {
    vec![
        OsString::from("clone"),
        OsString::from("--no-tags"),
        OsString::from("--no-checkout"),
        request.source.to_owned(),
        request.workspace.as_os_str().to_owned(),
    ]
}

async fn checkout_revision(
    git: &GitProcess<'_>,
    workspace: &Path,
    revision: &str,
) -> Result<(), RepositoryInstallError> {
    git.run(
        Some(workspace),
        &[
            OsString::from("fetch"),
            OsString::from("--no-tags"),
            OsString::from("origin"),
            OsString::from(revision),
        ],
    )
    .await?;
    git.run(
        Some(workspace),
        &[
            OsString::from("checkout"),
            OsString::from("--detach"),
            OsString::from(revision),
        ],
    )
    .await
}

fn github_source(repository: &str) -> OsString {
    OsString::from(format!("https://github.com/{repository}.git"))
}

pub(super) fn production_source(repository: &str) -> OsString {
    github_source(repository)
}

struct GitProcess<'a> {
    program: &'a Path,
    token: Option<&'a str>,
    uid: u32,
    gid: u32,
}

impl GitProcess<'_> {
    async fn run(
        &self,
        workspace: Option<&Path>,
        arguments: &[OsString],
    ) -> Result<(), RepositoryInstallError> {
        let mut command = self.command(workspace, arguments);
        let status = timeout(GIT_TIMEOUT, command.status())
            .await
            .map_err(|_| RepositoryInstallError)?
            .map_err(|_| RepositoryInstallError)?;
        status.success().then_some(()).ok_or(RepositoryInstallError)
    }

    async fn capture(
        &self,
        workspace: &Path,
        arguments: &[OsString],
    ) -> Result<String, RepositoryInstallError> {
        self.capture_at(Some(workspace), arguments).await
    }

    async fn capture_without_workspace(
        &self,
        arguments: &[OsString],
    ) -> Result<String, RepositoryInstallError> {
        self.capture_at(None, arguments).await
    }

    async fn capture_at(
        &self,
        workspace: Option<&Path>,
        arguments: &[OsString],
    ) -> Result<String, RepositoryInstallError> {
        let mut command = self.command(workspace, arguments);
        command.stdout(Stdio::piped());
        let output = timeout(GIT_TIMEOUT, command.output())
            .await
            .map_err(|_| RepositoryInstallError)?
            .map_err(|_| RepositoryInstallError)?;
        if !output.status.success() || output.stdout.len() > MAX_GIT_OUTPUT_BYTES {
            return Err(RepositoryInstallError);
        }
        String::from_utf8(output.stdout).map_err(|_| RepositoryInstallError)
    }

    fn command(&self, workspace: Option<&Path>, arguments: &[OsString]) -> Command {
        let mut command = Command::new(self.program);
        command
            // Hosted identities must not inherit a launcher cwd they cannot traverse. Every Git
            // effect below already uses an explicit source, destination, or `-C` workspace.
            .current_dir(Path::new("/"))
            .kill_on_drop(true)
            .env_clear()
            .env("LANG", "C")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_TERMINAL_PROMPT", "0")
            .arg("-c")
            .arg("core.hooksPath=/dev/null");
        if let Some(token) = self.token {
            command.arg("-c").arg(format!(
                "http.https://github.com/.extraheader=AUTHORIZATION: basic {}",
                encode_basic_credential(token)
            ));
        }
        if let Some(workspace) = workspace {
            command.arg("-C").arg(workspace);
        }
        command
            .args(arguments)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        configure_identity(&mut command, self.uid, self.gid);
        command
    }
}

#[cfg(target_os = "linux")]
fn configure_identity(command: &mut Command, uid: u32, gid: u32) {
    use std::os::unix::process::CommandExt as _;

    command.as_std_mut().uid(uid).gid(gid);
}

#[cfg(not(target_os = "linux"))]
fn configure_identity(_command: &mut Command, _uid: u32, _gid: u32) {}

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
#[error("repository checkout could not be installed")]
pub(super) struct RepositoryInstallError;

pub(super) fn repository_token(
    environment: &crate::native_v2_supervisor::RunEnvironment,
) -> Option<&str> {
    let name = crate::native_v2_contract::EnvironmentVariableName::new(
        crate::native_v2_delivery::GITHUB_TOKEN_ENV,
    )
    .ok()?;
    environment.get(&name)
}

#[cfg(test)]
pub(super) fn path_source(path: &Path) -> OsString {
    path.as_os_str().to_owned()
}
