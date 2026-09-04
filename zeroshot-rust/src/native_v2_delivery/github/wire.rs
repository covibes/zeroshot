use super::*;

#[derive(Deserialize)]
pub(super) struct PullRequestWire {
    number: u64,
    pub(super) body: Option<String>,
    pub(super) state: String,
    pub(super) merged: Option<bool>,
    pub(super) merge_commit_sha: Option<String>,
    pub(super) mergeable: Option<bool>,
    base: ReviewBranchWire,
    head: ReviewBranchWire,
}

#[derive(Deserialize)]
pub(super) struct IssueCommentWire {
    pub(super) body: Option<String>,
}

#[derive(Deserialize)]
pub(super) struct IssueWire {
    pub(super) comments: u64,
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

struct CheckRunsSnapshot {
    check_runs: Vec<CheckRunWire>,
    complete: bool,
}

#[derive(Deserialize)]
struct CheckRunWire {
    id: Option<u64>,
    name: String,
    status: String,
    conclusion: Option<String>,
    details_url: Option<String>,
}

#[derive(Deserialize)]
struct CombinedStatusWire {
    state: String,
    statuses: Vec<CommitStatusWire>,
}

#[derive(Deserialize)]
struct CommitStatusWire {
    state: String,
    context: String,
    description: Option<String>,
    target_url: Option<String>,
}

#[derive(Clone, Eq, PartialEq)]
enum CheckComponent {
    Absent,
    Pending,
    Passed,
    Failed(Vec<String>),
}

const MAX_FAILURE_ITEM_CHARS: usize = 1_024;
const MAX_FAILURE_DIAGNOSTIC_CHARS: usize = 8 * 1_024;
const MAX_FAILED_CHECK_LOGS: usize = 2;
const MAX_CHECK_LOG_CHARS: usize = 7 * 1_024;

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
    let check_runs = decode_check_runs(check_runs)?;
    let statuses: CombinedStatusWire =
        serde_json::from_value(statuses).map_err(|_| GitHubAuthorityError::Rejected)?;
    let mut check_runs_component = classify_check_runs(&check_runs.check_runs)?;
    if !check_runs.complete && !matches!(check_runs_component, CheckComponent::Failed(_)) {
        check_runs_component = CheckComponent::Pending;
    }
    let statuses = classify_statuses(&statuses)?;
    Ok(combine_checks(check_runs_component, statuses))
}

pub(super) fn failed_check_job_ids(check_runs: &Value) -> Result<Vec<u64>, GitHubAuthorityError> {
    Ok(decode_check_runs(check_runs.clone())?
        .check_runs
        .into_iter()
        .filter(|run| {
            run.status == "completed"
                && matches!(
                    run.conclusion.as_deref(),
                    Some(
                        "failure"
                            | "cancelled"
                            | "timed_out"
                            | "action_required"
                            | "stale"
                            | "startup_failure"
                    )
                )
        })
        .filter_map(|run| run.id)
        .take(MAX_FAILED_CHECK_LOGS)
        .collect())
}

pub(super) fn include_check_logs(checks: GitHubChecks, logs: &[String]) -> GitHubChecks {
    let GitHubChecks::Failed { diagnostic } = checks else {
        return checks;
    };
    if logs.is_empty() {
        return GitHubChecks::Failed { diagnostic };
    }
    let logs = logs
        .iter()
        .map(|log| log_tail(log))
        .collect::<Vec<_>>()
        .join("\n---\n");
    GitHubChecks::Failed {
        diagnostic: bounded_text(
            &format!("{diagnostic}\nFailed check log tail:\n{logs}"),
            MAX_FAILURE_DIAGNOSTIC_CHARS,
        ),
    }
}

