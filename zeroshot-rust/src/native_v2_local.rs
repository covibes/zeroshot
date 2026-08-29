//! Trusted local-host composition for one native-v2 run in the invoking Git workspace.
//!
//! The local CLI snapshots repository identity, the attached target branch, and exact `HEAD`
//! before it starts a one-run controller. Provider values are selected only for names declared by
//! the submitted runtime plan. The candidate then runs as the invoking user in that same
//! workspace; no cleanup authority owns, resets, or removes workspace mutations.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::time::Duration;

use openengine_cluster_protocol::{
    RunId, RunSubmission, RuntimePlan, SourceBranchId, SourceRepositoryId, SourceRevisionId,
    ResolvedSource,
};
use thiserror::Error;
use url::Url;

use crate::execution::process::HostedProcessPool;
use crate::native_v2_candidate::{
    NativeV2CandidateConfig, NativeV2CandidateError, NativeV2HarnessConfig,
    build_local_native_v2_candidate_with_github_token,
};
use crate::native_v2_claude::{ClaudeAdapterConfig, ClaudeAdapterConfigError, ClaudeProcessEnvironment};
use crate::native_v2_cli::PreparedRunRequest;
use crate::native_v2_codex::{NativeV2CodexConfig, NativeV2CodexUser};
use crate::native_v2_contract::AdmittedRun;
use crate::native_v2_delivery::{
    DeliveryTarget, GhCliAuthorityConfig, GhCliDeliveryAuthority, NativeV2DeliveryConfig,
};
use crate::native_v2_runner::NodeRunner;
use crate::native_v2_supervisor::{RunEnvironment, RunEnvironmentError};

const DEFAULT_SEARCH_PATH: &str = "/usr/local/bin:/usr/bin:/bin";
const MAX_GIT_OUTPUT_BYTES: usize = 16 * 1024;
const LOCAL_TURN_TIMEOUT: Duration = Duration::from_secs(6 * 60 * 60);

