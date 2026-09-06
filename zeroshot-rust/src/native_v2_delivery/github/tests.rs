use openengine_cluster_testkit::assertions::AssertValue;
use serde_json::json;

use super::*;
use super::policy::MergeMethod;
use crate::native_v2_delivery::{DeliveryTarget, GitHubChecks};

fn review() -> GitHubReviewReceipt {
    GitHubReviewReceipt {
        review_id: "17".to_owned(),
        repository: "acme/project".to_owned(),
        target_branch: "main".to_owned(),
        head_branch: "zeroshot/v2-run".to_owned(),
        head_revision: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb".to_owned(),
    }
}

fn check_run(name: &str, status: &str, conclusion: Option<&str>, required: bool) -> Value {
    json!({
        "__typename": "CheckRun",
        "name": name,
        "status": status,
        "conclusion": conclusion,
        "detailsUrl": "https://github.com/acme/project/actions/runs/17",
        "databaseId": 91,
        "isRequired": required
    })
}

fn status_context(context: &str, state: &str, required: bool) -> Value {
    json!({
        "__typename": "StatusContext",
        "context": context,
        "state": state,
        "description": "legacy CI rejected the revision",
        "targetUrl": "https://ci.example.invalid/build/17",
        "isRequired": required
    })
}

fn policy_page(
    mergeable: &str,
    merge_state_status: &str,
    contexts: Option<Vec<Value>>,
    pagination: (bool, Option<&str>),
) -> Value {
    let (has_next_page, end_cursor) = pagination;
    let rollup = contexts.map(|nodes| {
        json!({
            "contexts": {
                "pageInfo": {
                    "hasNextPage": has_next_page,
                    "endCursor": end_cursor
                },
                "nodes": nodes
            }
        })
    });
    json!({
        "data": {
            "repository": {
                "nameWithOwner": "acme/project",
                "mergeCommitAllowed": true,
                "squashMergeAllowed": true,
                "rebaseMergeAllowed": true,
                "pullRequest": {
                    "id": "PR_node_17",
                    "number": 17,
                    "state": "OPEN",
                    "merged": false,
                    "mergeCommit": null,
                    "mergeable": mergeable,
                    "mergeStateStatus": merge_state_status,
                    "isDraft": false,
                    "isInMergeQueue": false,
                    "isMergeQueueEnabled": false,
                    "baseRefName": "main",
                    "headRefName": "zeroshot/v2-run",
                    "headRefOid": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                    "commits": {
                        "nodes": [{
                            "commit": {
                                "statusCheckRollup": rollup
                            }
                        }]
                    }
                }
            }
        }
    })
}

fn classify(page: Value) -> PolicySnapshot {
    classify_policy(json!([page]), &review()).assert_value()
}

fn classify_conclusion(conclusion: &str, merge_state: &str) -> PolicySnapshot {
    classify(policy_page(
        "MERGEABLE",
        merge_state,
        Some(vec![check_run(
            "required-ci",
            "COMPLETED",
            Some(conclusion),
            true,
        )]),
        (false, Some(conclusion)),
    ))
}

#[test]
fn api_payload_budget_and_log_tail_are_bounded() {
    let payload = vec![b'x'; 512 * 1024];
    assert_eq!(
        validate_api_output(payload).assert_value().len(),
        512 * 1024
    );
    assert_eq!(
        validate_api_output(vec![b'x'; MAX_API_OUTPUT_BYTES + 1]),
        Err(GitHubAuthorityError::Rejected)
    );

    let mut output = b"discard".to_vec();
    output.extend(vec![b'x'; MAX_CHECK_LOG_TAIL_BYTES]);
    output.extend_from_slice(b"failure at end");
    let tail = check_log_tail(&output);
    assert_eq!(tail.len(), MAX_CHECK_LOG_TAIL_BYTES);
    assert!(!tail.contains("discard"));
    assert!(tail.ends_with("failure at end"));
}

