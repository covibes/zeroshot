use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

use async_trait::async_trait;
use serde::Deserialize;
use serde_json::Value;
use tokio::io::AsyncReadExt;
use tokio::process::Command;
use tokio::time::timeout;

use crate::native_v2_delivery::git_auth::encode_basic_credential;

use super::{
    GitHubAuthorityError, GitHubChecks, GitHubCredential, GitHubDeliveryAuthority,
    GitHubMergeRequestOutcome, GitHubPushRequest, GitHubReviewObservation, GitHubReviewReceipt,
    GitHubReviewRequest, GitHubReviewState, valid_revision,
};

const MAX_API_OUTPUT_BYTES: usize = 256 * 1024;
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

    async fn checks(
        &self,
        review: &GitHubReviewReceipt,
        credential: GitHubCredential<'_>,
    ) -> Result<GitHubChecks, GitHubAuthorityError> {
        let check_runs = self
            .api(
                &[
                    format!(
                        "repos/{}/commits/{}/check-runs",
                        review.repository, review.head_revision
                    ),
                    "--method".to_owned(),
                    "GET".to_owned(),
                    "-H".to_owned(),
                    "Accept: application/vnd.github+json".to_owned(),
                    "--paginate".to_owned(),
                    "--slurp".to_owned(),
                    "-f".to_owned(),
                    "per_page=100".to_owned(),
                ],
                credential,
            )
            .await?;
        let statuses = self
            .api(
                &[
                    format!(
                        "repos/{}/commits/{}/status",
                        review.repository, review.head_revision
                    ),
                    "--method".to_owned(),
                    "GET".to_owned(),
                ],
                credential,
            )
            .await?;
        let failed_jobs = failed_check_job_ids(&check_runs)?;
        let checks = classify_checks(check_runs, statuses)?;
        let mut logs = Vec::new();
        for job in failed_jobs {
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
                logs.push(String::from_utf8_lossy(&output).into_owned());
            }
        }
        Ok(include_check_logs(checks, &logs))
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
        let wire = self.pull_request(review, credential).await?;
        require_review_identity(&wire, review)?;
        if wire.state != "open" || wire.merged == Some(true) {
            return Err(GitHubAuthorityError::Rejected);
        }
        match wire.mergeable {
            Some(false) => Ok(GitHubMergeRequestOutcome::Conflict),
            Some(true) | None => Ok(GitHubMergeRequestOutcome::Pending),
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
        let mut command = clean_command(&self.config, &self.config.git_program, credential);
        let authorization = format!(
            "AUTHORIZATION: basic {}",
            encode_basic_credential(credential.expose())
        );
        command
            .env("GIT_CONFIG_COUNT", "2")
            .env("GIT_CONFIG_KEY_0", "credential.helper")
            .env("GIT_CONFIG_VALUE_0", "")
            .env("GIT_CONFIG_KEY_1", "http.https://github.com/.extraheader")
            .env("GIT_CONFIG_VALUE_1", authorization)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_TERMINAL_PROMPT", "0")
            .arg("-c")
            .arg("core.hooksPath=/dev/null")
            .arg("-c")
            .arg(format!("safe.directory={}", request.workspace.display()))
            .arg("-C")
            .arg(&request.workspace)
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
        let wire = self.pull_request(review, credential).await?;
        require_review_identity(&wire, review)?;
        let state = match classify_review(&wire)? {
            ReviewClassification::Merged(merge_revision) => {
                GitHubReviewState::Merged { merge_revision }
            }
            ReviewClassification::Closed => GitHubReviewState::Closed,
            ReviewClassification::Conflict => GitHubReviewState::Conflict,
            ReviewClassification::Open => GitHubReviewState::Open {
                checks: self.checks(review, credential).await?,
            },
        };
        Ok(review.observation(state))
    }

    async fn request_merge(
        &self,
        review: &GitHubReviewReceipt,
        credential: GitHubCredential<'_>,
    ) -> Result<GitHubMergeRequestOutcome, GitHubAuthorityError> {
        let response = self
            .api(
                &[
                    format!(
                        "repos/{}/pulls/{}/merge",
                        review.repository, review.review_id
                    ),
                    "--method".to_owned(),
                    "PUT".to_owned(),
                    "-f".to_owned(),
                    format!("sha={}", review.head_revision),
                    "-f".to_owned(),
                    "merge_method=merge".to_owned(),
                    "-f".to_owned(),
                    format!("commit_title={PULL_REQUEST_TITLE}"),
                ],
                credential,
            )
            .await;
        match response {
            Ok(value) => {
                if confirmed_merge(value).is_ok() {
                    Ok(GitHubMergeRequestOutcome::Accepted)
                } else {
                    self.classify_rejected_merge(review, credential).await
                }
            }
            Err(GitHubAuthorityError::Rejected) => {
                self.classify_rejected_merge(review, credential).await
            }
            Err(error) => Err(error),
        }
    }
}

fn confirmed_merge(value: Value) -> Result<(), GitHubAuthorityError> {
    let response: MergeWire =
        serde_json::from_value(value).map_err(|_| GitHubAuthorityError::Rejected)?;
    (response.merged && valid_revision(&response.sha))
        .then_some(())
        .ok_or(GitHubAuthorityError::Rejected)
}

mod source_issue;
mod wire;
use source_issue::{connect_source_issue, pull_request_body};
use wire::{
    MergeWire, PullRequestWire, classify_checks, failed_check_job_ids, include_check_logs,
    require_review_identity, review_receipt,
};

enum ReviewClassification {
    Open,
    Merged(String),
    Conflict,
    Closed,
}

fn classify_review(wire: &PullRequestWire) -> Result<ReviewClassification, GitHubAuthorityError> {
    if wire.merged == Some(true) {
        let merge_revision = wire
            .merge_commit_sha
            .clone()
            .filter(|revision| valid_revision(revision))
            .ok_or(GitHubAuthorityError::Rejected)?;
        return (wire.state == "closed")
            .then_some(ReviewClassification::Merged(merge_revision))
            .ok_or(GitHubAuthorityError::Rejected);
    }
    match (wire.state.as_str(), wire.mergeable) {
        ("closed", _) => Ok(ReviewClassification::Closed),
        ("open", Some(false)) => Ok(ReviewClassification::Conflict),
        ("open", _) => Ok(ReviewClassification::Open),
        _ => Err(GitHubAuthorityError::Rejected),
    }
}

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
    if output.is_empty() || output.len() > MAX_API_OUTPUT_BYTES {
        return Err(GitHubAuthorityError::Rejected);
    }
    Ok(output)
}

#[cfg(test)]
#[path = "github/tests.rs"]
mod unit;
