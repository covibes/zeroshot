#![cfg(unix)]

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use openengine_cluster_protocol::{GraphSpec, IdempotencyKey, NodeName, RunId, WorkerRef};
use serde_json::{Value, json};

use super::*;
use crate::execution::SessionScope;
use crate::native_v2_candidate::test_support::{
    TestDirectory, admit, environment_name, full_graph, success_node,
};
use crate::native_v2_capsule::CapsuleFilesystem;
use crate::native_v2_cloud::{CapsuleAllocationUnavailable, CapsuleAllocator};
use crate::native_v2_contract::{
    self, ClaudeProvider, CodexProvider, EnvironmentVariableName, ExecutionRef, NodeInvocation,
    NodeRuntimeBinding, RunSubmission,
};
use crate::native_v2_runner::{NodeRunRequest, ResolvedEnvironment};
use crate::native_v2_supervisor::RunRuntimeExit;
use crate::native_v2_target_authority::{TargetBase, TargetSetupDocument, TargetSetupOutcome};
use crate::worker_catalog::{self, ReasoningEffort};

use super::allocator::{ProductionCapsuleAllocator, ProductionCapsuleConfig};
use super::repository::{RepositoryInstall, install_repository, path_source};

struct RepositoryFixture {
    _root: TestDirectory,
    remote: PathBuf,
    main_revision: String,
    feature_revision: String,
}

