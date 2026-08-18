use std::ffi::{OsStr, OsString};
use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use tokio::process::Command;
use tokio::time::timeout;

use crate::execution::process::{HostedProcessPool, HostedProcessScope};
use crate::native_v2_delivery::DeliveryTarget;
use crate::native_v2_delivery::git_auth::encode_basic_credential;
use crate::native_v2_contract::{SourceBranchId, SourceRepositoryId, SourceRevisionId, SourceSnapshot};
use crate::native_v2_target_authority::TargetBase;
use crate::native_v2_target_authority::TargetSetupDocument;

const GIT_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const MAX_GIT_OUTPUT_BYTES: usize = 4_096;

pub(super) struct RepositoryInstall<'a> {
    pub git_program: &'a Path,
    pub source: &'a OsStr,
    pub repository: &'a str,
    pub base: &'a TargetBase,
    pub workspace: &'a Path,
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
    let clone = clone_arguments(&request);
    git.run(None, &clone).await?;
    let target_branch = checkout_base(&request, &git).await?;
    let revision = git
        .capture(
            request.workspace,
            &[OsString::from("rev-parse"), OsString::from("HEAD")],
        )
        .await?;
    if let TargetBase::Revision {
        revision: expected, ..
    } = request.base
    {
        if revision.trim() != expected {
            return Err(RepositoryInstallError);
        }
    }
    DeliveryTarget::new(request.repository, target_branch, revision.trim())
        .map_err(|_| RepositoryInstallError)
}

pub(super) async fn resolve_source_snapshot(
    git_program: &Path,
    setup: &TargetSetupDocument,
    process_pool: HostedProcessPool,
    github_token: Option<&str>,
) -> Result<SourceSnapshot, RepositoryInstallError> {
    let writer = process_pool
        .identity(HostedProcessScope::Writer)
        .map_err(|_| RepositoryInstallError)?;
    let git = GitProcess {
        program: git_program,
        token: github_token,
        uid: writer.uid(),
        gid: writer.gid(),
    };
    let source = production_source(&setup.repository);
    let (target_branch, base_revision) = match &setup.base {
        TargetBase::Default => resolve_default_source(&git, &source).await?,
        TargetBase::Branch { branch } => (
            branch.clone(),
            resolve_remote_revision(&git, &source, &format!("refs/heads/{branch}")).await?,
        ),
        TargetBase::Revision {
            revision,
            target_branch,
        } => (target_branch.clone(), revision.clone()),
    };
    Ok(SourceSnapshot {
        repository: SourceRepositoryId::new(setup.repository.clone())
            .map_err(|_| RepositoryInstallError)?,
        target_branch: SourceBranchId::new(target_branch).map_err(|_| RepositoryInstallError)?,
        base_revision: SourceRevisionId::new(base_revision).map_err(|_| RepositoryInstallError)?,
    })
}

async fn resolve_default_source(
    git: &GitProcess<'_>,
    source: &OsStr,
) -> Result<(String, String), RepositoryInstallError> {
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
) -> Result<String, RepositoryInstallError> {
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
) -> Result<String, RepositoryInstallError> {
    let expected = format!("\t{reference}");
    let mut matches = output
        .lines()
        .filter_map(|line| line.strip_suffix(&expected))
        .filter(|revision| !revision.is_empty());
    let revision = matches.next().ok_or(RepositoryInstallError)?;
    if matches.next().is_some() {
        return Err(RepositoryInstallError);
    }
    Ok(revision.to_owned())
}

fn clone_arguments(request: &RepositoryInstall<'_>) -> Vec<OsString> {
    let mut arguments = vec![OsString::from("clone"), OsString::from("--no-tags")];
    match request.base {
        TargetBase::Default => {}
        TargetBase::Branch { branch } => arguments.extend([
            OsString::from("--single-branch"),
            OsString::from("--branch"),
            OsString::from(branch),
        ]),
        TargetBase::Revision { .. } => arguments.push(OsString::from("--no-checkout")),
    }
    arguments.extend([
        request.source.to_owned(),
        request.workspace.as_os_str().to_owned(),
    ]);
    arguments
}

async fn checkout_base(
    request: &RepositoryInstall<'_>,
    git: &GitProcess<'_>,
) -> Result<String, RepositoryInstallError> {
    match request.base {
        TargetBase::Default => default_branch(request, git).await,
        TargetBase::Branch { branch } => Ok(branch.clone()),
        TargetBase::Revision {
            revision,
            target_branch,
        } => {
            checkout_revision(git, request.workspace, revision).await?;
            Ok(target_branch.clone())
        }
    }
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

async fn default_branch(
    request: &RepositoryInstall<'_>,
    git: &GitProcess<'_>,
) -> Result<String, RepositoryInstallError> {
    let branch = git
        .capture(
            request.workspace,
            &[
                OsString::from("symbolic-ref"),
                OsString::from("--short"),
                OsString::from("refs/remotes/origin/HEAD"),
            ],
        )
        .await?;
    branch
        .trim()
        .strip_prefix("origin/")
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .ok_or(RepositoryInstallError)
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
    environment: &std::collections::BTreeMap<
        crate::native_v2_contract::EnvironmentVariableName,
        String,
    >,
) -> Option<&str> {
    environment
        .iter()
        .find(|(name, _)| name.as_str() == crate::native_v2_delivery::GITHUB_TOKEN_ENV)
        .map(|(_, value)| value.as_str())
}

#[cfg(test)]
pub(super) fn path_source(path: &Path) -> OsString {
    path.as_os_str().to_owned()
}
