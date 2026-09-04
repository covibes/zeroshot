use openengine_cluster_testkit::assertions::AssertValue;
use serde_json::json;

use super::*;
use crate::native_v2_delivery::DeliveryTarget;

fn check_run(name: &str, status: &str, conclusion: Option<&str>) -> Value {
    check_run_with_id(91, name, status, conclusion)
}

fn check_run_with_id(id: u64, name: &str, status: &str, conclusion: Option<&str>) -> Value {
    json!({
        "id": id,
        "name": name,
        "status": status,
        "conclusion": conclusion,
        "details_url": "https://github.com/acme/project/actions/runs/17"
    })
}

fn check_runs(runs: Vec<Value>) -> Value {
    json!({"total_count":runs.len(),"check_runs":runs})
}

fn no_statuses() -> Value {
    json!({"state":"pending","statuses":[]})
}

#[test]
fn basic_credential_encoding_is_canonical() {
    assert_eq!(
        encode_basic_credential("token"),
        "eC1hY2Nlc3MtdG9rZW46dG9rZW4="
    );
}

#[test]
fn api_payload_budget_accepts_large_paginated_check_sets() {
    let payload = vec![b'x'; 512 * 1024];
    assert_eq!(
        validate_api_output(payload).assert_value().len(),
        512 * 1024
    );
    assert_eq!(
        validate_api_output(vec![b'x'; MAX_API_OUTPUT_BYTES + 1]),
        Err(GitHubAuthorityError::Rejected)
    );
}

#[test]
fn failed_check_log_diagnostics_keep_only_a_bounded_tail() {
    let mut output = b"discard".to_vec();
    output.extend(vec![b'x'; MAX_CHECK_LOG_TAIL_BYTES]);
    output.extend_from_slice(b"failure at end");
    let tail = check_log_tail(&output);
    assert_eq!(tail.len(), MAX_CHECK_LOG_TAIL_BYTES);
    assert!(!tail.contains("discard"));
    assert!(tail.ends_with("failure at end"));
}

