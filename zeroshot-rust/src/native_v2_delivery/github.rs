use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

use async_trait::async_trait;
use serde_json::Value;
use tokio::io::AsyncReadExt;
use tokio::process::Command;
use tokio::time::timeout;

use crate::native_v2_delivery::git_auth::encode_basic_credential;

use super::{
    GitHubAuthorityError, GitHubChecks, GitHubCredential, GitHubDeliveryAuthority,
    GitHubHeadUpdateOutcome, GitHubMergeRequestOutcome, GitHubPushRequest, GitHubReviewObservation,
    GitHubReviewReceipt, GitHubReviewRequest, GitHubReviewState, valid_head_update, valid_revision,
};

// A GitHub page may contain 100 checks or comments, including bounded user/check
// output fields. Keep subprocess output bounded while allowing many pages.
const MAX_API_OUTPUT_BYTES: usize = 16 * 1024 * 1024;
const MAX_CHECK_LOG_TAIL_BYTES: usize = 64 * 1024;
const DEFAULT_API_DEADLINE: Duration = Duration::from_secs(2 * 60);
const DEFAULT_PUSH_DEADLINE: Duration = Duration::from_secs(10 * 60);
const PULL_REQUEST_TITLE: &str = "feat: complete Zeroshot task";
const PULL_REQUEST_BODY: &str = "Created by Zeroshot v2.";

#[derive(Clone, Debug)]
pub struct GhCliAuthorityConfig {
    pub git_program: PathBuf,
    pub gh_program: PathBuf,
    pub home_directory: PathBuf,
    pub api_deadline: Duration,
    pub push_deadline: Duration,
}

impl GhCliAuthorityConfig {
    #[must_use]
    pub fn hosted(home_directory: PathBuf) -> Self {
        Self {
            git_program: PathBuf::from("/usr/bin/git"),
            gh_program: PathBuf::from("/usr/bin/gh"),
            home_directory,
            api_deadline: DEFAULT_API_DEADLINE,
            push_deadline: DEFAULT_PUSH_DEADLINE,
        }
    }
}

#[derive(Clone, Debug)]
pub struct GhCliDeliveryAuthority {
    config: GhCliAuthorityConfig,
}

impl GhCliDeliveryAuthority {
    #[must_use]
    pub fn new(config: GhCliAuthorityConfig) -> Self {
        Self { config }
    }

    async fn api(
        &self,
        arguments: &[String],
        credential: GitHubCredential<'_>,
    ) -> Result<Value, GitHubAuthorityError> {
        let output = self.api_output(arguments, credential).await?;
        serde_json::from_slice(&output).map_err(|_| GitHubAuthorityError::Rejected)
    }

    async fn api_output(
        &self,
        arguments: &[String],
        credential: GitHubCredential<'_>,
    ) -> Result<Vec<u8>, GitHubAuthorityError> {
        let mut command = clean_command(&self.config, &self.config.gh_program, credential);
        command.arg("api").args(arguments).stdout(Stdio::piped());
        bounded_output(command, self.config.api_deadline).await
    }

    async fn find_review(
        &self,
        request: &GitHubReviewRequest,
        credential: GitHubCredential<'_>,
    ) -> Result<Option<GitHubReviewReceipt>, GitHubAuthorityError> {
        let owner = request
            .target
            .repository
            .split_once('/')
            .map(|(owner, _)| owner)
            .ok_or(GitHubAuthorityError::Rejected)?;
        let value = self
            .api(
                &[
                    format!("repos/{}/pulls", request.target.repository),
                    "--method".to_owned(),
                    "GET".to_owned(),
                    "-f".to_owned(),
                    "state=all".to_owned(),
                    "-f".to_owned(),
                    format!("head={owner}:{}", request.head_branch),
                    "-f".to_owned(),
                    format!("base={}", request.target.target_branch),
                ],
                credential,
            )
            .await?;
        let reviews: Vec<PullRequestWire> =
            serde_json::from_value(value).map_err(|_| GitHubAuthorityError::Rejected)?;
        let mut exact = reviews
            .into_iter()
            .map(|review| review_receipt(review, request))
            .collect::<Result<Vec<_>, _>>()?;
        if exact.len() > 1 {
            return Err(GitHubAuthorityError::Rejected);
        }
        Ok(exact.pop())
    }

