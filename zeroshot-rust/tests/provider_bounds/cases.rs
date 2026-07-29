use super::*;

#[test]
fn provider_ids_enforce_every_exact_boundary_and_syntax() {
    for length in [63, 64] {
        let value = "a".repeat(length);
        assert!(SourceProviderId::new(value.clone()).is_ok());
        assert!(IssueProviderId::new(value.clone()).is_ok());
        assert!(serde_json::from_value::<SourceProviderId>(json!(value.clone())).is_ok());
        assert!(serde_json::from_value::<IssueProviderId>(json!(value)).is_ok());
    }
    let above = "a".repeat(65);
    assert!(SourceProviderId::new(above.clone()).is_err());
    assert!(IssueProviderId::new(above.clone()).is_err());
    assert!(serde_json::from_value::<SourceProviderId>(json!(above.clone())).is_err());
    assert!(serde_json::from_value::<IssueProviderId>(json!(above)).is_err());
    for invalid in [
        "",
        ".source",
        "Source.github",
        "source/github",
        "source\ngithub",
    ] {
        assert!(SourceProviderId::new(invalid).is_err(), "{invalid:?}");
        assert!(IssueProviderId::new(invalid).is_err(), "{invalid:?}");
        assert!(serde_json::from_value::<SourceProviderId>(json!(invalid)).is_err());
        assert!(serde_json::from_value::<IssueProviderId>(json!(invalid)).is_err());
    }
    round_trip(&SourceProviderId::new("source.github").unwrap());
    round_trip(&IssueProviderId::new("issue.linear").unwrap());
}

#[test]
fn profile_account_credential_and_operation_ids_enforce_128_character_bound() {
    assert_text_bounds!(SourceProfileId, 128);
    assert_text_bounds!(SourceAccountId, 128);
    assert_text_bounds!(SourceCredentialHandleId, 128);
    assert_text_bounds!(SourceOperationId, 128);
    assert_text_bounds!(IssueProfileId, 128);
    assert_text_bounds!(IssueAccountId, 128);
    assert_text_bounds!(IssueCredentialHandleId, 128);
    assert_text_bounds!(IssueOperationId, 128);
    assert!(SourceProfileId::new("é".repeat(128)).is_ok());
    assert!(SourceProfileId::new("é".repeat(129)).is_err());
}

#[test]
fn external_identities_enforce_256_character_bound() {
    assert_text_bounds!(SourceRepositoryReference, 256);
    assert_text_bounds!(SourceRepositoryId, 256);
    assert_text_bounds!(SourceRevisionId, 256);
    assert_text_bounds!(SourceBranchId, 256);
    assert_text_bounds!(IssueReference, 256);
    assert_text_bounds!(IssueId, 256);
    assert!(IssueId::new("é".repeat(256)).is_ok());
    assert!(IssueId::new("é".repeat(257)).is_err());
}

#[test]
fn public_urls_enforce_2048_byte_bound() {
    assert_text_bounds!(SourcePublicUrl, 2_048);
    assert_text_bounds!(IssuePublicUrl, 2_048);
    assert!(SourcePublicUrl::new("é".repeat(1_024)).is_ok());
    assert!(SourcePublicUrl::new(format!("{}x", "é".repeat(1_024))).is_err());
}

