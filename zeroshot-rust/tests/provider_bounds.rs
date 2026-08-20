use std::collections::{BTreeMap, BTreeSet};
use std::fmt::Debug;

use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::{json, Value};
use zeroshot_engine::issue_provider::*;
use zeroshot_engine::source_code_provider::*;

fn digest(character: char) -> String {
    std::iter::repeat_n(character, 64).collect()
}

fn round_trip<T>(value: &T)
where
    T: Serialize + DeserializeOwned + Debug + PartialEq,
{
    let encoded = serde_json::to_vec(value).assert_value();
    assert!(encoded.len() <= 65_536, "{} bytes", encoded.len());
    assert_eq!(serde_json::from_slice::<T>(&encoded).assert_value(), *value);
}

macro_rules! assert_text_bounds {
    ($type:path, $maximum:expr) => {{
        let below = "x".repeat($maximum - 1);
        let at = "x".repeat($maximum);
        let above = "x".repeat($maximum + 1);
        assert!(<$type>::new(below.clone()).is_ok());
        assert!(<$type>::new(at.clone()).is_ok());
        assert!(<$type>::new(above.clone()).is_err());
        assert!(serde_json::from_value::<$type>(json!(below)).is_ok());
        assert!(serde_json::from_value::<$type>(json!(at)).is_ok());
        assert!(serde_json::from_value::<$type>(json!(above)).is_err());
        assert!(<$type>::new("").is_err());
        assert!(<$type>::new("visible\ncontrol").is_err());
    }};
}

fn source_reference() -> SourceProviderRef {
    SourceProviderRef::new(SourceProviderId::new("source.github").assert_value(), 1).assert_value()
}

fn source_profile() -> SourceProfileId {
    SourceProfileId::new("production").assert_value()
}

fn repository() -> CanonicalRepository {
    CanonicalRepository::new(
        source_reference(),
        source_profile(),
        SourceAccountId::new("open-engine").assert_value(),
        SourceRepositoryId::new("the-open-engine/zeroshot").assert_value(),
    )
    .assert_value()
}
fn source_review() -> SourceReviewIdentity {
    SourceReviewIdentity::new(
        SourceReviewId::new("review-1").assert_value(),
        SourceBranchId::new("main").assert_value(),
        SourceBranchId::new("feature").assert_value(),
    )
    .assert_value()
}

fn source_policy() -> SourceRequiredPolicy {
    SourceRequiredPolicy::new(
        SourcePolicyDigest::new(digest('9')).assert_value(),
        BTreeMap::from([(
            SourceCheckId::new("required/build").assert_value(),
            SourceCheckConclusion::Satisfied,
        )]),
    )
    .assert_value()
}

fn merge_request() -> SourceOperationRequest {
    SourceOperationRequest::new(
        repository(),
        SourceCredentialHandleId::new("github-lease").assert_value(),
        (
            SourceWorkspaceId::new(digest('8')).assert_value(),
            SourceOperationId::new("merge-1").assert_value(),
        ),
        SourceOperation::Merge {
            review: source_review(),
            expected_base: SourceRevisionId::new("base-sha").assert_value(),
            expected_head: SourceRevisionId::new("head-sha").assert_value(),
            checked_revision: SourceRevisionId::new("head-sha").assert_value(),
            policy: source_policy(),
            integrated_revision: SourceRevisionId::new("merge-sha").assert_value(),
        },
    )
    .assert_value()
}

fn merge_receipt() -> SourceMergeReceipt {
    SourceMergeReceipt::new(
        merge_request(),
        SourceRevisionId::new("merge-sha").assert_value(),
    )
    .assert_value()
}

fn issue_reference() -> IssueProviderRef {
    IssueProviderRef::new(IssueProviderId::new("issue.linear").assert_value(), 1).assert_value()
}

fn issue_profile() -> IssueProfileId {
    IssueProfileId::new("production").assert_value()
}

