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
    round_trip(&SourceProviderId::new("source.github").assert_value());
    round_trip(&IssueProviderId::new("issue.linear").assert_value());
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
            .map(|url| SourcePublicUrl::new(url).assert_value())
            .collect();
        assert!(
            SourceRepositoryInspection::new(
                repository(),
                SourceRevisionId::new("head").assert_value(),
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
            SourceRevisionId::new("head").assert_value(),
            too_many_urls
                .iter()
                .map(|url| SourcePublicUrl::new(url).assert_value())
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
            .assert_value();
    for count in [63, 64] {
        let profiles = (0..count)
            .map(|index| {
                (
                    SourceProfileId::new(format!("profile-{index}")).assert_value(),
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
                SourceProfileId::new(format!("profile-{index}")).assert_value(),
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
    let empty_size = serde_json::to_vec(&value).assert_value().len();
    let delta = target.checked_sub(empty_size).assert_value();
    let (count, character_bytes) = (1..=64)
        .find_map(|count| {
            let syntax_bytes = 3 * count - 1;
            let character_bytes = delta.checked_sub(syntax_bytes)?;
            (count <= character_bytes && character_bytes <= count * 2_048)
                .then_some((count, character_bytes))
        })
        .assert_value_with("target must fit bounded URL evidence");
    let mut remaining = character_bytes;
    let mut urls = Vec::with_capacity(count);
    for index in 0..count {
        let remaining_entries = count - index - 1;
        let length = remaining.saturating_sub(remaining_entries).clamp(1, 2_048);
        urls.push("u".repeat(length));
        remaining -= length;
    }
    assert_eq!(remaining, 0);
    *value.get_mut("publicUrls").assert_value() = json!(urls);
    assert_eq!(serde_json::to_vec(&value).assert_value().len(), target);
    value
}

#[test]
fn serialized_bound_accepts_65535_and_65536_and_rejects_65537() {
    for size in [65_535, 65_536] {
        let value = inspection_value_with_size(size);
        let inspection: SourceRepositoryInspection =
            serde_json::from_value(value.clone()).assert_value();
        assert_eq!(serde_json::to_vec(&inspection).assert_value().len(), size);
        let urls = value
            .get("publicUrls")
            .assert_value()
            .as_array()
            .assert_value()
            .iter()
            .map(|url| SourcePublicUrl::new(url.as_str().assert_value()).assert_value())
            .collect();
        let constructed = SourceRepositoryInspection::new(
            repository(),
            SourceRevisionId::new("r").assert_value(),
            urls,
        )
        .assert_value();
        assert_eq!(serde_json::to_vec(&constructed).assert_value().len(), size);
    }
    let value = inspection_value_with_size(65_537);
    assert!(serde_json::from_value::<SourceRepositoryInspection>(value.clone()).is_err());
    let urls = value
        .get("publicUrls")
        .assert_value()
        .as_array()
        .assert_value()
        .iter()
        .map(|url| SourcePublicUrl::new(url.as_str().assert_value()).assert_value())
        .collect();
    assert!(
        SourceRepositoryInspection::new(
            repository(),
            SourceRevisionId::new("r").assert_value(),
            urls,
        )
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
            SourceProfileDescriptor::new(source_capabilities.clone(), BTreeSet::new())
                .assert_value(),
        )]),
    )
    .assert_value();
    round_trip(&source_descriptor);
    assert_eq!(
        source_descriptor
            .profile(&source_profile())
            .assert_value()
            .capabilities(),
        &source_capabilities
    );

    let issue_capabilities = BTreeSet::from([IssueCapability::Read, IssueCapability::Close]);
    let issue_descriptor = IssueProviderDescriptor::new(
        issue_reference(),
        BTreeMap::from([(
            issue_profile(),
            IssueProfileDescriptor::new(issue_capabilities.clone(), BTreeSet::new()).assert_value(),
        )]),
    )
    .assert_value();
    round_trip(&issue_descriptor);
    assert_eq!(
        issue_descriptor
            .profile(&issue_profile())
            .assert_value()
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
            SourceAccountId::new("open-engine").assert_value(),
            SourceCredentialHandleId::new("github-lease").assert_value(),
        ),
        SourceRepositoryReference::new("the-open-engine/zeroshot").assert_value(),
    )
    .assert_value();
    let inspect = SourceInspectRepositoryRequest::new(
        repository.clone(),
        SourceCredentialHandleId::new("github-lease").assert_value(),
    )
    .assert_value();
    let repository_inspection = SourceRepositoryInspection::new(
        repository.clone(),
        SourceRevisionId::new("head").assert_value(),
        Vec::new(),
    )
    .assert_value();
    let materialize = SourceMaterializeRequest::new(
        repository.clone(),
        SourceCredentialHandleId::new("github-lease").assert_value(),
        SourceRevisionId::new("head").assert_value(),
    )
    .assert_value();
    let materialized = SourceMaterializationReceipt::new(
        repository.clone(),
        SourceRevisionId::new("head").assert_value(),
        SourceContentDigest::new(digest('c')).assert_value(),
    )
    .assert_value();
    for value in [
        serde_json::to_value(&identify).assert_value(),
        serde_json::to_value(&inspect).assert_value(),
        serde_json::to_value(&repository_inspection).assert_value(),
        serde_json::to_value(&materialize).assert_value(),
        serde_json::to_value(&materialized).assert_value(),
    ] {
        assert!(serde_json::to_vec(&value).assert_value().len() <= 65_536);
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
            expected_parent: SourceRevisionId::new("base").assert_value(),
            branch: SourceBranchId::new("feature").assert_value(),
            pre_effect: SourceStateDigest::new(digest('1')).assert_value(),
        },
        SourceOperation::Commit {
            expected_head: SourceRevisionId::new("head").assert_value(),
            branch: SourceBranchId::new("feature").assert_value(),
            message_digest: SourceMessageDigest::new(digest('2')).assert_value(),
            change_digest: SourceContentDigest::new(digest('d')).assert_value(),
            pre_effect: SourceStateDigest::new(digest('3')).assert_value(),
        },
        SourceOperation::Push {
            expected_head: SourceRevisionId::new("head").assert_value(),
            branch: SourceBranchId::new("feature").assert_value(),
            remote: SourceRemoteId::new("origin").assert_value(),
            expected_remote_head: Some(SourceRevisionId::new("base").assert_value()),
            revision: SourceRevisionId::new("next").assert_value(),
            pre_effect: SourceStateDigest::new(digest('4')).assert_value(),
        },
        SourceOperation::PullRequest {
            review: review.clone(),
            expected_base: SourceRevisionId::new("base").assert_value(),
            expected_head: SourceRevisionId::new("head").assert_value(),
            checked_revision: SourceRevisionId::new("head").assert_value(),
            policy: policy.clone(),
        },
        SourceOperation::Checks {
            review: review.clone(),
            expected_base: SourceRevisionId::new("base").assert_value(),
            expected_head: SourceRevisionId::new("head").assert_value(),
            checked_revision: SourceRevisionId::new("head").assert_value(),
            policy: policy.clone(),
        },
        SourceOperation::AutoMerge {
            review: review.clone(),
            expected_base: SourceRevisionId::new("base").assert_value(),
            expected_head: SourceRevisionId::new("head").assert_value(),
            checked_revision: SourceRevisionId::new("head").assert_value(),
            policy: policy.clone(),
        },
        SourceOperation::MergeQueue {
            review: review.clone(),
            expected_base: SourceRevisionId::new("base").assert_value(),
            expected_head: SourceRevisionId::new("head").assert_value(),
            checked_revision: SourceRevisionId::new("head").assert_value(),
            policy: policy.clone(),
        },
        SourceOperation::Merge {
            review,
            expected_base: SourceRevisionId::new("base").assert_value(),
            expected_head: SourceRevisionId::new("head").assert_value(),
            checked_revision: SourceRevisionId::new("head").assert_value(),
            policy,
            integrated_revision: SourceRevisionId::new("merge").assert_value(),
        },
    ];
    for (index, operation) in operations.into_iter().enumerate() {
        round_trip(
            &SourceOperationRequest::new(
                repository.clone(),
                SourceCredentialHandleId::new("github-lease").assert_value(),
                (
                    SourceWorkspaceId::new(digest('8')).assert_value(),
                    SourceOperationId::new(format!("operation-{index}")).assert_value(),
                ),
                operation,
            )
            .assert_value(),
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
            observed_fingerprint: SourceOperationFingerprint::new(digest('f')).assert_value(),
        },
        SourceOperationInspection::Indeterminate {
            evidence: SourceFailureMessage::new("unknown outcome").assert_value(),
        },
    ] {
        round_trip(&inspection);
    }
}

#[path = "cases/issue_cases.rs"]
mod issue_cases;

use openengine_cluster_testkit::assertions::{AssertValue};
