use super::*;

#[derive(Deserialize)]
pub(super) struct PullRequestWire {
    number: u64,
    pub(super) state: String,
    pub(super) merged: Option<bool>,
    pub(super) merge_commit_sha: Option<String>,
    base: ReviewBranchWire,
    head: ReviewBranchWire,
}

#[derive(Deserialize)]
struct ReviewBranchWire {
    #[serde(rename = "ref")]
    branch: String,
    pub(super) sha: String,
    repo: ReviewRepositoryWire,
}

#[derive(Deserialize)]
struct ReviewRepositoryWire {
    full_name: String,
}

#[derive(Deserialize)]
pub(super) struct MergeWire {
    pub(super) merged: bool,
    pub(super) sha: String,
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

pub(super) fn review_receipt(
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

pub(super) fn require_review_identity(
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

pub(super) fn classify_checks(
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
