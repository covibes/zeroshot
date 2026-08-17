//! Native-v2's graph-visible Git delivery node.
//!
//! Delivery is a trusted built-in verifier: it commits the shared workspace, asks the selected
//! target's GitHub authority to push and open/update one run-stable review, and returns a signal
//! that authored graph control flow can route. A merge request is never treated as success; only a
//! later authoritative observation of the exact review and head revision can produce `merged`.

mod git;
mod github;

#[cfg(test)]
mod tests;

pub use github::{GhCliAuthorityConfig, GhCliDeliveryAuthority};

use std::any::Any;
use std::collections::BTreeMap;
use std::fmt;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use openengine_cluster_protocol::{EnumLabel, FieldName, PayloadType, WorkerErrorCode, WorkerOutcome};
use serde_json::Value;

use crate::native_v2_contract::{EnvironmentVariableName, NodeInvocation, NodeRuntimeBinding};
use crate::native_v2_runner::{
    DriverControl, DriverInvocation, LiveOutput, LiveOutputStream, NodeDriver,
    NodeResponseContract, NodeRole, NodeRunnerError, NodeSession, ResolvedEnvironment,
    SessionFactory,
};

use self::git::{GitError, SystemGit};

pub const GITHUB_TOKEN_ENV: &str = "GH_TOKEN";
pub const DELIVERY_SIGNAL_FIELD: &str = "delivery";
pub const DELIVERY_MERGED_LABEL: &str = "merged";
pub const DELIVERY_CI_FAILED_LABEL: &str = "ci_failed";

const DEFAULT_POLL_ATTEMPTS: usize = 90;
const DEFAULT_POLL_INTERVAL: Duration = Duration::from_secs(20);
const MAX_TOKEN_BYTES: usize = 4_096;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DeliveryTarget {
    pub repository: String,
    pub target_branch: String,
    pub base_revision: String,
}

impl DeliveryTarget {
    pub fn new(
        repository: impl Into<String>,
        target_branch: impl Into<String>,
        base_revision: impl Into<String>,
    ) -> Result<Self, DeliveryConfigError> {
        let target = Self {
            repository: repository.into(),
            target_branch: target_branch.into(),
            base_revision: base_revision.into(),
        };
        if !valid_repository(&target.repository) {
            return Err(DeliveryConfigError::Repository);
        }
        if !valid_branch(&target.target_branch) {
            return Err(DeliveryConfigError::Branch);
        }
        if !valid_revision(&target.base_revision) {
            return Err(DeliveryConfigError::Revision);
        }
        Ok(target)
    }
}

#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
pub enum DeliveryConfigError {
    #[error("GitHub repository must have the form owner/name")]
    Repository,
    #[error("target branch is not a bounded Git branch name")]
    Branch,
    #[error("base revision must be a lowercase 40-character Git revision")]
    Revision,
    #[error("delivery polling requires at least one observation")]
    PollAttempts,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct DeliveryPollPolicy {
    pub attempts: usize,
    pub interval: Duration,
}

impl DeliveryPollPolicy {
    pub fn new(attempts: usize, interval: Duration) -> Result<Self, DeliveryConfigError> {
        if attempts == 0 {
            return Err(DeliveryConfigError::PollAttempts);
        }
        Ok(Self { attempts, interval })
    }
}

impl Default for DeliveryPollPolicy {
    fn default() -> Self {
        Self {
            attempts: DEFAULT_POLL_ATTEMPTS,
            interval: DEFAULT_POLL_INTERVAL,
        }
    }
}

#[derive(Clone, Debug)]
pub struct NativeV2DeliveryConfig {
    pub workspace: PathBuf,
    pub git_program: PathBuf,
    pub target: DeliveryTarget,
    /// The admitted run's unchanged `--ship` authorization bit.
    pub ship_authorized: bool,
    pub poll: DeliveryPollPolicy,
}

impl NativeV2DeliveryConfig {
    #[must_use]
    pub fn for_hosted_workspace(
        workspace: PathBuf,
        target: DeliveryTarget,
        ship_authorized: bool,
    ) -> Self {
        Self {
            workspace,
            git_program: PathBuf::from("/usr/bin/git"),
            target,
            ship_authorized,
            poll: DeliveryPollPolicy::default(),
        }
    }
}

/// Borrowed credential authority. It is intentionally neither serializable nor printable.
#[derive(Clone, Copy)]
pub struct GitHubCredential<'a>(&'a str);

impl<'a> GitHubCredential<'a> {
    #[must_use]
    pub fn expose(self) -> &'a str {
        self.0
    }
}

