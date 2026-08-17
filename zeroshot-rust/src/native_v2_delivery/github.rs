use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

use async_trait::async_trait;
use serde::Deserialize;
use serde_json::Value;
use tokio::io::AsyncReadExt;
use tokio::process::Command;
use tokio::time::timeout;

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

#[derive(Deserialize)]
struct PullRequestWire {
    number: u64,
    state: String,
    merged: Option<bool>,
    merge_commit_sha: Option<String>,
    base: ReviewBranchWire,
    head: ReviewBranchWire,
}

#[derive(Deserialize)]
struct ReviewBranchWire {
    #[serde(rename = "ref")]
    branch: String,
    sha: String,
    repo: ReviewRepositoryWire,
}

#[derive(Deserialize)]
struct ReviewRepositoryWire {
    full_name: String,
}

#[derive(Deserialize)]
struct MergeWire {
    merged: bool,
    sha: String,
}

#[derive(Deserialize)]
struct CheckRunsWire {
    total_count: u64,
    check_runs: Vec<CheckRunWire>,
}

#[derive(Deserialize)]
struct CheckRunWire {
    status: String,
    conclusion: Option<String>,
}

#[derive(Deserialize)]
struct CombinedStatusWire {
    state: String,
    statuses: Vec<Value>,
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum CheckComponent {
    Absent,
    Pending,
    Passed,
    Failed,
}

fn review_receipt(
    wire: PullRequestWire,
    request: &GitHubReviewRequest,
) -> Result<GitHubReviewReceipt, GitHubAuthorityError> {
    let review_id = wire.number.to_string();
    let receipt = GitHubReviewReceipt {
        review_id,
        repository: wire.base.repo.full_name,
        target_branch: wire.base.branch,
        head_branch: wire.head.branch,
        head_revision: wire.head.sha,
    };
    if receipt.repository == request.target.repository
        && receipt.target_branch == request.target.target_branch
        && receipt.head_branch == request.head_branch
        && receipt.head_revision == request.head_revision
        && wire.head.repo.full_name == request.target.repository
    {
        Ok(receipt)
    } else {
        Err(GitHubAuthorityError::Rejected)
    }
}

fn require_review_identity(
    wire: &PullRequestWire,
    review: &GitHubReviewReceipt,
) -> Result<(), GitHubAuthorityError> {
    let valid = wire.number.to_string() == review.review_id
        && wire.base.repo.full_name == review.repository
        && wire.base.branch == review.target_branch
        && wire.head.repo.full_name == review.repository
        && wire.head.branch == review.head_branch
        && wire.head.sha == review.head_revision;
    valid.then_some(()).ok_or(GitHubAuthorityError::Rejected)
}

fn classify_checks(
    check_runs: Value,
    statuses: Value,
) -> Result<GitHubChecks, GitHubAuthorityError> {
    let check_runs: CheckRunsWire =
        serde_json::from_value(check_runs).map_err(|_| GitHubAuthorityError::Rejected)?;
    if check_runs.total_count != check_runs.check_runs.len() as u64 {
        return Err(GitHubAuthorityError::Rejected);
    }
    let statuses: CombinedStatusWire =
        serde_json::from_value(statuses).map_err(|_| GitHubAuthorityError::Rejected)?;
    let check_runs = classify_check_runs(&check_runs.check_runs)?;
    let statuses = classify_statuses(&statuses)?;
    Ok(combine_checks(check_runs, statuses))
}

fn classify_check_runs(runs: &[CheckRunWire]) -> Result<CheckComponent, GitHubAuthorityError> {
    let mut component = CheckComponent::Absent;
    for run in runs {
        if run.status != "completed" || run.conclusion.is_none() {
            component = CheckComponent::Pending;
            continue;
        }
        let conclusion = run.conclusion.as_deref().unwrap_or_default();
        if matches!(conclusion, "success" | "neutral" | "skipped") {
            if component == CheckComponent::Absent {
                component = CheckComponent::Passed;
            }
        } else if matches!(
            conclusion,
            "failure" | "cancelled" | "timed_out" | "action_required" | "stale"
        ) {
            return Ok(CheckComponent::Failed);
        } else {
            return Err(GitHubAuthorityError::Rejected);
        }
    }
    Ok(component)
}

fn classify_statuses(
    statuses: &CombinedStatusWire,
) -> Result<CheckComponent, GitHubAuthorityError> {
    if statuses.statuses.is_empty() {
        return Ok(CheckComponent::Absent);
    }
    match statuses.state.as_str() {
        "success" => Ok(CheckComponent::Passed),
        "pending" => Ok(CheckComponent::Pending),
        "failure" | "error" => Ok(CheckComponent::Failed),
        _ => Err(GitHubAuthorityError::Rejected),
    }
}

fn combine_checks(left: CheckComponent, right: CheckComponent) -> GitHubChecks {
    if left == CheckComponent::Failed || right == CheckComponent::Failed {
        GitHubChecks::Failed
    } else if left == CheckComponent::Pending || right == CheckComponent::Pending {
        GitHubChecks::Pending
    } else if left == CheckComponent::Passed || right == CheckComponent::Passed {
        GitHubChecks::Passed
    } else {
        GitHubChecks::NotRequired
    }
}

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

fn encode_basic_credential(token: &str) -> String {
    encode_base64(format!("x-access-token:{token}").as_bytes())
}

fn encode_base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut output = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let first = chunk[0];
        let second = chunk.get(1).copied().unwrap_or(0);
        let third = chunk.get(2).copied().unwrap_or(0);
        output.push(char::from(ALPHABET[(first >> 2) as usize]));
        output.push(char::from(
            ALPHABET[(((first & 0x03) << 4) | (second >> 4)) as usize],
        ));
        output.push(if chunk.len() > 1 {
            char::from(ALPHABET[(((second & 0x0f) << 2) | (third >> 6)) as usize])
        } else {
            '='
        });
        output.push(if chunk.len() > 2 {
            char::from(ALPHABET[(third & 0x3f) as usize])
        } else {
            '='
        });
    }
    output
}

#[cfg(test)]
mod unit {
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
            .unwrap(),
            GitHubChecks::NotRequired
        );
        assert_eq!(
            classify_checks(
                json!({"total_count":1,"check_runs":[{"status":"completed","conclusion":"failure"}]}),
                json!({"state":"success","statuses":[]})
            )
            .unwrap(),
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
            .unwrap(),
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
        .unwrap();
        assert!(review_receipt(changed, &request).is_err());
    }
}
