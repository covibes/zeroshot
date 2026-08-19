use super::*;

#[derive(Clone)]
pub struct NativeV2DeliveryAdapter {
    config: Arc<NativeV2DeliveryConfig>,
    authority: Arc<dyn GitHubDeliveryAuthority>,
    git: SystemGit,
}

impl NativeV2DeliveryAdapter {
    #[must_use]
    pub fn new(
        config: NativeV2DeliveryConfig,
        authority: Arc<dyn GitHubDeliveryAuthority>,
    ) -> Self {
        let git = SystemGit::new(config.git_program.clone());
        Self {
            config: Arc::new(config),
            authority,
            git,
        }
    }
}

struct DeliverySession {
    workspace: PathBuf,
    live: AtomicBool,
}

#[async_trait]
impl NodeSession for DeliverySession {
    fn as_any(&self) -> &dyn Any {
        self
    }

    async fn is_live(&self) -> bool {
        self.live.load(Ordering::SeqCst) && self.workspace.is_dir()
    }

    async fn close(&self) {
        self.live.store(false, Ordering::SeqCst);
    }
}

#[async_trait]
impl SessionFactory for NativeV2DeliveryAdapter {
    async fn open(
        &self,
        invocation: &NodeInvocation,
        _environment: &ResolvedEnvironment,
    ) -> Result<Arc<dyn NodeSession>, NodeRunnerError> {
        if !matches!(invocation.binding, NodeRuntimeBinding::GitDelivery { .. })
            || DeliveryMode::from_worker(&invocation.worker).is_none()
        {
            return Err(NodeRunnerError::InvalidRole);
        }
        Ok(Arc::new(DeliverySession {
            workspace: self.config.workspace.clone(),
            live: AtomicBool::new(true),
        }))
    }
}

#[async_trait]
impl NodeDriver for NativeV2DeliveryAdapter {
    async fn run(
        &self,
        invocation: DriverInvocation,
        mut control: DriverControl,
    ) -> Result<WorkerOutcome, NodeRunnerError> {
        let (session, credential, mode) = match self.authorize(&invocation) {
            Ok(authority) => authority,
            Err(stop) => return stop.result(),
        };
        if control.is_cancelled() {
            return Err(NodeRunnerError::Cancelled);
        }
        let review = match self
            .prepare_review(DeliveryPreparation {
                invocation: &invocation,
                session,
                credential,
                control: &control,
            })
            .await
        {
            Ok(review) => review,
            Err(stop) => return stop.result(),
        };
        self.drive_review(ReviewDrive {
            mode,
            response: &invocation.response,
            review: &review,
            credential,
            control: &mut control,
            merge_requested: false,
            merge_rejection_reobserved: false,
        })
        .await
    }
}

enum DeliveryStop {
    Runner(NodeRunnerError),
    Outcome(WorkerOutcome),
}

struct DeliveryPreparation<'a> {
    invocation: &'a DriverInvocation,
    session: &'a DeliverySession,
    credential: GitHubCredential<'a>,
    control: &'a DriverControl,
}

impl DeliveryStop {
    fn result(self) -> Result<WorkerOutcome, NodeRunnerError> {
        match self {
            Self::Runner(error) => Err(error),
            Self::Outcome(outcome) => Ok(outcome),
        }
    }
}

impl From<NodeRunnerError> for DeliveryStop {
    fn from(error: NodeRunnerError) -> Self {
        Self::Runner(error)
    }
}

struct ReviewDrive<'a> {
    mode: DeliveryMode,
    response: &'a NodeResponseContract,
    review: &'a GitHubReviewReceipt,
    credential: GitHubCredential<'a>,
    control: &'a mut DriverControl,
    merge_requested: bool,
    merge_rejection_reobserved: bool,
}