impl fmt::Debug for GitHubCredential<'_> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("GitHubCredential([REDACTED])")
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GitHubPushRequest {
    pub workspace: PathBuf,
    pub target: DeliveryTarget,
    pub head_branch: String,
    pub head_revision: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GitHubReviewRequest {
    pub target: DeliveryTarget,
    pub head_branch: String,
    pub head_revision: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GitHubReviewReceipt {
    pub review_id: String,
    pub repository: String,
    pub target_branch: String,
    pub head_branch: String,
    pub head_revision: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum GitHubChecks {
    NotRequired,
    Pending,
    Passed,
    Failed,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum GitHubReviewState {
    Open { checks: GitHubChecks },
    Merged { merge_revision: String },
    Closed,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GitHubReviewObservation {
    pub review_id: String,
    pub repository: String,
    pub target_branch: String,
    pub head_branch: String,
    pub head_revision: String,
    pub state: GitHubReviewState,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
pub enum GitHubAuthorityError {
    #[error("GitHub delivery authority is unavailable")]
    Unavailable,
    #[error("GitHub rejected delivery")]
    Rejected,
}

/// Target-owned, bounded GitHub effects. Implementations must bound every network operation.
#[async_trait]
pub trait GitHubDeliveryAuthority: Send + Sync {
    async fn push_branch(
        &self,
        request: &GitHubPushRequest,
        credential: GitHubCredential<'_>,
    ) -> Result<(), GitHubAuthorityError>;

    /// Opens the review or updates the existing run-stable review after an authored loop revisit.
    async fn open_or_update_review(
        &self,
        request: &GitHubReviewRequest,
        credential: GitHubCredential<'_>,
    ) -> Result<GitHubReviewReceipt, GitHubAuthorityError>;

    async fn inspect_review(
        &self,
        review: &GitHubReviewReceipt,
        credential: GitHubCredential<'_>,
    ) -> Result<GitHubReviewObservation, GitHubAuthorityError>;

    /// Requests an immediate merge after checks are absent or satisfied. Acceptance is not proof.
    async fn request_merge(
        &self,
        review: &GitHubReviewReceipt,
        credential: GitHubCredential<'_>,
    ) -> Result<(), GitHubAuthorityError>;
}

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
        if !matches!(invocation.binding, NodeRuntimeBinding::GitDelivery { .. }) {
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
        let (session, credential) = match self.authorize(&invocation) {
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
            response: &invocation.response,
            review: &review,
            credential,
            control: &mut control,
            merge_requested: false,
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
    response: &'a NodeResponseContract,
    review: &'a GitHubReviewReceipt,
    credential: GitHubCredential<'a>,
    control: &'a mut DriverControl,
    merge_requested: bool,
}

impl NativeV2DeliveryAdapter {
    fn authorize<'a>(
        &self,
        invocation: &'a DriverInvocation,
    ) -> Result<(&'a DeliverySession, GitHubCredential<'a>), DeliveryStop> {
        if invocation.role != NodeRole::GitDelivery
            || !matches!(
                invocation.node.binding,
                NodeRuntimeBinding::GitDelivery { .. }
            )
        {
            return Err(DeliveryStop::Runner(NodeRunnerError::InvalidRole));
        }
        validate_delivery_contract(&invocation.response)?;
        if !self.config.ship_authorized {
            return Err(DeliveryStop::Outcome(WorkerOutcome::policy_refusal()));
        }
        let credential = github_credential(&invocation.environment)
            .ok_or_else(|| DeliveryStop::Outcome(WorkerOutcome::authentication_refusal()))?;
        let session = invocation
            .session
            .as_any()
            .downcast_ref::<DeliverySession>()
            .ok_or(DeliveryStop::Runner(NodeRunnerError::InvalidRole))?;
        Ok((session, credential))
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
            .authority
            .open_or_update_review(&review_request, preparation.credential)
            .await
            .map_err(|_| crash_outcome())?;
        if !valid_review(&review_request, &review) {
            return Err(DeliveryStop::Outcome(WorkerOutcome::malformed()));
        }
        emit(preparation.control, "delivery: review is open")?;
        Ok(review)
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
        emit(drive.control, "delivery: merge confirmation timed out")?;
        Ok(WorkerOutcome::declared_failure(WorkerErrorCode::Timeout))
    }

    async fn advance_review(
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
            ReviewProgress::CiFailed => {
                review_completion(drive, DELIVERY_CI_FAILED_LABEL, "required CI checks failed")
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
            self.request_merge(drive.review, drive.credential, drive.control)
                .await?;
            drive.merge_requested = true;
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
    ) -> Result<(), DeliveryStop> {
        emit(control, "delivery: requesting merge")?;
        self.authority
            .request_merge(review, credential)
            .await
            .map_err(|_| crash_outcome())
    }
}

enum ReviewProgress {
    Merged,
    CiFailed,
    Mergeable,
    Pending,
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
                checks: GitHubChecks::Failed,
            } => Ok(Self::CiFailed),
            GitHubReviewState::Open {
                checks: GitHubChecks::Pending,
            } => Ok(Self::Pending),
            GitHubReviewState::Open {
                checks: GitHubChecks::NotRequired | GitHubChecks::Passed,
            } => Ok(Self::Mergeable),
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
    diagnostic: &'static str,
) -> Result<ReviewStep, DeliveryStop> {
    emit(drive.control, diagnostic)?;
    delivery_outcome(drive.response, label, diagnostic)
        .map(ReviewStep::Complete)
        .map_err(DeliveryStop::Runner)
}

pub fn validate_delivery_contract(response: &NodeResponseContract) -> Result<(), NodeRunnerError> {
    let NodeResponseContract::Verifier {
        output,
        signals,
        diagnostic,
    } = response
    else {
        return Err(NodeRunnerError::InvalidRole);
    };
    if output != &PayloadType::Null || diagnostic != &PayloadType::String || signals.len() != 1 {
        return Err(NodeRunnerError::Driver);
    }
    let field = FieldName::new(DELIVERY_SIGNAL_FIELD).expect("fixed delivery field is valid");
    let Some(labels) = signals.get(&field) else {
        return Err(NodeRunnerError::Driver);
    };
    let expected = [DELIVERY_MERGED_LABEL, DELIVERY_CI_FAILED_LABEL];
    if labels.values().len() != expected.len()
        || !expected.iter().all(|expected| {
            labels
                .values()
                .iter()
                .any(|label| label.as_str() == *expected)
        })
    {
        return Err(NodeRunnerError::Driver);
    }
    Ok(())
}

fn github_credential(environment: &ResolvedEnvironment) -> Option<GitHubCredential<'_>> {
    let name = EnvironmentVariableName::new(GITHUB_TOKEN_ENV).ok()?;
    let token = environment.get(&name)?;
    (!token.trim().is_empty() && token.len() <= MAX_TOKEN_BYTES).then_some(GitHubCredential(token))
}

fn delivery_outcome(
    response: &NodeResponseContract,
    label: &str,
    diagnostic: &str,
) -> Result<WorkerOutcome, NodeRunnerError> {
    validate_delivery_contract(response)?;
    let field = FieldName::new(DELIVERY_SIGNAL_FIELD).map_err(|_| NodeRunnerError::Driver)?;
    let label = EnumLabel::new(label).map_err(|_| NodeRunnerError::Driver)?;
    Ok(WorkerOutcome::Verifier {
        output: Value::Null,
        signals: BTreeMap::from([(field, label)]),
        diagnostic: Value::String(diagnostic.to_owned()),
        artifacts: Vec::new(),
    })
}

fn valid_review(request: &GitHubReviewRequest, review: &GitHubReviewReceipt) -> bool {
    !review.review_id.trim().is_empty()
        && review.repository == request.target.repository
        && review.target_branch == request.target.target_branch
        && review.head_branch == request.head_branch
        && review.head_revision == request.head_revision
}

fn valid_observation(review: &GitHubReviewReceipt, observation: &GitHubReviewObservation) -> bool {
    observation.review_id == review.review_id
        && observation.repository == review.repository
        && observation.target_branch == review.target_branch
        && observation.head_branch == review.head_branch
        && observation.head_revision == review.head_revision
}

fn delivery_branch(run_id: &str) -> String {
    use sha2::{Digest, Sha256};

    let digest = Sha256::digest(run_id.as_bytes());
    let suffix = digest[..10]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    format!("zeroshot/v2-{suffix}")
}

async fn wait_for_poll(
    control: &mut DriverControl,
    interval: Duration,
) -> Result<(), NodeRunnerError> {
    tokio::select! {
        _ = control.cancelled() => Err(NodeRunnerError::Cancelled),
        () = tokio::time::sleep(interval) => Ok(()),
    }
}

async fn poll_before_next(
    control: &mut DriverControl,
    interval: Duration,
    has_next: bool,
) -> Result<(), NodeRunnerError> {
    if has_next {
        wait_for_poll(control, interval).await
    } else {
        Ok(())
    }
}

fn ensure_active(control: &DriverControl) -> Result<(), NodeRunnerError> {
    (!control.is_cancelled())
        .then_some(())
        .ok_or(NodeRunnerError::Cancelled)
}

fn emit(control: &DriverControl, message: &'static str) -> Result<(), NodeRunnerError> {
    control.emit(LiveOutput::new(LiveOutputStream::System, message)?)
}

fn valid_repository(value: &str) -> bool {
    let Some((owner, name)) = value.split_once('/') else {
        return false;
    };
    !owner.is_empty()
        && !name.is_empty()
        && !name.contains('/')
        && value.len() <= 256
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'/'))
}

fn valid_branch(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && !value.starts_with('-')
        && !value.contains("..")
        && !value.ends_with('.')
        && !value.ends_with('/')
        && !value.bytes().any(|byte| {
            byte.is_ascii_control()
                || byte.is_ascii_whitespace()
                || matches!(byte, b'~' | b'^' | b':' | b'?' | b'*' | b'[' | b'\\')
        })
}

fn valid_revision(value: &str) -> bool {
    value.len() == 40
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}
