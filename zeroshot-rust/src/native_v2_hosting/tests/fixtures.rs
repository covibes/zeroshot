use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use openengine_cluster_protocol::{
    DeclaredEnvironment, GraphSpec, IdempotencyKey, NodeName, RunSize, RunTitle, RuntimePlan,
    SourceBranchId, SourceRepositoryId, SourceRevisionId, SourceSnapshot,
};
use openengine_cluster_testkit::assertions::AssertValue;
use serde_json::{Value, json};

use crate::execution::SessionScope;
use crate::execution::process::HostedProcessPool;
use crate::native_v2_candidate::test_support::{TestDirectory, full_graph, success_node};
use crate::native_v2_capsule::CapsuleFilesystem;
use crate::native_v2_claude::ClaudeProcessEnvironment;
use crate::native_v2_cloud::CapsuleAllocationUnavailable;
use crate::native_v2_contract::{
    ClaudeProvider, CodexProvider, EnvironmentVariableName, NodeRuntimeBinding, RunSubmission,
};
use crate::native_v2_target_authority::{TargetBase, TargetSetupDocument};
use crate::worker_catalog::{self, ReasoningEffort};

use super::super::ProductionHostingConfig;
use super::super::allocator::ProductionCapsuleConfig;

pub(super) struct RepositoryFixture {
    _root: TestDirectory,
    pub(super) remote: PathBuf,
    pub(super) main_revision: String,
    pub(super) feature_revision: String,
}

impl RepositoryFixture {
    pub(super) fn new() -> Self {
        let root = TestDirectory::new("hosting-repository");
        let seed = root.path().join("seed");
        let remote = root.path().join("remote.git");
        git(root.path(), &["init", "--initial-branch=main", text(&seed)]);
        fs::write(seed.join("README.md"), "base\n").assert_value_with("write base");
        git(&seed, &["add", "README.md"]);
        commit(&seed, "base");
        let main_revision = git_output(&seed, &["rev-parse", "HEAD"]);
        git(&seed, &["switch", "-c", "feature"]);
        fs::write(seed.join("feature.txt"), "feature\n").assert_value_with("write feature");
        git(&seed, &["add", "feature.txt"]);
        commit(&seed, "feature");
        let feature_revision = git_output(&seed, &["rev-parse", "HEAD"]);
        git(&seed, &["switch", "main"]);
        git(
            root.path(),
            &["clone", "--bare", text(&seed), text(&remote)],
        );
        git(&remote, &["symbolic-ref", "HEAD", "refs/heads/main"]);
        Self {
            _root: root,
            remote,
            main_revision,
            feature_revision,
        }
    }
}

pub(super) fn hosting_config(
    storage_root: PathBuf,
    controller_environment: BTreeMap<EnvironmentVariableName, String>,
) -> ProductionHostingConfig {
    ProductionHostingConfig {
        storage_root,
        controller_environment,
        codex_executable: PathBuf::from("/usr/bin/false"),
        claude_executable: "/usr/bin/false".to_owned(),
        claude_prefix_arguments: Vec::new(),
        claude_process_environment: ClaudeProcessEnvironment::default(),
        executable_search_path: "/usr/bin:/bin".to_owned(),
        git_program: PathBuf::from("/usr/bin/git"),
        gh_program: PathBuf::from("/usr/bin/false"),
        process_pool: test_process_pool(),
        claude_turn_timeout: Duration::from_secs(1),
    }
}

pub(super) fn capsule_config(storage_root: PathBuf) -> ProductionCapsuleConfig {
    let config = hosting_config(storage_root.clone(), BTreeMap::new());
    ProductionCapsuleConfig {
        storage_root,
        environment: BTreeMap::new(),
        codex_executable: config.codex_executable,
        claude_executable: config.claude_executable,
        claude_prefix_arguments: config.claude_prefix_arguments,
        claude_process_environment: config.claude_process_environment,
        executable_search_path: config.executable_search_path,
        git_program: config.git_program,
        gh_program: config.gh_program,
        process_pool: config.process_pool,
        claude_turn_timeout: config.claude_turn_timeout,
    }
}

pub(super) fn setup(base: TargetBase) -> TargetSetupDocument {
    TargetSetupDocument {
        repository: "acme/project".to_owned(),
        base,
    }
}

