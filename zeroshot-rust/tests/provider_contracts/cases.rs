use super::*;

#[test]
fn source_registry_exact_lookup_and_errors_are_deterministic() {
    let reference = source_ref("source.github", 1);
    let provider = Arc::new(FakeSourceProvider::new(
        source_descriptor(reference.clone(), [SourceCapability::Read], []),
        SourceOperationInspection::Unobserved,
    ));
    let mut registry = SourceCodeProviderRegistry::new();
    registry.register(provider.clone()).assert_value();
    assert_eq!(
        registry.lookup(&reference).assert_value().descriptor(),
        provider.descriptor()
    );
    assert_eq!(
        registry.register(provider).assert_error(),
        SourceRegistryError::DuplicateRegistration {
            provider: reference.clone()
        }
    );
    assert_eq!(
        registry
            .lookup(&source_ref("source.bitbucket", 1))
            .err()
            .assert_value()
            .to_string(),
        "unknown source provider id source.bitbucket"
    );
    assert_eq!(
        registry
            .lookup(&source_ref("source.github", 2))
            .err()
            .assert_value(),
        SourceRegistryError::UnavailableVersion {
            provider: source_ref("source.github", 2)
        }
    );
    assert_eq!(
        registry
            .capability(
                &reference,
                &SourceProfileId::new("staging").assert_value(),
                SourceCapability::Read,
            )
            .assert_error(),
        SourceRegistryError::UnavailableProfile {
            provider: reference,
            profile: SourceProfileId::new("staging").assert_value()
        }
    );
}

#[test]
fn issue_registry_exact_lookup_and_errors_are_deterministic() {
    let reference = issue_ref("issue.linear", 1);
    let provider = Arc::new(FakeIssueProvider::new(
        issue_descriptor(reference.clone(), [IssueCapability::Read], []),
        IssueCloseInspection::Unobserved,
    ));
    let mut registry = IssueProviderRegistry::new();
    registry.register(provider.clone()).assert_value();
    assert_eq!(
        registry.lookup(&reference).assert_value().descriptor(),
        provider.descriptor()
    );
    assert_eq!(
        registry.register(provider).assert_error(),
        IssueRegistryError::DuplicateRegistration {
            provider: reference.clone()
        }
    );
    assert_eq!(
        registry
            .lookup(&issue_ref("issue.github", 1))
            .err()
            .assert_value()
            .to_string(),
        "unknown issue provider id issue.github"
    );
    assert_eq!(
        registry
            .lookup(&issue_ref("issue.linear", 2))
            .err()
            .assert_value(),
        IssueRegistryError::UnavailableVersion {
            provider: issue_ref("issue.linear", 2)
        }
    );
    assert_eq!(
        registry
            .capability(
                &reference,
                &IssueProfileId::new("staging").assert_value(),
                IssueCapability::Read,
            )
            .assert_error(),
        IssueRegistryError::UnavailableProfile {
            provider: reference,
            profile: IssueProfileId::new("staging").assert_value(),
        }
    );
}

