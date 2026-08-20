use openengine_cluster_testkit::assertions::AssertValue;
use serde_json::json;

use super::*;
use crate::native_v2_delivery::DeliveryTarget;

#[test]
fn basic_credential_encoding_is_canonical() {
    assert_eq!(
        encode_basic_credential("token"),
        "eC1hY2Nlc3MtdG9rZW46dG9rZW4="
    );
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
