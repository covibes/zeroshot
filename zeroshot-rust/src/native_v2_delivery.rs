//! Native-v2's graph-visible Git delivery node.
//!
//! Two graph worker references select PR or merge completion on one shared implementation. Both
//! commit the workspace, push one deterministic run branch, and create or rediscover one stable
//! review. Only authoritative open/merge observations produce successful inline receipts;
//! conflict and CI failure remain routable attempt results.

mod adapter;
pub(crate) mod contract;
mod git;
#[doc(hidden)]
pub mod git_auth;
mod github;

#[cfg(test)]
mod tests;

pub use github::{GhCliAuthorityConfig, GhCliDeliveryAuthority};
pub use contract::{is_matching_success_receipt, validate_delivery_contract};
#[cfg(test)]
pub(crate) use contract::{delivery_diagnostic_schema, delivery_result_schema, delivery_signal_labels};

use std::any::Any;
use std::collections::BTreeMap;
use std::fmt;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use openengine_cluster_protocol::{EnumLabel, FieldName, WorkerErrorCode, WorkerOutcome, WorkerRef};
use serde_json::{Map, Value, json};

use crate::native_v2_contract::{
    EnvironmentVariableName, GIT_DELIVERY_MERGE_WORKER_REF, GIT_DELIVERY_PR_WORKER_REF,
    NodeInvocation, NodeRuntimeBinding,
};
use crate::native_v2_runner::{
    DriverControl, DriverInvocation, LiveOutput, LiveOutputStream, NodeDriver,
    NodeResponseContract, NodeRole, NodeRunnerError, NodeSession, ResolvedEnvironment,
    SessionFactory,
};

use self::git::{GitError, SystemGit};

pub const GITHUB_TOKEN_ENV: &str = "GH_TOKEN";
pub const DELIVERY_SIGNAL_FIELD: &str = "delivery";
pub const DELIVERY_OPENED_LABEL: &str = "opened";
pub const DELIVERY_MERGED_LABEL: &str = "merged";
pub const DELIVERY_CONFLICT_LABEL: &str = "conflict";
pub const DELIVERY_CI_FAILED_LABEL: &str = "ci_failed";

const DELIVERY_RESULT_VERSION: &str = "v1";
const DELIVERY_VERSION_FIELD: &str = "version";
const DELIVERY_MODE_FIELD: &str = "mode";
const DELIVERY_OUTCOME_FIELD: &str = "outcome";
const DELIVERY_REPOSITORY_FIELD: &str = "repository";
const DELIVERY_TARGET_BRANCH_FIELD: &str = "targetBranch";
const DELIVERY_HEAD_REVISION_FIELD: &str = "headRevision";
const DELIVERY_PULL_REQUEST_ID_FIELD: &str = "pullRequestId";

const DEFAULT_POLL_ATTEMPTS: usize = 90;
const DEFAULT_POLL_INTERVAL: Duration = Duration::from_secs(20);
const REVIEW_SYNC_ATTEMPTS: usize = 5;
const REVIEW_SYNC_INTERVAL: Duration = Duration::from_secs(1);
const MAX_TOKEN_BYTES: usize = 4_096;
const MAX_REVIEW_ID_BYTES: usize = 32;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DeliveryMode {
    PullRequest,
    Merge,
}

impl DeliveryMode {
    #[must_use]
    pub fn from_worker(worker: &WorkerRef) -> Option<Self> {
        match worker.as_str() {
            GIT_DELIVERY_PR_WORKER_REF => Some(Self::PullRequest),
            GIT_DELIVERY_MERGE_WORKER_REF => Some(Self::Merge),
            _ => None,
        }
    }

    const fn label(self) -> &'static str {
        match self {
            Self::PullRequest => "pr",
            Self::Merge => "merge",
        }
    }

    const fn success_outcome(self) -> &'static str {
        match self {
            Self::PullRequest => DELIVERY_OPENED_LABEL,
            Self::Merge => DELIVERY_MERGED_LABEL,
        }
    }
}

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
    pub poll: DeliveryPollPolicy,
}

