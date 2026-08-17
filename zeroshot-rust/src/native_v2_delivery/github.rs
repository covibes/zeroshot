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
    GitHubPushRequest, GitHubReviewObservation, GitHubReviewReceipt, GitHubReviewRequest,
    GitHubReviewState, valid_revision,
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
    pub api_deadline: Duration,
    pub push_deadline: Duration,
}

impl GhCliAuthorityConfig {
    #[must_use]
    pub fn hosted() -> Self {
        Self {
            git_program: PathBuf::from("/usr/bin/git"),
            gh_program: PathBuf::from("/usr/bin/gh"),
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
        let mut command = clean_command(&self.config.gh_program, credential);
        command.arg("api").args(arguments).stdout(Stdio::piped());
        let output = bounded_output(command, self.config.api_deadline).await?;
        serde_json::from_slice(&output).map_err(|_| GitHubAuthorityError::Rejected)
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
                    "state=open".to_owned(),
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
                    format!("body={PULL_REQUEST_BODY}"),
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
        classify_checks(check_runs, statuses)
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
}

#[async_trait]
impl GitHubDeliveryAuthority for GhCliDeliveryAuthority {
    async fn push_branch(
        &self,
        request: &GitHubPushRequest,
        credential: GitHubCredential<'_>,
    ) -> Result<(), GitHubAuthorityError> {
        let mut command = clean_command(&self.config.git_program, credential);
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
        match self.find_review(request, credential).await? {
            Some(review) => Ok(review),
            None => self.create_review(request, credential).await,
        }
    }

    async fn inspect_review(
        &self,
        review: &GitHubReviewReceipt,
        credential: GitHubCredential<'_>,
    ) -> Result<GitHubReviewObservation, GitHubAuthorityError> {
        let wire = self.pull_request(review, credential).await?;
        require_review_identity(&wire, review)?;
        let state = if wire.merged == Some(true) {
            let merge_revision = wire
                .merge_commit_sha
                .filter(|revision| valid_revision(revision))
                .ok_or(GitHubAuthorityError::Rejected)?;
            if wire.state != "closed" {
                return Err(GitHubAuthorityError::Rejected);
            }
            GitHubReviewState::Merged { merge_revision }
        } else if wire.state == "closed" {
            GitHubReviewState::Closed
        } else if wire.state == "open" {
            GitHubReviewState::Open {
                checks: self.checks(review, credential).await?,
            }
        } else {
            return Err(GitHubAuthorityError::Rejected);
        };
        Ok(review.observation(state))
    }

    async fn request_merge(
        &self,
        review: &GitHubReviewReceipt,
        credential: GitHubCredential<'_>,
    ) -> Result<(), GitHubAuthorityError> {
        let value = self
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
            .await?;
        let response: MergeWire =
            serde_json::from_value(value).map_err(|_| GitHubAuthorityError::Rejected)?;
        if response.merged && valid_revision(&response.sha) {
            Ok(())
        } else {
            Err(GitHubAuthorityError::Rejected)
        }
    }
}

mod wire;
use wire::{MergeWire, PullRequestWire, classify_checks, require_review_identity, review_receipt};

fn clean_command(program: &PathBuf, credential: GitHubCredential<'_>) -> Command {
    let mut command = Command::new(program);
    command
        .kill_on_drop(true)
        .env_clear()
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
mod unit {
    use openengine_cluster_testkit::assertions::AssertValue;
    use super::*;
    use crate::native_v2_delivery::DeliveryTarget;
    use serde_json::json;

    #[test]
    fn basic_credential_encoding_is_canonical() {
        assert_eq!(
            encode_basic_credential("token"),
            "eC1hY2Nlc3MtdG9rZW46dG9rZW4="
        );
    }

    #[test]
    fn check_evidence_is_closed_and_complete() {
        assert_eq!(
            classify_checks(
                json!({"total_count":0,"check_runs":[]}),
                json!({"state":"pending","statuses":[]})
            )
            .assert_value(),
            GitHubChecks::NotRequired
        );
        assert_eq!(
            classify_checks(
                json!({"total_count":1,"check_runs":[{"status":"completed","conclusion":"failure"}]}),
                json!({"state":"success","statuses":[]})
            )
            .assert_value(),
            GitHubChecks::Failed
        );
        assert!(
            classify_checks(
                json!({"total_count":101,"check_runs":[]}),
                json!({"state":"success","statuses":[]})
            )
            .is_err()
        );
    }

    #[test]
    fn receipt_rejects_changed_authority() {
        let request = GitHubReviewRequest {
            target: DeliveryTarget::new(
                "acme/project",
                "main",
                "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            )
            .assert_value(),
            head_branch: "zeroshot/v2-run".to_owned(),
            head_revision: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb".to_owned(),
        };
        let changed: PullRequestWire = serde_json::from_value(json!({
            "number":17,"state":"open","merged":false,"merge_commit_sha":null,
            "base":{
                "ref":"other","sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                "repo":{"full_name":"acme/project"}
            },
            "head":{
                "ref":"zeroshot/v2-run","sha":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                "repo":{"full_name":"acme/project"}
            }
        }))
        .assert_value();
        assert!(review_receipt(changed, &request).is_err());
    }
}