#[tokio::test]
async fn unsupported_source_capability_is_rejected_before_fake_invocation() {
    let reference = source_ref("source.github", 1);
    let provider = Arc::new(FakeSourceProvider::new(
        source_descriptor(reference.clone(), [SourceCapability::Read], []),
        SourceOperationInspection::Unobserved,
    ));
    let mut registry = SourceCodeProviderRegistry::new();
    registry.register(provider.clone()).assert_value();
    let request = source_operation(canonical_repository(reference.clone()));
    let mut workspace = verified_workspace(&request);
    let error = registry
        .operate(&request, workspace.capability())
        .await
        .assert_error();
    assert_eq!(
        error,
        SourceCallError::Registry(SourceRegistryError::UnsupportedCapability {
            provider: reference,
            profile: source_profile(),
            capability: SourceCapability::Merge,
        })
    );
    assert_eq!(provider.inspect_calls.load(Ordering::SeqCst), 0);
    assert_eq!(provider.operation_calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn unsupported_issue_capability_is_rejected_before_fake_invocation() {
    let reference = issue_ref("issue.linear", 1);
    let provider = Arc::new(FakeIssueProvider::new(
        issue_descriptor(reference.clone(), [IssueCapability::Read], []),
        IssueCloseInspection::Unobserved,
    ));
    let mut registry = IssueProviderRegistry::new();
    registry.register(provider.clone()).assert_value();
    let error = registry
        .close(&issue_close_request(reference.clone()))
        .await
        .assert_error();
    assert_eq!(
        error,
        IssueCallError::Registry(IssueRegistryError::UnsupportedCapability {
            provider: reference,
            profile: issue_profile(),
            capability: IssueCapability::Close,
        })
    );
    assert_eq!(provider.inspect_calls.load(Ordering::SeqCst), 0);
    assert_eq!(provider.close_calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn inspect_before_repeat_invokes_only_from_proven_unobserved_state() {
    let reference = source_ref("source.github", 1);
    let provider = Arc::new(FakeSourceProvider::new(
        source_descriptor(
            reference.clone(),
            [SourceCapability::Merge],
            BTreeSet::new(),
        ),
        SourceOperationInspection::Pending,
    ));
    let mut registry = SourceCodeProviderRegistry::new();
    registry.register(provider.clone()).assert_value();
    let request = source_operation(canonical_repository(reference));
    let mut workspace = verified_workspace(&request);

    let applied = SourceOperationReceipt::Merge(provider.merge_receipt(&request));
    provider.set_inspection(SourceOperationInspection::Applied(Box::new(
        applied.clone(),
    )));
    assert_eq!(
        registry
            .operate(&request, workspace.capability())
            .await
            .assert_value(),
        applied
    );
    assert_eq!(provider.operation_calls.load(Ordering::SeqCst), 0);

    for inspection in [
        SourceOperationInspection::Pending,
        SourceOperationInspection::Conflict {
            observed_fingerprint: SourceOperationFingerprint::new(digest('c')).assert_value(),
        },
        SourceOperationInspection::Indeterminate {
            evidence: SourceFailureMessage::new("provider outcome unavailable").assert_value(),
        },
    ] {
        provider.set_inspection(inspection.clone());
        assert_eq!(
            registry
                .operate(&request, workspace.capability())
                .await
                .assert_error(),
            SourceCallError::UnsafeToInvoke { inspection }
        );
    }
    assert_eq!(provider.operation_calls.load(Ordering::SeqCst), 0);

    provider.set_inspection(SourceOperationInspection::Unobserved);
    assert!(matches!(
        registry
            .operate(&request, workspace.capability())
            .await
            .assert_value(),
        SourceOperationReceipt::Merge(_)
    ));
    assert_eq!(provider.operation_calls.load(Ordering::SeqCst), 1);

    let native_reference = source_ref("source.bitbucket", 1);
    let native = Arc::new(FakeSourceProvider::new(
        source_descriptor(
            native_reference.clone(),
            [SourceCapability::Merge],
            [SourceCapability::Merge],
        ),
        SourceOperationInspection::Pending,
    ));
    let mut native_registry = SourceCodeProviderRegistry::new();
    native_registry.register(native.clone()).assert_value();
    let native_request = source_operation(canonical_repository(native_reference));
    let mut native_workspace = verified_workspace(&native_request);
    for inspection in [
        SourceOperationInspection::Pending,
        SourceOperationInspection::Indeterminate {
            evidence: SourceFailureMessage::new("connection ended after submission").assert_value(),
        },
    ] {
        native.set_inspection(inspection.clone());
        assert_eq!(
            native_registry
                .operate(&native_request, native_workspace.capability())
                .await
                .assert_error(),
            SourceCallError::UnsafeToInvoke { inspection }
        );
    }
    assert_eq!(native.operation_calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn issue_close_inspects_before_repeat_and_indeterminate_is_not_success() {
    let reference = issue_ref("issue.linear", 1);
    let request = issue_close_request(reference.clone());
    let provider = Arc::new(FakeIssueProvider::new(
        issue_descriptor(reference, [IssueCapability::Close], []),
        IssueCloseInspection::Pending,
    ));
    let mut registry = IssueProviderRegistry::new();
    registry.register(provider.clone()).assert_value();

    let applied = issue_close_receipt(&request);
    *provider.inspection.lock().assert_value() =
        IssueCloseInspection::Applied(Box::new(applied.clone()));
    assert_eq!(registry.close(&request).await.assert_value(), applied);
    assert_eq!(provider.close_calls.load(Ordering::SeqCst), 0);

    for inspection in [
        IssueCloseInspection::Pending,
        IssueCloseInspection::Conflict {
            observed_fingerprint: IssueOperationFingerprint::new(digest('c')).assert_value(),
        },
        IssueCloseInspection::Indeterminate {
            evidence: IssueFailureMessage::new("provider outcome unavailable").assert_value(),
        },
    ] {
        *provider.inspection.lock().assert_value() = inspection.clone();
        assert_eq!(
            registry.close(&request).await.assert_error(),
            IssueCallError::UnsafeToInvoke { inspection }
        );
    }
    assert_eq!(provider.close_calls.load(Ordering::SeqCst), 0);

    *provider.inspection.lock().assert_value() = IssueCloseInspection::Unobserved;
    registry.close(&request).await.assert_value();
    assert_eq!(provider.close_calls.load(Ordering::SeqCst), 1);

    let native_reference = issue_ref("issue.github", 1);
    let native = Arc::new(FakeIssueProvider::new(
        issue_descriptor(
            native_reference.clone(),
            [IssueCapability::Close],
            [IssueCapability::Close],
        ),
        IssueCloseInspection::Pending,
    ));
    let mut native_registry = IssueProviderRegistry::new();
    native_registry.register(native.clone()).assert_value();
    let native_request = issue_close_request(native_reference);
    for inspection in [
        IssueCloseInspection::Pending,
        IssueCloseInspection::Indeterminate {
            evidence: IssueFailureMessage::new("connection ended after submission").assert_value(),
        },
    ] {
        *native.inspection.lock().assert_value() = inspection;
        native_registry.close(&native_request).await.assert_value();
    }
    assert_eq!(native.close_calls.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn applied_inspections_must_match_the_authoritative_request() {
    let source_reference = source_ref("source.github", 1);
    let repository = canonical_repository(source_reference.clone());
    let source_request = source_operation(repository.clone());
    let other_source_request = SourceOperationRequest::new(
        repository,
        SourceCredentialHandleId::new("source-lease-7").assert_value(),
        (
            source_request.workspace().clone(),
            SourceOperationId::new("different-operation").assert_value(),
        ),
        source_request.operation().clone(),
    )
    .assert_value();
    let mut source_workspace = verified_workspace(&source_request);
    let source = Arc::new(FakeSourceProvider::new(
        source_descriptor(source_reference, [SourceCapability::Merge], []),
        SourceOperationInspection::Unobserved,
    ));
    source.set_inspection(SourceOperationInspection::Applied(Box::new(
        SourceOperationReceipt::Merge(source.merge_receipt(&other_source_request)),
    )));
    let mut sources = SourceCodeProviderRegistry::new();
    sources.register(source.clone()).assert_value();
    assert!(matches!(
        sources
            .operate(&source_request, source_workspace.capability())
            .await,
        Err(SourceCallError::InvalidEvidence { .. })
    ));
    assert_eq!(source.operation_calls.load(Ordering::SeqCst), 0);

    let issue_reference = issue_ref("issue.linear", 1);
    let issue_request = issue_close_request(issue_reference.clone());
    let other_issue_request = IssueCloseRequest::new(
        issue_request.issue().clone(),
        issue_request.credential_handle().clone(),
        (
            IssueOperationId::new("different-close").assert_value(),
            issue_request.fingerprint().clone(),
        ),
        issue_request.source_merge().clone(),
    )
    .assert_value();
    let issue = Arc::new(FakeIssueProvider::new(
        issue_descriptor(issue_reference, [IssueCapability::Close], []),
        IssueCloseInspection::Applied(Box::new(issue_close_receipt(&other_issue_request))),
    ));
    let mut issues = IssueProviderRegistry::new();
    issues.register(issue.clone()).assert_value();
    assert!(matches!(
        issues.close(&issue_request).await,
        Err(IssueCallError::InvalidEvidence { .. })
    ));
    assert_eq!(issue.close_calls.load(Ordering::SeqCst), 0);
}

async fn github_merge() -> (
    SourceProviderRef,
    Arc<FakeSourceProvider>,
    SourceMergeReceipt,
) {
    let source_reference = source_ref("source.github", 1);
    let source = Arc::new(FakeSourceProvider::new(
        source_descriptor(
            source_reference.clone(),
            [SourceCapability::Read, SourceCapability::Merge],
            [],
        ),
        SourceOperationInspection::Unobserved,
    ));
    let mut sources = SourceCodeProviderRegistry::new();
    sources.register(source.clone()).assert_value();
    let identify = SourceIdentifyRepositoryRequest::new(
        source_reference.clone(),
        source_profile(),
        (
            SourceAccountId::new("open-engine").assert_value(),
            SourceCredentialHandleId::new("github-lease").assert_value(),
        ),
        SourceRepositoryReference::new("the-open-engine/zeroshot").assert_value(),
    )
    .assert_value();
    let repository = sources.identify_repository(&identify).await.assert_value();
    let request = source_operation(repository);
    let mut workspace = verified_workspace(&request);
    let merge = match sources
        .operate(&request, workspace.capability())
        .await
        .assert_value()
    {
        SourceOperationReceipt::Merge(receipt) => Some(receipt),
        _ => None,
    }
    .assert_value_with("merge must return a typed merge receipt");
    (source_reference, source, merge)
}

#[tokio::test]
async fn linear_issue_close_is_gated_by_github_merge_receipt() {
    let (source_reference, source, merge) = github_merge().await;
    let issue_reference = issue_ref("issue.linear", 1);
    let issue = Arc::new(FakeIssueProvider::new(
        issue_descriptor(
            issue_reference.clone(),
            [IssueCapability::Read, IssueCapability::Close],
            [],
        ),
        IssueCloseInspection::Unobserved,
    ));
    let mut issues = IssueProviderRegistry::new();
    issues.register(issue.clone()).assert_value();
    let resolved = issues
        .resolve(
            &IssueResolveRequest::new(
                issue_reference.clone(),
                issue_profile(),
                (
                    IssueAccountId::new("open-engine-linear").assert_value(),
                    IssueCredentialHandleId::new("linear-lease").assert_value(),
                ),
                IssueReference::new("ENG-7").assert_value(),
            )
            .assert_value(),
        )
        .await
        .assert_value();
    let close_request = IssueCloseRequest::new(
        resolved,
        IssueCredentialHandleId::new("linear-lease").assert_value(),
        (
            IssueOperationId::new("close-ENG-7").assert_value(),
            IssueOperationFingerprint::new(digest('d')).assert_value(),
        ),
        merge.clone(),
    )
    .assert_value();
    let close_receipt = issues.close(&close_request).await.assert_value();

    assert_eq!(close_receipt.source_merge(), &merge);
    assert_eq!(merge.request().repository().provider(), &source_reference);
    assert_eq!(close_receipt.issue().provider(), &issue_reference);
    assert_eq!(source.identify_calls.load(Ordering::SeqCst), 1);
    assert_eq!(source.operation_calls.load(Ordering::SeqCst), 1);
    assert_eq!(issue.resolve_calls.load(Ordering::SeqCst), 1);
    assert_eq!(issue.close_calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn materialization_uses_only_an_ephemeral_destination_handle() {
    let reference = source_ref("source.github", 1);
    let provider = Arc::new(FakeSourceProvider::new(
        source_descriptor(reference.clone(), [SourceCapability::Read], []),
        SourceOperationInspection::Unobserved,
    ));
    let mut registry = SourceCodeProviderRegistry::new();
    registry.register(provider).assert_value();
    let repository = canonical_repository(reference);
    let request = SourceMaterializeRequest::new(
        repository.clone(),
        SourceCredentialHandleId::new("source-lease").assert_value(),
        SourceRevisionId::new("head-sha").assert_value(),
    )
    .assert_value();
    // SAFETY: this harness is used only for the external provider contract and carries no path,
    // descriptor, or persisted workspace authority.
    let target = unsafe { SourceMaterializationContractHarness::new() };
    let receipt = registry
        .materialize(&request, target.destination())
        .await
        .assert_value();
    assert_eq!(target.write_count(), 1);
    assert_eq!(receipt.repository(), &repository);
}

use openengine_cluster_testkit::assertions::{AssertValue, AssertError};