#[test]
fn policy_query_is_repository_generic_and_paginates_required_contexts() {
    let arguments = query_arguments(&review()).assert_value();
    assert_eq!(arguments.first().map(String::as_str), Some("graphql"));
    assert!(arguments.iter().any(|argument| argument == "--paginate"));
    assert!(arguments.iter().any(|argument| argument == "--slurp"));
    assert!(arguments.iter().any(|argument| argument == "owner=acme"));
    assert!(arguments.iter().any(|argument| argument == "name=project"));
    assert!(arguments.iter().any(|argument| argument == "number=17"));
    let query = arguments
        .iter()
        .find(|argument| argument.starts_with("query="))
        .assert_value();
    assert!(query.contains("isRequired(pullRequestNumber: $number)"));
    assert!(query.contains("statusCheckRollup"));
    assert!(query.contains("isMergeQueueEnabled"));
    assert!(query.contains("mergeCommitAllowed"));
}

#[test]
fn delayed_required_workflow_registration_stays_pending_until_github_is_ready() {
    let absent = classify(policy_page("MERGEABLE", "BLOCKED", None, (false, None)));
    assert_eq!(
        absent.state,
        GitHubReviewState::Open {
            checks: GitHubChecks::Pending
        }
    );

    let queued = classify(policy_page(
        "MERGEABLE",
        "BLOCKED",
        Some(vec![check_run("required-ci", "QUEUED", None, true)]),
        (false, Some("queued")),
    ));
    assert_eq!(
        queued.state,
        GitHubReviewState::Open {
            checks: GitHubChecks::Pending
        }
    );

    let ready = classify(policy_page(
        "MERGEABLE",
        "CLEAN",
        Some(vec![check_run(
            "required-ci",
            "COMPLETED",
            Some("SUCCESS"),
            true,
        )]),
        (false, Some("ready")),
    ));
    assert_eq!(
        ready.state,
        GitHubReviewState::Open {
            checks: GitHubChecks::Passed
        }
    );
}

#[test]
fn optional_checks_never_block_or_fail_delivery() {
    let snapshot = classify(policy_page(
        "MERGEABLE",
        "UNSTABLE",
        Some(vec![
            check_run("optional-failure", "COMPLETED", Some("FAILURE"), false),
            check_run("optional-pending", "IN_PROGRESS", None, false),
            status_context("optional-legacy", "FAILURE", false),
        ]),
        (false, Some("optional")),
    ));
    assert_eq!(
        snapshot.state,
        GitHubReviewState::Open {
            checks: GitHubChecks::NotRequired
        }
    );
    assert!(snapshot.failed_job_ids.is_empty());
}

#[test]
fn required_check_failures_win_and_preserve_diagnostics() {
    let mut snapshot = classify(policy_page(
        "MERGEABLE",
        "BLOCKED",
        Some(vec![
            check_run("required-actions", "COMPLETED", Some("FAILURE"), true),
            status_context("required-legacy", "ERROR", true),
            check_run("still-running", "IN_PROGRESS", None, true),
        ]),
        (false, Some("failed")),
    ));
    assert_eq!(snapshot.failed_job_ids, vec![91]);
    include_check_logs(
        &mut snapshot,
        &["setup passed\nAssertionError: validation failed".to_owned()],
    );
    let diagnostic = match snapshot.state {
        GitHubReviewState::Open {
            checks: GitHubChecks::Failed { diagnostic },
        } => Some(diagnostic),
        _ => None,
    }
    .assert_value_with("expected required CI failure");
    assert!(diagnostic.contains("required-actions concluded FAILURE"));
    assert!(diagnostic.contains("required-legacy concluded ERROR"));
    assert!(diagnostic.contains("legacy CI rejected the revision"));
    assert!(diagnostic.contains("AssertionError: validation failed"));
}