#[test]
fn collections_enforce_64_entry_bound_during_construction_and_deserialization() {
    for count in [63, 64] {
        let raw_urls = (0..count)
            .map(|index| format!("https://example.test/{index}"))
            .collect::<Vec<_>>();
        let urls = raw_urls
            .iter()
            .map(|url| SourcePublicUrl::new(url).unwrap())
            .collect();
        assert!(
            SourceRepositoryInspection::new(
                repository(),
                SourceRevisionId::new("head").unwrap(),
                urls,
            )
            .is_ok()
        );
        assert!(
            serde_json::from_value::<SourceRepositoryInspection>(json!({
                "repository": repository(),
                "defaultRevision": "head",
                "publicUrls": raw_urls,
            }))
            .is_ok()
        );
    }
    let too_many_urls = (0..65)
        .map(|index| format!("https://example.test/{index}"))
        .collect::<Vec<_>>();
    assert!(
        SourceRepositoryInspection::new(
            repository(),
            SourceRevisionId::new("head").unwrap(),
            too_many_urls
                .iter()
                .map(|url| SourcePublicUrl::new(url).unwrap())
                .collect(),
        )
        .is_err()
    );
    assert!(
        serde_json::from_value::<SourceRepositoryInspection>(json!({
            "repository": repository(),
            "defaultRevision": "head",
            "publicUrls": too_many_urls,
        }))
        .is_err()
    );

    let profile_descriptor =
        SourceProfileDescriptor::new(BTreeSet::from([SourceCapability::Read]), BTreeSet::new())
            .unwrap();
    for count in [63, 64] {
        let profiles = (0..count)
            .map(|index| {
                (
                    SourceProfileId::new(format!("profile-{index}")).unwrap(),
                    profile_descriptor.clone(),
                )
            })
            .collect::<BTreeMap<_, _>>();
        let wire = json!({ "provider": source_reference(), "profiles": profiles.clone() });
        assert!(SourceProviderDescriptor::new(source_reference(), profiles).is_ok());
        assert!(serde_json::from_value::<SourceProviderDescriptor>(wire).is_ok());
    }
    let profiles = (0..65)
        .map(|index| {
            (
                SourceProfileId::new(format!("profile-{index}")).unwrap(),
                profile_descriptor.clone(),
            )
        })
        .collect::<BTreeMap<_, _>>();
    let wire = json!({ "provider": source_reference(), "profiles": profiles.clone() });
    assert!(SourceProviderDescriptor::new(source_reference(), profiles).is_err());
    assert!(serde_json::from_value::<SourceProviderDescriptor>(wire).is_err());
}

fn inspection_value_with_size(target: usize) -> Value {
    let mut value = json!({
        "repository": repository(),
        "defaultRevision": "r",
        "publicUrls": [],
    });
    let empty_size = serde_json::to_vec(&value).unwrap().len();
    let delta = target.checked_sub(empty_size).unwrap();
    let (count, character_bytes) = (1..=64)
        .find_map(|count| {
            let syntax_bytes = 3 * count - 1;
            let character_bytes = delta.checked_sub(syntax_bytes)?;
            (count <= character_bytes && character_bytes <= count * 2_048)
                .then_some((count, character_bytes))
        })
        .expect("target must fit bounded URL evidence");
    let mut remaining = character_bytes;
    let mut urls = Vec::with_capacity(count);
    for index in 0..count {
        let remaining_entries = count - index - 1;
        let length = remaining.saturating_sub(remaining_entries).clamp(1, 2_048);
        urls.push("u".repeat(length));
        remaining -= length;
    }
    assert_eq!(remaining, 0);
    value["publicUrls"] = json!(urls);
    assert_eq!(serde_json::to_vec(&value).unwrap().len(), target);
    value
}

#[test]
fn serialized_bound_accepts_65535_and_65536_and_rejects_65537() {
    for size in [65_535, 65_536] {
        let value = inspection_value_with_size(size);
        let inspection: SourceRepositoryInspection = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(serde_json::to_vec(&inspection).unwrap().len(), size);
        let urls = value["publicUrls"]
            .as_array()
            .unwrap()
            .iter()
            .map(|url| SourcePublicUrl::new(url.as_str().unwrap()).unwrap())
            .collect();
        let constructed = SourceRepositoryInspection::new(
            repository(),
            SourceRevisionId::new("r").unwrap(),
            urls,
        )
        .unwrap();
        assert_eq!(serde_json::to_vec(&constructed).unwrap().len(), size);
    }
    let value = inspection_value_with_size(65_537);
    assert!(serde_json::from_value::<SourceRepositoryInspection>(value.clone()).is_err());
    let urls = value["publicUrls"]
        .as_array()
        .unwrap()
        .iter()
        .map(|url| SourcePublicUrl::new(url.as_str().unwrap()).unwrap())
        .collect();
    assert!(
        SourceRepositoryInspection::new(repository(), SourceRevisionId::new("r").unwrap(), urls,)
            .is_err()
    );
}

