#![cfg(unix)]

use std::any::Any;
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use openengine_cluster_protocol::{
    GraphSpec, IdempotencyKey, NodeName, RunAttachEventNotification, RunAttachParams,
    RunForceParams, RunForceResult, RunId, RunListParams, RunListResult, RunLogEventNotification,
    RunLogsParams, RunStatus, RunStatusParams, RunStatusResult, RunSubmitParams, RunSubmitResult,
    RunWatchEventNotification, RunWatchParams, TerminalResult, WorkerOutcome,
};
use openengine_cluster_server::{ClusterBackend, ConnectionContext};
use serde_json::{json, Value};

use super::*;
use crate::execution::process::HostedProcessPool;
use crate::execution::SessionScope;
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
use crate::worker_catalog::{ModelId, ReasoningEffort};

static NEXT_TEMP: AtomicU64 = AtomicU64::new(1);

struct TempRepository {
    root: PathBuf,
    remote: PathBuf,
    workspace: PathBuf,
    base: String,
}

impl TempRepository {
    fn new() -> Self {
        let serial = NEXT_TEMP.fetch_add(1, Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!(
            "zeroshot-v2-candidate-{}-{serial}",
            std::process::id()
        ));
        let remote = root.join("remote.git");
        let seed = root.join("seed");
        let workspace = root.join("workspace");
        fs::create_dir_all(&root).expect("create test root");
        git(&root, &["init", "--bare", text(&remote)]);
        git(&root, &["init", text(&seed)]);
        fs::write(seed.join("README.md"), "base\n").expect("seed file");
        git(&seed, &["add", "README.md"]);
        git(
            &seed,
            &[
                "-c",
                "user.name=Candidate Test",
                "-c",
                "user.email=candidate@example.invalid",
                "commit",
                "-m",
                "base",
            ],
        );
        git(&seed, &["branch", "-M", "main"]);
        git(&seed, &["remote", "add", "origin", text(&remote)]);
        git(&seed, &["push", "origin", "main"]);
        git(&remote, &["symbolic-ref", "HEAD", "refs/heads/main"]);
        git(&root, &["clone", text(&remote), text(&workspace)]);
        let base = git_output(&workspace, &["rev-parse", "HEAD"]);
        Self {
            root,
            remote,
            workspace,
            base,
        }
    }
}

impl Drop for TempRepository {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

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
        Ok(GitHubReviewObservation {
            review_id: review.review_id.clone(),
            repository: review.repository.clone(),
            target_branch: review.target_branch.clone(),
            head_branch: review.head_branch.clone(),
            head_revision: review.head_revision.clone(),
            state,
        })
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

struct EmptySubscription<E>(std::marker::PhantomData<E>);

#[async_trait]
impl<E> CliSubscription<E> for EmptySubscription<E>
where
    E: Send,
{
    async fn next(&mut self) -> Result<Option<CliSubscriptionItem<E>>, NativeV2CliError> {
        Ok(None)
    }
}

struct InProcessCliBackend {
    controller: Arc<NativeV2CloudController>,
}

impl InProcessCliBackend {
    fn target(&self, target: &str) -> Result<(), NativeV2CliError> {
        if target == "candidate-cloud" {
            Ok(())
        } else {
            Err(NativeV2CliError::Target("unknown test target".to_owned()))
        }
    }
}

#[async_trait]
impl NativeV2CliBackend for InProcessCliBackend {
    type Watch = EmptySubscription<RunWatchEventNotification>;
    type Logs = EmptySubscription<RunLogEventNotification>;
    type Attach = EmptySubscription<RunAttachEventNotification>;

    async fn target_add(&self, _request: TargetAdd) -> Result<(), NativeV2CliError> {
        Err(NativeV2CliError::Target(
            "test backend has no target registry".to_owned(),
        ))
    }

    async fn target_login(&self, _name: &str) -> Result<(), NativeV2CliError> {
        Err(NativeV2CliError::Target(
            "test backend has no login authority".to_owned(),
        ))
    }

    async fn target_setup(&self, _request: TargetSetup) -> Result<(), NativeV2CliError> {
        Err(NativeV2CliError::Target(
            "test backend has no setup authority".to_owned(),
        ))
    }

    async fn run_submit(
        &self,
        target: &str,
        params: RunSubmitParams,
    ) -> Result<RunSubmitResult, NativeV2CliError> {
        self.target(target)?;
        ClusterBackend::run_submit(&*self.controller, &ConnectionContext::default(), params)
            .await
            .map_err(cli_protocol_error)
    }

    async fn run_list(
        &self,
        target: &str,
        params: RunListParams,
    ) -> Result<RunListResult, NativeV2CliError> {
        self.target(target)?;
        ClusterBackend::run_list(&*self.controller, &ConnectionContext::default(), params)
            .await
            .map_err(cli_protocol_error)
    }

    async fn run_status(
        &self,
        target: &str,
        params: RunStatusParams,
    ) -> Result<RunStatusResult, NativeV2CliError> {
        self.target(target)?;
        ClusterBackend::run_status(&*self.controller, &ConnectionContext::default(), params)
            .await
            .map_err(cli_protocol_error)
    }

