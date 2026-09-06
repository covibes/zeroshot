#![cfg(unix)]

use std::{any::Any, collections::BTreeMap, fs, path::PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use openengine_cluster_protocol::{
    ConnectionKey, IdempotencyKey, NodeName, PositiveInteger, RunId, Sha256Digest,
    StaticConnectionValues, TerminalResult, WorkerErrorCode, WorkerOutcome, WorkerRef,
};
use openengine_cluster_server::admission::VerifiedGraph;
use serde_json::{json, Value};

use super::*;
use crate::full_v1_reducer::{
    Decision, DurableExecution, DurableExecutionState, FullV1Reducer, HistoryPosition,
    ReductionInput, StructuralOccurrence,
};
use crate::native_v2_admission::NativeV2Admission;
use crate::native_v2_candidate::test_support::{TestGitRepository, full_graph, git, success_node};
use crate::native_v2_contract::{
    self, CodexProvider, DeclaredConnections, DeclaredEnvironment, ExecutionRef, NodeInvocation,
    NodeRuntimeBinding, RunSize, RunSubmission, RunTitle, RuntimePlan, SourceBranchId,
    SourceRepositoryId, SourceRevisionId, ResolvedSource, GIT_DELIVERY_MERGE_WORKER_REF,
    GIT_DELIVERY_PR_WORKER_REF,
};
use crate::native_v2_runner::{
    DriverControl, DriverInvocation, NativeNodeRunner, NodeDriver, NodeRunRequest, NodeRunner,
    NodeRunnerError, NodeSession, ResolvedEnvironment, SessionFactory,
};
use crate::native_v2_supervisor::{NativeV2Supervisor, RunEnvironment};
use crate::v2_run_ledger::fake::FakeRunLedger;
use crate::v2_run_ledger::{CreateRun, RunLedger};

#[path = "tests/github_fixture.rs"]
mod github_fixture;
#[path = "tests/head_update.rs"]
mod head_update;
#[path = "tests/routing.rs"]
mod routing;

use github_fixture::{
    FakeGitHub, GH_MISMATCH_SCRIPT, GH_SCRIPT, GIT_SCRIPT, Script, argument_lines,
    delivery_harness, write_executable,
};
use routing::assert_ci_failure_routes_an_authored_worker_loop;

type TempRepo = TestGitRepository;

#[tokio::test]
async fn pr_mode_completes_only_after_authoritative_open_observation() {
    let authority = successful_delivery(DeliveryMode::PullRequest, DELIVERY_OPENED_LABEL, 2).await;
    assert_eq!(authority.inspections.load(Ordering::SeqCst), 1);
    assert_eq!(authority.merge_requests.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn no_ci_can_merge_but_only_after_authoritative_confirmation() {
    let authority = successful_delivery(DeliveryMode::Merge, DELIVERY_MERGED_LABEL, 3).await;
    assert_eq!(authority.merge_requests.load(Ordering::SeqCst), 1);
}

async fn successful_delivery(
    mode: DeliveryMode,
    expected_label: &str,
    attempts: usize,
) -> Arc<FakeGitHub> {
    let repo = TempRepo::delivery();
    let authority = Arc::new(FakeGitHub::new(repo.remote.clone(), Script::NoCi));
    let outcome = run_delivery(&repo, authority.clone(), attempts, mode).await;
    let output = assert_delivery_signal(&outcome, expected_label);
    assert_receipt_match(output, mode, &repo, true);
    authority
}

#[tokio::test]
async fn ci_failure_is_a_routable_verifier_result() {
    let repo = TempRepo::delivery();
    let authority = Arc::new(FakeGitHub::new(repo.remote.clone(), Script::CiFailed));
    let outcome = run_delivery(&repo, authority.clone(), 2, DeliveryMode::Merge).await;
    let output = assert_delivery_signal(&outcome, DELIVERY_CI_FAILED_LABEL);
    assert_receipt_match(output, DeliveryMode::Merge, &repo, false);
    assert_eq!(authority.merge_requests.load(Ordering::SeqCst), 0);
    assert_ci_failure_routes_an_authored_worker_loop(&repo.base, outcome).await;
}

#[tokio::test]
async fn observed_conflict_is_a_routable_non_receipt_result() {
    let repo = TempRepo::delivery();
    let authority = Arc::new(FakeGitHub::new(repo.remote.clone(), Script::Conflict));
    let outcome = run_delivery(&repo, authority.clone(), 2, DeliveryMode::Merge).await;
    let output = assert_delivery_signal(&outcome, DELIVERY_CONFLICT_LABEL);
    assert_receipt_match(output, DeliveryMode::Merge, &repo, false);
    assert_eq!(authority.merge_requests.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn merge_api_conflict_is_not_collapsed_into_infrastructure_failure() {
    let repo = TempRepo::delivery();
    let authority = Arc::new(FakeGitHub::new(
        repo.remote.clone(),
        Script::ConflictAtMerge,
    ));
    let outcome = run_delivery(&repo, authority.clone(), 2, DeliveryMode::Merge).await;
    assert_delivery_signal(&outcome, DELIVERY_CONFLICT_LABEL);
    assert_eq!(authority.merge_requests.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn merge_rejection_before_ci_registration_is_reobserved() {
    let repo = TempRepo::delivery();
    let authority = Arc::new(FakeGitHub::new(
        repo.remote.clone(),
        Script::RegistrationRace,
    ));
    let outcome = run_delivery(&repo, authority.clone(), 4, DeliveryMode::Merge).await;
    assert_delivery_signal(&outcome, DELIVERY_MERGED_LABEL);
    assert_eq!(authority.merge_requests.load(Ordering::SeqCst), 2);
    assert_eq!(authority.inspections.load(Ordering::SeqCst), 3);
}

#[tokio::test]
async fn multiple_ci_registration_waves_each_allow_a_fresh_merge_attempt() {
    assert_eventual_merge(Script::MultipleRegistrationWaves, 7, 3, 6).await;
}

#[tokio::test]
async fn repeated_merge_deferrals_can_eventually_merge_without_a_check_state_change() {
    assert_eventual_merge(Script::DeferredMerge, 7, 5, 6).await;
}

async fn assert_eventual_merge(
    script: Script,
    attempts: usize,
    expected_requests: usize,
    expected_inspections: usize,
) {
    let (repo, authority) = delivery_harness(script);

    let outcome = run_delivery(&repo, authority.clone(), attempts, DeliveryMode::Merge).await;

    assert_delivery_signal(&outcome, DELIVERY_MERGED_LABEL);
    assert_eq!(
        authority.merge_requests.load(Ordering::SeqCst),
        expected_requests
    );
    assert_eq!(
        authority.inspections.load(Ordering::SeqCst),
        expected_inspections
    );
}

#[tokio::test]
async fn repeated_merge_deferral_is_not_misclassified_as_policy_refusal() {
    let repo = TempRepo::delivery();
    let authority = Arc::new(FakeGitHub::new(
        repo.remote.clone(),
        Script::ProtectedBranch,
    ));

    let outcome = run_delivery(&repo, authority.clone(), 20, DeliveryMode::Merge).await;

    assert_eq!(
        outcome,
        WorkerOutcome::declared_failure(WorkerErrorCode::Timeout)
    );
    assert!(authority.merge_requests.load(Ordering::SeqCst) > 2);
    assert!(authority.inspections.load(Ordering::SeqCst) > 2);
}

#[tokio::test]
async fn pushed_review_head_is_retried_during_github_visibility_lag() {
    let repo = TempRepo::delivery();
    let authority = Arc::new(FakeGitHub::new(repo.remote.clone(), Script::ReviewSyncRace));

    let outcome = run_delivery(&repo, authority.clone(), 3, DeliveryMode::Merge).await;

    assert_delivery_signal(&outcome, DELIVERY_MERGED_LABEL);
    assert_eq!(authority.review_sync_attempts.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn accepted_merge_request_is_reasserted_until_authoritative_success() {
    let repo = TempRepo::delivery();
    let authority = Arc::new(FakeGitHub::new(
        repo.remote.clone(),
        Script::NeverConfirmsMerge,
    ));
    let outcome = run_delivery(&repo, authority.clone(), 2, DeliveryMode::Merge).await;
    assert_eq!(
        outcome,
        WorkerOutcome::declared_failure(WorkerErrorCode::Timeout)
    );
    assert_eq!(authority.merge_requests.load(Ordering::SeqCst), 2);
}

struct RefreshedDeliveryEnvironment {
    binding: NodeRuntimeBinding,
}

#[async_trait]
impl crate::native_v2_runner::RuntimeEnvironmentRefresh for RefreshedDeliveryEnvironment {
    async fn refresh(
        &self,
    ) -> Result<ResolvedEnvironment, crate::native_v2_runner::EnvironmentRefreshUnavailable> {
        ResolvedEnvironment::exact(
            &self.binding,
            BTreeMap::from([(
                EnvironmentVariableName::new(GITHUB_TOKEN_ENV).assert_value(),
                "refreshed-token".to_owned(),
            )]),
        )
        .map_err(|_| crate::native_v2_runner::EnvironmentRefreshUnavailable)
    }
}

#[tokio::test]
async fn delivery_refreshes_an_expired_dynamic_github_credential() {
    let repo = TempRepo::delivery();
    let authority = Arc::new(FakeGitHub::new(
        repo.remote.clone(),
        Script::CredentialExpires,
    ));
    let admitted = admitted(&repo, DeliveryMode::Merge).await;
    let binding = admitted
        .runtime
        .nodes()
        .get(&NodeName::new("deliver").assert_value())
        .assert_value()
        .clone();
    let outcome = run_delivery_with_id(
        DeliveryRunRequest {
            repo: &repo,
            attempts: 3,
            mode: DeliveryMode::Merge,
            run_id: "refresh-delivery-credential",
            refresh: Some(Arc::new(RefreshedDeliveryEnvironment { binding })),
        },
        authority.clone(),
    )
    .await;

    assert_delivery_signal(&outcome, DELIVERY_MERGED_LABEL);
    assert_eq!(authority.inspections.load(Ordering::SeqCst), 3);
}

#[tokio::test]
async fn exact_merge_retry_rediscovers_the_same_review_and_receipt() {
    let repo = TempRepo::delivery();
    let authority = Arc::new(FakeGitHub::new(repo.remote.clone(), Script::NoCi));
    let first = run_delivery_with_id(
        DeliveryRunRequest {
            repo: &repo,
            attempts: 3,
            mode: DeliveryMode::Merge,
            run_id: "stable-delivery-run",
            refresh: None,
        },
        authority.clone(),
    )
    .await;
    let second = run_delivery_with_id(
        DeliveryRunRequest {
            repo: &repo,
            attempts: 3,
            mode: DeliveryMode::Merge,
            run_id: "stable-delivery-run",
            refresh: None,
        },
        authority.clone(),
    )
    .await;

    assert_eq!(first, second);
    assert_eq!(authority.merge_requests.load(Ordering::SeqCst), 1);
    let reviews = authority
        .reviews
        .lock()
        .assert_value_with("review request lock");
    assert_eq!(reviews.len(), 2);
    assert_eq!(reviews.assert_at(0), reviews.assert_at(1));
}

#[tokio::test]
async fn rewritten_history_is_rejected_before_push() {
    let repo = TempRepo::delivery();
    git(&repo.workspace, &["checkout", "--orphan", "rewritten"]);
    git(&repo.workspace, &["rm", "-r", "--force", "."]);
    fs::write(repo.workspace.join("result.txt"), "rewritten\n").assert_value();
    let authority = Arc::new(FakeGitHub::new(repo.remote.clone(), Script::NoCi));

    let outcome = run_delivery(&repo, authority.clone(), 2, DeliveryMode::Merge).await;

    assert_eq!(
        outcome,
        WorkerOutcome::declared_failure(WorkerErrorCode::Crash)
    );
    assert!(!authority.pushed.load(Ordering::SeqCst));
    assert!(
        authority
            .reviews
            .lock()
            .assert_value_with("review request lock")
            .is_empty()
    );
}

#[test]
fn delivery_contract_rejects_the_other_modes_schema() {
    let response = NodeResponseContract::Verifier {
        output: delivery_result_schema(DeliveryMode::Merge).assert_value(),
        signals: BTreeMap::from([(
            FieldName::new(DELIVERY_SIGNAL_FIELD).assert_value(),
            delivery_signal_labels(DeliveryMode::PullRequest).assert_value(),
        )]),
        diagnostic: delivery_diagnostic_schema().assert_value(),
    };

    assert!(validate_delivery_contract(DeliveryMode::PullRequest, &response).is_err());
}

#[path = "tests/github_acceptance.rs"]
mod github_acceptance;

async fn run_delivery(
    repo: &TempRepo,
    authority: Arc<FakeGitHub>,
    attempts: usize,
    mode: DeliveryMode,
) -> WorkerOutcome {
    run_delivery_with_id(
        DeliveryRunRequest {
            repo,
            attempts,
            mode,
            run_id: "delivery-run",
            refresh: None,
        },
        authority,
    )
    .await
}

struct DeliveryRunRequest<'a> {
    repo: &'a TempRepo,
    attempts: usize,
    mode: DeliveryMode,
    run_id: &'a str,
    refresh: Option<Arc<dyn crate::native_v2_runner::RuntimeEnvironmentRefresh>>,
}

async fn run_delivery_with_id(
    request: DeliveryRunRequest<'_>,
    authority: Arc<FakeGitHub>,
) -> WorkerOutcome {
    let admitted = admitted(request.repo, request.mode).await;
    let config = NativeV2DeliveryConfig {
        workspace: request.repo.workspace.clone(),
        git_program: PathBuf::from("/usr/bin/git"),
        target: target(request.repo),
        poll: DeliveryPollPolicy::new(request.attempts, Duration::ZERO).assert_value(),
    };
    let adapter = Arc::new(NativeV2DeliveryAdapter::new(config, authority));
    let runner = NativeNodeRunner::new(&admitted, adapter.clone(), adapter).assert_value();
    let binding = admitted
        .runtime
        .nodes()
        .get(&NodeName::new("deliver").assert_value())
        .assert_value()
        .clone();
    let mut environment = ResolvedEnvironment::exact(
        &binding,
        BTreeMap::from([(
            EnvironmentVariableName::new(GITHUB_TOKEN_ENV).assert_value(),
            "test-token".to_owned(),
        )]),
    )
    .assert_value();
    if let Some(refresh) = request.refresh {
        environment = crate::native_v2_runner::with_environment_refresh(environment, refresh);
    }
    let mut handle = runner
        .start(NodeRunRequest {
            invocation: NodeInvocation {
                reference: ExecutionRef {
                    run_id: RunId::new(request.run_id),
                    node: NodeName::new("deliver").assert_value(),
                    node_instance: native_v2_contract::NodeInstanceId::new(1).assert_value(),
                    execution: native_v2_contract::ExecutionId::new(1).assert_value(),
                },
                worker: WorkerRef::new(worker_ref(request.mode)).assert_value(),
                instructions: None,
                input: Value::Null,
                binding,
            },
            environment,
        })
        .await
        .assert_value();
    handle.completion().await.assert_value().outcome
}

async fn admitted(repo: &TempRepo, mode: DeliveryMode) -> crate::native_v2_contract::AdmittedRun {
    let graph = full_graph(vec![delivery_node(mode), success_node()]);
    let binding = NodeRuntimeBinding::GitDelivery {
        connections: DeclaredConnections::single(
            "github",
            DeclaredEnvironment::new([
                EnvironmentVariableName::new(GITHUB_TOKEN_ENV).assert_value()
            ])
            .assert_value(),
        )
        .assert_value(),
    };
    NativeV2Admission
        .admit(RunSubmission {
            title: RunTitle::new("Delivery test").assert_value(),
            graph,
            initial_input: Value::Null,
            runtime: RuntimePlan::Codex {
                provider: CodexProvider::OpenAi,
                size: RunSize::Medium,
                nodes: BTreeMap::from([(NodeName::new("deliver").assert_value(), binding)]),
            },
            source: ResolvedSource {
                repository: SourceRepositoryId::new("acme/project").assert_value(),
                branch: SourceBranchId::new("main").assert_value(),
                revision: SourceRevisionId::new(repo.base.clone()).assert_value(),
            },
            submission_key: IdempotencyKey::new(format!("delivery-{}-{}", repo.base, mode.label()))
                .assert_value(),
        })
        .await
        .assert_value()
}

fn target(repo: &TempRepo) -> DeliveryTarget {
    DeliveryTarget::new("acme/project", "main", repo.base.clone()).assert_value()
}

fn worker_ref(mode: DeliveryMode) -> &'static str {
    match mode {
        DeliveryMode::PullRequest => GIT_DELIVERY_PR_WORKER_REF,
        DeliveryMode::Merge => GIT_DELIVERY_MERGE_WORKER_REF,
    }
}

fn delivery_node(mode: DeliveryMode) -> Value {
    let labels: &[&str] = match mode {
        DeliveryMode::PullRequest => &[DELIVERY_OPENED_LABEL],
        DeliveryMode::Merge => &[
            DELIVERY_MERGED_LABEL,
            DELIVERY_CONFLICT_LABEL,
            DELIVERY_CI_FAILED_LABEL,
        ],
    };
    json!({
        "kind":"verifier","name":"deliver","worker":worker_ref(mode),
        "input":{"kind":"null"},"output":delivery_result_schema(mode).assert_value(),
        "inputBindings":[],"writeBindings":[],"timeoutMs":1000,"attempts":1,
        "signals":{"delivery":labels},"diagnostic":delivery_diagnostic_schema().assert_value()
    })
}

fn assert_delivery_signal<'a>(outcome: &'a WorkerOutcome, expected: &str) -> &'a Value {
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
    assert_eq!(
        signals
            .get(&FieldName::new(DELIVERY_SIGNAL_FIELD).assert_value())
            .assert_value()
            .as_str(),
        expected
    );
    assert!(diagnostic.pointer("/message").is_some_and(Value::is_string));
    assert!(artifacts.is_empty());
    output
}

fn assert_receipt_match(output: &Value, mode: DeliveryMode, repo: &TempRepo, expected: bool) {
    assert_eq!(
        is_matching_success_receipt(output, mode, &target(repo)),
        expected
    );
}

use openengine_cluster_testkit::assertions::{AssertAt, AssertValue};
