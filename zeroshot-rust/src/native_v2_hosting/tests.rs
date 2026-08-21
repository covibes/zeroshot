#![cfg(unix)]

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::Path;
use std::time::Duration;

use openengine_cluster_protocol::{NodeName, RunId, RunSize, RuntimePlan, WorkerRef};
use serde_json::Value;

use super::*;
use crate::native_v2_candidate::test_support::{TestDirectory, admit, environment_name};
use crate::native_v2_cloud::CapsuleAllocator;
use crate::native_v2_contract::{self, ExecutionRef, NodeInvocation};
use crate::native_v2_runner::{NodeRunRequest, ResolvedEnvironment};
use crate::native_v2_portable_controller::WorkspaceIdentity;
use crate::native_v2_supervisor::{RunEnvironment, RunEnvironmentError, RunRuntimeExit};
use crate::native_v2_target_authority::TargetAuthorityErrorKind;

use super::allocator::{ProductionCapsuleAllocator, monitor_workspace_identity};
use super::repository::{RepositoryInstall, install_repository, path_source};

mod fixtures;

use fixtures::*;

#[test]
fn run_environment_is_exact_and_request_debug_is_redacted() {
    let declared = environment_name("OPENAI_API_KEY");
    let unused = environment_name("UNUSED_SECRET");
    let runtime = runtime(BTreeSet::from([declared.clone()]));
    let available = BTreeMap::from([
        (declared.clone(), "openai-secret".to_owned()),
        (unused, "unused-secret".to_owned()),
    ]);
    let selected = RunEnvironment::from_available(&runtime, &available)
        .assert_value_with("select declared environment");
    assert!(matches!(
        RunEnvironment::exact(&runtime, available.clone()),
        Err(RunEnvironmentError::Undeclared(_))
    ));
    let selected_debug = format!("{selected:?}");
    assert!(!selected_debug.contains("openai-secret"));
    assert!(!selected_debug.contains("unused-secret"));

    let request = crate::native_v2_target_authority::TargetRunRequest {
        run_id: RunId::new("018f5e78-7f95-7c22-8d98-3f15af20c991"),
        submission: submission(
            runtime,
            "0123456789abcdef0123456789abcdef01234567",
            "redacted-request",
        ),
        environment: available,
        github_token: Some("github-secret".to_owned()),
    };
    let debug = format!("{request:?}");
    assert!(debug.contains("OPENAI_API_KEY"));
    assert!(debug.contains("UNUSED_SECRET"));
    assert!(!debug.contains("openai-secret"));
    assert!(!debug.contains("unused-secret"));
    assert!(!debug.contains("github-secret"));
}

#[tokio::test]
async fn sqlite_controllers_share_one_durable_namespace_without_a_target_wide_claim() {
    let root = TestDirectory::new("hosting-controller");
    let first = ProductionTargetControllerFactory::new(hosting_config(root.path().to_owned()));
    let second = first.clone();

    let first_controller = first
        .create_controller()
        .await
        .assert_value_with("first controller");
    let second_controller = second
        .create_controller()
        .await
        .assert_value_with("second controller");
    assert!(first_controller.list().await.assert_value().is_empty());
    assert!(second_controller.list().await.assert_value().is_empty());
    assert!(root.path().join("runs.sqlite3").is_file());
}

#[tokio::test]
async fn invalid_submission_fails_before_run_allocation() {
    let root = TestDirectory::new("hosting-invalid-intent");
    let mut config = hosting_config(root.path().to_owned());
    config.git_program = root.path().join("git-must-not-run");
    let factory = ProductionTargetControllerFactory::new(config);
    let controller = factory
        .create_controller()
        .await
        .assert_value_with("controller");
    let mut sourceful = submission(
        runtime(BTreeSet::new()),
        "0123456789abcdef0123456789abcdef01234567",
        "invalid-before-effects",
    );
    sourceful.runtime = RuntimePlan::Codex {
        provider: crate::native_v2_contract::CodexProvider::OpenAi,
        size: RunSize::Small,
        nodes: BTreeMap::new(),
    };

    let error = factory
        .submit(
            &controller,
            crate::native_v2_target_authority::TargetRunRequest {
                run_id: RunId::new("018f5e78-7f95-7c22-8d98-3f15af20c991"),
                submission: sourceful,
                environment: BTreeMap::new(),
                github_token: None,
            },
        )
        .await
        .assert_error_with("invalid runtime must fail admission");

    assert_eq!(error.kind(), TargetAuthorityErrorKind::Invalid);
    assert_eq!(
        fs::read_dir(root.path().join("runs"))
            .assert_value_with("runs directory")
            .count(),
        0
    );
}

