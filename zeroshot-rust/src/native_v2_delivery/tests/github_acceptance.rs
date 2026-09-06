use super::*;
use std::path::Path;

#[tokio::test]
async fn production_gh_transport_uses_exact_args_and_a_clean_environment() {
    let repo = TempRepo::delivery();
    let git_program = write_executable(repo.root.path(), "git-script", GIT_SCRIPT);
    let gh_program = write_executable(repo.root.path(), "gh-script", GH_SCRIPT);
    let authority = GhCliDeliveryAuthority::new(GhCliAuthorityConfig {
        git_program: git_program.clone(),
        gh_program: gh_program.clone(),
        home_directory: repo.root.path().to_owned(),
        api_deadline: Duration::from_secs(10),
        push_deadline: Duration::from_secs(10),
    });
    let target = DeliveryTarget::new(
        "acme/project",
        "main",
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    )
    .assert_value();
    let review_request = GitHubReviewRequest {
        target: target.clone(),
        head_branch: "zeroshot/v2-test".to_owned(),
        head_revision: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb".to_owned(),
        source_issue: Some(GitHubSourceIssue { number: 208 }),
    };
    let credential = GitHubCredential("test-token");
    authority
        .push_branch(
            &GitHubPushRequest {
                workspace: repo.workspace.clone(),
                target,
                head_branch: review_request.head_branch.clone(),
                head_revision: review_request.head_revision.clone(),
            },
            credential,
        )
        .await
        .assert_value();
    let review = authority
        .open_or_update_review(&review_request, credential)
        .await
        .assert_value();
    let observation = authority
        .inspect_review(&review, credential)
        .await
        .assert_value();
    assert_eq!(
        observation.state,
        GitHubReviewState::Open {
            checks: GitHubChecks::NotRequired
        }
    );
    let merge_request = authority
        .request_merge(&review, credential)
        .await
        .assert_value();
    assert_eq!(merge_request, GitHubMergeRequestOutcome::Accepted);

    let git_capture =
        fs::read_to_string(format!("{}.capture", git_program.display())).assert_value();
    assert!(git_capture.contains("token=test-token"));
    assert!(git_capture.contains(&format!("home={}", repo.root.path().display())));
    assert!(git_capture.contains("config_count=2"));
    assert!(git_capture.contains("config_key_1=http.https://github.com/.extraheader"));
    assert!(git_capture.contains("arg=https://github.com/acme/project.git"));
    assert!(git_capture.contains("arg=HEAD:refs/heads/zeroshot/v2-test"));
    assert!(!argument_lines(&git_capture).contains("test-token"));

    let gh_capture = fs::read_to_string(format!("{}.capture", gh_program.display())).assert_value();
    assert_production_github_capture(&gh_capture, repo.root.path());
}

fn assert_production_github_capture(gh_capture: &str, home: &Path) {
    assert!(gh_capture.contains(&format!(
        "token=test-token\nhost=github.com\nhome={}",
        home.display()
    )));
    assert!(gh_capture.contains("arg=repos/acme/project/pulls"));
    assert!(gh_capture.contains("arg=state=all"));
    assert!(gh_capture.contains("arg=head=acme:zeroshot/v2-test"));
    assert!(gh_capture.contains("arg=body=Created by Zeroshot v2.\n\nCloses #208"));
    assert!(gh_capture.contains("arg=repos/acme/project/issues/208"));
    assert!(gh_capture.contains("arg=repos/acme/project/issues/208/comments"));
    assert!(gh_capture.contains("arg=page=1"));
    assert!(gh_capture.contains("arg=graphql"));
    assert!(gh_capture.contains("arg=--paginate"));
    assert!(gh_capture.contains("isRequired(pullRequestNumber: $number)"));
    assert!(gh_capture.contains(
        "arg=body=Zeroshot opened pull request #17 for this issue.\n\n<!-- zeroshot-delivery:zeroshot/v2-test -->"
    ));
    assert!(gh_capture.contains("arg=pr"));
    assert!(gh_capture.contains("arg=merge"));
    assert!(gh_capture.contains("arg=--repo"));
    assert!(gh_capture.contains("arg=--merge"));
    assert!(gh_capture.contains("arg=--match-head-commit"));
    assert!(gh_capture.contains("arg=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"));
    assert!(!argument_lines(gh_capture).contains("test-token"));
}

#[tokio::test]
async fn production_gh_transport_rejects_malformed_or_changed_authority() {
    let repo = TempRepo::delivery();
    let malformed = write_executable(
        repo.root.path(),
        "gh-malformed",
        "#!/bin/sh\n/usr/bin/printf '%s\\n' '{'\n",
    );
    let mismatch = write_executable(repo.root.path(), "gh-mismatch", GH_MISMATCH_SCRIPT);
    let request = GitHubReviewRequest {
        target: DeliveryTarget::new(
            "acme/project",
            "main",
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        )
        .assert_value(),
        head_branch: "zeroshot/v2-test".to_owned(),
        head_revision: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb".to_owned(),
        source_issue: None,
    };
    for gh_program in [malformed, mismatch] {
        let authority = GhCliDeliveryAuthority::new(GhCliAuthorityConfig {
            git_program: PathBuf::from("/usr/bin/git"),
            gh_program,
            home_directory: repo.root.path().to_owned(),
            api_deadline: Duration::from_secs(10),
            push_deadline: Duration::from_secs(10),
        });
        assert_eq!(
            authority
                .open_or_update_review(&request, GitHubCredential("test-token"))
                .await,
            Err(GitHubAuthorityError::Rejected)
        );
    }
}

use openengine_cluster_testkit::assertions::{AssertValue};
