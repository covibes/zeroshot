use super::{GitHubReviewReceipt, valid_revision};

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum GitHubMergeRequestOutcome {
    Accepted,
    Pending,
    HeadUpdateRequired,
    Conflict,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum GitHubHeadUpdateOutcome {
    Updated(GitHubReviewReceipt),
    Pending,
    Conflict,
}

pub(super) fn valid_head_update(
    previous: &GitHubReviewReceipt,
    updated: &GitHubReviewReceipt,
) -> bool {
    updated.review_id == previous.review_id
        && updated.repository == previous.repository
        && updated.target_branch == previous.target_branch
        && updated.head_branch == previous.head_branch
        && valid_revision(&updated.head_revision)
        && updated.head_revision != previous.head_revision
}