    async fn run_watch(
        &self,
        _target: &str,
        _params: RunWatchParams,
    ) -> Result<Self::Watch, NativeV2CliError> {
        Err(NativeV2CliError::Target(
            "detached test run does not open watch".to_owned(),
        ))
    }

    async fn run_logs(
        &self,
        _target: &str,
        _params: RunLogsParams,
    ) -> Result<Self::Logs, NativeV2CliError> {
        Err(NativeV2CliError::Target(
            "test backend does not open logs".to_owned(),
        ))
    }

    async fn run_attach(
        &self,
        _target: &str,
        _params: RunAttachParams,
    ) -> Result<Self::Attach, NativeV2CliError> {
        Err(NativeV2CliError::Target(
            "test backend does not open attach".to_owned(),
        ))
    }

    async fn run_force(
        &self,
        target: &str,
        params: RunForceParams,
    ) -> Result<RunForceResult, NativeV2CliError> {
        self.target(target)?;
        ClusterBackend::run_force(&*self.controller, &ConnectionContext::default(), params)
            .await
            .map_err(cli_protocol_error)
    }
}

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
    let repository = TempRepository::new();
    let target = DeliveryTarget::new("acme/project", "main", repository.base.clone())
        .expect("delivery target");
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
    let token = EnvironmentVariableName::new(GITHUB_TOKEN_ENV).expect("token name");
    let controller = Arc::new(
        NativeV2CloudController::new(
            ledger,
            runtime(RuntimePlanKind::Codex),
            ControllerEnvironment::new(BTreeMap::from([(token, "test-github-token".to_owned())])),
            allocator,
        )
        .await
        .expect("controller"),
    );
    let graph_path = repository.root.join("graph.json");
    let input_path = repository.root.join("input.json");
    fs::write(
        &graph_path,
        serde_json::to_vec(&shipping_graph()).expect("encode graph"),
    )
    .expect("write graph");
    fs::write(&input_path, b"null\n").expect("write input");
    let backend = InProcessCliBackend {
        controller: controller.clone(),
    };
    let mut output = Vec::new();
    let outcome = execute_native_v2_cli(
        NativeV2CliCommand::Run(RunCommand {
            target: "candidate-cloud".to_owned(),
            graph: graph_path,
            input: input_path,
            ship: true,
            detach: true,
            submission_key: Some(IdempotencyKey::new("candidate-e2e").expect("submission key")),
        }),
        &backend,
        &mut NeverDetach,
        &mut output,
    )
    .await
    .expect("CLI run");
    assert_eq!(outcome, CliOutcome::Detached);
    let submitted: RunSubmitResult = serde_json::from_slice(&output).expect("CLI receipt");
    let direct_status = ClusterBackend::run_status(
        &*controller,
        &ConnectionContext::default(),
        RunStatusParams {
            run_id: submitted.run_id.clone(),
        },
    )
    .await
    .expect("direct OECP status");
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

#[tokio::test]
async fn concrete_codex_and_claude_configs_bind_only_to_their_admitted_lane() {
    let repository = TempRepository::new();
    let github = Arc::new(ScriptedGitHub::new(repository.remote.clone()));
    let codex = admitted(RuntimePlanKind::Codex).await;
    let codex_config = candidate_config(
        RuntimePlanKind::Codex,
        &repository,
        github.clone(),
        codex.ship,
    );
    build_native_v2_candidate(&codex, codex_config).expect("Codex candidate");

    let claude = admitted(RuntimePlanKind::Claude).await;
    let claude_config = candidate_config(
        RuntimePlanKind::Claude,
        &repository,
        github.clone(),
        claude.ship,
    );
    build_native_v2_candidate(&claude, claude_config).expect("Claude candidate");

    let mismatch = candidate_config(RuntimePlanKind::Claude, &repository, github, codex.ship);
    match build_native_v2_candidate(&codex, mismatch) {
        Err(error) => assert_eq!(error, NativeV2CandidateError::RuntimeMismatch),
        Ok(_) => panic!("mismatched candidate must fail"),
    }
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

#[derive(Clone, Copy)]
enum RuntimePlanKind {
    Codex,
    Claude,
}

fn runtime(kind: RuntimePlanKind) -> RuntimePlan {
    let agent = NodeRuntimeBinding::Agent {
        model: ModelId::new(match kind {
            RuntimePlanKind::Codex => "gpt-5.6-sol",
            RuntimePlanKind::Claude => "claude-sonnet-5",
        })
        .expect("model"),
        effort: Some(ReasoningEffort::Max),
        session_scope: SessionScope::Execution,
        env: BTreeSet::new(),
    };
    let delivery = NodeRuntimeBinding::GitDelivery {
        env: BTreeSet::from([EnvironmentVariableName::new(GITHUB_TOKEN_ENV).expect("token name")]),
    };
    let nodes = BTreeMap::from([
        (NodeName::new("worker").expect("worker name"), agent),
        (NodeName::new("deliver").expect("delivery name"), delivery),
    ]);
    match kind {
        RuntimePlanKind::Codex => RuntimePlan::Codex {
            provider: CodexProvider::OpenAi,
            nodes,
        },
        RuntimePlanKind::Claude => RuntimePlan::Claude {
            provider: crate::native_v2_contract::ClaudeProvider::Anthropic,
            nodes,
        },
    }
}

fn shipping_graph() -> GraphSpec {
    serde_json::from_value(json!({
        "profile":"openengine.graph.full/v1",
        "initialInput":{"kind":"null"},
        "policy":{"policy":"policy.native-v2@1","default":"deny"},
        "root":{
            "kind":"seq","name":"root","state":{"kind":"null"},
            "children":[
                {
                    "kind":"step","name":"worker","worker":"agent.worker@1",
                    "input":{"kind":"null"},"output":{"kind":"null"},
                    "inputBindings":[],"writeBindings":[],"timeoutMs":10000,"attempts":1
                },
                {
                    "kind":"verifier","name":"deliver","worker":"builtin.git-delivery@1",
                    "input":{"kind":"null"},"output":{"kind":"null"},
                    "inputBindings":[],"writeBindings":[],"timeoutMs":10000,"attempts":1,
                    "signals":{"delivery":["merged","ci_failed"]},
                    "diagnostic":{"kind":"string"}
                },
                {"kind":"succeed","name":"done","output":{"kind":"null"},"bindings":[]}
            ],
            "promotedStatePaths":[]
        }
    }))
    .expect("shipping graph")
}

async fn admitted(kind: RuntimePlanKind) -> AdmittedRun {
    NativeV2Admission
        .admit(RunSubmission {
            graph: shipping_graph(),
            initial_input: Value::Null,
            runtime: runtime(kind),
            ship: true,
            submission_key: IdempotencyKey::new("candidate-config").expect("key"),
        })
        .await
        .expect("admitted")
}

fn candidate_config(
    kind: RuntimePlanKind,
    repository: &TempRepository,
    github: Arc<ScriptedGitHub>,
    ship: bool,
) -> NativeV2CandidateConfig {
    let pool = HostedProcessPool::new(10_002, 10_002, 20_000, 20_000).expect("pool");
    let harness = match kind {
        RuntimePlanKind::Codex => NativeV2HarnessConfig::Codex(NativeV2CodexConfig {
            provider: CodexProvider::OpenAi,
            executable: PathBuf::from("/usr/bin/false"),
            workspace: repository.workspace.clone(),
            runtime_home: repository.root.join("codex-home"),
            search_path: "/usr/bin:/bin".to_owned(),
            process_pool: pool,
        }),
        RuntimePlanKind::Claude => NativeV2HarnessConfig::Claude(ClaudeAdapterConfig {
            provider: crate::native_v2_contract::ClaudeProvider::Anthropic,
            executable: "/usr/bin/false".to_owned(),
            prefix_arguments: Vec::new(),
            workspace: repository.workspace.clone(),
            base_environment: ClaudeProcessEnvironment::new(BTreeMap::from([
                (
                    "HOME".to_owned(),
                    repository.root.to_string_lossy().into_owned(),
                ),
                ("PATH".to_owned(), "/usr/bin:/bin".to_owned()),
            ]))
            .expect("Claude environment"),
            turn_timeout: Duration::from_secs(1),
            process_pool: pool,
        }),
    };
    NativeV2CandidateConfig {
        harness,
        delivery: NativeV2DeliveryConfig {
            workspace: repository.workspace.clone(),
            git_program: PathBuf::from("/usr/bin/git"),
            target: DeliveryTarget::new("acme/project", "main", repository.base.clone())
                .expect("target"),
            ship_authorized: ship,
            poll: DeliveryPollPolicy::new(2, Duration::ZERO).expect("poll"),
        },
        github,
    }
}

async fn wait_for_terminal(controller: &NativeV2CloudController, run_id: &RunId) -> TerminalResult {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let status = ClusterBackend::run_status(
                controller,
                &ConnectionContext::default(),
                RunStatusParams {
                    run_id: run_id.clone(),
                },
            )
            .await
            .expect("OECP status");
            if let RunStatus::Finished { terminal_result } = status.status {
                return terminal_result;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("candidate became terminal")
}

fn cli_protocol_error(error: impl std::fmt::Display) -> NativeV2CliError {
    NativeV2CliError::Protocol(error.to_string())
}

fn git(directory: &Path, arguments: &[&str]) {
    assert!(
        Command::new("/usr/bin/git")
            .arg("-C")
            .arg(directory)
            .args(arguments)
            .status()
            .expect("run Git")
            .success()
    );
}

fn git_output(directory: &Path, arguments: &[&str]) -> String {
    let output = Command::new("/usr/bin/git")
        .arg("-C")
        .arg(directory)
        .args(arguments)
        .output()
        .expect("run Git");
    assert!(output.status.success());
    String::from_utf8(output.stdout)
        .expect("Git output is UTF-8")
        .trim()
        .to_owned()
}

fn text(path: &Path) -> &str {
    path.to_str().expect("test path is UTF-8")
}
