//! Native-v2's graph-visible Git delivery node.
//!
//! Delivery is a trusted built-in verifier: it commits the shared workspace, asks the selected
//! target's GitHub authority to push and open/update one run-stable review, and returns a signal
//! that authored graph control flow can route. A merge request is never treated as success; only a
//! later authoritative observation of the exact review and head revision can produce `merged`.

mod adapter;
mod git;
pub(crate) mod git_auth;
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
    ) -> Result<(), GitHubAuthorityError>;
}

pub use adapter::NativeV2DeliveryAdapter;

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
    let field = FieldName::new(DELIVERY_SIGNAL_FIELD).map_err(|_| NodeRunnerError::Driver)?;
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
    value.len() == 40 && value.bytes().all(is_lowercase_hex_digit)
}

fn is_lowercase_hex_digit(byte: u8) -> bool {
    byte.is_ascii_digit() || matches!(byte, b'a'..=b'f')
}
