#![cfg(unix)]

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use openengine_cluster_protocol::{
    GraphSpec, IdempotencyKey, NodeName, PositiveInteger, RunId, WorkerErrorCode, WorkerOutcome,
    WorkerRef,
};
use openengine_cluster_server::admission::VerifiedGraph;
use serde_json::{json, Value};

use super::*;
use crate::full_v1_reducer::{
    Decision, DurableExecution, DurableExecutionState, FullV1Reducer, HistoryPosition,
    ReductionInput, StructuralOccurrence,
};
use crate::native_v2_admission::NativeV2Admission;
use crate::native_v2_contract::{
    ExecutionId, ExecutionRef, NodeInstanceId, NodeRuntimeBinding, RunSubmission, RuntimePlan,
};
use crate::native_v2_runner::{NativeNodeRunner, NodeRunRequest, NodeRunner};

static NEXT_TEMP: AtomicU64 = AtomicU64::new(1);

const GH_SCRIPT: &str = r#"#!/bin/sh
set -eu
capture="${0}.capture"
{
  /usr/bin/printf '%s\n' '---'
  /usr/bin/printf 'token=%s\n' "${GH_TOKEN-unset}"
  /usr/bin/printf 'host=%s\n' "${GH_HOST-unset}"
  /usr/bin/printf 'home=%s\n' "${HOME-unset}"
  /usr/bin/printf 'path=%s\n' "${PATH-unset}"
  for argument in "$@"; do /usr/bin/printf 'arg=%s\n' "$argument"; done
} >> "$capture"
endpoint=$2
method=GET
previous=
for argument in "$@"; do
  if [ "$previous" = "--method" ]; then method=$argument; fi
  previous=$argument
done
case "$endpoint:$method" in
  repos/acme/project/pulls:GET)
    /usr/bin/printf '%s\n' '[]'
    ;;
  repos/acme/project/pulls:POST)
    /usr/bin/printf '%s%s%s%s\n' \
      '{"number":17,"state":"open","merged":false,"merge_commit_sha":null,"base":' \
      '{"ref":"main","sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","repo":{"full_name":"acme/project"}},' \
      '"head":{"ref":"zeroshot/v2-test","sha":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",' \
      '"repo":{"full_name":"acme/project"}}}'
    ;;
  repos/acme/project/pulls/17:GET)
    /usr/bin/printf '%s%s%s%s\n' \
      '{"number":17,"state":"open","merged":false,"merge_commit_sha":null,"base":' \
      '{"ref":"main","sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","repo":{"full_name":"acme/project"}},' \
      '"head":{"ref":"zeroshot/v2-test","sha":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",' \
      '"repo":{"full_name":"acme/project"}}}'
    ;;
  repos/acme/project/commits/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/check-runs:GET)
    /usr/bin/printf '%s\n' '{"total_count":0,"check_runs":[]}'
    ;;
  repos/acme/project/commits/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/status:GET)
    /usr/bin/printf '%s\n' '{"state":"pending","statuses":[]}'
    ;;
  repos/acme/project/pulls/17/merge:PUT)
    /usr/bin/printf '%s\n' '{"merged":true,"sha":"cccccccccccccccccccccccccccccccccccccccc"}'
    ;;
  *) exit 19 ;;
esac
"#;

const GIT_SCRIPT: &str = r#"#!/bin/sh
set -eu
capture="${0}.capture"
{
  /usr/bin/printf '%s\n' '---'
  /usr/bin/printf 'token=%s\n' "${GH_TOKEN-unset}"
  /usr/bin/printf 'home=%s\n' "${HOME-unset}"
  /usr/bin/printf 'path=%s\n' "${PATH-unset}"
  /usr/bin/printf 'config_count=%s\n' "${GIT_CONFIG_COUNT-unset}"
  /usr/bin/printf 'config_key_1=%s\n' "${GIT_CONFIG_KEY_1-unset}"
  /usr/bin/printf 'config_value_1=%s\n' "${GIT_CONFIG_VALUE_1-unset}"
  for argument in "$@"; do /usr/bin/printf 'arg=%s\n' "$argument"; done
} >> "$capture"
"#;