#[test]
fn descriptors_and_all_closed_capabilities_round_trip() {
    let source_capabilities = BTreeSet::from([
        SourceCapability::Read,
        SourceCapability::Branch,
        SourceCapability::Commit,
        SourceCapability::Push,
        SourceCapability::PullRequest,
        SourceCapability::Checks,
        SourceCapability::AutoMerge,
        SourceCapability::MergeQueue,
        SourceCapability::Merge,
    ]);
    let source_descriptor = SourceProviderDescriptor::new(
        source_reference(),
        BTreeMap::from([(
            source_profile(),
            SourceProfileDescriptor::new(source_capabilities.clone(), BTreeSet::new()).unwrap(),
        )]),
    )
    .unwrap();
    round_trip(&source_descriptor);
    assert_eq!(
        source_descriptor
            .profile(&source_profile())
            .unwrap()
            .capabilities(),
        &source_capabilities
    );

    let issue_capabilities = BTreeSet::from([IssueCapability::Read, IssueCapability::Close]);
    let issue_descriptor = IssueProviderDescriptor::new(
        issue_reference(),
        BTreeMap::from([(
            issue_profile(),
            IssueProfileDescriptor::new(issue_capabilities.clone(), BTreeSet::new()).unwrap(),
        )]),
    )
    .unwrap();
    round_trip(&issue_descriptor);
    assert_eq!(
        issue_descriptor
            .profile(&issue_profile())
            .unwrap()
            .capabilities(),
        &issue_capabilities
    );
}

#[test]
fn repository_requests_and_inspections_round_trip() {
    let repository = repository();
    let identify = SourceIdentifyRepositoryRequest::new(
        source_reference(),
        source_profile(),
        (
            SourceAccountId::new("open-engine").unwrap(),
            SourceCredentialHandleId::new("github-lease").unwrap(),
        ),
        SourceRepositoryReference::new("the-open-engine/zeroshot").unwrap(),
    )
    .unwrap();
    let inspect = SourceInspectRepositoryRequest::new(
        repository.clone(),
        SourceCredentialHandleId::new("github-lease").unwrap(),
    )
    .unwrap();
    let repository_inspection = SourceRepositoryInspection::new(
        repository.clone(),
        SourceRevisionId::new("head").unwrap(),
        Vec::new(),
    )
    .unwrap();
    let materialize = SourceMaterializeRequest::new(
        repository.clone(),
        SourceCredentialHandleId::new("github-lease").unwrap(),
        SourceRevisionId::new("head").unwrap(),
    )
    .unwrap();
    let materialized = SourceMaterializationReceipt::new(
        repository.clone(),
        SourceRevisionId::new("head").unwrap(),
        SourceContentDigest::new(digest('c')).unwrap(),
    )
    .unwrap();
    for value in [
        serde_json::to_value(&identify).unwrap(),
        serde_json::to_value(&inspect).unwrap(),
        serde_json::to_value(&repository_inspection).unwrap(),
        serde_json::to_value(&materialize).unwrap(),
        serde_json::to_value(&materialized).unwrap(),
    ] {
        assert!(serde_json::to_vec(&value).unwrap().len() <= 65_536);
    }
    round_trip(&identify);
    round_trip(&inspect);
    round_trip(&repository_inspection);
    round_trip(&materialize);
    round_trip(&materialized);
}