    async fn create_review(
        &self,
        request: &GitHubReviewRequest,
        credential: GitHubCredential<'_>,
    ) -> Result<GitHubReviewReceipt, GitHubAuthorityError> {
        let value = self
            .api(
                &[
                    format!("repos/{}/pulls", request.target.repository),
                    "--method".to_owned(),
                    "POST".to_owned(),
                    "-f".to_owned(),
                    format!("title={PULL_REQUEST_TITLE}"),
                    "-f".to_owned(),
                    format!("body={}", pull_request_body(request)),
                    "-f".to_owned(),
                    format!("head={}", request.head_branch),
                    "-f".to_owned(),
                    format!("base={}", request.target.target_branch),
                ],
                credential,
            )
            .await?;
        let review = serde_json::from_value(value).map_err(|_| GitHubAuthorityError::Rejected)?;
        review_receipt(review, request)
    }

    async fn policy_snapshot(
        &self,
        review: &GitHubReviewReceipt,
        credential: GitHubCredential<'_>,
    ) -> Result<PolicySnapshot, GitHubAuthorityError> {
        let value = self.api(&query_arguments(review)?, credential).await?;
        classify_policy(value, review)
    }

    async fn policy_snapshot_with_logs(
        &self,
        review: &GitHubReviewReceipt,
        credential: GitHubCredential<'_>,
    ) -> Result<PolicySnapshot, GitHubAuthorityError> {
        let mut snapshot = self.policy_snapshot(review, credential).await?;
        let mut logs = Vec::new();
        for job in &snapshot.failed_job_ids {
            let output = self
                .api_output(
                    &[
                        format!("repos/{}/actions/jobs/{job}/logs", review.repository),
                        "--method".to_owned(),
                        "GET".to_owned(),
                    ],
                    credential,
                )
                .await;
            if let Ok(output) = output {
                logs.push(check_log_tail(&output));
            }
        }
        include_check_logs(&mut snapshot, &logs);
        Ok(snapshot)
    }

    async fn pull_request(
        &self,
        review: &GitHubReviewReceipt,
        credential: GitHubCredential<'_>,
    ) -> Result<PullRequestWire, GitHubAuthorityError> {
        let value = self
            .api(
                &[
                    format!("repos/{}/pulls/{}", review.repository, review.review_id),
                    "--method".to_owned(),
                    "GET".to_owned(),
                ],
                credential,
            )
            .await?;
        serde_json::from_value(value).map_err(|_| GitHubAuthorityError::Rejected)
    }

    async fn classify_rejected_merge(
        &self,
        review: &GitHubReviewReceipt,
        credential: GitHubCredential<'_>,
    ) -> Result<GitHubMergeRequestOutcome, GitHubAuthorityError> {
        let snapshot = self.policy_snapshot(review, credential).await?;
        match snapshot.state {
            GitHubReviewState::Merged { .. } => Ok(GitHubMergeRequestOutcome::Accepted),
            GitHubReviewState::Conflict => Ok(GitHubMergeRequestOutcome::Conflict),
            GitHubReviewState::Open { .. } if snapshot.head_update.is_some() => {
                Ok(GitHubMergeRequestOutcome::HeadUpdateRequired)
            }
            GitHubReviewState::Open { .. } => Ok(GitHubMergeRequestOutcome::Pending),
            GitHubReviewState::Closed => Err(GitHubAuthorityError::Rejected),
        }
    }
}

#[async_trait]
impl GitHubDeliveryAuthority for GhCliDeliveryAuthority {
    async fn push_branch(
        &self,
        request: &GitHubPushRequest,
        credential: GitHubCredential<'_>,
    ) -> Result<(), GitHubAuthorityError> {
        let mut command = authenticated_git_command(&self.config, &request.workspace, credential);
        command
            .arg("push")
            .arg("--porcelain")
            .arg("--no-verify")
            .arg(format!(
                "https://github.com/{}.git",
                request.target.repository
            ))
            .arg(format!("HEAD:refs/heads/{}", request.head_branch));
        bounded_status(command, self.config.push_deadline).await
    }

