use super::wire::{IssueCommentWire, IssueWire, require_review_identity};
use super::*;

pub(super) async fn connect_source_issue(
    authority: &GhCliDeliveryAuthority,
    request: &GitHubReviewRequest,
    review: &GitHubReviewReceipt,
    credential: GitHubCredential<'_>,
) -> Result<(), GitHubAuthorityError> {
    let Some(issue) = request.source_issue.as_ref() else {
        return Ok(());
    };
    let mut wire = authority.pull_request(review, credential).await?;
    require_review_identity(&wire, review)?;
    let closing_reference = closing_reference(issue.number);
    if !body_has_closing_reference(wire.body.as_deref(), &closing_reference) {
        let body = append_closing_reference(wire.body.as_deref(), &closing_reference);
        let value = authority
            .api(
                &[
                    format!("repos/{}/pulls/{}", review.repository, review.review_id),
                    "--method".to_owned(),
                    "PATCH".to_owned(),
                    "-f".to_owned(),
                    format!("body={body}"),
                ],
                credential,
            )
            .await?;
        wire = serde_json::from_value(value).map_err(|_| GitHubAuthorityError::Rejected)?;
        require_review_identity(&wire, review)?;
    }
    comment_on_source_issue(authority, request, review, credential).await
}

async fn comment_on_source_issue(
    authority: &GhCliDeliveryAuthority,
    request: &GitHubReviewRequest,
    review: &GitHubReviewReceipt,
    credential: GitHubCredential<'_>,
) -> Result<(), GitHubAuthorityError> {
    let issue = request
        .source_issue
        .as_ref()
        .ok_or(GitHubAuthorityError::Rejected)?;
    let marker = delivery_comment_marker(&request.head_branch);
    let value = authority
        .api(
            &[
                format!("repos/{}/issues/{}", review.repository, issue.number),
                "--method".to_owned(),
                "GET".to_owned(),
            ],
            credential,
        )
        .await?;
    let issue_wire: IssueWire =
        serde_json::from_value(value).map_err(|_| GitHubAuthorityError::Rejected)?;
    let last_comment_page = issue_wire.comments.saturating_sub(1) / 100 + 1;
    let value = authority
        .api(
            &[
                format!(
                    "repos/{}/issues/{}/comments",
                    review.repository, issue.number
                ),
                "--method".to_owned(),
                "GET".to_owned(),
                "-f".to_owned(),
                "per_page=100".to_owned(),
                "-f".to_owned(),
                format!("page={last_comment_page}"),
            ],
            credential,
        )
        .await?;
    let comments: Vec<IssueCommentWire> =
        serde_json::from_value(value).map_err(|_| GitHubAuthorityError::Rejected)?;
    if comments.iter().any(|comment| {
        comment
            .body
            .as_deref()
            .is_some_and(|body| body.contains(&marker))
    }) {
        return Ok(());
    }
    authority
        .api(
            &[
                format!(
                    "repos/{}/issues/{}/comments",
                    review.repository, issue.number
                ),
                "--method".to_owned(),
                "POST".to_owned(),
                "-f".to_owned(),
                format!(
                    "body=Zeroshot opened pull request #{} for this issue.\n\n{}",
                    review.review_id, marker
                ),
            ],
            credential,
        )
        .await?;
    Ok(())
}

fn closing_reference(issue_number: u64) -> String {
    format!("Closes #{issue_number}")
}

pub(super) fn pull_request_body(request: &GitHubReviewRequest) -> String {
    request.source_issue.as_ref().map_or_else(
        || PULL_REQUEST_BODY.to_owned(),
        |issue| format!("{PULL_REQUEST_BODY}\n\n{}", closing_reference(issue.number)),
    )
}

fn body_has_closing_reference(body: Option<&str>, closing_reference: &str) -> bool {
    body.is_some_and(|body| {
        body.lines()
            .any(|line| line.trim().eq_ignore_ascii_case(closing_reference))
    })
}

fn append_closing_reference(body: Option<&str>, closing_reference: &str) -> String {
    let body = body.unwrap_or_default().trim_end();
    if body.is_empty() {
        format!("{PULL_REQUEST_BODY}\n\n{closing_reference}")
    } else {
        format!("{body}\n\n{closing_reference}")
    }
}

fn delivery_comment_marker(head_branch: &str) -> String {
    format!("<!-- zeroshot-delivery:{head_branch} -->")
}

#[cfg(test)]
mod tests {
    use openengine_cluster_testkit::assertions::AssertValue;

    use super::*;
    use crate::native_v2_delivery::{DeliveryTarget, GitHubSourceIssue};

    #[test]
    fn reference_is_created_and_repaired_without_replacing_body() {
        let request = GitHubReviewRequest {
            target: DeliveryTarget::new(
                "acme/project",
                "main",
                "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            )
            .assert_value(),
            head_branch: "zeroshot/v2-run".to_owned(),
            head_revision: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb".to_owned(),
            source_issue: Some(GitHubSourceIssue { number: 208 }),
        };
        assert_eq!(
            pull_request_body(&request),
            "Created by Zeroshot v2.\n\nCloses #208"
        );
        assert_eq!(
            append_closing_reference(Some("Human context"), "Closes #208"),
            "Human context\n\nCloses #208"
        );
        assert!(body_has_closing_reference(
            Some("Human context\n\ncloses #208"),
            "Closes #208"
        ));
    }
}