#[test]
fn source_operations_inspections_and_receipts_round_trip() {
    let repository = repository();
    let review = source_review();
    let policy = source_policy();
    let operations = [
        SourceOperation::Branch {
            expected_parent: SourceRevisionId::new("base").unwrap(),
            branch: SourceBranchId::new("feature").unwrap(),
            pre_effect: SourceStateDigest::new(digest('1')).unwrap(),
        },
        SourceOperation::Commit {
            expected_head: SourceRevisionId::new("head").unwrap(),
            branch: SourceBranchId::new("feature").unwrap(),
            message_digest: SourceMessageDigest::new(digest('2')).unwrap(),
            change_digest: SourceContentDigest::new(digest('d')).unwrap(),
            pre_effect: SourceStateDigest::new(digest('3')).unwrap(),
        },
        SourceOperation::Push {
            expected_head: SourceRevisionId::new("head").unwrap(),
            branch: SourceBranchId::new("feature").unwrap(),
            remote: SourceRemoteId::new("origin").unwrap(),
            expected_remote_head: Some(SourceRevisionId::new("base").unwrap()),
            revision: SourceRevisionId::new("next").unwrap(),
            pre_effect: SourceStateDigest::new(digest('4')).unwrap(),
        },
        SourceOperation::PullRequest {
            review: review.clone(),
            expected_base: SourceRevisionId::new("base").unwrap(),
            expected_head: SourceRevisionId::new("head").unwrap(),
            checked_revision: SourceRevisionId::new("head").unwrap(),
            policy: policy.clone(),
        },
        SourceOperation::Checks {
            review: review.clone(),
            expected_base: SourceRevisionId::new("base").unwrap(),
            expected_head: SourceRevisionId::new("head").unwrap(),
            checked_revision: SourceRevisionId::new("head").unwrap(),
            policy: policy.clone(),
        },
        SourceOperation::AutoMerge {
            review: review.clone(),
            expected_base: SourceRevisionId::new("base").unwrap(),
            expected_head: SourceRevisionId::new("head").unwrap(),
            checked_revision: SourceRevisionId::new("head").unwrap(),
            policy: policy.clone(),
        },
        SourceOperation::MergeQueue {
            review: review.clone(),
            expected_base: SourceRevisionId::new("base").unwrap(),
            expected_head: SourceRevisionId::new("head").unwrap(),
            checked_revision: SourceRevisionId::new("head").unwrap(),
            policy: policy.clone(),
        },
        SourceOperation::Merge {
            review,
            expected_base: SourceRevisionId::new("base").unwrap(),
            expected_head: SourceRevisionId::new("head").unwrap(),
            checked_revision: SourceRevisionId::new("head").unwrap(),
            policy,
            integrated_revision: SourceRevisionId::new("merge").unwrap(),
        },
    ];
    for (index, operation) in operations.into_iter().enumerate() {
        round_trip(
            &SourceOperationRequest::new(
                repository.clone(),
                SourceCredentialHandleId::new("github-lease").unwrap(),
                (
                    SourceWorkspaceId::new(digest('8')).unwrap(),
                    SourceOperationId::new(format!("operation-{index}")).unwrap(),
                ),
                operation,
            )
            .unwrap(),
        );
    }

    let merge = merge_receipt();
    let source_receipt = SourceOperationReceipt::Merge(merge.clone());
    round_trip(&merge);
    round_trip(&source_receipt);
    for inspection in [
        SourceOperationInspection::Unobserved,
        SourceOperationInspection::Pending,
        SourceOperationInspection::Applied(Box::new(source_receipt)),
        SourceOperationInspection::Conflict {
            observed_fingerprint: SourceOperationFingerprint::new(digest('f')).unwrap(),
        },
        SourceOperationInspection::Indeterminate {
            evidence: SourceFailureMessage::new("unknown outcome").unwrap(),
        },
    ] {
        round_trip(&inspection);
    }
}

#[test]
fn issue_requests_inspections_and_receipts_round_trip() {
    let resolve = IssueResolveRequest::new(
        issue_reference(),
        issue_profile(),
        (
            IssueAccountId::new("open-engine-linear").unwrap(),
            IssueCredentialHandleId::new("linear-lease").unwrap(),
        ),
        IssueReference::new("ENG-1").unwrap(),
    )
    .unwrap();
    let close = close_request();
    let close_receipt = IssueCloseReceipt::new(
        close.issue().clone(),
        (close.operation_id().clone(), close.fingerprint().clone()),
        close.source_merge().clone(),
        Vec::new(),
    )
    .unwrap();
    round_trip(&resolve);
    round_trip(&resolved_issue());
    round_trip(&close);
    round_trip(&close_receipt);
    for inspection in [
        IssueCloseInspection::Unobserved,
        IssueCloseInspection::Pending,
        IssueCloseInspection::Applied(Box::new(close_receipt)),
        IssueCloseInspection::Conflict {
            observed_fingerprint: IssueOperationFingerprint::new(digest('0')).unwrap(),
        },
        IssueCloseInspection::Indeterminate {
            evidence: IssueFailureMessage::new("unknown outcome").unwrap(),
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
    .unwrap();
    let values = [
        serde_json::to_value(
            SourceRepositoryInspection::new(
                repository(),
                SourceRevisionId::new("head").unwrap(),
                vec![SourcePublicUrl::new("https://github.com/repository").unwrap()],
            )
            .unwrap(),
        )
        .unwrap(),
        serde_json::to_value(SourceOperationInspection::Applied(Box::new(
            SourceOperationReceipt::Merge(merge),
        )))
        .unwrap(),
        serde_json::to_value(close).unwrap(),
        serde_json::to_value(IssueCloseInspection::Applied(Box::new(close_receipt))).unwrap(),
    ];
    for value in values {
        assert!(serde_json::to_vec(&value).unwrap().len() <= 65_536);
        assert_secret_free(&value);
    }
}