#[tokio::test]
async fn invalid_run_environment_fails_before_allocation() {
    let root = TestDirectory::new("hosting-invalid-environment");
    let mut config = hosting_config(root.path().to_owned());
    config.git_program = root.path().join("git-must-not-run");
    let factory = ProductionTargetControllerFactory::new(config);
    let controller = factory
        .create_controller()
        .await
        .assert_value_with("controller");
    let declared = environment_name("NODE_TOKEN");
    let sourceful = submission(
        runtime(BTreeSet::from([declared])),
        "0123456789abcdef0123456789abcdef01234567",
        "invalid-environment-before-effects",
    );

    let error = factory
        .submit(
            &controller,
            crate::native_v2_target_authority::TargetRunRequest {
                run_id: RunId::new("018f5e78-7f96-7c22-8d98-3f15af20c991"),
                submission: sourceful,
                environment: BTreeMap::new(),
                github_token: None,
            },
        )
        .await
        .assert_error_with("missing environment must fail before source resolution");

    assert_eq!(error.kind(), TargetAuthorityErrorKind::Invalid);
    assert_eq!(
        fs::read_dir(root.path().join("runs"))
            .assert_value_with("runs directory")
            .count(),
        0
    );
}

#[tokio::test]
async fn repository_resolution_and_installation_preserve_the_exact_revision() {
    let repository = RepositoryFixture::new();
    let root = TestDirectory::new("hosting-installs");
    let pool = test_process_pool();
    let source = path_source(&repository.remote);
    let feature = openengine_cluster_protocol::ResolvedSource {
        repository: openengine_cluster_protocol::SourceRepositoryId::new("acme/project")
            .assert_value_with("repository"),
        branch: openengine_cluster_protocol::SourceBranchId::new("feature")
            .assert_value_with("branch"),
        revision: openengine_cluster_protocol::SourceRevisionId::new(&repository.feature_revision)
            .assert_value_with("revision"),
    };

    repository.move_feature_to(&repository.main_revision);
    let workspace = root.path().join("workspace");
    writable_directory(&workspace);
    let installed = install_repository(RepositoryInstall {
        git_program: Path::new("/usr/bin/git"),
        source: &source,
        resolved: &feature,
        workspace: &workspace,
        process_pool: pool,
        github_token: None,
    })
    .await
    .assert_value_with("install exact resolved revision");
    assert_eq!(installed.target_branch, "feature");
    assert_eq!(installed.base_revision, repository.feature_revision);
}

#[tokio::test]
async fn allocator_uses_one_workspace_then_cleans_without_replacement() {
    let repository = RepositoryFixture::new();
    let root = TestDirectory::new("hosting-allocator");
    prepare_storage_root(&root.path().to_owned()).assert_value_with("storage root");
    let runtime = runtime(BTreeSet::new());
    let admitted = admit(submission(
        runtime.clone(),
        repository.main_revision.as_str(),
        "hosting-allocation",
    ))
    .await;
    let allocator = ProductionCapsuleAllocator::new(capsule_config(root.path().to_owned()))
        .assert_value_with("allocator")
        .with_test_filesystem_and_source(repository.remote, portable_filesystem);
    let run_id = RunId::new("run-hosting-one");
    let run_path = allocator.run_path(&run_id);

    let capsule = allocator
        .allocate(&run_id, &admitted, None)
        .await
        .assert_value_with("allocate capsule");
    assert!(run_path.join("workspace/.git").is_dir());
    assert!(run_path.join("runtime").is_dir());
    assert!(allocator.allocate(&run_id, &admitted, None).await.is_err());

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
    assert!(allocator.allocate(&run_id, &admitted, None).await.is_err());
}

#[tokio::test]
async fn hosted_workspace_replacement_signals_runtime_loss() {
    let root = TestDirectory::new("hosting-workspace-loss");
    let workspace = root.path().join("workspace");
    fs::create_dir(&workspace).assert_value_with("create workspace");
    let identity = WorkspaceIdentity::capture(&workspace).assert_value_with("workspace identity");
    let (loss_sender, mut loss) = tokio::sync::watch::channel(false);
    monitor_workspace_identity(workspace.clone(), identity, loss_sender);

    fs::remove_dir(&workspace).assert_value_with("remove workspace");
    fs::create_dir(&workspace).assert_value_with("replace workspace");

    tokio::time::timeout(Duration::from_secs(1), async {
        while !*loss.borrow_and_update() {
            loss.changed()
                .await
                .assert_value_with("workspace loss signal");
        }
    })
    .await
    .assert_value_with("workspace loss timeout");
}

#[tokio::test]
async fn default_claude_environment_prepares_capsule_session_home() {
    let repository = RepositoryFixture::new();
    let root = TestDirectory::new("hosting-claude-environment");
    prepare_storage_root(&root.path().to_owned()).assert_value_with("storage root");
    let runtime = claude_runtime();
    let admitted = admit(submission(
        runtime,
        repository.main_revision.as_str(),
        "hosting-claude-environment",
    ))
    .await;
    let mut config = capsule_config(root.path().to_owned());
    config.claude_process_environment = ClaudeProcessEnvironment::default();
    let allocator = ProductionCapsuleAllocator::new(config)
        .assert_value_with("allocator")
        .with_test_filesystem_and_source(repository.remote, portable_filesystem);
    let run_id = RunId::new("run-hosting-claude-environment");
    let run_path = allocator.run_path(&run_id);
    let capsule = allocator
        .allocate(&run_id, &admitted, None)
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
                instructions: Some(
                    openengine_cluster_protocol::NodeInstructions::new("Exercise the hosted node.")
                        .assert_value_with("instructions"),
                ),
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

use openengine_cluster_testkit::assertions::{AssertError, AssertValue};
