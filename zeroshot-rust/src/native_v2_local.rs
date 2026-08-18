//! Trusted local-host composition for one native-v2 run in the invoking Git workspace.
//!
//! The local CLI snapshots repository identity, the attached target branch, and exact `HEAD`
//! before it starts a one-run controller. Provider values are selected only for names declared by
//! the submitted runtime plan. The candidate then runs as the invoking user in that same
//! workspace; no cleanup authority owns, resets, or removes workspace mutations.

use std::collections::{BTreeMap, BTreeSet};
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::time::Duration;

use openengine_cluster_protocol::{
    EnvironmentVariableName, RunId, RunSubmission, RuntimePlan, SourceBranchId, SourceRepositoryId,
    SourceRevisionId, SourceSnapshot,
};
use thiserror::Error;
use url::Url;

use crate::execution::process::HostedProcessPool;
use crate::native_v2_candidate::{
    NativeV2CandidateConfig, NativeV2CandidateError, NativeV2HarnessConfig,
    build_local_native_v2_candidate,
};
use crate::native_v2_claude::{ClaudeAdapterConfig, ClaudeAdapterConfigError, ClaudeProcessEnvironment};
use crate::native_v2_cli::TargetRunIntent;
use crate::native_v2_codex::NativeV2CodexConfig;
use crate::native_v2_contract::AdmittedRun;
#[cfg(test)]
use crate::native_v2_contract::CodexProvider;
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
    #[error("current Git source snapshot is invalid")]
    SourceSnapshot,
    #[error("local run identity could not be assigned")]
    RunIdentity,
    #[error("declared environment variable {0} is unavailable or is not valid UTF-8")]
    Environment(EnvironmentVariableName),
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
    pub environment: BTreeMap<EnvironmentVariableName, String>,
    pub workspace: PathBuf,
}

/// Snapshots local source and selects only runtime-declared values from the invoking process.
pub fn prepare_local_run(
    intent: TargetRunIntent,
    current_directory: &Path,
    git_program: &Path,
) -> Result<PreparedLocalRun, LocalCompositionError> {
    prepare_local_run_with_environment(intent, current_directory, git_program, |name| {
        std::env::var_os(name)
    })
}

fn prepare_local_run_with_environment<F>(
    intent: TargetRunIntent,
    current_directory: &Path,
    git_program: &Path,
    environment: F,
) -> Result<PreparedLocalRun, LocalCompositionError>
where
    F: Fn(&str) -> Option<OsString>,
{
    let (workspace, source) = local_source_snapshot(current_directory, git_program)?;
    let selected = select_environment(&intent.runtime, environment)?;
    RunEnvironment::exact(&intent.runtime, selected.clone())?;
    let run_id = fresh_local_run_id()?;
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
        environment: selected,
        workspace,
    })
}

fn select_environment<F>(
    runtime: &RuntimePlan,
    environment: F,
) -> Result<BTreeMap<EnvironmentVariableName, String>, LocalCompositionError>
where
    F: Fn(&str) -> Option<OsString>,
{
    declared_environment_names(runtime)
        .into_iter()
        .map(|name| {
            let value = environment(name.as_str())
                .and_then(|value| value.into_string().ok())
                .ok_or_else(|| LocalCompositionError::Environment(name.clone()))?;
            Ok((name, value))
        })
        .collect()
}

fn declared_environment_names(runtime: &RuntimePlan) -> BTreeSet<EnvironmentVariableName> {
    runtime
        .nodes()
        .values()
        .flat_map(|binding| binding.declared_environment().iter().cloned())
        .collect()
}