#[test]
fn every_known_terminal_check_run_conclusion_is_classified() {
    for conclusion in ["SUCCESS", "NEUTRAL", "SKIPPED"] {
        let snapshot = classify_conclusion(conclusion, "CLEAN");
        assert!(matches!(
            snapshot.state,
            GitHubReviewState::Open {
                checks: GitHubChecks::Passed
            }
        ));
    }
    for conclusion in [
        "FAILURE",
        "CANCELLED",
        "TIMED_OUT",
        "ACTION_REQUIRED",
        "STALE",
        "STARTUP_FAILURE",
    ] {
        let snapshot = classify_conclusion(conclusion, "BLOCKED");
        assert!(matches!(
            snapshot.state,
            GitHubReviewState::Open {
                checks: GitHubChecks::Failed { .. }
            }
        ));
    }
}

#[test]
fn unknown_or_nonterminal_provider_states_fail_closed_as_pending() {
    for (mergeable, merge_state) in [
        ("UNKNOWN", "UNKNOWN"),
        ("MERGEABLE", "BLOCKED"),
        ("MERGEABLE", "DRAFT"),
        ("MERGEABLE", "UNKNOWN"),
    ] {
        let snapshot = classify(policy_page(mergeable, merge_state, None, (false, None)));
        assert_eq!(
            snapshot.state,
            GitHubReviewState::Open {
                checks: GitHubChecks::Pending
            }
        );
    }
    let snapshot = classify(policy_page(
        "MERGEABLE",
        "CLEAN",
        Some(vec![check_run(
            "future-conclusion",
            "COMPLETED",
            Some("FUTURE_VALUE"),
            true,
        )]),
        (false, Some("future")),
    ));
    assert_eq!(
        snapshot.state,
        GitHubReviewState::Open {
            checks: GitHubChecks::Pending
        }
    );
}

#[test]
fn clean_repository_without_required_checks_is_ready() {
    for merge_state in ["BEHIND", "CLEAN", "HAS_HOOKS", "UNSTABLE"] {
        let snapshot = classify(policy_page("MERGEABLE", merge_state, None, (false, None)));
        assert_eq!(
            snapshot.state,
            GitHubReviewState::Open {
                checks: GitHubChecks::NotRequired
            }
        );
        assert_eq!(snapshot.head_update.is_some(), merge_state == "BEHIND");
    }
}

#[test]
fn drafts_and_queued_reviews_wait_for_github() {
    for field in ["isDraft", "isInMergeQueue"] {
        let mut page = policy_page("MERGEABLE", "CLEAN", None, (false, None));
        page.pointer_mut(&format!("/data/repository/pullRequest/{field}"))
            .assert_value()
            .clone_from(&json!(true));
        assert_eq!(
            classify(page).state,
            GitHubReviewState::Open {
                checks: GitHubChecks::Pending
            }
        );
    }
}

#[test]
fn merge_queue_policy_reaches_native_submission_without_ci_special_cases() {
    for merge_state in ["BLOCKED", "BEHIND", "UNKNOWN"] {
        let mut page = policy_page("UNKNOWN", merge_state, None, (false, None));
        page.pointer_mut("/data/repository/pullRequest/isMergeQueueEnabled")
            .assert_value()
            .clone_from(&json!(true));
        let snapshot = classify(page);
        assert_eq!(
            snapshot.state,
            GitHubReviewState::Open {
                checks: GitHubChecks::NotRequired
            }
        );
        assert_eq!(snapshot.merge_method, Some(MergeMethod::Queue));
        assert!(snapshot.head_update.is_none());
    }
}

#[test]
fn repository_merge_capabilities_select_an_allowed_method() {
    let cases = [
        ((true, true, true), MergeMethod::Merge),
        ((false, true, true), MergeMethod::Squash),
        ((false, false, true), MergeMethod::Rebase),
    ];
    for ((merge, squash, rebase), expected) in cases {
        let mut page = policy_page("MERGEABLE", "CLEAN", None, (false, None));
        let repository = page.pointer_mut("/data/repository").assert_value();
        repository["mergeCommitAllowed"] = json!(merge);
        repository["squashMergeAllowed"] = json!(squash);
        repository["rebaseMergeAllowed"] = json!(rebase);
        assert_eq!(classify(page).merge_method, Some(expected));
    }
}

