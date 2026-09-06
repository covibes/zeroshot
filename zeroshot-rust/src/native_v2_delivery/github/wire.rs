use serde::Deserialize;

use super::*;

#[derive(Deserialize)]
pub(super) struct PullRequestWire {
    number: u64,
    pub(super) body: Option<String>,
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