impl NativeV2DeliveryAdapter {
    fn authorize<'a>(
        &self,
        invocation: &'a DriverInvocation,
    ) -> Result<(&'a DeliverySession, GitHubCredential<'a>, DeliveryMode), DeliveryStop> {
        if invocation.role != NodeRole::GitDelivery
            || !matches!(
                invocation.node.binding,
                NodeRuntimeBinding::GitDelivery { .. }
            )
        {
            return Err(DeliveryStop::Runner(NodeRunnerError::InvalidRole));
        }
        let mode = DeliveryMode::from_worker(&invocation.node.worker)
            .ok_or(DeliveryStop::Runner(NodeRunnerError::InvalidRole))?;
        validate_delivery_contract(mode, &invocation.response)?;
        let credential = github_credential(&invocation.environment)
            .ok_or_else(|| DeliveryStop::Outcome(WorkerOutcome::authentication_refusal()))?;
        let session = invocation
            .session
            .as_any()
            .downcast_ref::<DeliverySession>()
            .ok_or(DeliveryStop::Runner(NodeRunnerError::InvalidRole))?;
        Ok((session, credential, mode))
    }

    async fn prepare_review(
        &self,
        preparation: DeliveryPreparation<'_>,
    ) -> Result<GitHubReviewReceipt, DeliveryStop> {
        let head_revision = self
            .prepare_head(preparation.session, preparation.control)
            .await?;
        let review_request = GitHubReviewRequest {
            target: self.config.target.clone(),
            head_branch: delivery_branch(preparation.invocation.node.reference.run_id.as_str()),
            head_revision,
        };
        self.push_review_head(&preparation, &review_request).await?;
        let review = self
            .synchronize_review(&review_request, preparation.credential, preparation.control)
            .await?;
        if !valid_review(&review_request, &review) {
            return Err(DeliveryStop::Outcome(WorkerOutcome::malformed()));
        }
        emit(
            preparation.control,
            "delivery: review created or rediscovered",
        )?;
        Ok(review)
    }

    async fn synchronize_review(
        &self,
        request: &GitHubReviewRequest,
        credential: GitHubCredential<'_>,
        control: &DriverControl,
    ) -> Result<GitHubReviewReceipt, DeliveryStop> {
        for attempt in 0..REVIEW_SYNC_ATTEMPTS {
            match self
                .authority
                .open_or_update_review(request, credential)
                .await
            {
                Ok(review) => return Ok(review),
                Err(_) if attempt + 1 < REVIEW_SYNC_ATTEMPTS => {
                    emit(control, "delivery: waiting for pushed review head")?;
                    tokio::time::sleep(REVIEW_SYNC_INTERVAL).await;
                }
                Err(_) => return Err(crash_outcome()),
            }
        }
        Err(crash_outcome())
    }

    async fn prepare_head(
        &self,
        session: &DeliverySession,
        control: &DriverControl,
    ) -> Result<String, DeliveryStop> {
        emit(control, "delivery: preparing workspace revision")?;
        match self
            .git
            .prepare_revision(&session.workspace, &self.config.target.base_revision)
            .await
        {
            Ok(revision) => Ok(revision),
            Err(GitError::NoMutation) => {
                emit(control, "delivery: workspace has no deliverable mutation")?;
                Err(DeliveryStop::Outcome(WorkerOutcome::declared_failure(
                    WorkerErrorCode::Malformed,
                )))
            }
            Err(GitError::Command) => {
                emit(control, "delivery: local Git preparation failed")?;
                Err(crash_outcome())
            }
        }
    }

    async fn push_review_head(
        &self,
        preparation: &DeliveryPreparation<'_>,
        review: &GitHubReviewRequest,
    ) -> Result<(), DeliveryStop> {
        let push = GitHubPushRequest {
            workspace: preparation.session.workspace.clone(),
            target: review.target.clone(),
            head_branch: review.head_branch.clone(),
            head_revision: review.head_revision.clone(),
        };
        emit(preparation.control, "delivery: pushing run branch")?;
        self.authority
            .push_branch(&push, preparation.credential)
            .await
            .map_err(|_| crash_outcome())?;
        Ok(())
    }

    async fn drive_review(
        &self,
        mut drive: ReviewDrive<'_>,
    ) -> Result<WorkerOutcome, NodeRunnerError> {
        for attempt in 0..self.config.poll.attempts {
            ensure_active(drive.control)?;
            let progress = match self.observe_review(drive.review, drive.credential).await {
                Ok(progress) => progress,
                Err(stop) => return stop.result(),
            };
            match self.advance_review(&mut drive, progress).await {
                Ok(ReviewStep::Continue) => {}
                Ok(ReviewStep::Complete(outcome)) => return Ok(outcome),
                Err(stop) => return stop.result(),
            }
            poll_before_next(
                drive.control,
                self.config.poll.interval,
                attempt + 1 < self.config.poll.attempts,
            )
            .await?;
        }
        emit(
            drive.control,
            "delivery: authoritative confirmation timed out",
        )?;
        Ok(WorkerOutcome::declared_failure(WorkerErrorCode::Timeout))
    }

    async fn advance_review(
        &self,
        drive: &mut ReviewDrive<'_>,
        progress: ReviewProgress,
    ) -> Result<ReviewStep, DeliveryStop> {
        match drive.mode {
            DeliveryMode::PullRequest => self.advance_pull_request(drive, progress),
            DeliveryMode::Merge => self.advance_merge(drive, progress).await,
        }
    }

    fn advance_pull_request(
        &self,
        drive: &ReviewDrive<'_>,
        progress: ReviewProgress,
    ) -> Result<ReviewStep, DeliveryStop> {
        match progress {
            ReviewProgress::CiFailed(_)
            | ReviewProgress::Mergeable
            | ReviewProgress::Pending
            | ReviewProgress::Conflict => review_completion(
                drive,
                DELIVERY_OPENED_LABEL,
                "GitHub authoritatively confirmed the pull request is open",
            ),
            ReviewProgress::Merged | ReviewProgress::Closed => Err(crash_outcome()),
        }
    }

    async fn advance_merge(
        &self,
        drive: &mut ReviewDrive<'_>,
        progress: ReviewProgress,
    ) -> Result<ReviewStep, DeliveryStop> {
        match progress {
            ReviewProgress::Merged => review_completion(
                drive,
                DELIVERY_MERGED_LABEL,
                "GitHub authoritatively confirmed merge",
            ),
            ReviewProgress::Conflict => review_completion(
                drive,
                DELIVERY_CONFLICT_LABEL,
                "GitHub authoritatively reported a merge conflict",
            ),
            ReviewProgress::CiFailed(diagnostic) => {
                review_completion(drive, DELIVERY_CI_FAILED_LABEL, &diagnostic)
            }
            ReviewProgress::Mergeable => self.advance_mergeable(drive).await,
            ReviewProgress::Pending => {
                emit(drive.control, "delivery: waiting for required CI checks")?;
                Ok(ReviewStep::Continue)
            }
            ReviewProgress::Closed => Err(crash_outcome()),
        }
    }

    async fn advance_mergeable(
        &self,
        drive: &mut ReviewDrive<'_>,
    ) -> Result<ReviewStep, DeliveryStop> {
        if drive.merge_requested {
            emit(
                drive.control,
                "delivery: waiting for authoritative merge confirmation",
            )?;
        } else {
            match self
                .request_merge(drive.review, drive.credential, drive.control)
                .await?
            {
                GitHubMergeRequestOutcome::Accepted => drive.merge_requested = true,
                GitHubMergeRequestOutcome::Pending => {
                    if let Some(completion) = rejected_merge_step(drive)? {
                        return Ok(completion);
                    }
                }
                GitHubMergeRequestOutcome::Conflict => {
                    return review_completion(
                        drive,
                        DELIVERY_CONFLICT_LABEL,
                        "GitHub authoritatively rejected merge due to conflict",
                    );
                }
            }
        }
        Ok(ReviewStep::Continue)
    }

    async fn observe_review(
        &self,
        review: &GitHubReviewReceipt,
        credential: GitHubCredential<'_>,
    ) -> Result<ReviewProgress, DeliveryStop> {
        let observation = self
            .authority
            .inspect_review(review, credential)
            .await
            .map_err(|_| crash_outcome())?;
        if !valid_observation(review, &observation) {
            return Err(DeliveryStop::Outcome(WorkerOutcome::malformed()));
        }
        ReviewProgress::from_state(observation.state)
    }

    async fn request_merge(
        &self,
        review: &GitHubReviewReceipt,
        credential: GitHubCredential<'_>,
        control: &DriverControl,
    ) -> Result<GitHubMergeRequestOutcome, DeliveryStop> {
        emit(control, "delivery: requesting merge")?;
        self.authority
            .request_merge(review, credential)
            .await
            .map_err(|_| crash_outcome())
    }
}

