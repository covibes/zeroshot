#![cfg(unix)]

use std::any::Any;
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use openengine_cluster_protocol::{
    IdempotencyKey, NodeName, RunAttachEventNotification, RunAttachParams, RunForceParams,
    RunForceResult, RunId, RunListParams, RunListResult, RunLogEventNotification, RunLogsParams,
    RunStatus, RunStatusParams, RunStatusResult, RunSubmitParams, RunSubmitResult,
    RunWatchEventNotification, RunWatchParams, TerminalResult, WorkerOutcome,
};
use openengine_cluster_server::{ClusterBackend, ConnectionContext};
use serde_json::{json, Value};

use super::*;
use crate::execution::process::HostedProcessPool;
use crate::execution::SessionScope;
use crate::native_v2_candidate::test_support::{TestGitRepository, git_output};
use crate::native_v2_admission::NativeV2Admission;
use crate::native_v2_capsule::{NativeCapsuleNodeEndpoint, RemoteCapsuleNodeRunner};
use crate::native_v2_claude::ClaudeProcessEnvironment;
use crate::native_v2_cli::{
    execute_native_v2_cli, CliOutcome, CliSubscription, CliSubscriptionItem, NativeV2CliBackend,
    NativeV2CliCommand, NativeV2CliError, NeverDetach, RunCommand, TargetAdd, TargetSetup,
};
use crate::native_v2_cloud::{
    AllocatedCapsule, CapsuleAllocationUnavailable, CapsuleAllocator, CapsuleCleanup,
    CapsuleCleanupUnavailable, CapsuleDestroyed, ControllerClaimUnavailable, ControllerEnvironment,
    ExclusiveControllerClaim, NativeV2CloudController,
};
use crate::native_v2_contract::{CodexProvider, EnvironmentVariableName, NodeInvocation, RunSubmission};
use crate::native_v2_delivery::{
    DeliveryPollPolicy, DeliveryTarget, GitHubAuthorityError, GitHubChecks, GitHubCredential,
    GitHubPushRequest, GitHubReviewObservation, GitHubReviewReceipt, GitHubReviewRequest,
    GitHubReviewState, GITHUB_TOKEN_ENV,
};
use crate::native_v2_runner::NodeRole;
use crate::native_v2_supervisor::RunRuntimeExit;
use crate::v2_run_ledger::fake::FakeRunLedger;
use crate::worker_catalog::{self, ReasoningEffort};

type TempRepository = TestGitRepository;

struct ScriptedGitHub {
    remote: PathBuf,
    pushed: AtomicBool,
    merge_requested: AtomicBool,
}

impl ScriptedGitHub {
    fn new(remote: PathBuf) -> Self {
        Self {
            remote,
            pushed: AtomicBool::new(false),
            merge_requested: AtomicBool::new(false),
        }
    }
}

#[async_trait]
impl GitHubDeliveryAuthority for ScriptedGitHub {
    async fn push_branch(
        &self,
        request: &GitHubPushRequest,
        credential: GitHubCredential<'_>,
    ) -> Result<(), GitHubAuthorityError> {
        if credential.expose() != "test-github-token" {
            return Err(GitHubAuthorityError::Rejected);
        }
        let status = tokio::process::Command::new("/usr/bin/git")
            .arg("-C")
            .arg(&request.workspace)
            .arg("push")
            .arg(&self.remote)
            .arg(format!("HEAD:refs/heads/{}", request.head_branch))
            .status()
            .await
            .map_err(|_| GitHubAuthorityError::Unavailable)?;
        if !status.success() {
            return Err(GitHubAuthorityError::Rejected);
        }
        self.pushed.store(true, Ordering::SeqCst);
        Ok(())
    }