#[test]
fn check_evidence_is_closed_and_complete() {
    assert_eq!(
        classify_checks(
            json!({"total_count":0,"check_runs":[]}),
            json!({"state":"pending","statuses":[]})
        )
        .assert_value(),
        GitHubChecks::NotRequired
    );
    assert_eq!(
        classify_checks(
            json!({"total_count":1,"check_runs":[{
                "id":91,
                "name":"organization policy: production requires changeTicket",
                "status":"completed",
                "conclusion":"failure",
                "details_url":"https://github.com/acme/project/actions/runs/17"
            }]}),
            json!({"state":"success","statuses":[]})
        )
        .assert_value(),
        GitHubChecks::Failed {
            diagnostic: "Required CI checks failed:\n- organization policy: production requires \
                         changeTicket concluded failure \
                         (https://github.com/acme/project/actions/runs/17)"
                .to_owned()
        }
    );
    assert_eq!(
        failed_check_job_ids(&json!({"total_count":1,"check_runs":[{
            "id":91,
            "name":"organization policy",
            "status":"completed",
            "conclusion":"failure",
            "details_url":"https://github.com/acme/project/actions/runs/17"
        }]}))
        .assert_value(),
        vec![91]
    );
    assert_eq!(
        include_check_logs(
            GitHubChecks::Failed {
                diagnostic: "Required CI checks failed".to_owned()
            },
            &["setup passed\nAssertionError: deployment object requires changeTicket".to_owned()]
        ),
        GitHubChecks::Failed {
            diagnostic: "Required CI checks failed\nFailed check log tail:\nsetup passed\n\
                         AssertionError: deployment object requires changeTicket"
                .to_owned()
        }
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
fn pending_check_runs_override_completed_successes_in_any_order() {
    let passed = check_run("scope", "completed", Some("success"));
    for pending_status in ["queued", "in_progress", "requested", "waiting", "pending"] {
        let pending = check_run_with_id(92, "frontend", pending_status, None);
        for runs in [
            vec![passed.clone(), pending.clone()],
            vec![pending.clone(), passed.clone()],
        ] {
            assert_eq!(
                classify_checks(check_runs(runs), no_statuses()).assert_value(),
                GitHubChecks::Pending
            );
        }
    }
}

#[test]
fn checks_and_commit_statuses_use_failure_pending_success_precedence() {
    let passed_checks = check_runs(vec![check_run("checks", "completed", Some("success"))]);
    let pending_checks = check_runs(vec![check_run("checks", "in_progress", None)]);
    let failed_checks = check_runs(vec![check_run("checks", "completed", Some("failure"))]);
    let passed_statuses = json!({"state":"success","statuses":[{
        "state":"success","context":"legacy-ci","description":null,"target_url":null
    }]});
    let pending_statuses = json!({"state":"pending","statuses":[{
        "state":"pending","context":"legacy-ci","description":null,"target_url":null
    }]});
    let failed_statuses = json!({"state":"failure","statuses":[{
        "state":"failure","context":"legacy-ci","description":null,"target_url":null
    }]});

    assert_eq!(
        classify_checks(passed_checks.clone(), pending_statuses.clone()).assert_value(),
        GitHubChecks::Pending
    );
    assert_eq!(
        classify_checks(pending_checks, passed_statuses.clone()).assert_value(),
        GitHubChecks::Pending
    );
    assert!(matches!(
        classify_checks(failed_checks, pending_statuses).assert_value(),
        GitHubChecks::Failed { .. }
    ));
    assert!(matches!(
        classify_checks(passed_checks.clone(), failed_statuses).assert_value(),
        GitHubChecks::Failed { .. }
    ));
    assert_eq!(
        classify_checks(passed_checks, passed_statuses).assert_value(),
        GitHubChecks::Passed
    );
}

#[test]
fn every_github_terminal_check_conclusion_is_classified() {
    for conclusion in ["success", "neutral", "skipped"] {
        assert_eq!(
            classify_checks(
                check_runs(vec![check_run("checks", "completed", Some(conclusion))]),
                no_statuses()
            )
            .assert_value(),
            GitHubChecks::Passed
        );
    }
    for conclusion in [
        "failure",
        "cancelled",
        "timed_out",
        "action_required",
        "stale",
        "startup_failure",
    ] {
        let checks = check_runs(vec![check_run("checks", "completed", Some(conclusion))]);
        assert!(matches!(
            classify_checks(checks.clone(), no_statuses()).assert_value(),
            GitHubChecks::Failed { .. }
        ));
        assert_eq!(failed_check_job_ids(&checks).assert_value(), vec![91]);
    }
}

#[test]
fn paginated_check_runs_are_classified_as_one_complete_set() {
    let pages = json!([
        {
            "total_count": 2,
            "check_runs": [check_run("scope", "completed", Some("success"))]
        },
        {
            "total_count": 2,
            "check_runs": [check_run_with_id(92, "matrix shard", "in_progress", None)]
        }
    ]);
    assert_eq!(
        classify_checks(pages, no_statuses()).assert_value(),
        GitHubChecks::Pending
    );
    assert_eq!(
        classify_checks(
            json!([{
                "total_count": 2,
                "check_runs": [check_run("only page", "completed", Some("success"))]
            }]),
            no_statuses()
        )
        .assert_value(),
        GitHubChecks::Pending
    );
    assert_eq!(
        classify_checks(
            json!([
                {
                    "total_count": 2,
                    "check_runs": [check_run("page boundary", "completed", Some("success"))]
                },
                {
                    "total_count": 2,
                    "check_runs": [check_run("page boundary", "completed", Some("success"))]
                }
            ]),
            no_statuses()
        )
        .assert_value(),
        GitHubChecks::Pending
    );
    assert_eq!(
        classify_checks(
            json!([
                {
                    "total_count": 2,
                    "check_runs": [check_run("scope", "completed", Some("success"))]
                },
                {
                    "total_count": 3,
                    "check_runs": [check_run("matrix shard", "completed", Some("success"))]
                }
            ]),
            no_statuses()
        )
        .assert_value(),
        GitHubChecks::Pending
    );
    assert!(matches!(
        classify_checks(
            json!([{
                "total_count": 2,
                "check_runs": [check_run("failed shard", "completed", Some("failure"))]
            }]),
            no_statuses()
        )
        .assert_value(),
        GitHubChecks::Failed { .. }
    ));
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
    let changed = review_wire("other", None);
    assert!(review_receipt(changed, &request).is_err());
}

#[test]
fn open_nonmergeable_review_is_an_authoritative_conflict() {
    assert!(matches!(
        classify_review(&review_wire("main", Some(false))).assert_value(),
        ReviewClassification::Conflict
    ));
    assert!(matches!(
        classify_review(&review_wire("main", None)).assert_value(),
        ReviewClassification::Open
    ));
}

fn review_wire(base_branch: &str, mergeable: Option<bool>) -> PullRequestWire {
    serde_json::from_value(json!({
        "number":17,"state":"open","merged":false,"merge_commit_sha":null,
        "mergeable":mergeable,
        "base":{
            "ref":base_branch,"sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "repo":{"full_name":"acme/project"}
        },
        "head":{
            "ref":"zeroshot/v2-run","sha":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            "repo":{"full_name":"acme/project"}
        }
    }))
    .assert_value()
}
