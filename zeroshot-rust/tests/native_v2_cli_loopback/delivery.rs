use super::*;

#[derive(Clone, Copy)]
pub(crate) enum DeliveryScenario {
    NoCi,
    CiFailureThenMerge,
}

pub(crate) struct DeliveryFixture {
    pub(crate) remote: PathBuf,
    pub(crate) workspace: PathBuf,
    pub(crate) base_revision: String,
}

impl DeliveryFixture {
    pub(crate) fn new(root: &TempRoot, name: &str) -> Self {
        let remote = root.path(&format!("{name}-remote.git"));
        let seed = root.path(&format!("{name}-seed"));
        let workspace = root.path(&format!("{name}-workspace"));
        git(
            root.as_path(),
            &[
                "init",
                "--initial-branch=main",
                seed.to_str().assert_value(),
            ],
        );
        std::fs::write(seed.join("README.md"), "base\n").assert_value();
        git(&seed, &["add", "README.md"]);
        git(&seed, &["config", "user.name", "Test"]);
        git(&seed, &["config", "user.email", "test@example.invalid"]);
        git(&seed, &["commit", "--message=base"]);
        git(
            root.as_path(),
            &[
                "clone",
                "--bare",
                seed.to_str().assert_value(),
                remote.to_str().assert_value(),
            ],
        );
        git(
            root.as_path(),
            &[
                "clone",
                remote.to_str().assert_value(),
                workspace.to_str().assert_value(),
            ],
        );
        let base_revision = git_output(&workspace, &["rev-parse", "HEAD"]);
        std::fs::write(workspace.join("result.txt"), "ready for delivery\n").assert_value();
        Self {
            remote,
            workspace,
            base_revision,
        }
    }
}

fn git(directory: &Path, arguments: &[&str]) {
    assert!(
        git_command(directory)
            .args(arguments)
            .status()
            .assert_value()
            .success()
    );
}

fn git_output(directory: &Path, arguments: &[&str]) -> String {
    let output = git_command(directory)
        .args(arguments)
        .output()
        .assert_value();
    assert!(output.status.success());
    String::from_utf8_lossy(&output.stdout).trim().to_owned()
}

fn git_command(directory: &Path) -> std::process::Command {
    let mut command = std::process::Command::new("/usr/bin/git");
    command.arg("-C").arg(directory);
    command
}

pub(crate) struct DeliveryAuthority {
    pub(crate) remote: PathBuf,
    scenario: DeliveryScenario,
    pub(crate) reviews: AtomicUsize,
    pub(crate) inspections: AtomicUsize,
    pub(crate) merge_requests: AtomicUsize,
    merged_reviews: Mutex<BTreeSet<String>>,
}

impl DeliveryAuthority {
    pub(crate) fn new(remote: PathBuf, scenario: DeliveryScenario) -> Self {
        Self {
            remote,
            scenario,
            reviews: AtomicUsize::new(0),
            inspections: AtomicUsize::new(0),
            merge_requests: AtomicUsize::new(0),
            merged_reviews: Mutex::new(BTreeSet::new()),
        }
    }
}

fn require_test_credential(credential: GitHubCredential<'_>) -> Result<(), GitHubAuthorityError> {
    (credential.expose() == "test-token")
        .then_some(())
        .ok_or(GitHubAuthorityError::Rejected)
}

fn review_receipt(request: &GitHubReviewRequest, review_id: String) -> GitHubReviewReceipt {
    GitHubReviewReceipt {
        review_id,
        repository: request.target.repository.clone(),
        target_branch: request.target.target_branch.clone(),
        head_branch: request.head_branch.clone(),
        head_revision: request.head_revision.clone(),
    }
}

fn review_observation(
    review: &GitHubReviewReceipt,
    state: GitHubReviewState,
) -> GitHubReviewObservation {
    GitHubReviewObservation {
        state,
        head_revision: review.head_revision.clone(),
        head_branch: review.head_branch.clone(),
        target_branch: review.target_branch.clone(),
        repository: review.repository.clone(),
        review_id: review.review_id.clone(),
    }
}

#[async_trait]
impl GitHubDeliveryAuthority for DeliveryAuthority {
    async fn push_branch(
        &self,
        request: &GitHubPushRequest,
        credential: GitHubCredential<'_>,
    ) -> Result<(), GitHubAuthorityError> {
        require_test_credential(credential)?;
        let mut push = tokio::process::Command::new("/usr/bin/git");
        push.arg("-C")
            .arg(&request.workspace)
            .args(["push", self.remote.to_str().assert_value()])
            .arg(format!("HEAD:refs/heads/{}", request.head_branch));
        match push.status().await {
            Ok(status) if status.success() => Ok(()),
            Ok(_) => Err(GitHubAuthorityError::Rejected),
            Err(_) => Err(GitHubAuthorityError::Unavailable),
        }
    }

    async fn open_or_update_review(
        &self,
        request: &GitHubReviewRequest,
        credential: GitHubCredential<'_>,
    ) -> Result<GitHubReviewReceipt, GitHubAuthorityError> {
        require_test_credential(credential)?;
        let review_id = (self.reviews.fetch_add(1, Ordering::SeqCst) + 1).to_string();
        Ok(review_receipt(request, review_id))
    }