fn decode_check_runs(check_runs: Value) -> Result<CheckRunsSnapshot, GitHubAuthorityError> {
    if !check_runs.is_array() {
        let wire: CheckRunsWire =
            serde_json::from_value(check_runs).map_err(|_| GitHubAuthorityError::Rejected)?;
        if wire.total_count != wire.check_runs.len() as u64 {
            return Err(GitHubAuthorityError::Rejected);
        }
        return Ok(CheckRunsSnapshot {
            check_runs: wire.check_runs,
            complete: true,
        });
    }
    let pages = serde_json::from_value::<Vec<CheckRunsWire>>(check_runs)
        .map_err(|_| GitHubAuthorityError::Rejected)?;
    let total_count = pages
        .first()
        .map(|page| page.total_count)
        .ok_or(GitHubAuthorityError::Rejected)?;
    let counts_match = pages.iter().all(|page| page.total_count == total_count);
    let mut runs = Vec::new();
    for page in pages {
        runs.extend(page.check_runs);
    }
    let complete = counts_match && total_count == runs.len() as u64;
    Ok(CheckRunsSnapshot {
        check_runs: runs,
        complete,
    })
}

fn classify_check_runs(runs: &[CheckRunWire]) -> Result<CheckComponent, GitHubAuthorityError> {
    let mut component = CheckComponent::Absent;
    let mut failures = Vec::new();
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
            "failure" | "cancelled" | "timed_out" | "action_required" | "stale" | "startup_failure"
        ) {
            failures.push(failure_item(
                &run.name,
                conclusion,
                None,
                run.details_url.as_deref(),
            ));
        } else {
            return Err(GitHubAuthorityError::Rejected);
        }
    }
    if failures.is_empty() {
        Ok(component)
    } else {
        Ok(CheckComponent::Failed(failures))
    }
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
        "failure" | "error" => {
            let mut failures = statuses
                .statuses
                .iter()
                .filter(|status| matches!(status.state.as_str(), "failure" | "error"))
                .map(|status| {
                    failure_item(
                        &status.context,
                        &status.state,
                        status.description.as_deref(),
                        status.target_url.as_deref(),
                    )
                })
                .collect::<Vec<_>>();
            if failures.is_empty() {
                failures.push("commit status checks failed".to_owned());
            }
            Ok(CheckComponent::Failed(failures))
        }
        _ => Err(GitHubAuthorityError::Rejected),
    }
}

fn combine_checks(left: CheckComponent, right: CheckComponent) -> GitHubChecks {
    match (left, right) {
        (CheckComponent::Failed(mut left), CheckComponent::Failed(right)) => {
            left.extend(right);
            failed_checks(left)
        }
        (CheckComponent::Failed(failures), _) | (_, CheckComponent::Failed(failures)) => {
            failed_checks(failures)
        }
        (CheckComponent::Pending, _) | (_, CheckComponent::Pending) => GitHubChecks::Pending,
        (CheckComponent::Passed, _) | (_, CheckComponent::Passed) => GitHubChecks::Passed,
        (CheckComponent::Absent, CheckComponent::Absent) => GitHubChecks::NotRequired,
    }
}

fn failed_checks(failures: Vec<String>) -> GitHubChecks {
    let detail = failures
        .into_iter()
        .map(|failure| format!("- {failure}"))
        .collect::<Vec<_>>()
        .join("\n");
    let diagnostic = bounded_text(
        &format!("Required CI checks failed:\n{detail}"),
        MAX_FAILURE_DIAGNOSTIC_CHARS,
    );
    GitHubChecks::Failed { diagnostic }
}

fn failure_item(
    name: &str,
    conclusion: &str,
    description: Option<&str>,
    url: Option<&str>,
) -> String {
    let mut item = format!("{} concluded {}", one_line(name), one_line(conclusion));
    if let Some(description) = description.filter(|value| !value.trim().is_empty()) {
        item.push_str(": ");
        item.push_str(&one_line(description));
    }
    if let Some(url) = url.filter(|value| !value.trim().is_empty()) {
        item.push_str(" (");
        item.push_str(&one_line(url));
        item.push(')');
    }
    bounded_text(&item, MAX_FAILURE_ITEM_CHARS)
}

fn one_line(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn bounded_text(value: &str, maximum: usize) -> String {
    value.chars().take(maximum).collect()
}

fn log_tail(value: &str) -> String {
    let mut tail = value
        .chars()
        .filter(|character| !character.is_control() || matches!(character, '\n' | '\t'))
        .rev()
        .take(MAX_CHECK_LOG_CHARS)
        .collect::<Vec<_>>();
    tail.reverse();
    tail.into_iter().collect()
}
