#![cfg(unix)]

use std::{
    any::Any,
    collections::{BTreeMap, BTreeSet},
    fs,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use openengine_cluster_protocol::{
    GraphSpec, IdempotencyKey, NodeName, PositiveInteger, RunId, Sha256Digest, TerminalResult,
    WorkerErrorCode, WorkerOutcome, WorkerRef,
};
use openengine_cluster_server::admission::VerifiedGraph;
use serde_json::{json, Value};

use super::*;
use crate::full_v1_reducer::{
    Decision, DurableExecution, DurableExecutionState, FullV1Reducer, HistoryPosition,
    ReductionInput, StructuralOccurrence,
};
use crate::native_v2_admission::NativeV2Admission;
use crate::native_v2_candidate::test_support::{
    TestGitRepository, git_delivery_node, full_graph, success_node,
};
use crate::native_v2_contract::{
    self, ExecutionRef, NodeInvocation, NodeRuntimeBinding, RunSubmission, RuntimePlan,
};
use crate::native_v2_cloud::ControllerEnvironment;
use crate::native_v2_runner::{
    DriverControl, DriverInvocation, NativeNodeRunner, NodeDriver, NodeRunRequest, NodeRunner,
    NodeRunnerError, NodeSession, ResolvedEnvironment, SessionFactory,
};
use crate::native_v2_supervisor::NativeV2Supervisor;
use crate::v2_run_ledger::fake::FakeRunLedger;
use crate::v2_run_ledger::{CreateRun, RunLedger};

#[path = "tests/github_fixture.rs"]
mod github_fixture;
#[path = "tests/routing.rs"]
mod routing;

use github_fixture::{GH_MISMATCH_SCRIPT, GH_SCRIPT, GIT_SCRIPT};
use routing::assert_ci_failure_routes_an_authored_worker_loop;

type TempRepo = TestGitRepository;

#[derive(Clone, Copy)]
enum Script {
    NoCi,
    CiFailed,
    CiFailsThenMerges,
    NeverConfirmsMerge,
}

struct FakeGitHub {
    remote: PathBuf,
    script: Script,
    pushed: AtomicBool,
    merge_requested: AtomicBool,
    merge_requests: AtomicUsize,
    inspections: AtomicUsize,
}

impl FakeGitHub {
    fn new(remote: PathBuf, script: Script) -> Self {
        Self {
            remote,
            script,
            pushed: AtomicBool::new(false),
            merge_requested: AtomicBool::new(false),
            merge_requests: AtomicUsize::new(0),
            inspections: AtomicUsize::new(0),
        }
    }

    fn review_state(&self, inspection: usize) -> GitHubReviewState {
        match self.script {
            Script::NoCi => self.no_ci_state(),
            Script::CiFailed => open_review(GitHubChecks::Failed),
            Script::CiFailsThenMerges => self.ci_repair_state(inspection),
            Script::NeverConfirmsMerge => open_review(GitHubChecks::Passed),
        }
    }

    fn no_ci_state(&self) -> GitHubReviewState {
        if self.merge_requested.load(Ordering::SeqCst) {
            merged_review()
        } else {
            open_review(GitHubChecks::NotRequired)
        }
    }

    fn ci_repair_state(&self, inspection: usize) -> GitHubReviewState {
        if inspection == 1 {
            return open_review(GitHubChecks::Failed);
        }
        if self.merge_requested.load(Ordering::SeqCst) {
            merged_review()
        } else {
            open_review(GitHubChecks::Passed)
        }
    }
}

fn merged_review() -> GitHubReviewState {
    GitHubReviewState::Merged {
        merge_revision: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb".to_owned(),
    }
}

fn open_review(checks: GitHubChecks) -> GitHubReviewState {
    GitHubReviewState::Open { checks }
}

#[async_trait]
impl GitHubDeliveryAuthority for FakeGitHub {
    async fn push_branch(
        &self,
        request: &GitHubPushRequest,
        credential: GitHubCredential<'_>,
    ) -> Result<(), GitHubAuthorityError> {
        assert_eq!(credential.expose(), "test-token");
        let status = tokio::process::Command::new("/usr/bin/git")
            .arg("-C")
            .arg(&request.workspace)
            .arg("push")
            .arg(&self.remote)
            .arg(format!("HEAD:refs/heads/{}", request.head_branch))
            .status()
            .await
            .assert_value();
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
        assert_eq!(credential.expose(), "test-token");
        assert!(self.pushed.load(Ordering::SeqCst));
        Ok(GitHubReviewReceipt {
            review_id: "17".to_owned(),
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
        assert_eq!(credential.expose(), "test-token");
        let inspection = self.inspections.fetch_add(1, Ordering::SeqCst) + 1;
        let state = self.review_state(inspection);
        Ok(review.observation(state))
    }

    async fn request_merge(
        &self,
        _review: &GitHubReviewReceipt,
        credential: GitHubCredential<'_>,
    ) -> Result<(), GitHubAuthorityError> {
        assert_eq!(credential.expose(), "test-token");
        self.merge_requests.fetch_add(1, Ordering::SeqCst);
        self.merge_requested.store(true, Ordering::SeqCst);
        Ok(())
    }
}

#[tokio::test]
async fn no_ci_can_merge_but_only_after_authoritative_confirmation() {
    let repo = TempRepo::delivery();
    let authority = Arc::new(FakeGitHub::new(repo.remote.clone(), Script::NoCi));
    let outcome = run_delivery(&repo, authority.clone(), 3).await;
    assert_delivery_signal(&outcome, DELIVERY_MERGED_LABEL);
    assert_eq!(authority.merge_requests.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn ci_failure_is_a_routable_verifier_result() {
    let repo = TempRepo::delivery();
    let authority = Arc::new(FakeGitHub::new(repo.remote.clone(), Script::CiFailed));
    let outcome = run_delivery(&repo, authority.clone(), 2).await;
    assert_delivery_signal(&outcome, DELIVERY_CI_FAILED_LABEL);
    assert_eq!(authority.merge_requests.load(Ordering::SeqCst), 0);
    assert_ci_failure_routes_an_authored_worker_loop(outcome).await;
}

#[tokio::test]
async fn accepted_merge_request_is_not_shipping_success() {
    let repo = TempRepo::delivery();
    let authority = Arc::new(FakeGitHub::new(
        repo.remote.clone(),
        Script::NeverConfirmsMerge,
    ));
    let outcome = run_delivery(&repo, authority.clone(), 2).await;
    assert_eq!(
        outcome,
        WorkerOutcome::declared_failure(WorkerErrorCode::Timeout)
    );
    assert_eq!(authority.merge_requests.load(Ordering::SeqCst), 1);
}

#[path = "tests/github_acceptance.rs"]
mod github_acceptance;

async fn run_delivery(
    repo: &TempRepo,
    authority: Arc<FakeGitHub>,
    attempts: usize,
) -> WorkerOutcome {
    let admitted = admitted(repo).await;
    let config = NativeV2DeliveryConfig {
        workspace: repo.workspace.clone(),
        git_program: PathBuf::from("/usr/bin/git"),
        target: DeliveryTarget::new("acme/project", "main", repo.base.clone()).assert_value(),
        ship_authorized: admitted.ship,
        poll: DeliveryPollPolicy::new(attempts, Duration::ZERO).assert_value(),
    };
    let adapter = Arc::new(NativeV2DeliveryAdapter::new(config, authority));
    let runner = NativeNodeRunner::new(&admitted, adapter.clone(), adapter).assert_value();
    let binding = admitted
        .runtime
        .nodes()
        .get(&NodeName::new("deliver").assert_value())
        .assert_value()
        .clone();
    let environment = ResolvedEnvironment::exact(
        &binding,
        BTreeMap::from([(
            EnvironmentVariableName::new(GITHUB_TOKEN_ENV).assert_value(),
            "test-token".to_owned(),
        )]),
    )
    .assert_value();
    let mut handle = runner
        .start(NodeRunRequest {
            invocation: NodeInvocation {
                reference: ExecutionRef {
                    run_id: RunId::new("delivery-run"),
                    node: NodeName::new("deliver").assert_value(),
                    node_instance: native_v2_contract::NodeInstanceId::new(1).assert_value(),
                    execution: native_v2_contract::ExecutionId::new(1).assert_value(),
                },
                worker: WorkerRef::new("builtin.git-delivery@1").assert_value(),
                input: Value::Null,
                binding,
            },
            environment,
        })
        .await
        .assert_value();
    handle.completion().await.assert_value().outcome
}

async fn admitted(repo: &TempRepo) -> crate::native_v2_contract::AdmittedRun {
    let graph = full_graph(vec![git_delivery_node(), success_node()]);
    let binding = NodeRuntimeBinding::GitDelivery {
        env: BTreeSet::from([EnvironmentVariableName::new(GITHUB_TOKEN_ENV).assert_value()]),
    };
    NativeV2Admission
        .admit(RunSubmission {
            graph,
            initial_input: Value::Null,
            runtime: RuntimePlan::Codex {
                provider: crate::native_v2_contract::CodexProvider::OpenAi,
                nodes: BTreeMap::from([(NodeName::new("deliver").assert_value(), binding)]),
            },
            ship: true,
            submission_key: IdempotencyKey::new(format!("delivery-{}", repo.base)).assert_value(),
        })
        .await
        .assert_value()
}

fn assert_delivery_signal(outcome: &WorkerOutcome, expected: &str) {
    let extracted = match outcome {
        WorkerOutcome::Verifier {
            output,
            signals,
            diagnostic,
            artifacts,
        } => Some((output, signals, diagnostic, artifacts)),
        _ => None,
    };
    let (output, signals, diagnostic, artifacts) =
        extracted.assert_value_with("delivery must return a verifier result");
    assert_eq!(output, &Value::Null);
    assert_eq!(
        signals
            .get(&FieldName::new(DELIVERY_SIGNAL_FIELD).assert_value())
            .assert_value()
            .as_str(),
        expected
    );
    assert!(diagnostic.is_string());
    assert!(artifacts.is_empty());
}

fn write_executable(directory: &Path, name: &str, contents: &str) -> PathBuf {
    let path = directory.join(name);
    fs::write(&path, contents).assert_value();
    let mut permissions = fs::metadata(&path).assert_value().permissions();
    permissions.set_mode(0o700);
    fs::set_permissions(&path, permissions).assert_value();
    path
}

fn argument_lines(capture: &str) -> String {
    capture
        .lines()
        .filter(|line| line.starts_with("arg="))
        .collect::<Vec<_>>()
        .join("\n")
}

use openengine_cluster_testkit::assertions::{AssertValue};