    async fn open_or_update_review(
        &self,
        request: &GitHubReviewRequest,
        credential: GitHubCredential<'_>,
    ) -> Result<GitHubReviewReceipt, GitHubAuthorityError> {
        let review = match self.find_review(request, credential).await? {
            Some(review) => Ok(review),
            None => self.create_review(request, credential).await,
        }?;
        connect_source_issue(self, request, &review, credential).await?;
        Ok(review)
    }

    async fn inspect_review(
        &self,
        review: &GitHubReviewReceipt,
        credential: GitHubCredential<'_>,
    ) -> Result<GitHubReviewObservation, GitHubAuthorityError> {
        let snapshot = self.policy_snapshot_with_logs(review, credential).await?;
        Ok(review.observation(snapshot.state))
    }

    async fn request_merge(
        &self,
        review: &GitHubReviewReceipt,
        credential: GitHubCredential<'_>,
    ) -> Result<GitHubMergeRequestOutcome, GitHubAuthorityError> {
        let snapshot = self.policy_snapshot(review, credential).await?;
        let merge_method = match merge_action(snapshot)? {
            MergeAction::Complete(outcome) => return Ok(outcome),
            MergeAction::Submit(method) => method,
        };
        let mut command = clean_command(&self.config, &self.config.gh_program, credential);
        command.args([
            "pr",
            "merge",
            &review.review_id,
            "--repo",
            &review.repository,
            "--match-head-commit",
            &review.head_revision,
        ]);
        if let Some(argument) = merge_method_argument(merge_method) {
            command.arg(argument);
        }
        match bounded_status(command, self.config.api_deadline).await {
            Ok(()) => Ok(GitHubMergeRequestOutcome::Accepted),
            Err(GitHubAuthorityError::Rejected) => {
                self.classify_rejected_merge(review, credential).await
            }
            Err(error) => Err(error),
        }
    }

    async fn update_review_head(
        &self,
        workspace: &std::path::Path,
        review: &GitHubReviewReceipt,
        credential: GitHubCredential<'_>,
    ) -> Result<GitHubHeadUpdateOutcome, GitHubAuthorityError> {
        let snapshot = self.policy_snapshot(review, credential).await?;
        match snapshot.state {
            GitHubReviewState::Conflict => Ok(GitHubHeadUpdateOutcome::Conflict),
            GitHubReviewState::Open { .. } => match snapshot.head_update {
                Some(update) => head::update_review_head(
                    self,
                    head::HeadUpdateRequest {
                        workspace,
                        review,
                        pull_request_id: &update.0,
                    },
                    credential,
                )
                .await
                .map(GitHubHeadUpdateOutcome::Updated),
                None => Ok(GitHubHeadUpdateOutcome::Pending),
            },
            GitHubReviewState::Merged { .. } => Ok(GitHubHeadUpdateOutcome::Pending),
            GitHubReviewState::Closed => Err(GitHubAuthorityError::Rejected),
        }
    }
}

enum MergeAction {
    Complete(GitHubMergeRequestOutcome),
    Submit(policy::MergeMethod),
}

fn merge_action(snapshot: PolicySnapshot) -> Result<MergeAction, GitHubAuthorityError> {
    match snapshot.state {
        GitHubReviewState::Merged { .. } => {
            Ok(MergeAction::Complete(GitHubMergeRequestOutcome::Accepted))
        }
        GitHubReviewState::Conflict => {
            Ok(MergeAction::Complete(GitHubMergeRequestOutcome::Conflict))
        }
        GitHubReviewState::Open {
            checks:
                crate::native_v2_delivery::GitHubChecks::NotRequired
                | crate::native_v2_delivery::GitHubChecks::Passed,
        } => snapshot
            .merge_method
            .map(MergeAction::Submit)
            .ok_or(GitHubAuthorityError::Rejected),
        GitHubReviewState::Open { .. } => {
            Ok(MergeAction::Complete(GitHubMergeRequestOutcome::Pending))
        }
        GitHubReviewState::Closed => Err(GitHubAuthorityError::Rejected),
    }
}

