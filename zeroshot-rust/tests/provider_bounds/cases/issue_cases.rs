use super::*;

#[test]
fn issue_requests_inspections_and_receipts_round_trip() {
    let resolve = IssueResolveRequest::new(
        issue_reference(),
        issue_profile(),
        (
            IssueAccountId::new("open-engine-linear").assert_value(),
            IssueCredentialHandleId::new("linear-lease").assert_value(),
        ),
        IssueReference::new("ENG-1").assert_value(),
    )
    .assert_value();
    let close = close_request();
    let close_receipt = IssueCloseReceipt::new(
        close.issue().clone(),
        (close.operation_id().clone(), close.fingerprint().clone()),
        close.source_merge().clone(),
        Vec::new(),
    )
    .assert_value();
    round_trip(&resolve);
    round_trip(&resolved_issue());
    round_trip(&close);
    round_trip(&close_receipt);
    for inspection in [
        IssueCloseInspection::Unobserved,
        IssueCloseInspection::Pending,
        IssueCloseInspection::Applied(Box::new(close_receipt)),
        IssueCloseInspection::Conflict {
            observed_fingerprint: IssueOperationFingerprint::new(digest('0')).assert_value(),
        },
        IssueCloseInspection::Indeterminate {
            evidence: IssueFailureMessage::new("unknown outcome").assert_value(),
        },
    ] {
        round_trip(&inspection);
    }
}

fn assert_secret_free(value: &Value) {
    const FORBIDDEN_KEYS: &[&str] = &[
        "body",
        "diff",
        "fileContent",
        "path",
        "command",
        "endpoint",
        "credentialValue",
        "rawResponse",
        "stdout",
        "stderr",
    ];
    match value {
        Value::Object(fields) => {
            for (key, value) in fields {
                assert!(
                    !FORBIDDEN_KEYS.contains(&key.as_str()),
                    "forbidden key {key}"
                );
                assert_secret_free(value);
            }
        }
        Value::Array(values) => values.iter().for_each(assert_secret_free),
        Value::String(value) => assert_ne!(value, "TOP-SECRET-CREDENTIAL"),
        _ => {}
    }
}

#[test]
fn serialized_contracts_are_bounded_and_secret_free() {
    let merge = merge_receipt();
    let close = close_request();
    let close_receipt = IssueCloseReceipt::new(
        close.issue().clone(),
        (close.operation_id().clone(), close.fingerprint().clone()),
        merge.clone(),
        Vec::new(),
    )
    .assert_value();
    let values = [
        serde_json::to_value(
            SourceRepositoryInspection::new(
                repository(),
                SourceRevisionId::new("head").assert_value(),
                vec![SourcePublicUrl::new("https://github.com/repository").assert_value()],
            )
            .assert_value(),
        )
        .assert_value(),
        serde_json::to_value(SourceOperationInspection::Applied(Box::new(
            SourceOperationReceipt::Merge(merge),
        )))
        .assert_value(),
        serde_json::to_value(close).assert_value(),
        serde_json::to_value(IssueCloseInspection::Applied(Box::new(close_receipt))).assert_value(),
    ];
    for value in values {
        assert!(serde_json::to_vec(&value).assert_value().len() <= 65_536);
        assert_secret_free(&value);
    }
}