    async fn open_or_update_review(
        &self,
        request: &GitHubReviewRequest,
        credential: GitHubCredential<'_>,
    ) -> Result<GitHubReviewReceipt, GitHubAuthorityError> {
        if credential.expose() != "test-github-token" || !self.pushed.load(Ordering::SeqCst) {
            return Err(GitHubAuthorityError::Rejected);
        }
        Ok(GitHubReviewReceipt {
            review_id: "candidate-review".to_owned(),
            repository: request.target.repository.clone(),
            target_branch: request.target.target_branch.clone(),
            head_branch: request.head_branch.clone(),
            head_revision: request.head_revision.clone(),
        })
    }

    async fn inspect_review(
        &self,
        review: &GitHubReviewReceipt,
        credential: GitHubCredential<'_>,
    ) -> Result<GitHubReviewObservation, GitHubAuthorityError> {
        if credential.expose() != "test-github-token" {
            return Err(GitHubAuthorityError::Rejected);
        }
        let state = if self.merge_requested.load(Ordering::SeqCst) {
            GitHubReviewState::Merged {
                merge_revision: review.head_revision.clone(),
            }
        } else {
            GitHubReviewState::Open {
                checks: GitHubChecks::NotRequired,
            }
        };
        Ok(review.observation(state))
    }

    async fn request_merge(
        &self,
        _review: &GitHubReviewReceipt,
        credential: GitHubCredential<'_>,
    ) -> Result<(), GitHubAuthorityError> {
        if credential.expose() != "test-github-token" {
            return Err(GitHubAuthorityError::Rejected);
        }
        self.merge_requested.store(true, Ordering::SeqCst);
        Ok(())
    }
}

struct AgentSession(AtomicBool);

#[async_trait]
impl NodeSession for AgentSession {
    fn as_any(&self) -> &dyn Any {
        self
    }

    async fn is_live(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }

    async fn close(&self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

struct ScriptedAgent {
    workspace: PathBuf,
    starts: AtomicUsize,
}

#[async_trait]
impl SessionFactory for ScriptedAgent {
    async fn open(
        &self,
        _invocation: &NodeInvocation,
        _environment: &ResolvedEnvironment,
    ) -> Result<Arc<dyn NodeSession>, NodeRunnerError> {
        Ok(Arc::new(AgentSession(AtomicBool::new(true))))
    }
}

#[async_trait]
impl NodeDriver for ScriptedAgent {
    async fn run(
        &self,
        invocation: DriverInvocation,
        control: DriverControl,
    ) -> Result<WorkerOutcome, NodeRunnerError> {
        if invocation.role != NodeRole::Worker {
            return Err(NodeRunnerError::InvalidRole);
        }
        self.starts.fetch_add(1, Ordering::SeqCst);
        fs::write(self.workspace.join("result.txt"), "native v2\n")
            .map_err(|_| NodeRunnerError::Driver)?;
        control.emit(crate::native_v2_runner::LiveOutput::new(
            crate::native_v2_runner::LiveOutputStream::Output,
            "worker: mutation ready",
        )?)?;
        Ok(WorkerOutcome::Verified {
            output: Value::Null,
            artifacts: Vec::new(),
        })
    }
}

#[derive(Clone, Default)]
struct ClaimAuthority(Arc<AtomicBool>);

struct Claim(Arc<AtomicBool>);

impl ExclusiveControllerClaim for Claim {}

impl Drop for Claim {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

struct ConfirmCleanup(AtomicUsize);

#[async_trait]
impl CapsuleCleanup for ConfirmCleanup {
    async fn destroy_or_confirm_absent(
        &self,
        _exit: RunRuntimeExit,
    ) -> Result<CapsuleDestroyed, CapsuleCleanupUnavailable> {
        self.0.fetch_add(1, Ordering::SeqCst);
        Ok(CapsuleDestroyed::confirmed())
    }
}

struct CandidateAllocator {
    claims: ClaimAuthority,
    workspace: PathBuf,
    target: DeliveryTarget,
    github: Arc<ScriptedGitHub>,
    agent: Arc<ScriptedAgent>,
    cleanup: Arc<ConfirmCleanup>,
}

#[path = "tests/cli_backend.rs"]
mod cli_backend;
use cli_backend::InProcessCliBackend;

#[async_trait]
impl CapsuleAllocator for CandidateAllocator {
    async fn claim_controller(
        &self,
    ) -> Result<Arc<dyn ExclusiveControllerClaim>, ControllerClaimUnavailable> {
        if self.claims.0.swap(true, Ordering::SeqCst) {
            return Err(ControllerClaimUnavailable);
        }
        Ok(Arc::new(Claim(self.claims.0.clone())))
    }

    async fn allocate(
        &self,
        _run_id: &RunId,
        admitted: &AdmittedRun,
    ) -> Result<AllocatedCapsule, CapsuleAllocationUnavailable> {
        let delivery = Arc::new(NativeV2DeliveryAdapter::new(
            NativeV2DeliveryConfig {
                workspace: self.workspace.clone(),
                git_program: PathBuf::from("/usr/bin/git"),
                target: self.target.clone(),
                ship_authorized: admitted.ship,
                poll: DeliveryPollPolicy::new(3, Duration::ZERO)
                    .map_err(|_| CapsuleAllocationUnavailable)?,
            },
            self.github.clone(),
        ));
        let local = assemble_runner(admitted, self.agent.clone(), self.agent.clone(), delivery)
            .map_err(|_| CapsuleAllocationUnavailable)?;
        let endpoint = Arc::new(NativeCapsuleNodeEndpoint::new(Arc::new(local)));
        let remote = Arc::new(RemoteCapsuleNodeRunner::new(endpoint));
        Ok(AllocatedCapsule {
            loss: remote.connection_loss(),
            runner: remote,
            cleanup: self.cleanup.clone(),
        })
    }

    async fn destroy_or_confirm_absent(
        &self,
        _run_id: &RunId,
        exit: RunRuntimeExit,
    ) -> Result<CapsuleDestroyed, CapsuleCleanupUnavailable> {
        self.cleanup.destroy_or_confirm_absent(exit).await
    }
}

#[tokio::test]
async fn cloud_oecp_candidate_runs_worker_and_trusted_merge_entirely_through_v2() {
    let repository = TempRepository::candidate();
    let target = DeliveryTarget::new("acme/project", "main", repository.base.clone())
        .assert_value_with("delivery target");
    let github = Arc::new(ScriptedGitHub::new(repository.remote.clone()));
    let agent = Arc::new(ScriptedAgent {
        workspace: repository.workspace.clone(),
        starts: AtomicUsize::new(0),
    });
    let cleanup = Arc::new(ConfirmCleanup(AtomicUsize::new(0)));
    let allocator = Arc::new(CandidateAllocator {
        claims: ClaimAuthority::default(),
        workspace: repository.workspace.clone(),
        target,
        github: github.clone(),
        agent: agent.clone(),
        cleanup: cleanup.clone(),
    });
    let ledger = Arc::new(FakeRunLedger::new());
    let token = EnvironmentVariableName::new(GITHUB_TOKEN_ENV).assert_value_with("token name");
    let controller = Arc::new(
        NativeV2CloudController::new(
            ledger,
            runtime(RuntimePlanKind::Codex),
            ControllerEnvironment::new(BTreeMap::from([(token, "test-github-token".to_owned())])),
            allocator,
        )
        .await
        .assert_value_with("controller"),
    );
    let submitted = submit_through_cli(&repository, controller.clone()).await;
    let direct_status = ClusterBackend::run_status(
        &*controller,
        &ConnectionContext::default(),
        RunStatusParams {
            run_id: submitted.run_id.clone(),
        },
    )
    .await
    .assert_value_with("direct OECP status");
    assert_eq!(direct_status.run_id, submitted.run_id);
    let terminal = wait_for_terminal(&controller, &submitted.run_id).await;

    assert_eq!(
        terminal,
        TerminalResult::Succeeded {
            output: Value::Null
        }
    );
    assert_eq!(agent.starts.load(Ordering::SeqCst), 1);
    assert!(github.pushed.load(Ordering::SeqCst));
    assert!(github.merge_requested.load(Ordering::SeqCst));
    assert_eq!(cleanup.0.load(Ordering::SeqCst), 1);
    assert!(repository.workspace.join("result.txt").is_file());
    assert!(!git_output(&repository.remote, &["show-ref", "--heads"]).is_empty());
}

async fn submit_through_cli(
    repository: &TempRepository,
    controller: Arc<NativeV2CloudController>,
) -> RunSubmitResult {
    let graph_path = repository.root.child("graph.json");
    let input_path = repository.root.child("input.json");
    fs::write(
        &graph_path,
        serde_json::to_vec(&shipping_graph()).assert_value_with("encode graph"),
    )
    .assert_value_with("write graph");
    fs::write(&input_path, b"null\n").assert_value_with("write input");
    let backend = InProcessCliBackend { controller };
    let mut output = Vec::new();
    let outcome = execute_native_v2_cli(
        NativeV2CliCommand::Run(RunCommand {
            target: "candidate-cloud".to_owned(),
            graph: graph_path,
            input: input_path,
            ship: true,
            detach: true,
            submission_key: Some(
                IdempotencyKey::new("candidate-e2e").assert_value_with("submission key"),
            ),
        }),
        &backend,
        &mut NeverDetach,
        &mut output,
    )
    .await
    .assert_value_with("CLI run");
    assert_eq!(outcome, CliOutcome::Detached);
    serde_json::from_slice(&output).assert_value_with("CLI receipt")
}

#[tokio::test]
async fn concrete_codex_and_claude_configs_bind_only_to_their_admitted_lane() {
    let repository = TempRepository::candidate();
    let github = Arc::new(ScriptedGitHub::new(repository.remote.clone()));
    let codex = admitted(RuntimePlanKind::Codex).await;
    let codex_config = candidate_config(
        RuntimePlanKind::Codex,
        &repository,
        github.clone(),
        codex.ship,
    );
    build_native_v2_candidate(&codex, codex_config).assert_value_with("Codex candidate");

    let claude = admitted(RuntimePlanKind::Claude).await;
    let claude_config = candidate_config(
        RuntimePlanKind::Claude,
        &repository,
        github.clone(),
        claude.ship,
    );
    build_native_v2_candidate(&claude, claude_config).assert_value_with("Claude candidate");

    let mismatch = candidate_config(RuntimePlanKind::Claude, &repository, github, codex.ship);
    let error = build_native_v2_candidate(&codex, mismatch)
        .assert_error_with("mismatched candidate must fail");
    assert_eq!(error, NativeV2CandidateError::RuntimeMismatch);
}

#[test]
fn candidate_source_has_no_route_to_the_replaced_runtime_paths() {
    let source = include_str!("../native_v2_candidate.rs");
    for forbidden in [
        ["cluster", "_ledger"].concat(),
        ["hosted", "_oecp"].concat(),
        ["native", "_admission"].concat(),
        ["Native", "Backend"].concat(),
    ] {
        assert!(!source.contains(&forbidden), "forbidden route {forbidden}");
    }
    for required in [
        "NativeV2CodexAdapter",
        "ClaudeAdapter",
        "NativeV2DeliveryAdapter",
        "NativeNodeRunner",
    ] {
        assert!(source.contains(required), "missing v2 seam {required}");
    }
}

#[path = "tests/fixtures.rs"]
mod fixtures;
use fixtures::{
    RuntimePlanKind, admitted, candidate_config, runtime, shipping_graph, wait_for_terminal,
};

use openengine_cluster_testkit::assertions::{AssertError, AssertValue};