fn rejected_merge_step(drive: &mut ReviewDrive<'_>) -> Result<Option<ReviewStep>, DeliveryStop> {
    if !drive.merge_rejection_reobserved {
        drive.merge_rejection_reobserved = true;
        emit(drive.control, "delivery: merge request is not yet accepted")?;
        return Ok(None);
    }
    emit(
        drive.control,
        "delivery: target policy rejected direct merge",
    )?;
    Ok(Some(ReviewStep::Complete(WorkerOutcome::policy_refusal())))
}

enum ReviewProgress {
    Merged,
    CiFailed(String),
    Mergeable,
    Pending,
    Conflict,
    Closed,
}

enum ReviewStep {
    Continue,
    Complete(WorkerOutcome),
}

impl ReviewProgress {
    fn from_state(state: GitHubReviewState) -> Result<Self, DeliveryStop> {
        match state {
            GitHubReviewState::Merged { merge_revision } if valid_revision(&merge_revision) => {
                Ok(Self::Merged)
            }
            GitHubReviewState::Merged { .. } => {
                Err(DeliveryStop::Outcome(WorkerOutcome::malformed()))
            }
            GitHubReviewState::Open {
                checks: GitHubChecks::Failed { diagnostic },
            } => Ok(Self::CiFailed(diagnostic)),
            GitHubReviewState::Open {
                checks: GitHubChecks::Pending,
            } => Ok(Self::Pending),
            GitHubReviewState::Open {
                checks: GitHubChecks::NotRequired | GitHubChecks::Passed,
            } => Ok(Self::Mergeable),
            GitHubReviewState::Conflict => Ok(Self::Conflict),
            GitHubReviewState::Closed => Ok(Self::Closed),
        }
    }
}

fn crash_outcome() -> DeliveryStop {
    DeliveryStop::Outcome(WorkerOutcome::declared_failure(WorkerErrorCode::Crash))
}

fn review_completion(
    drive: &ReviewDrive<'_>,
    label: &'static str,
    diagnostic: &str,
) -> Result<ReviewStep, DeliveryStop> {
    emit(drive.control, diagnostic)?;
    validate_delivery_contract(drive.mode, drive.response).map_err(DeliveryStop::Runner)?;
    delivery_outcome(drive.mode, label, drive.review, diagnostic)
        .map(ReviewStep::Complete)
        .map_err(DeliveryStop::Runner)
}