const GH_MISMATCH_SCRIPT: &str = r#"#!/bin/sh
/usr/bin/printf '%s%s%s%s\n' \
  '[{"number":17,"state":"open","merged":false,"merge_commit_sha":null,"base":' \
  '{"ref":"other","sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","repo":{"full_name":"acme/project"}},' \
  '"head":{"ref":"zeroshot/v2-test","sha":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",' \
  '"repo":{"full_name":"acme/project"}}}]'
"#;

struct TempRepo {
    root: PathBuf,
    remote: PathBuf,
    workspace: PathBuf,
    base: String,
}

impl TempRepo {
    fn new() -> Self {
        let serial = NEXT_TEMP.fetch_add(1, Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!(
            "zeroshot-v2-delivery-{}-{serial}",
            std::process::id()
        ));
        let remote = root.join("remote.git");
        let seed = root.join("seed");
        let workspace = root.join("workspace");
        fs::create_dir_all(&root).unwrap();
        git(&root, &["init", "--bare", remote.to_str().unwrap()]);
        git(&root, &["init", seed.to_str().unwrap()]);
        fs::write(seed.join("README.md"), "base\n").unwrap();
        git(&seed, &["add", "README.md"]);
        git(
            &seed,
            &[
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.invalid",
                "commit",
                "-m",
                "base",
            ],
        );
        git(&seed, &["branch", "-M", "main"]);
        git(
            &seed,
            &["remote", "add", "origin", remote.to_str().unwrap()],
        );
        git(&seed, &["push", "origin", "main"]);
        git(&remote, &["symbolic-ref", "HEAD", "refs/heads/main"]);
        git(
            &root,
            &[
                "clone",
                remote.to_str().unwrap(),
                workspace.to_str().unwrap(),
            ],
        );
        let base = git_output(&workspace, &["rev-parse", "HEAD"]);
        fs::write(workspace.join("result.txt"), "delivered\n").unwrap();
        Self {
            root,
            remote,
            workspace,
            base,
        }
    }
}