fn resolved_issue() -> ResolvedIssue {
    ResolvedIssue::new(
        issue_reference(),
        issue_profile(),
        (
            IssueAccountId::new("open-engine-linear").assert_value(),
            IssueId::new("ENG-1").assert_value(),
        ),
        (
            IssueState::Open,
            vec![IssuePublicUrl::new("https://linear.app/issue/ENG-1").assert_value()],
        ),
    )
    .assert_value()
}

fn close_request() -> IssueCloseRequest {
    IssueCloseRequest::new(
        resolved_issue(),
        IssueCredentialHandleId::new("linear-lease").assert_value(),
        (
            IssueOperationId::new("close-ENG-1").assert_value(),
            IssueOperationFingerprint::new(digest('b')).assert_value(),
        ),
        merge_receipt(),
    )
    .assert_value()
}

#[test]
fn fingerprints_and_digests_are_exact_lowercase_hex() {
    for value in [digest('0'), digest('a'), digest('f')] {
        round_trip(&SourceOperationFingerprint::new(value.clone()).assert_value());
        round_trip(&SourceContentDigest::new(value.clone()).assert_value());
        round_trip(&IssueOperationFingerprint::new(value).assert_value());
    }
    for invalid in [
        "a".repeat(63),
        "a".repeat(65),
        "A".repeat(64),
        "g".repeat(64),
        format!("{}-", "a".repeat(63)),
    ] {
        assert!(SourceOperationFingerprint::new(invalid.clone()).is_err());
        assert!(SourceContentDigest::new(invalid.clone()).is_err());
        assert!(IssueOperationFingerprint::new(invalid.clone()).is_err());
        assert!(
            serde_json::from_value::<SourceOperationFingerprint>(json!(invalid.clone())).is_err()
        );
        assert!(serde_json::from_value::<SourceContentDigest>(json!(invalid.clone())).is_err());
        assert!(serde_json::from_value::<IssueOperationFingerprint>(json!(invalid)).is_err());
    }
}

#[test]
fn bounded_provider_failure_evidence_round_trips() {
    for code in [
        SourceProviderFailureCode::Unavailable,
        SourceProviderFailureCode::Unauthorized,
        SourceProviderFailureCode::InvalidRequest,
        SourceProviderFailureCode::Conflict,
        SourceProviderFailureCode::Indeterminate,
    ] {
        round_trip(
            &SourceProviderFailure::new(
                code,
                SourceFailureMessage::new("bounded source failure evidence").assert_value(),
            )
            .assert_value(),
        );
    }
    for code in [
        IssueProviderFailureCode::Unavailable,
        IssueProviderFailureCode::Unauthorized,
        IssueProviderFailureCode::InvalidRequest,
        IssueProviderFailureCode::Conflict,
        IssueProviderFailureCode::Indeterminate,
    ] {
        round_trip(
            &IssueProviderFailure::new(
                code,
                IssueFailureMessage::new("bounded issue failure evidence").assert_value(),
            )
            .assert_value(),
        );
    }
}

#[test]
fn operation_specific_source_receipts_round_trip_and_reject_cross_operation_use() {
    let request = SourceOperationRequest::new(
        repository(),
        SourceCredentialHandleId::new("github-lease").assert_value(),
        (
            SourceWorkspaceId::new(digest('8')).assert_value(),
            SourceOperationId::new("branch-1").assert_value(),
        ),
        SourceOperation::Branch {
            expected_parent: SourceRevisionId::new("branch-sha").assert_value(),
            branch: SourceBranchId::new("feature").assert_value(),
            pre_effect: SourceStateDigest::new(digest('c')).assert_value(),
        },
    )
    .assert_value();
    let receipt = SourceBranchReceipt::new(
        request.clone(),
        SourceRevisionId::new("branch-sha").assert_value(),
    )
    .assert_value();
    round_trip(&receipt);
    round_trip(&SourceOperationReceipt::Branch(receipt));
    assert!(
        SourceMergeReceipt::new(request, SourceRevisionId::new("branch-sha").assert_value())
            .is_err()
    );
}

#[path = "provider_bounds/cases.rs"]
mod cases;

use openengine_cluster_testkit::assertions::{AssertValue};
