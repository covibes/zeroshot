use std::collections::BTreeSet;

use serde::Deserialize;
use serde_json::Value;

use super::*;

mod checks;
use checks::{RequiredChecks, classify_required_checks, failure_diagnostic};

const POLICY_QUERY: &str = r#"
query($owner: String!, $name: String!, $number: Int!, $endCursor: String) {
  repository(owner: $owner, name: $name) {
    nameWithOwner
    mergeCommitAllowed
    squashMergeAllowed
    rebaseMergeAllowed
    pullRequest(number: $number) {
      id
      number
      state
      merged
      mergeCommit { oid }
      mergeable
      mergeStateStatus
      isDraft
      isInMergeQueue
      isMergeQueueEnabled
      baseRefName
      headRefName
      headRefOid
      commits(last: 1) {
        nodes {
          commit {
            statusCheckRollup {
              contexts(first: 100, after: $endCursor) {
                pageInfo { hasNextPage endCursor }
                nodes {
                  __typename
                  ... on CheckRun {
                    name
                    status
                    conclusion
                    detailsUrl
                    databaseId
                    isRequired(pullRequestNumber: $number)
                  }
                  ... on StatusContext {
                    context
                    state
                    description
                    targetUrl
                    isRequired(pullRequestNumber: $number)
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}
"#;

const MAX_FAILURE_DIAGNOSTIC_CHARS: usize = 8 * 1_024;

pub(super) struct PolicySnapshot {
    pub(super) state: GitHubReviewState,
    pub(super) failed_job_ids: Vec<u64>,
    pub(super) merge_method: Option<MergeMethod>,
    pub(super) head_update: Option<HeadUpdate>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct HeadUpdate(pub(super) String);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum MergeMethod {
    Queue,
    Merge,
    Squash,
    Rebase,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
struct PullRequestPolicyWire {
    id: String,
    number: u64,
    state: String,
    merged: bool,
    merge_commit: Option<RevisionWire>,
    mergeable: String,
    merge_state_status: String,
    is_draft: bool,
    is_in_merge_queue: bool,
    is_merge_queue_enabled: bool,
    base_ref_name: String,
    head_ref_name: String,
    head_ref_oid: String,
    commits: CommitConnectionWire,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
struct RevisionWire {
    oid: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
struct CommitConnectionWire {
    nodes: Vec<CommitNodeWire>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
struct CommitNodeWire {
    commit: CommitWire,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
struct CommitWire {
    status_check_rollup: Option<StatusCheckRollupWire>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
struct StatusCheckRollupWire {
    contexts: CheckContextConnectionWire,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
struct CheckContextConnectionWire {
    page_info: PageInfoWire,
    nodes: Vec<CheckContextWire>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
struct PageInfoWire {
    has_next_page: bool,
    end_cursor: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(tag = "__typename")]
enum CheckContextWire {
    CheckRun {
        name: String,
        status: String,
        conclusion: Option<String>,
        #[serde(rename = "detailsUrl")]
        details_url: Option<String>,
        #[serde(rename = "databaseId")]
        database_id: Option<u64>,
        #[serde(rename = "isRequired")]
        is_required: bool,
    },
    StatusContext {
        context: String,
        state: String,
        description: Option<String>,
        #[serde(rename = "targetUrl")]
        target_url: Option<String>,
        #[serde(rename = "isRequired")]
        is_required: bool,
    },
}

#[derive(Deserialize)]
struct QueryPageWire {
    data: QueryDataWire,
}

#[derive(Deserialize)]
struct QueryDataWire {
    repository: Option<RepositoryPolicyWire>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RepositoryPolicyWire {
    name_with_owner: String,
    merge_commit_allowed: bool,
    squash_merge_allowed: bool,
    rebase_merge_allowed: bool,
    pull_request: Option<PullRequestPolicyWire>,
}

pub(super) fn query_arguments(
    review: &GitHubReviewReceipt,
) -> Result<Vec<String>, GitHubAuthorityError> {
    let (owner, name) = review
        .repository
        .split_once('/')
        .filter(|(owner, name)| !owner.is_empty() && !name.is_empty() && !name.contains('/'))
        .ok_or(GitHubAuthorityError::Rejected)?;
    let number = review
        .review_id
        .parse::<u64>()
        .ok()
        .filter(|number| *number > 0)
        .ok_or(GitHubAuthorityError::Rejected)?;
    Ok(vec![
        "graphql".to_owned(),
        "--paginate".to_owned(),
        "--slurp".to_owned(),
        "-f".to_owned(),
        format!("query={POLICY_QUERY}"),
        "-F".to_owned(),
        format!("owner={owner}"),
        "-F".to_owned(),
        format!("name={name}"),
        "-F".to_owned(),
        format!("number={number}"),
    ])
}

pub(super) fn classify_policy(
    value: Value,
    review: &GitHubReviewReceipt,
) -> Result<PolicySnapshot, GitHubAuthorityError> {
    let pages: Vec<QueryPageWire> =
        serde_json::from_value(value).map_err(|_| GitHubAuthorityError::Rejected)?;
    let first = pages.first().ok_or(GitHubAuthorityError::Rejected)?;
    let first_repository = first
        .data
        .repository
        .as_ref()
        .ok_or(GitHubAuthorityError::Rejected)?;
    let first_pull_request = require_identity(first_repository, review)?.clone();
    let (contexts, complete) = collect_contexts(&pages, review, first_repository)?;
    if !complete {
        return Ok(waiting_snapshot());
    }
    classify_snapshot(first_repository, &first_pull_request, &contexts)
}

fn collect_contexts(
    pages: &[QueryPageWire],
    review: &GitHubReviewReceipt,
    first_repository: &RepositoryPolicyWire,
) -> Result<(Vec<CheckContextWire>, bool), GitHubAuthorityError> {
    let mut contexts = Vec::new();
    let mut complete = true;
    let mut cursors = BTreeSet::new();

    for (index, page) in pages.iter().enumerate() {
        let repository = page
            .data
            .repository
            .as_ref()
            .ok_or(GitHubAuthorityError::Rejected)?;
        let pull_request = require_identity(repository, review)?;
        complete &= page_policy_is_stable(first_repository, repository, pull_request)?;
        let Some(page_contexts) = check_contexts(pull_request)? else {
            complete &= pages.len() == 1;
            continue;
        };
        complete &= page_is_complete(page_contexts, index, pages.len(), &mut cursors);
        contexts.extend(page_contexts.nodes.iter().cloned());
    }
    Ok((contexts, complete))
}

fn page_policy_is_stable(
    first_repository: &RepositoryPolicyWire,
    repository: &RepositoryPolicyWire,
    pull_request: &PullRequestPolicyWire,
) -> Result<bool, GitHubAuthorityError> {
    let first_pull_request = first_repository
        .pull_request
        .as_ref()
        .ok_or(GitHubAuthorityError::Rejected)?;
    Ok(same_repository_policy(first_repository, repository)
        && same_policy(first_pull_request, pull_request))
}

fn page_is_complete(
    contexts: &CheckContextConnectionWire,
    index: usize,
    page_count: usize,
    cursors: &mut BTreeSet<String>,
) -> bool {
    let pagination_matches = contexts.page_info.has_next_page != (index + 1 == page_count);
    match contexts.page_info.end_cursor.as_ref() {
        Some(cursor) => pagination_matches && cursors.insert(cursor.clone()),
        None => pagination_matches && !contexts.page_info.has_next_page,
    }
}

pub(super) fn include_check_logs(snapshot: &mut PolicySnapshot, logs: &[String]) {
    let GitHubReviewState::Open {
        checks: GitHubChecks::Failed { diagnostic },
    } = &mut snapshot.state
    else {
        return;
    };
    if logs.is_empty() {
        return;
    }
    let logs = logs
        .iter()
        .map(|log| log_tail(log))
        .collect::<Vec<_>>()
        .join("\n---\n");
    *diagnostic = bounded_text(
        &format!("{diagnostic}\nFailed check log tail:\n{logs}"),
        MAX_FAILURE_DIAGNOSTIC_CHARS,
    );
}

fn require_identity<'a>(
    repository: &'a RepositoryPolicyWire,
    review: &GitHubReviewReceipt,
) -> Result<&'a PullRequestPolicyWire, GitHubAuthorityError> {
    let pull_request = repository
        .pull_request
        .as_ref()
        .ok_or(GitHubAuthorityError::Rejected)?;
    let valid = repository.name_with_owner == review.repository
        && pull_request.number.to_string() == review.review_id
        && pull_request.base_ref_name == review.target_branch
        && pull_request.head_ref_name == review.head_branch
        && pull_request.head_ref_oid == review.head_revision;
    valid
        .then_some(pull_request)
        .ok_or(GitHubAuthorityError::Rejected)
}

fn same_policy(left: &PullRequestPolicyWire, right: &PullRequestPolicyWire) -> bool {
    left.id == right.id
        && left.number == right.number
        && left.state == right.state
        && left.merged == right.merged
        && left.merge_commit == right.merge_commit
        && left.mergeable == right.mergeable
        && left.merge_state_status == right.merge_state_status
        && left.is_draft == right.is_draft
        && left.is_in_merge_queue == right.is_in_merge_queue
        && left.is_merge_queue_enabled == right.is_merge_queue_enabled
}

fn same_repository_policy(left: &RepositoryPolicyWire, right: &RepositoryPolicyWire) -> bool {
    left.name_with_owner == right.name_with_owner
        && left.merge_commit_allowed == right.merge_commit_allowed
        && left.squash_merge_allowed == right.squash_merge_allowed
        && left.rebase_merge_allowed == right.rebase_merge_allowed
}

fn check_contexts(
    pull_request: &PullRequestPolicyWire,
) -> Result<Option<&CheckContextConnectionWire>, GitHubAuthorityError> {
    let [commit] = pull_request.commits.nodes.as_slice() else {
        return Err(GitHubAuthorityError::Rejected);
    };
    Ok(commit
        .commit
        .status_check_rollup
        .as_ref()
        .map(|rollup| &rollup.contexts))
}

fn classify_snapshot(
    repository: &RepositoryPolicyWire,
    pull_request: &PullRequestPolicyWire,
    contexts: &[CheckContextWire],
) -> Result<PolicySnapshot, GitHubAuthorityError> {
    if let Some(snapshot) = terminal_snapshot(pull_request)? {
        return Ok(snapshot);
    }
    let evidence = classify_required_checks(contexts);
    if !evidence.failures.is_empty() {
        return Ok(PolicySnapshot {
            state: GitHubReviewState::Open {
                checks: GitHubChecks::Failed {
                    diagnostic: failure_diagnostic(evidence.failures),
                },
            },
            failed_job_ids: evidence.failed_job_ids,
            merge_method: merge_method(repository, pull_request),
            head_update: head_update(pull_request),
        });
    }
    let checks = match (merge_gate_ready(pull_request), evidence.checks) {
        (true, RequiredChecks::Absent) => GitHubChecks::NotRequired,
        (true, RequiredChecks::Passed) => GitHubChecks::Passed,
        _ => GitHubChecks::Pending,
    };
    Ok(PolicySnapshot {
        state: GitHubReviewState::Open { checks },
        failed_job_ids: Vec::new(),
        merge_method: merge_method(repository, pull_request),
        head_update: head_update(pull_request),
    })
}

fn head_update(pull_request: &PullRequestPolicyWire) -> Option<HeadUpdate> {
    (!pull_request.is_merge_queue_enabled
        && !pull_request.is_draft
        && !pull_request.is_in_merge_queue
        && pull_request.mergeable == "MERGEABLE"
        && pull_request.merge_state_status == "BEHIND")
        .then(|| HeadUpdate(pull_request.id.clone()))
}

fn merge_method(
    repository: &RepositoryPolicyWire,
    pull_request: &PullRequestPolicyWire,
) -> Option<MergeMethod> {
    if pull_request.is_merge_queue_enabled {
        Some(MergeMethod::Queue)
    } else if repository.merge_commit_allowed {
        Some(MergeMethod::Merge)
    } else if repository.squash_merge_allowed {
        Some(MergeMethod::Squash)
    } else if repository.rebase_merge_allowed {
        Some(MergeMethod::Rebase)
    } else {
        None
    }
}

fn terminal_snapshot(
    pull_request: &PullRequestPolicyWire,
) -> Result<Option<PolicySnapshot>, GitHubAuthorityError> {
    if pull_request.merged {
        return merged_snapshot(pull_request).map(Some);
    }
    let state = match pull_request.state.as_str() {
        "CLOSED" => Some(GitHubReviewState::Closed),
        "OPEN" if pull_request.mergeable == "CONFLICTING" => Some(GitHubReviewState::Conflict),
        "OPEN" if pull_request.merge_state_status == "DIRTY" => Some(GitHubReviewState::Conflict),
        "OPEN" => None,
        _ => return Err(GitHubAuthorityError::Rejected),
    };
    Ok(state.map(|state| PolicySnapshot {
        state,
        failed_job_ids: Vec::new(),
        merge_method: None,
        head_update: None,
    }))
}

fn merged_snapshot(
    pull_request: &PullRequestPolicyWire,
) -> Result<PolicySnapshot, GitHubAuthorityError> {
    let merge_revision = pull_request
        .merge_commit
        .as_ref()
        .map(|commit| commit.oid.clone())
        .filter(|revision| valid_revision(revision))
        .ok_or(GitHubAuthorityError::Rejected)?;
    (pull_request.state == "MERGED")
        .then_some(PolicySnapshot {
            state: GitHubReviewState::Merged { merge_revision },
            failed_job_ids: Vec::new(),
            merge_method: None,
            head_update: None,
        })
        .ok_or(GitHubAuthorityError::Rejected)
}

fn merge_gate_ready(pull_request: &PullRequestPolicyWire) -> bool {
    let state_ready = matches!(
        pull_request.merge_state_status.as_str(),
        "BEHIND" | "CLEAN" | "HAS_HOOKS" | "UNSTABLE"
    );
    !pull_request.is_draft
        && !pull_request.is_in_merge_queue
        && (pull_request.is_merge_queue_enabled
            || pull_request.mergeable == "MERGEABLE" && state_ready)
}

fn waiting_snapshot() -> PolicySnapshot {
    PolicySnapshot {
        state: GitHubReviewState::Open {
            checks: GitHubChecks::Pending,
        },
        failed_job_ids: Vec::new(),
        merge_method: None,
        head_update: None,
    }
}

fn bounded_text(value: &str, maximum: usize) -> String {
    value.chars().take(maximum).collect()
}

fn log_tail(value: &str) -> String {
    let mut tail = value
        .chars()
        .filter(|character| !character.is_control() || matches!(character, '\n' | '\t'))
        .rev()
        .take(MAX_FAILURE_DIAGNOSTIC_CHARS)
        .collect::<Vec<_>>();
    tail.reverse();
    tail.into_iter().collect()
}