impl Drop for TempRepo {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[derive(Clone, Copy)]
enum Script {
    NoCi,
    CiFailed,
    NeverConfirmsMerge,
}

struct FakeGitHub {
    remote: PathBuf,
    script: Script,
    pushed: AtomicBool,
    merge_requested: AtomicBool,
    merge_requests: AtomicUsize,
}

impl FakeGitHub {
    fn new(remote: PathBuf, script: Script) -> Self {
        Self {
            remote,
            script,
            pushed: AtomicBool::new(false),
            merge_requested: AtomicBool::new(false),
            merge_requests: AtomicUsize::new(0),
        }
    }
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
            .unwrap();
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
        let state = match self.script {
            Script::NoCi if self.merge_requested.load(Ordering::SeqCst) => {
                GitHubReviewState::Merged {
                    merge_revision: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb".to_owned(),
                }
            }
            Script::NoCi => GitHubReviewState::Open {
                checks: GitHubChecks::NotRequired,
            },
            Script::CiFailed => GitHubReviewState::Open {
                checks: GitHubChecks::Failed,
            },
            Script::NeverConfirmsMerge => GitHubReviewState::Open {
                checks: GitHubChecks::Passed,
            },
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
        assert_eq!(credential.expose(), "test-token");
        self.merge_requests.fetch_add(1, Ordering::SeqCst);
        self.merge_requested.store(true, Ordering::SeqCst);
        Ok(())
    }
}

#[tokio::test]
async fn no_ci_can_merge_but_only_after_authoritative_confirmation() {
    let repo = TempRepo::new();
    let authority = Arc::new(FakeGitHub::new(repo.remote.clone(), Script::NoCi));
    let outcome = run_delivery(&repo, authority.clone(), 3).await;
    assert_delivery_signal(&outcome, DELIVERY_MERGED_LABEL);
    assert_eq!(authority.merge_requests.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn ci_failure_is_a_routable_verifier_result() {
    let repo = TempRepo::new();
    let authority = Arc::new(FakeGitHub::new(repo.remote.clone(), Script::CiFailed));
    let outcome = run_delivery(&repo, authority.clone(), 2).await;
    assert_delivery_signal(&outcome, DELIVERY_CI_FAILED_LABEL);
    assert_eq!(authority.merge_requests.load(Ordering::SeqCst), 0);
    assert_ci_failure_routes_an_authored_worker_loop(outcome).await;
}

#[tokio::test]
async fn accepted_merge_request_is_not_shipping_success() {
    let repo = TempRepo::new();
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

#[tokio::test]
async fn production_gh_transport_uses_exact_args_and_a_clean_environment() {
    let repo = TempRepo::new();
    let git_program = write_executable(&repo.root, "git-script", GIT_SCRIPT);
    let gh_program = write_executable(&repo.root, "gh-script", GH_SCRIPT);
    let authority = GhCliDeliveryAuthority::new(GhCliAuthorityConfig {
        git_program: git_program.clone(),
        gh_program: gh_program.clone(),
        api_deadline: Duration::from_secs(2),
        push_deadline: Duration::from_secs(2),
    });
    let target = DeliveryTarget::new(
        "acme/project",
        "main",
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    )
    .unwrap();
    let review_request = GitHubReviewRequest {
        target: target.clone(),
        head_branch: "zeroshot/v2-test".to_owned(),
        head_revision: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb".to_owned(),
    };
    let credential = GitHubCredential("test-token");
    authority
        .push_branch(
            &GitHubPushRequest {
                workspace: repo.workspace.clone(),
                target,
                head_branch: review_request.head_branch.clone(),
                head_revision: review_request.head_revision.clone(),
            },
            credential,
        )
        .await
        .unwrap();
    let review = authority
        .open_or_update_review(&review_request, credential)
        .await
        .unwrap();
    let observation = authority.inspect_review(&review, credential).await.unwrap();
    assert_eq!(
        observation.state,
        GitHubReviewState::Open {
            checks: GitHubChecks::NotRequired
        }
    );
    authority.request_merge(&review, credential).await.unwrap();

    let git_capture = fs::read_to_string(format!("{}.capture", git_program.display())).unwrap();
    assert!(git_capture.contains("token=test-token"));
    assert!(git_capture.contains("home=unset"));
    assert!(git_capture.contains("config_count=2"));
    assert!(git_capture.contains("config_key_1=http.https://github.com/.extraheader"));
    assert!(git_capture.contains("arg=https://github.com/acme/project.git"));
    assert!(git_capture.contains("arg=HEAD:refs/heads/zeroshot/v2-test"));
    assert!(!argument_lines(&git_capture).contains("test-token"));

    let gh_capture = fs::read_to_string(format!("{}.capture", gh_program.display())).unwrap();
    assert!(gh_capture.contains("token=test-token\nhost=github.com\nhome=unset"));
    assert!(gh_capture.contains("arg=repos/acme/project/pulls"));
    assert!(gh_capture.contains("arg=head=acme:zeroshot/v2-test"));
    assert!(gh_capture.contains("arg=repos/acme/project/pulls/17/merge"));
    assert!(gh_capture.contains("arg=sha=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"));
    assert!(!argument_lines(&gh_capture).contains("test-token"));
}

#[tokio::test]
async fn production_gh_transport_rejects_malformed_or_changed_authority() {
    let repo = TempRepo::new();
    let malformed = write_executable(
        &repo.root,
        "gh-malformed",
        "#!/bin/sh\n/usr/bin/printf '%s\\n' '{'\n",
    );
    let mismatch = write_executable(&repo.root, "gh-mismatch", GH_MISMATCH_SCRIPT);
    let request = GitHubReviewRequest {
        target: DeliveryTarget::new(
            "acme/project",
            "main",
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        )
        .unwrap(),
        head_branch: "zeroshot/v2-test".to_owned(),
        head_revision: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb".to_owned(),
    };
    for gh_program in [malformed, mismatch] {
        let authority = GhCliDeliveryAuthority::new(GhCliAuthorityConfig {
            git_program: PathBuf::from("/usr/bin/git"),
            gh_program,
            api_deadline: Duration::from_secs(2),
            push_deadline: Duration::from_secs(2),
        });
        assert_eq!(
            authority
                .open_or_update_review(&request, GitHubCredential("test-token"))
                .await,
            Err(GitHubAuthorityError::Rejected)
        );
    }
}

async fn run_delivery(
    repo: &TempRepo,
    authority: Arc<FakeGitHub>,
    attempts: usize,
) -> WorkerOutcome {
    let admitted = admitted(repo).await;
    let config = NativeV2DeliveryConfig {
        workspace: repo.workspace.clone(),
        git_program: PathBuf::from("/usr/bin/git"),
        target: DeliveryTarget::new("acme/project", "main", repo.base.clone()).unwrap(),
        ship_authorized: admitted.ship,
        poll: DeliveryPollPolicy::new(attempts, Duration::ZERO).unwrap(),
    };
    let adapter = Arc::new(NativeV2DeliveryAdapter::new(config, authority));
    let runner = NativeNodeRunner::new(&admitted, adapter.clone(), adapter).unwrap();
    let binding = admitted
        .runtime
        .nodes()
        .get(&NodeName::new("deliver").unwrap())
        .unwrap()
        .clone();
    let environment = ResolvedEnvironment::exact(
        &binding,
        BTreeMap::from([(
            EnvironmentVariableName::new(GITHUB_TOKEN_ENV).unwrap(),
            "test-token".to_owned(),
        )]),
    )
    .unwrap();
    let mut handle = runner
        .start(NodeRunRequest {
            invocation: NodeInvocation {
                reference: ExecutionRef {
                    run_id: RunId::new("delivery-run"),
                    node: NodeName::new("deliver").unwrap(),
                    node_instance: NodeInstanceId::new(1).unwrap(),
                    execution: ExecutionId::new(1).unwrap(),
                },
                worker: WorkerRef::new("builtin.git-delivery@1").unwrap(),
                input: Value::Null,
                binding,
            },
            environment,
        })
        .await
        .unwrap();
    handle.completion().await.unwrap().outcome
}

async fn admitted(repo: &TempRepo) -> crate::native_v2_contract::AdmittedRun {
    let graph: GraphSpec = serde_json::from_value(json!({
        "profile":"openengine.graph.full/v1",
        "initialInput":{"kind":"null"},
        "policy":{"policy":"policy.native-v2@1","default":"deny"},
        "root":{
            "kind":"seq","name":"root","state":{"kind":"null"},
            "children":[
                {
                    "kind":"verifier","name":"deliver","worker":"builtin.git-delivery@1",
                    "input":{"kind":"null"},"output":{"kind":"null"},
                    "inputBindings":[],"writeBindings":[],"timeoutMs":1000,"attempts":1,
                    "signals":{"delivery":["merged","ci_failed"]},
                    "diagnostic":{"kind":"string"}
                },
                {"kind":"succeed","name":"done","output":{"kind":"null"},"bindings":[]}
            ],
            "promotedStatePaths":[]
        }
    }))
    .unwrap();
    let binding = NodeRuntimeBinding::GitDelivery {
        env: BTreeSet::from([EnvironmentVariableName::new(GITHUB_TOKEN_ENV).unwrap()]),
    };
    NativeV2Admission
        .admit(RunSubmission {
            graph,
            initial_input: Value::Null,
            runtime: RuntimePlan::Codex {
                provider: crate::native_v2_contract::CodexProvider::OpenAi,
                nodes: BTreeMap::from([(NodeName::new("deliver").unwrap(), binding)]),
            },
            ship: true,
            submission_key: IdempotencyKey::new(format!("delivery-{}", repo.base)).unwrap(),
        })
        .await
        .unwrap()
}

async fn assert_ci_failure_routes_an_authored_worker_loop(outcome: WorkerOutcome) {
    let admitted = admitted_routing_graph().await;
    let verified = VerifiedGraph {
        compiled_ir: admitted.graph,
        diagnostics: Vec::new(),
    };
    let delivery = settled_execution((1, 1), "deliver", (0, 1), outcome);
    let after_failure = FullV1Reducer::native_v2(&verified)
        .reduce(ReductionInput {
            initial_input: &Value::Null,
            executions: std::slice::from_ref(&delivery),
            next_node_instance: 2,
            next_execution: 2,
        })
        .unwrap();
    assert!(after_failure.decisions.iter().any(|decision| matches!(
        decision,
        Decision::Dispatch { occurrence, .. } if occurrence.node.as_str() == "repair"
    )));

    let repair = settled_execution(
        (2, 2),
        "repair",
        (2, 3),
        WorkerOutcome::Verified {
            output: Value::Null,
            artifacts: Vec::new(),
        },
    );
    let next_iteration = FullV1Reducer::native_v2(&verified)
        .reduce(ReductionInput {
            initial_input: &Value::Null,
            executions: &[delivery, repair],
            next_node_instance: 3,
            next_execution: 3,
        })
        .unwrap();
    assert!(next_iteration.decisions.iter().any(|decision| matches!(
        decision,
        Decision::Dispatch { occurrence, node_instance, execution, .. }
            if occurrence.node.as_str() == "deliver"
                && node_instance.get() == 1
                && execution.get() == 3
    )));
}

async fn admitted_routing_graph() -> crate::native_v2_contract::AdmittedRun {
    let graph: GraphSpec = serde_json::from_value(json!({
        "profile":"openengine.graph.full/v1",
        "initialInput":{"kind":"null"},
        "policy":{"policy":"policy.native-v2@1","default":"deny"},
        "root":{
            "kind":"seq","name":"root","state":{"kind":"null"},
            "children":[
                {
                    "kind":"loop","name":"delivery_loop","state":{"kind":"null"},
                    "body":{
                        "kind":"seq","name":"delivery_attempt","state":{"kind":"null"},
                        "children":[
                            {
                                "kind":"verifier","name":"deliver","worker":"builtin.git-delivery@1",
                                "input":{"kind":"null"},"output":{"kind":"null"},
                                "inputBindings":[],"writeBindings":[],"timeoutMs":1000,"attempts":1,
                                "signals":{"delivery":["merged","ci_failed"]},
                                "diagnostic":{"kind":"string"}
                            },
                            {
                                "kind":"choice","name":"delivery_route","state":{"kind":"null"},
                                "branches":[{
                                    "when":{
                                        "kind":"in",
                                        "value":{"name":"deliver","source":"signal","field":"delivery"},
                                        "labels":["ci_failed"]
                                    },
                                    "node":{
                                        "kind":"step","name":"repair","worker":"agent.repair@1",
                                        "input":{"kind":"null"},"output":{"kind":"null"},
                                        "inputBindings":[],"writeBindings":[],"timeoutMs":1000,"attempts":1
                                    }
                                }],
                                "otherwise":{
                                    "kind":"succeed","name":"merged",
                                    "output":{"kind":"null"},"bindings":[]
                                },
                                "promotedStatePaths":[]
                            }
                        ],
                        "promotedStatePaths":[]
                    },
                    "until":{
                        "kind":"in",
                        "value":{"name":"deliver","source":"signal","field":"delivery"},
                        "labels":["merged"]
                    },
                    "maxIterations":3,"promotedStatePaths":[]
                },
                {"kind":"succeed","name":"done","output":{"kind":"null"},"bindings":[]}
            ],
            "promotedStatePaths":[]
        }
    }))
    .unwrap();
    let delivery = NodeRuntimeBinding::GitDelivery {
        env: BTreeSet::from([EnvironmentVariableName::new(GITHUB_TOKEN_ENV).unwrap()]),
    };
    let repair = NodeRuntimeBinding::Agent {
        model: crate::worker_catalog::ModelId::new("gpt-5.6").unwrap(),
        effort: Some(crate::worker_catalog::ReasoningEffort::Max),
        session_scope: crate::execution::SessionScope::Execution,
        env: BTreeSet::new(),
    };
    NativeV2Admission
        .admit(RunSubmission {
            graph,
            initial_input: Value::Null,
            runtime: RuntimePlan::Codex {
                provider: crate::native_v2_contract::CodexProvider::OpenAi,
                nodes: BTreeMap::from([
                    (NodeName::new("deliver").unwrap(), delivery),
                    (NodeName::new("repair").unwrap(), repair),
                ]),
            },
            ship: true,
            submission_key: IdempotencyKey::new("delivery-routing").unwrap(),
        })
        .await
        .unwrap()
}

fn settled_execution(
    identity: (u64, u64),
    node: &str,
    positions: (u64, u64),
    outcome: WorkerOutcome,
) -> DurableExecution {
    let (execution, node_instance) = identity;
    let (dispatch_position, settle_position) = positions;
    DurableExecution {
        dispatch_position: HistoryPosition::new(dispatch_position).unwrap(),
        node_instance: NodeInstanceId::new(node_instance).unwrap(),
        execution: ExecutionId::new(execution).unwrap(),
        occurrence: StructuralOccurrence {
            node: NodeName::new(node).unwrap(),
            map_indices: Vec::new(),
        },
        attempt: PositiveInteger::new(1).unwrap(),
        input: Value::Null,
        state: DurableExecutionState::Settled {
            position: HistoryPosition::new(settle_position).unwrap(),
            outcome,
        },
    }
}

fn assert_delivery_signal(outcome: &WorkerOutcome, expected: &str) {
    let WorkerOutcome::Verifier {
        output,
        signals,
        diagnostic,
        artifacts,
    } = outcome
    else {
        panic!("delivery must return a verifier result")
    };
    assert_eq!(output, &Value::Null);
    assert_eq!(
        signals
            .get(&FieldName::new(DELIVERY_SIGNAL_FIELD).unwrap())
            .unwrap()
            .as_str(),
        expected
    );
    assert!(diagnostic.is_string());
    assert!(artifacts.is_empty());
}

fn git(directory: &Path, arguments: &[&str]) {
    assert!(
        Command::new("/usr/bin/git")
            .arg("-C")
            .arg(directory)
            .args(arguments)
            .status()
            .unwrap()
            .success()
    );
}

fn git_output(directory: &Path, arguments: &[&str]) -> String {
    let output = Command::new("/usr/bin/git")
        .arg("-C")
        .arg(directory)
        .args(arguments)
        .output()
        .unwrap();
    assert!(output.status.success());
    String::from_utf8(output.stdout).unwrap().trim().to_owned()
}

fn write_executable(directory: &Path, name: &str, contents: &str) -> PathBuf {
    let path = directory.join(name);
    fs::write(&path, contents).unwrap();
    let mut permissions = fs::metadata(&path).unwrap().permissions();
    permissions.set_mode(0o700);
    fs::set_permissions(&path, permissions).unwrap();
    path
}

fn argument_lines(capture: &str) -> String {
    capture
        .lines()
        .filter(|line| line.starts_with("arg="))
        .collect::<Vec<_>>()
        .join("\n")
}