#[derive(Debug, Error)]
pub enum LocalCompositionError {
    #[error("current Git workspace could not be resolved")]
    Workspace,
    #[error("current Git workspace must have an attached branch")]
    DetachedHead,
    #[error("current Git workspace must have a GitHub origin")]
    RepositoryIdentity,
    #[error("current Git resolved source is invalid")]
    ResolvedSource,
    #[error("local run identity could not be assigned")]
    RunIdentity,
    #[error(transparent)]
    RunEnvironment(#[from] RunEnvironmentError),
    #[error("local controller storage could not be prepared")]
    Storage,
    #[error(transparent)]
    Claude(#[from] ClaudeAdapterConfigError),
    #[error(transparent)]
    Candidate(#[from] NativeV2CandidateError),
}

/// Host-assigned immutable inputs for one local controller process.
pub struct PreparedLocalRun {
    pub run_id: RunId,
    pub submission: RunSubmission,
    pub environment: RunEnvironment,
    pub github_token: Option<String>,
    pub workspace: PathBuf,
}

/// Snapshots local source and revalidates the request's exact runtime environment.
pub fn prepare_local_run(
    request: PreparedRunRequest,
    current_directory: &Path,
    git_program: &Path,
) -> Result<PreparedLocalRun, LocalCompositionError> {
    let PreparedRunRequest {
        run_id,
        intent,
        connections,
        github_token,
    } = request;
    let environment = RunEnvironment::exact(&intent.runtime, connections)?;
    let (workspace, source) = local_resolved_source(current_directory, git_program)?;
    Ok(PreparedLocalRun {
        run_id,
        submission: RunSubmission {
            title: intent.title,
            graph: intent.graph,
            initial_input: intent.initial_input,
            runtime: intent.runtime,
            source,
            submission_key: intent.submission_key,
        },
        environment,
        github_token,
        workspace,
    })
}

fn local_resolved_source(
    current_directory: &Path,
    git_program: &Path,
) -> Result<(PathBuf, ResolvedSource), LocalCompositionError> {
    let workspace = PathBuf::from(git_line(
        git_program,
        current_directory,
        &["rev-parse", "--show-toplevel"],
    )?);
    let workspace =
        std::fs::canonicalize(workspace).map_err(|_| LocalCompositionError::Workspace)?;
    let branch = git_line(
        git_program,
        &workspace,
        &["symbolic-ref", "--quiet", "--short", "HEAD"],
    )
    .map_err(|_| LocalCompositionError::DetachedHead)?;
    let revision = git_line(
        git_program,
        &workspace,
        &["rev-parse", "--verify", "HEAD^{commit}"],
    )?;
    let origin = git_line(
        git_program,
        &workspace,
        &["config", "--get", "remote.origin.url"],
    )
    .map_err(|_| LocalCompositionError::RepositoryIdentity)?;
    let repository = github_repository(&origin).ok_or(LocalCompositionError::RepositoryIdentity)?;
    let source = ResolvedSource {
        repository: SourceRepositoryId::new(repository)
            .map_err(|_| LocalCompositionError::ResolvedSource)?,
        branch: SourceBranchId::new(branch).map_err(|_| LocalCompositionError::ResolvedSource)?,
        revision: SourceRevisionId::new(revision)
            .map_err(|_| LocalCompositionError::ResolvedSource)?,
    };
    Ok((workspace, source))
}

fn git_line(
    git_program: &Path,
    workspace: &Path,
    arguments: &[&str],
) -> Result<String, LocalCompositionError> {
    let output = Command::new(git_program)
        .arg("-C")
        .arg(workspace)
        .args(arguments)
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .map_err(|_| LocalCompositionError::Workspace)?;
    if !output.status.success() || output.stdout.len() > MAX_GIT_OUTPUT_BYTES {
        return Err(LocalCompositionError::Workspace);
    }
    let value = String::from_utf8(output.stdout).map_err(|_| LocalCompositionError::Workspace)?;
    let value = value.trim_end_matches(['\r', '\n']);
    if value.is_empty() || value.contains(['\r', '\n', '\0']) {
        return Err(LocalCompositionError::Workspace);
    }
    Ok(value.to_owned())
}

fn github_repository(origin: &str) -> Option<String> {
    let path = github_remote_path(origin)?;
    let path = path
        .trim_matches('/')
        .strip_suffix(".git")
        .unwrap_or(path.trim_matches('/'));
    let mut segments = path.split('/');
    let owner = segments.next()?;
    let repository = segments.next()?;
    if owner.is_empty() || repository.is_empty() || segments.next().is_some() {
        return None;
    }
    Some(format!("{owner}/{repository}"))
}

fn github_remote_path(origin: &str) -> Option<String> {
    match Url::parse(origin) {
        Ok(url) => url
            .host_str()
            .filter(|host| host.eq_ignore_ascii_case("github.com"))
            .map(|_| url.path().to_owned()),
        Err(_) => {
            let (authority, path) = origin.split_once(':')?;
            let host = authority
                .rsplit_once('@')
                .map_or(authority, |(_, host)| host);
            host.eq_ignore_ascii_case("github.com")
                .then(|| path.to_owned())
        }
    }
}

/// Builds a local-user process candidate rooted in the existing workspace.
///
/// `storage` owns only provider session homes and controller state. No cleanup object is returned
/// because the existing workspace and every mutation within it remain user-owned.
pub fn build_local_process_candidate(
    admitted: &AdmittedRun,
    workspace: &Path,
    storage: &Path,
    github_token: Option<String>,
) -> Result<Arc<dyn NodeRunner>, LocalCompositionError> {
    let runtime_home = storage.join("runtime");
    prepare_private_directory(&runtime_home)?;
    let search_path = std::env::var("PATH").unwrap_or_else(|_| DEFAULT_SEARCH_PATH.to_owned());
    let local_home = current_user_home();
    let process_pool = HostedProcessPool::hosted_default();
    let harness = match &admitted.runtime {
        RuntimePlan::Codex { provider, .. } => NativeV2HarnessConfig::Codex(NativeV2CodexConfig {
            provider: *provider,
            executable: PathBuf::from("codex"),
            workspace: workspace.to_owned(),
            runtime_home: runtime_home.clone(),
            local_user: local_home.clone().map(|home| NativeV2CodexUser {
                codex_home: std::env::var_os("CODEX_HOME")
                    .filter(|value| !value.is_empty())
                    .map_or_else(|| home.join(".codex"), PathBuf::from),
                home,
            }),
            search_path: search_path.clone(),
            process_pool,
        }),
        RuntimePlan::Claude { provider, .. } => {
            NativeV2HarnessConfig::Claude(ClaudeAdapterConfig {
                provider: *provider,
                executable: "claude".to_owned(),
                prefix_arguments: Vec::new(),
                workspace: workspace.to_owned(),
                runtime_home: runtime_home.clone(),
                local_user_home: local_home,
                base_environment: local_claude_environment(&search_path)?,
                turn_timeout: LOCAL_TURN_TIMEOUT,
                process_pool,
            })
        }
    };
    let target = DeliveryTarget::new(
        admitted.source.repository.as_str(),
        admitted.source.branch.as_str(),
        admitted.source.revision.as_str(),
    )
    .map_err(|_| LocalCompositionError::ResolvedSource)?;
    let mut github_config = GhCliAuthorityConfig::hosted(runtime_home);
    github_config.git_program = PathBuf::from("git");
    github_config.gh_program = PathBuf::from("gh");
    let candidate = build_local_native_v2_candidate_with_github_token(
        admitted,
        NativeV2CandidateConfig {
            harness,
            delivery: NativeV2DeliveryConfig {
                workspace: workspace.to_owned(),
                git_program: PathBuf::from("git"),
                target,
                poll: Default::default(),
            },
            github: Arc::new(GhCliDeliveryAuthority::new(github_config)),
        },
        github_token.map(Arc::<str>::from),
    )?;
    Ok(Arc::new(candidate))
}

fn current_user_home() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

fn local_claude_environment(
    search_path: &str,
) -> Result<ClaudeProcessEnvironment, ClaudeAdapterConfigError> {
    let mut base_environment = BTreeMap::from([("PATH".to_owned(), search_path.to_owned())]);
    for name in ["LANG", "LC_ALL", "TERM", "TMPDIR"] {
        if let Ok(value) = std::env::var(name) {
            base_environment.insert(name.to_owned(), value);
        }
    }
    ClaudeProcessEnvironment::new(base_environment)
}

fn prepare_private_directory(path: &Path) -> Result<(), LocalCompositionError> {
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder
        .create(path)
        .map_err(|_| LocalCompositionError::Storage)?;
    let metadata = std::fs::symlink_metadata(path).map_err(|_| LocalCompositionError::Storage)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(LocalCompositionError::Storage);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
            .map_err(|_| LocalCompositionError::Storage)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_canonical_github_remote_forms() {
        for remote in [
            "https://github.com/open-engine/zeroshot.git",
            "ssh://git@github.com/open-engine/zeroshot.git",
            "git@github.com:open-engine/zeroshot.git",
        ] {
            assert_eq!(
                github_repository(remote).as_deref(),
                Some("open-engine/zeroshot")
            );
        }
        assert!(github_repository("https://example.com/open-engine/zeroshot.git").is_none());
        assert!(github_repository("https://github.com/extra/open-engine/zeroshot").is_none());
    }
}
