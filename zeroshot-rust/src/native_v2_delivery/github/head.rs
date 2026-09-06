use std::path::Path;

use serde::Deserialize;

use super::*;

const UPDATE_HEAD_MUTATION: &str = r#"
mutation($pullRequestId: ID!, $expectedHeadOid: GitObjectID!) {
  updatePullRequestBranch(input: {
    pullRequestId: $pullRequestId
    expectedHeadOid: $expectedHeadOid
    updateMethod: MERGE
  }) {
    pullRequest {
      id
      number
      repository { nameWithOwner }
      baseRefName
      headRefName
      headRefOid
    }
  }
}
"#;

const MAX_GIT_OUTPUT_BYTES: usize = 4 * 1_024;

#[derive(Deserialize)]
struct UpdateHeadWire {
    data: UpdateHeadDataWire,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateHeadDataWire {
    update_pull_request_branch: Option<UpdateHeadPayloadWire>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateHeadPayloadWire {
    pull_request: Option<UpdatedPullRequestWire>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdatedPullRequestWire {
    id: String,
    number: u64,
    repository: UpdatedRepositoryWire,
    base_ref_name: String,
    head_ref_name: String,
    head_ref_oid: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdatedRepositoryWire {
    name_with_owner: String,
}

#[derive(Clone, Copy)]
struct HeadUpdateContext<'a> {
    authority: &'a GhCliDeliveryAuthority,
    workspace: &'a Path,
    credential: GitHubCredential<'a>,
}

pub(super) struct HeadUpdateRequest<'a> {
    pub(super) workspace: &'a Path,
    pub(super) review: &'a GitHubReviewReceipt,
    pub(super) pull_request_id: &'a str,
}

pub(super) async fn update_review_head(
    authority: &GhCliDeliveryAuthority,
    request: HeadUpdateRequest<'_>,
    credential: GitHubCredential<'_>,
) -> Result<GitHubReviewReceipt, GitHubAuthorityError> {
    let context = HeadUpdateContext {
        authority,
        workspace: request.workspace,
        credential,
    };
    require_local_head(context, &request.review.head_revision).await?;
    let value = context
        .authority
        .api(
            &update_arguments(request.pull_request_id, &request.review.head_revision),
            context.credential,
        )
        .await?;
    let updated = updated_receipt(value, request.review, request.pull_request_id)?;
    adopt_local_head(context, request.review, &updated).await?;
    Ok(updated)
}

fn update_arguments(pull_request_id: &str, expected_head: &str) -> Vec<String> {
    vec![
        "graphql".to_owned(),
        "-f".to_owned(),
        format!("query={UPDATE_HEAD_MUTATION}"),
        "-f".to_owned(),
        format!("pullRequestId={pull_request_id}"),
        "-f".to_owned(),
        format!("expectedHeadOid={expected_head}"),
    ]
}

fn updated_receipt(
    value: Value,
    previous: &GitHubReviewReceipt,
    pull_request_id: &str,
) -> Result<GitHubReviewReceipt, GitHubAuthorityError> {
    let wire: UpdateHeadWire =
        serde_json::from_value(value).map_err(|_| GitHubAuthorityError::Rejected)?;
    let updated = wire
        .data
        .update_pull_request_branch
        .and_then(|payload| payload.pull_request)
        .ok_or(GitHubAuthorityError::Rejected)?;
    let receipt = GitHubReviewReceipt {
        review_id: updated.number.to_string(),
        repository: updated.repository.name_with_owner,
        target_branch: updated.base_ref_name,
        head_branch: updated.head_ref_name,
        head_revision: updated.head_ref_oid,
    };
    (updated.id == pull_request_id && valid_head_update(previous, &receipt))
        .then_some(receipt)
        .ok_or(GitHubAuthorityError::Rejected)
}

async fn require_local_head(
    context: HeadUpdateContext<'_>,
    expected: &str,
) -> Result<(), GitHubAuthorityError> {
    let head = git_output(
        git_command(
            &context.authority.config,
            context.workspace,
            context.credential,
        )
        .args(["rev-parse", "HEAD"]),
        context.authority.config.api_deadline,
    )
    .await?;
    let status = git_output(
        git_command(
            &context.authority.config,
            context.workspace,
            context.credential,
        )
        .args(["status", "--porcelain=v1", "--untracked-files=all"]),
        context.authority.config.api_deadline,
    )
    .await?;
    (head.trim() == expected && status.is_empty())
        .then_some(())
        .ok_or(GitHubAuthorityError::Rejected)
}

async fn adopt_local_head(
    context: HeadUpdateContext<'_>,
    previous: &GitHubReviewReceipt,
    updated: &GitHubReviewReceipt,
) -> Result<(), GitHubAuthorityError> {
    let mut fetch = authenticated_git_command(
        &context.authority.config,
        context.workspace,
        context.credential,
    );
    fetch.args([
        "fetch",
        "--no-tags",
        "--quiet",
        &format!("https://github.com/{}.git", previous.repository),
        &updated.head_revision,
    ]);
    bounded_status(fetch, context.authority.config.push_deadline).await?;
    let mut ancestor = git_command(
        &context.authority.config,
        context.workspace,
        context.credential,
    );
    ancestor.args([
        "merge-base",
        "--is-ancestor",
        &previous.head_revision,
        &updated.head_revision,
    ]);
    bounded_status(ancestor, context.authority.config.api_deadline).await?;
    let mut fast_forward = git_command(
        &context.authority.config,
        context.workspace,
        context.credential,
    );
    fast_forward.args(["merge", "--ff-only", &updated.head_revision]);
    bounded_status(fast_forward, context.authority.config.api_deadline).await?;
    require_local_head(context, &updated.head_revision).await
}

async fn git_output(
    command: &mut Command,
    deadline: Duration,
) -> Result<String, GitHubAuthorityError> {
    command.stdout(Stdio::piped());
    let output = timeout(deadline, command.output())
        .await
        .map_err(|_| GitHubAuthorityError::Unavailable)?
        .map_err(|_| GitHubAuthorityError::Unavailable)?;
    if !output.status.success() || output.stdout.len() > MAX_GIT_OUTPUT_BYTES {
        return Err(GitHubAuthorityError::Rejected);
    }
    String::from_utf8(output.stdout).map_err(|_| GitHubAuthorityError::Rejected)
}

#[cfg(test)]
#[path = "head/tests.rs"]
mod tests;