#[test]
fn pagination_must_be_complete_and_policy_stable() {
    let first = policy_page(
        "MERGEABLE",
        "CLEAN",
        Some(vec![check_run(
            "required-one",
            "COMPLETED",
            Some("SUCCESS"),
            true,
        )]),
        (true, Some("one")),
    );
    let second = policy_page(
        "MERGEABLE",
        "CLEAN",
        Some(vec![status_context("required-two", "SUCCESS", true)]),
        (false, Some("two")),
    );
    assert_eq!(
        classify_policy(json!([first.clone(), second]), &review())
            .assert_value()
            .state,
        GitHubReviewState::Open {
            checks: GitHubChecks::Passed
        }
    );
    assert_policy_pages_pending(vec![first]);

    let stable = policy_page("MERGEABLE", "CLEAN", None, (true, Some("one")));
    let changed = policy_page("MERGEABLE", "BLOCKED", None, (false, Some("two")));
    assert_policy_pages_pending(vec![stable, changed]);

    let stable = policy_page("MERGEABLE", "CLEAN", None, (true, Some("one")));
    let mut changed = policy_page("MERGEABLE", "CLEAN", None, (false, Some("two")));
    changed
        .pointer_mut("/data/repository/pullRequest/isMergeQueueEnabled")
        .assert_value()
        .clone_from(&json!(true));
    assert_policy_pages_pending(vec![stable, changed]);
}

fn assert_policy_pages_pending(pages: Vec<Value>) {
    assert_eq!(
        classify_policy(json!(pages), &review())
            .assert_value()
            .state,
        GitHubReviewState::Open {
            checks: GitHubChecks::Pending
        }
    );
}

#[test]
fn terminal_state_and_exact_identity_are_authoritative() {
    let mut conflict = policy_page("CONFLICTING", "DIRTY", None, (false, None));
    assert_eq!(
        classify(conflict.clone()).state,
        GitHubReviewState::Conflict
    );

    let mut closed = conflict.clone();
    let pull_request = closed
        .pointer_mut("/data/repository/pullRequest")
        .assert_value();
    pull_request["state"] = json!("CLOSED");
    pull_request["mergeable"] = json!("UNKNOWN");
    pull_request["mergeStateStatus"] = json!("UNKNOWN");
    assert_eq!(classify(closed).state, GitHubReviewState::Closed);

    let pull_request = conflict
        .pointer_mut("/data/repository/pullRequest")
        .assert_value();
    pull_request["state"] = json!("MERGED");
    pull_request["merged"] = json!(true);
    pull_request["mergeable"] = json!("MERGEABLE");
    pull_request["mergeStateStatus"] = json!("CLEAN");
    pull_request["mergeCommit"] = json!({"oid":"cccccccccccccccccccccccccccccccccccccccc"});
    assert_eq!(
        classify(conflict.clone()).state,
        GitHubReviewState::Merged {
            merge_revision: "cccccccccccccccccccccccccccccccccccccccc".to_owned()
        }
    );

    let pull_request = conflict
        .pointer_mut("/data/repository/pullRequest")
        .assert_value();
    pull_request["headRefOid"] = json!("dddddddddddddddddddddddddddddddddddddddd");
    assert!(classify_policy(json!([conflict]), &review()).is_err());
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
        source_issue: None,
    };
    let wire = serde_json::from_value(json!({
        "number": 17,
        "body": null,
        "base": {
            "ref": "other",
            "sha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "repo": {"full_name": "acme/project"}
        },
        "head": {
            "ref": "zeroshot/v2-run",
            "sha": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            "repo": {"full_name": "acme/project"}
        }
    }))
    .assert_value();
    assert!(review_receipt(wire, &request).is_err());
}