const fn merge_method_argument(method: policy::MergeMethod) -> Option<&'static str> {
    match method {
        policy::MergeMethod::Queue => None,
        policy::MergeMethod::Merge => Some("--merge"),
        policy::MergeMethod::Squash => Some("--squash"),
        policy::MergeMethod::Rebase => Some("--rebase"),
    }
}

mod head;
mod policy;
mod source_issue;
mod wire;
use policy::{PolicySnapshot, classify_policy, include_check_logs, query_arguments};
use source_issue::{connect_source_issue, pull_request_body};
use wire::{PullRequestWire, review_receipt};

fn clean_command(
    config: &GhCliAuthorityConfig,
    program: &PathBuf,
    credential: GitHubCredential<'_>,
) -> Command {
    let mut command = Command::new(program);
    command
        .kill_on_drop(true)
        .env_clear()
        .env("HOME", &config.home_directory)
        .env("LANG", "C")
        .env("GH_HOST", "github.com")
        .env("GH_TOKEN", credential.expose())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    command
}

fn git_command(
    config: &GhCliAuthorityConfig,
    workspace: &std::path::Path,
    credential: GitHubCredential<'_>,
) -> Command {
    let mut command = clean_command(config, &config.git_program, credential);
    command
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_TERMINAL_PROMPT", "0")
        .arg("-c")
        .arg("core.hooksPath=/dev/null")
        .arg("-c")
        .arg(format!("safe.directory={}", workspace.display()))
        .arg("-C")
        .arg(workspace);
    command
}

fn authenticated_git_command(
    config: &GhCliAuthorityConfig,
    workspace: &std::path::Path,
    credential: GitHubCredential<'_>,
) -> Command {
    let mut command = git_command(config, workspace, credential);
    let authorization = format!(
        "AUTHORIZATION: basic {}",
        encode_basic_credential(credential.expose())
    );
    command
        .env("GIT_CONFIG_COUNT", "2")
        .env("GIT_CONFIG_KEY_0", "credential.helper")
        .env("GIT_CONFIG_VALUE_0", "")
        .env("GIT_CONFIG_KEY_1", "http.https://github.com/.extraheader")
        .env("GIT_CONFIG_VALUE_1", authorization);
    command
}

async fn bounded_status(
    mut command: Command,
    deadline: Duration,
) -> Result<(), GitHubAuthorityError> {
    let status = timeout(deadline, command.status())
        .await
        .map_err(|_| GitHubAuthorityError::Unavailable)?
        .map_err(|_| GitHubAuthorityError::Unavailable)?;
    status
        .success()
        .then_some(())
        .ok_or(GitHubAuthorityError::Rejected)
}

async fn bounded_output(
    mut command: Command,
    deadline: Duration,
) -> Result<Vec<u8>, GitHubAuthorityError> {
    command.stdout(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|_| GitHubAuthorityError::Unavailable)?;
    let stdout = child
        .stdout
        .take()
        .ok_or(GitHubAuthorityError::Unavailable)?;
    let mut output = Vec::new();
    let mut bounded = stdout.take((MAX_API_OUTPUT_BYTES + 1) as u64);
    let (status, ()) = timeout(deadline, async {
        tokio::try_join!(child.wait(), async {
            bounded.read_to_end(&mut output).await?;
            Ok::<(), std::io::Error>(())
        })
    })
    .await
    .map_err(|_| GitHubAuthorityError::Unavailable)?
    .map_err(|_| GitHubAuthorityError::Unavailable)?;
    if !status.success() {
        return Err(GitHubAuthorityError::Rejected);
    }
    validate_api_output(output)
}

fn validate_api_output(output: Vec<u8>) -> Result<Vec<u8>, GitHubAuthorityError> {
    if output.is_empty() || output.len() > MAX_API_OUTPUT_BYTES {
        return Err(GitHubAuthorityError::Rejected);
    }
    Ok(output)
}

fn check_log_tail(output: &[u8]) -> String {
    let start = output.len().saturating_sub(MAX_CHECK_LOG_TAIL_BYTES);
    String::from_utf8_lossy(output.get(start..).unwrap_or_default()).into_owned()
}

#[cfg(test)]
#[path = "github/tests.rs"]
mod unit;