impl RepositoryFixture {
    fn new() -> Self {
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

#[test]
fn controller_environment_is_filtered_to_declared_names_and_debug_is_redacted() {
    let declared = environment_name("OPENAI_API_KEY");
    let unused = environment_name("UNUSED_SECRET");
    let runtime = runtime(BTreeSet::from([declared.clone()]));
    let available = BTreeMap::from([
        (declared.clone(), "openai-secret".to_owned()),
        (unused, "unused-secret".to_owned()),
    ]);
    assert_eq!(
        declared_environment(&runtime, &available),
        BTreeMap::from([(declared, "openai-secret".to_owned())])
    );

    let config = hosting_config(PathBuf::from("/tmp/native-v2-redaction"), available);
    let debug = format!("{config:?}");
    assert!(debug.contains("OPENAI_API_KEY"));
    assert!(!debug.contains("openai-secret"));
    assert!(!debug.contains("unused-secret"));
}

#[tokio::test]
async fn sqlite_controller_claim_is_exclusive_and_released_with_controller() {
    let root = TestDirectory::new("hosting-controller");
    let setup = setup(TargetBase::Default, runtime(BTreeSet::new()));
    let first = ProductionTargetControllerFactory::new(hosting_config(
        root.path().to_owned(),
        BTreeMap::new(),
    ));
    let second = first.clone();

    let controller = first
        .create_controller(&setup)
        .await
        .assert_value_with("first controller");
    assert!(matches!(
        second.create_controller(&setup).await,
        Err(ProductionHostingError::Controller)
    ));
    drop(controller);
    second
        .create_controller(&setup)
        .await
        .assert_value_with("claim released");
    assert!(root.path().join("runs.sqlite3").is_file());
}

#[tokio::test]
async fn production_authority_restores_setup_from_target_storage() {
    let root = TestDirectory::new("hosting-authority-setup");
    let setup = setup(TargetBase::Default, runtime(BTreeSet::new()));
    let first =
        build_production_target_authority(hosting_config(root.path().to_owned(), BTreeMap::new()))
            .await
            .assert_value_with("first authority");
    assert_eq!(
        first
            .install(setup.clone())
            .await
            .assert_value_with("install setup"),
        TargetSetupOutcome::Installed
    );
    drop(first);
    assert!(root.path().join(TARGET_SETUP_FILE).is_file());

    let restored =
        build_production_target_authority(hosting_config(root.path().to_owned(), BTreeMap::new()))
            .await
            .assert_value_with("restored authority");
    assert_eq!(
        restored
            .install(setup)
            .await
            .assert_value_with("exact reinstall"),
        TargetSetupOutcome::Unchanged
    );
    restored
        .controller()
        .await
        .assert_value_with("restored controller");
}

#[tokio::test]
async fn repository_installer_resolves_default_branch_named_branch_and_exact_revision() {
    let repository = RepositoryFixture::new();
    let root = TestDirectory::new("hosting-installs");
    let pool = test_process_pool();
    let cases = [
        (
            TargetBase::Default,
            "main",
            repository.main_revision.as_str(),
        ),
        (
            TargetBase::Branch {
                branch: "feature".to_owned(),
            },
            "feature",
            repository.feature_revision.as_str(),
        ),
        (
            TargetBase::Revision {
                revision: repository.main_revision.clone(),
                target_branch: "release".to_owned(),
            },
            "release",
            repository.main_revision.as_str(),
        ),
    ];
    for (index, (base, expected_branch, expected_revision)) in cases.into_iter().enumerate() {
        let workspace = root.path().join(format!("workspace-{index}"));
        writable_directory(&workspace);
        let source = path_source(&repository.remote);
        let installed = install_repository(RepositoryInstall {
            git_program: Path::new("/usr/bin/git"),
            source: &source,
            repository: "acme/project",
            base: &base,
            workspace: &workspace,
            process_pool: pool,
            github_token: None,
        })
        .await
        .assert_value_with("install repository");
        assert_eq!(installed.target_branch, expected_branch);
        assert_eq!(installed.base_revision, expected_revision);
    }
}

#[tokio::test]
async fn allocator_uses_one_workspace_then_cleans_without_replacement() {
    let repository = RepositoryFixture::new();
    let root = TestDirectory::new("hosting-allocator");
    prepare_storage_root(&root.path().to_owned()).assert_value_with("storage root");
    let runtime = runtime(BTreeSet::new());
    let admitted = admit(RunSubmission {
        graph: graph(),
        initial_input: Value::Null,
        runtime: runtime.clone(),
        ship: false,
        submission_key: IdempotencyKey::new("hosting-allocation")
            .assert_value_with("submission key"),
    })
    .await;
    let allocator = ProductionCapsuleAllocator::new(capsule_config(
        root.path().to_owned(),
        TargetBase::Default,
    ))
    .assert_value_with("allocator")
    .with_test_filesystem_and_source(repository.remote, portable_filesystem);
    let run_id = RunId::new("run-hosting-one");
    let run_path = allocator.run_path(&run_id);

    let capsule = allocator
        .allocate(&run_id, &admitted)
        .await
        .assert_value_with("allocate capsule");
    assert!(run_path.join("workspace/.git").is_dir());
    assert!(run_path.join("runtime").is_dir());
    assert!(allocator.allocate(&run_id, &admitted).await.is_err());

    capsule
        .cleanup
        .destroy_or_confirm_absent(RunRuntimeExit::Completed)
        .await
        .assert_value_with("cleanup");
    assert!(!run_path.exists());
    allocator
        .destroy_or_confirm_absent(&run_id, RunRuntimeExit::RuntimeLost)
        .await
        .assert_value_with("confirm absent");
    assert!(allocator.allocate(&run_id, &admitted).await.is_err());
}

#[tokio::test]
async fn default_claude_environment_prepares_capsule_session_home() {
    let repository = RepositoryFixture::new();
    let root = TestDirectory::new("hosting-claude-environment");
    prepare_storage_root(&root.path().to_owned()).assert_value_with("storage root");
    let runtime = claude_runtime();
    let admitted = admit(RunSubmission {
        graph: graph(),
        initial_input: Value::Null,
        runtime,
        ship: false,
        submission_key: IdempotencyKey::new("hosting-claude-environment")
            .assert_value_with("submission key"),
    })
    .await;
    let mut config = capsule_config(root.path().to_owned(), TargetBase::Default);
    config.claude_process_environment = ClaudeProcessEnvironment::default();
    let allocator = ProductionCapsuleAllocator::new(config)
        .assert_value_with("allocator")
        .with_test_filesystem_and_source(repository.remote, portable_filesystem);
    let run_id = RunId::new("run-hosting-claude-environment");
    let run_path = allocator.run_path(&run_id);
    let capsule = allocator
        .allocate(&run_id, &admitted)
        .await
        .assert_value_with("allocate Claude capsule");
    let node = NodeName::new("work").assert_value_with("node");
    let binding = admitted
        .runtime
        .nodes()
        .get(&node)
        .assert_value_with("admitted binding")
        .clone();
    let mut handle = capsule
        .runner
        .start(NodeRunRequest {
            invocation: NodeInvocation {
                reference: ExecutionRef {
                    run_id: run_id.clone(),
                    node,
                    node_instance: native_v2_contract::NodeInstanceId::new(1)
                        .assert_value_with("node instance"),
                    execution: native_v2_contract::ExecutionId::new(1)
                        .assert_value_with("execution"),
                },
                worker: WorkerRef::new("agent.work@1").assert_value_with("worker"),
                input: Value::Null,
                binding: binding.clone(),
            },
            environment: ResolvedEnvironment::exact(&binding, BTreeMap::new())
                .assert_value_with("empty declared environment"),
        })
        .await
        .assert_value_with("start Claude node");
    assert!(matches!(
        handle.completion().await,
        Err(crate::native_v2_runner::NodeRunnerError::Driver)
    ));

    let private_home = run_path.join("runtime/writer-execution-1");
    assert!(private_home.is_dir());

    capsule
        .cleanup
        .destroy_or_confirm_absent(RunRuntimeExit::Completed)
        .await
        .assert_value_with("cleanup");
}

fn hosting_config(
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

fn capsule_config(storage_root: PathBuf, base: TargetBase) -> ProductionCapsuleConfig {
    let config = hosting_config(storage_root.clone(), BTreeMap::new());
    ProductionCapsuleConfig {
        storage_root,
        repository: "acme/project".to_owned(),
        base,
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

fn setup(base: TargetBase, runtime: RuntimePlan) -> TargetSetupDocument {
    TargetSetupDocument {
        repository: "acme/project".to_owned(),
        base,
        runtime,
    }
}

fn runtime(environment: BTreeSet<EnvironmentVariableName>) -> RuntimePlan {
    RuntimePlan::Codex {
        provider: CodexProvider::OpenAi,
        nodes: BTreeMap::from([(
            NodeName::new("work").assert_value_with("node"),
            NodeRuntimeBinding::Agent {
                model: worker_catalog::ModelId::new("gpt-5.6").assert_value_with("model"),
                effort: None,
                session_scope: SessionScope::Execution,
                env: environment,
            },
        )]),
    }
}

fn claude_runtime() -> RuntimePlan {
    RuntimePlan::Claude {
        provider: ClaudeProvider::Anthropic,
        nodes: BTreeMap::from([(
            NodeName::new("work").assert_value_with("node"),
            NodeRuntimeBinding::Agent {
                model: worker_catalog::ModelId::new("claude-sonnet-5").assert_value_with("model"),
                effort: Some(ReasoningEffort::Max),
                session_scope: SessionScope::Execution,
                env: BTreeSet::new(),
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

fn portable_filesystem(
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

fn writable_directory(path: &Path) {
    fs::create_dir(path).assert_value_with("create writable directory");
    fs::set_permissions(path, fs::Permissions::from_mode(0o777))
        .assert_value_with("writable permissions");
}

fn test_process_pool() -> HostedProcessPool {
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

use openengine_cluster_testkit::assertions::{AssertValue};