impl NativeV2DeliveryConfig {
    #[must_use]
    pub fn for_hosted_workspace(workspace: PathBuf, target: DeliveryTarget) -> Self {
        Self {
            workspace,
            git_program: PathBuf::from("/usr/bin/git"),
            target,
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
    Failed { diagnostic: String },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum GitHubReviewState {
    Open { checks: GitHubChecks },
    Merged { merge_revision: String },
    Conflict,
    Closed,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GitHubMergeRequestOutcome {
    Accepted,
    Pending,
    Conflict,
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

impl GitHubReviewReceipt {
    pub(crate) fn observation(&self, state: GitHubReviewState) -> GitHubReviewObservation {
        GitHubReviewObservation {
            review_id: self.review_id.clone(),
            repository: self.repository.clone(),
            target_branch: self.target_branch.clone(),
            head_branch: self.head_branch.clone(),
            head_revision: self.head_revision.clone(),
            state,
        }
    }
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
    ) -> Result<GitHubMergeRequestOutcome, GitHubAuthorityError>;
}

pub use adapter::NativeV2DeliveryAdapter;

fn github_credential(environment: &ResolvedEnvironment) -> Option<GitHubCredential<'_>> {
    let name = EnvironmentVariableName::new(GITHUB_TOKEN_ENV).ok()?;
    let token = environment.get(&name)?;
    (!token.trim().is_empty() && token.len() <= MAX_TOKEN_BYTES).then_some(GitHubCredential(token))
}

fn delivery_outcome(
    mode: DeliveryMode,
    outcome: &str,
    review: &GitHubReviewReceipt,
    diagnostic: &str,
) -> Result<WorkerOutcome, NodeRunnerError> {
    if !valid_mode_outcome(mode, outcome) {
        return Err(NodeRunnerError::Driver);
    }
    let field = FieldName::new(DELIVERY_SIGNAL_FIELD).map_err(|_| NodeRunnerError::Driver)?;
    let label = EnumLabel::new(outcome).map_err(|_| NodeRunnerError::Driver)?;
    Ok(WorkerOutcome::Verifier {
        output: delivery_result(mode, outcome, review),
        signals: BTreeMap::from([(field, label)]),
        diagnostic: json!({"message":diagnostic}),
        artifacts: Vec::new(),
    })
}

fn valid_mode_outcome(mode: DeliveryMode, outcome: &str) -> bool {
    match mode {
        DeliveryMode::PullRequest => outcome == DELIVERY_OPENED_LABEL,
        DeliveryMode::Merge => matches!(
            outcome,
            DELIVERY_MERGED_LABEL | DELIVERY_CONFLICT_LABEL | DELIVERY_CI_FAILED_LABEL
        ),
    }
}

fn delivery_result(mode: DeliveryMode, outcome: &str, review: &GitHubReviewReceipt) -> Value {
    Value::Object(Map::from_iter([
        (
            DELIVERY_VERSION_FIELD.to_owned(),
            Value::String(DELIVERY_RESULT_VERSION.to_owned()),
        ),
        (
            DELIVERY_MODE_FIELD.to_owned(),
            Value::String(mode.label().to_owned()),
        ),
        (
            DELIVERY_OUTCOME_FIELD.to_owned(),
            Value::String(outcome.to_owned()),
        ),
        (
            DELIVERY_REPOSITORY_FIELD.to_owned(),
            Value::String(review.repository.clone()),
        ),
        (
            DELIVERY_TARGET_BRANCH_FIELD.to_owned(),
            Value::String(review.target_branch.clone()),
        ),
        (
            DELIVERY_HEAD_REVISION_FIELD.to_owned(),
            Value::String(review.head_revision.clone()),
        ),
        (
            DELIVERY_PULL_REQUEST_ID_FIELD.to_owned(),
            Value::String(review.review_id.clone()),
        ),
    ]))
}

fn valid_review(request: &GitHubReviewRequest, review: &GitHubReviewReceipt) -> bool {
    valid_review_id(&review.review_id)
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
    let suffix = digest
        .get(..10)
        .unwrap_or(digest.as_slice())
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

fn emit(control: &DriverControl, message: &str) -> Result<(), NodeRunnerError> {
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
    value.len() == 40 && value.bytes().all(is_lowercase_hex_digit)
}

fn valid_review_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_REVIEW_ID_BYTES
        && value.bytes().all(|byte| byte.is_ascii_digit())
}

fn is_lowercase_hex_digit(byte: u8) -> bool {
    byte.is_ascii_digit() || matches!(byte, b'a'..=b'f')
}