pub(super) fn submission(runtime: RuntimePlan, revision: &str, key: &str) -> RunSubmission {
    RunSubmission {
        title: RunTitle::new("Hosting test run").assert_value_with("title"),
        graph: graph(),
        initial_input: Value::Null,
        runtime,
        source: SourceSnapshot {
            repository: SourceRepositoryId::new("acme/project").assert_value_with("repository"),
            target_branch: SourceBranchId::new("main").assert_value_with("branch"),
            base_revision: SourceRevisionId::new(revision).assert_value_with("revision"),
        },
        submission_key: IdempotencyKey::new(key).assert_value_with("submission key"),
    }
}

pub(super) fn runtime(environment: BTreeSet<EnvironmentVariableName>) -> RuntimePlan {
    RuntimePlan::Codex {
        provider: CodexProvider::OpenAi,
        size: RunSize::Small,
        nodes: BTreeMap::from([(
            NodeName::new("work").assert_value_with("node"),
            NodeRuntimeBinding::Agent {
                model: worker_catalog::ModelId::new("gpt-5.6").assert_value_with("model"),
                effort: None,
                session_scope: SessionScope::Execution,
                env: DeclaredEnvironment::new(environment)
                    .assert_value_with("declared environment"),
            },
        )]),
    }
}

pub(super) fn claude_runtime() -> RuntimePlan {
    RuntimePlan::Claude {
        provider: ClaudeProvider::Anthropic,
        size: RunSize::Small,
        nodes: BTreeMap::from([(
            NodeName::new("work").assert_value_with("node"),
            NodeRuntimeBinding::Agent {
                model: worker_catalog::ModelId::new("claude-sonnet-5").assert_value_with("model"),
                effort: Some(ReasoningEffort::Max),
                session_scope: SessionScope::Execution,
                env: DeclaredEnvironment::empty(),
            },
        )]),
    }
}

fn graph() -> GraphSpec {
    full_graph(vec![
        json!({
            "kind":"step","name":"work","worker":"agent.work@1",
            "input":{"kind":"null"},"output":{"kind":"null"},
            "inputBindings":[],"writeBindings":[],"timeoutMs":1000,"attempts":1
        }),
        success_node(),
    ])
}

pub(super) fn portable_filesystem(
    workspace: &Path,
    runtime_home: &Path,
    _process_pool: HostedProcessPool,
) -> Result<CapsuleFilesystem, CapsuleAllocationUnavailable> {
    writable_directory(workspace);
    writable_directory(runtime_home);
    Ok(CapsuleFilesystem {
        workspace: fs::canonicalize(workspace).map_err(|_| CapsuleAllocationUnavailable)?,
        runtime_home: fs::canonicalize(runtime_home).map_err(|_| CapsuleAllocationUnavailable)?,
    })
}

pub(super) fn writable_directory(path: &Path) {
    fs::create_dir(path).assert_value_with("create writable directory");
    fs::set_permissions(path, fs::Permissions::from_mode(0o777))
        .assert_value_with("writable permissions");
}

pub(super) fn test_process_pool() -> HostedProcessPool {
    let uid = unsafe { libc::geteuid() };
    let gid = unsafe { libc::getegid() };
    if uid == 0 || gid == 0 {
        HostedProcessPool::new(31_002, 31_002, 32_000, 32_000).assert_value_with("root test pool")
    } else {
        let verifier_base = uid.checked_add(10_000).assert_value_with("test UID range");
        HostedProcessPool::new(uid, gid, verifier_base, gid)
            .assert_value_with("current-user test pool")
    }
}

fn commit(repository: &Path, message: &str) {
    git(
        repository,
        &[
            "-c",
            "user.name=Hosting Test",
            "-c",
            "user.email=hosting@example.invalid",
            "commit",
            "-m",
            message,
        ],
    );
}

fn git(repository: &Path, arguments: &[&str]) {
    assert!(
        Command::new("/usr/bin/git")
            .args(arguments)
            .current_dir(repository)
            .env_clear()
            .env("LANG", "C")
            .status()
            .assert_value_with("run Git")
            .success()
    );
}

fn git_output(repository: &Path, arguments: &[&str]) -> String {
    let output = Command::new("/usr/bin/git")
        .args(arguments)
        .current_dir(repository)
        .env_clear()
        .env("LANG", "C")
        .output()
        .assert_value_with("run Git");
    assert!(output.status.success());
    String::from_utf8(output.stdout)
        .assert_value_with("Git UTF-8")
        .trim()
        .to_owned()
}

fn text(path: &Path) -> &str {
    path.to_str().assert_value_with("UTF-8 path")
}