fn local_source_snapshot(
    current_directory: &Path,
    git_program: &Path,
) -> Result<(PathBuf, SourceSnapshot), LocalCompositionError> {
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
    let source = SourceSnapshot {
        repository: SourceRepositoryId::new(repository)
            .map_err(|_| LocalCompositionError::SourceSnapshot)?,
        target_branch: SourceBranchId::new(branch)
            .map_err(|_| LocalCompositionError::SourceSnapshot)?,
        base_revision: SourceRevisionId::new(revision)
            .map_err(|_| LocalCompositionError::SourceSnapshot)?,
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

fn fresh_local_run_id() -> Result<RunId, LocalCompositionError> {
    let mut random = [0_u8; 16];
    getrandom::fill(&mut random).map_err(|_| LocalCompositionError::RunIdentity)?;
    let mut value = String::from("run-");
    for byte in random {
        use std::fmt::Write as _;
        let _ = write!(&mut value, "{byte:02x}");
    }
    Ok(RunId::new(value))
}

/// Builds a local-user process candidate rooted in the existing workspace.
///
/// `storage` owns only provider session homes and controller state. No cleanup object is returned
/// because the existing workspace and every mutation within it remain user-owned.
pub fn build_local_process_candidate(
    admitted: &AdmittedRun,
    workspace: &Path,
    storage: &Path,
) -> Result<Arc<dyn NodeRunner>, LocalCompositionError> {
    let runtime_home = storage.join("runtime");
    prepare_private_directory(&runtime_home)?;
    let search_path = std::env::var("PATH").unwrap_or_else(|_| DEFAULT_SEARCH_PATH.to_owned());
    let process_pool = HostedProcessPool::hosted_default();
    let harness = match &admitted.runtime {
        RuntimePlan::Codex { provider, .. } => NativeV2HarnessConfig::Codex(NativeV2CodexConfig {
            provider: *provider,
            executable: PathBuf::from("codex"),
            workspace: workspace.to_owned(),
            runtime_home: runtime_home.clone(),
            search_path: search_path.clone(),
            process_pool,
        }),
        RuntimePlan::Claude { provider, .. } => {
            NativeV2HarnessConfig::Claude(ClaudeAdapterConfig {
                provider: *provider,
                executable: "claude".to_owned(),
                prefix_arguments: Vec::new(),
                workspace: workspace.to_owned(),
                base_environment: local_claude_environment(&runtime_home, &search_path)?,
                turn_timeout: LOCAL_TURN_TIMEOUT,
                process_pool,
            })
        }
    };
    let target = DeliveryTarget::new(
        admitted.source.repository.as_str(),
        admitted.source.target_branch.as_str(),
        admitted.source.base_revision.as_str(),
    )
    .map_err(|_| LocalCompositionError::SourceSnapshot)?;
    let mut github_config = GhCliAuthorityConfig::hosted();
    github_config.git_program = PathBuf::from("git");
    github_config.gh_program = PathBuf::from("gh");
    let candidate = build_local_native_v2_candidate(
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
    )?;
    Ok(Arc::new(candidate))
}

fn local_claude_environment(
    runtime_home: &Path,
    search_path: &str,
) -> Result<ClaudeProcessEnvironment, ClaudeAdapterConfigError> {
    let mut base_environment = BTreeMap::from([
        (
            "HOME".to_owned(),
            runtime_home.to_string_lossy().into_owned(),
        ),
        ("PATH".to_owned(), search_path.to_owned()),
    ]);
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
    use openengine_cluster_protocol::{DeclaredEnvironment, NodeName, NodeRuntimeBinding, RunSize};
    use openengine_cluster_testkit::assertions::AssertValue;

    use super::*;
    use crate::native_v2_contract::{ModelId, ReasoningEffort, SessionScope};

    fn runtime_with_credential(effort: Option<ReasoningEffort>) -> RuntimePlan {
        let credential = EnvironmentVariableName::new("OPENAI_API_KEY").assert_value();
        RuntimePlan::Codex {
            provider: CodexProvider::OpenAi,
            size: RunSize::Standard,
            nodes: BTreeMap::from([(
                NodeName::new("worker").assert_value(),
                NodeRuntimeBinding::Agent {
                    model: ModelId::new("gpt-5.6").assert_value(),
                    effort,
                    session_scope: SessionScope::Execution,
                    env: DeclaredEnvironment::new([credential]).assert_value(),
                },
            )]),
        }
    }

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

    #[test]
    fn selects_exactly_declared_environment_names() {
        let credential = EnvironmentVariableName::new("OPENAI_API_KEY").assert_value();
        let runtime = runtime_with_credential(Some(ReasoningEffort::Max));
        let selected = select_environment(&runtime, |name| match name {
            "OPENAI_API_KEY" => Some(OsString::from("declared-secret")),
            _ => Some(OsString::from("ambient-secret")),
        })
        .assert_value();
        assert_eq!(selected.len(), 1);
        assert_eq!(
            selected.get(&credential).map(String::as_str),
            Some("declared-secret")
        );
    }

    #[test]
    fn missing_declared_environment_fails_without_exposing_values() {
        let credential = EnvironmentVariableName::new("OPENAI_API_KEY").assert_value();
        let runtime = runtime_with_credential(None);
        let result = select_environment(&runtime, |_| None)
            .map(|_| ())
            .map_err(|error| error.to_string());
        assert_eq!(
            result,
            Err(format!(
                "declared environment variable {credential} is unavailable or is not valid UTF-8"
            ))
        );
    }
}