    async fn inspect_review(
        &self,
        review: &GitHubReviewReceipt,
        credential: GitHubCredential<'_>,
    ) -> Result<GitHubReviewObservation, GitHubAuthorityError> {
        require_test_credential(credential)?;
        self.inspections.fetch_add(1, Ordering::SeqCst);
        let merged = self
            .merged_reviews
            .lock()
            .assert_value()
            .contains(&review.review_id);
        let state = if merged {
            GitHubReviewState::Merged {
                merge_revision: review.head_revision.clone(),
            }
        } else if matches!(self.scenario, DeliveryScenario::CiFailureThenMerge)
            && review.review_id == "1"
        {
            GitHubReviewState::Open {
                checks: GitHubChecks::Failed {
                    diagnostic: "Required CI checks failed:\n- realistic CI fixture failed"
                        .to_owned(),
                },
            }
        } else {
            GitHubReviewState::Open {
                checks: GitHubChecks::NotRequired,
            }
        };
        Ok(review_observation(review, state))
    }

    async fn request_merge(
        &self,
        review: &GitHubReviewReceipt,
        credential: GitHubCredential<'_>,
    ) -> Result<GitHubMergeRequestOutcome, GitHubAuthorityError> {
        require_test_credential(credential)?;
        self.merge_requests.fetch_add(1, Ordering::SeqCst);
        let mut merged = self.merged_reviews.lock().assert_value();
        merged.insert(review.review_id.clone());
        Ok(GitHubMergeRequestOutcome::Accepted)
    }
}

struct DeliveryLane {
    delivery: NativeV2DeliveryAdapter,
    workspace: PathBuf,
    repairs: Arc<AtomicUsize>,
}

#[async_trait]
impl SessionFactory for DeliveryLane {
    async fn open(
        &self,
        invocation: &NodeInvocation,
        environment: &ResolvedEnvironment,
    ) -> Result<Arc<dyn NodeSession>, NodeRunnerError> {
        match invocation.binding {
            NodeRuntimeBinding::GitDelivery { .. } => {
                SessionFactory::open(&self.delivery, invocation, environment).await
            }
            NodeRuntimeBinding::Agent { .. } => Ok(Arc::new(ImmediateSession {
                live: std::sync::atomic::AtomicBool::new(true),
            })),
        }
    }
}

#[async_trait]
impl NodeDriver for DeliveryLane {
    async fn run(
        &self,
        invocation: DriverInvocation,
        control: DriverControl,
    ) -> Result<WorkerOutcome, NodeRunnerError> {
        if matches!(
            invocation.node.binding,
            NodeRuntimeBinding::GitDelivery { .. }
        ) {
            return NodeDriver::run(&self.delivery, invocation, control).await;
        }
        let repair = self.repairs.fetch_add(1, Ordering::SeqCst) + 1;
        std::fs::write(
            self.workspace.join(format!("repair-{repair}.txt")),
            format!("repair {repair}\n"),
        )
        .map_err(|_| NodeRunnerError::Driver)?;
        Ok(WorkerOutcome::Verified {
            output: serde_json::Value::Null,
            artifacts: Vec::new(),
        })
    }
}

pub(crate) struct DeliveryAllocator {
    pub(crate) fixture: DeliveryFixture,
    pub(crate) authority: Arc<DeliveryAuthority>,
    pub(crate) repairs: Arc<AtomicUsize>,
    pub(crate) lifecycle: ImmediateAllocator,
}

#[async_trait]
impl CapsuleAllocator for DeliveryAllocator {
    async fn claim_controller(
        &self,
        run_id: &RunId,
    ) -> Result<Arc<dyn ExclusiveControllerClaim>, ControllerClaimUnavailable> {
        self.lifecycle.claim_controller(run_id).await
    }

    async fn allocate(
        &self,
        _run_id: &RunId,
        admitted: &AdmittedRun,
        _github_token: Option<&str>,
    ) -> Result<AllocatedCapsule, CapsuleAllocationUnavailable> {
        let delivery = NativeV2DeliveryAdapter::new(
            NativeV2DeliveryConfig {
                workspace: self.fixture.workspace.clone(),
                git_program: PathBuf::from("/usr/bin/git"),
                target: DeliveryTarget::new(
                    admitted.source.repository.as_str(),
                    admitted.source.branch.as_str(),
                    admitted.source.revision.as_str(),
                )
                .map_err(|_| CapsuleAllocationUnavailable)?,
                poll: DeliveryPollPolicy::new(3, Duration::ZERO)
                    .map_err(|_| CapsuleAllocationUnavailable)?,
            },
            self.authority.clone(),
        );
        let lane = Arc::new(DeliveryLane {
            delivery,
            workspace: self.fixture.workspace.clone(),
            repairs: self.repairs.clone(),
        });
        let runner = NativeNodeRunner::new(admitted, lane.clone(), lane)
            .map_err(|_| CapsuleAllocationUnavailable)?;
        let (sender, loss) = watch::channel(false);
        self.lifecycle.losses.lock().assert_value().push(sender);
        Ok(AllocatedCapsule {
            runner: Arc::new(runner),
            loss,
            cleanup: Arc::new(ImmediateCleanup),
        })
    }

    async fn destroy_or_confirm_absent(
        &self,
        run_id: &RunId,
        exit: RunRuntimeExit,
    ) -> Result<CapsuleDestroyed, CapsuleCleanupUnavailable> {
        self.lifecycle.destroy_or_confirm_absent(run_id, exit).await
    }
}

use openengine_cluster_testkit::assertions::{AssertValue};
