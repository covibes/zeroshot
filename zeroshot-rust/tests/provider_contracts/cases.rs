use super::*;

#[test]
fn source_registry_exact_lookup_and_errors_are_deterministic() {
    let reference = source_ref("source.github", 1);
    let provider = Arc::new(FakeSourceProvider::new(
        source_descriptor(reference.clone(), [SourceCapability::Read], []),
        SourceOperationInspection::Unobserved,
    ));
    let mut registry = SourceCodeProviderRegistry::new();
    registry.register(provider.clone()).unwrap();
    assert_eq!(
        registry.lookup(&reference).unwrap().descriptor(),
        provider.descriptor()
    );
    assert_eq!(
        registry.register(provider).unwrap_err(),
        SourceRegistryError::DuplicateRegistration {
            provider: reference.clone()
        }
    );
    assert_eq!(
        registry
            .lookup(&source_ref("source.bitbucket", 1))
            .err()
            .unwrap()
            .to_string(),
        "unknown source provider id source.bitbucket"
    );
    assert_eq!(
        registry
            .lookup(&source_ref("source.github", 2))
            .err()
            .unwrap(),
        SourceRegistryError::UnavailableVersion {
            provider: source_ref("source.github", 2)
        }
    );
    assert_eq!(
        registry
            .capability(
                &reference,
                &SourceProfileId::new("staging").unwrap(),
                SourceCapability::Read,
            )
            .unwrap_err(),
        SourceRegistryError::UnavailableProfile {
            provider: reference,
            profile: SourceProfileId::new("staging").unwrap()
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
    registry.register(provider.clone()).unwrap();
    assert_eq!(
        registry.lookup(&reference).unwrap().descriptor(),
        provider.descriptor()
    );
    assert_eq!(
        registry.register(provider).unwrap_err(),
        IssueRegistryError::DuplicateRegistration {
            provider: reference.clone()
        }
    );
    assert_eq!(
        registry
            .lookup(&issue_ref("issue.github", 1))
            .err()
            .unwrap()
            .to_string(),
        "unknown issue provider id issue.github"
    );
    assert_eq!(
        registry
            .lookup(&issue_ref("issue.linear", 2))
            .err()
            .unwrap(),
        IssueRegistryError::UnavailableVersion {
            provider: issue_ref("issue.linear", 2)
        }
    );
    assert_eq!(
        registry
            .capability(
                &reference,
                &IssueProfileId::new("staging").unwrap(),
                IssueCapability::Read,
            )
            .unwrap_err(),
        IssueRegistryError::UnavailableProfile {
            provider: reference,
            profile: IssueProfileId::new("staging").unwrap(),
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
    registry.register(provider.clone()).unwrap();
    let request = source_operation(canonical_repository(reference.clone()));
    let mut workspace = verified_workspace(&request);
    let error = registry
        .operate(&request, workspace.capability())
        .await
        .unwrap_err();
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
    registry.register(provider.clone()).unwrap();
    let error = registry
        .close(&issue_close_request(reference.clone()))
        .await
        .unwrap_err();
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
    registry.register(provider.clone()).unwrap();
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
            .unwrap(),
        applied
    );
    assert_eq!(provider.operation_calls.load(Ordering::SeqCst), 0);

    for inspection in [
        SourceOperationInspection::Pending,
        SourceOperationInspection::Conflict {
            observed_fingerprint: SourceOperationFingerprint::new(digest('c')).unwrap(),
        },
        SourceOperationInspection::Indeterminate {
            evidence: SourceFailureMessage::new("provider outcome unavailable").unwrap(),
        },
    ] {
        provider.set_inspection(inspection.clone());
        assert_eq!(
            registry
                .operate(&request, workspace.capability())
                .await
                .unwrap_err(),
            SourceCallError::UnsafeToInvoke { inspection }
        );
    }
    assert_eq!(provider.operation_calls.load(Ordering::SeqCst), 0);

    provider.set_inspection(SourceOperationInspection::Unobserved);
    assert!(matches!(
        registry
            .operate(&request, workspace.capability())
            .await
            .unwrap(),
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
    native_registry.register(native.clone()).unwrap();
    let native_request = source_operation(canonical_repository(native_reference));
    let mut native_workspace = verified_workspace(&native_request);
    for inspection in [
        SourceOperationInspection::Pending,
        SourceOperationInspection::Indeterminate {
            evidence: SourceFailureMessage::new("connection ended after submission").unwrap(),
        },
    ] {
        native.set_inspection(inspection.clone());
        assert_eq!(
            native_registry
                .operate(&native_request, native_workspace.capability())
                .await
                .unwrap_err(),
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
    registry.register(provider.clone()).unwrap();

    let applied = issue_close_receipt(&request);
    *provider.inspection.lock().unwrap() = IssueCloseInspection::Applied(Box::new(applied.clone()));
    assert_eq!(registry.close(&request).await.unwrap(), applied);
    assert_eq!(provider.close_calls.load(Ordering::SeqCst), 0);

    for inspection in [
        IssueCloseInspection::Pending,
        IssueCloseInspection::Conflict {
            observed_fingerprint: IssueOperationFingerprint::new(digest('c')).unwrap(),
        },
        IssueCloseInspection::Indeterminate {
            evidence: IssueFailureMessage::new("provider outcome unavailable").unwrap(),
        },
    ] {
        *provider.inspection.lock().unwrap() = inspection.clone();
        assert_eq!(
            registry.close(&request).await.unwrap_err(),
            IssueCallError::UnsafeToInvoke { inspection }
        );
    }
    assert_eq!(provider.close_calls.load(Ordering::SeqCst), 0);

    *provider.inspection.lock().unwrap() = IssueCloseInspection::Unobserved;
    registry.close(&request).await.unwrap();
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
    native_registry.register(native.clone()).unwrap();
    let native_request = issue_close_request(native_reference);
    for inspection in [
        IssueCloseInspection::Pending,
        IssueCloseInspection::Indeterminate {
            evidence: IssueFailureMessage::new("connection ended after submission").unwrap(),
        },
    ] {
        *native.inspection.lock().unwrap() = inspection;
        native_registry.close(&native_request).await.unwrap();
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
        SourceCredentialHandleId::new("source-lease-7").unwrap(),
        (
            source_request.workspace().clone(),
            SourceOperationId::new("different-operation").unwrap(),
        ),
        source_request.operation().clone(),
    )
    .unwrap();
    let mut source_workspace = verified_workspace(&source_request);
    let source = Arc::new(FakeSourceProvider::new(
        source_descriptor(source_reference, [SourceCapability::Merge], []),
        SourceOperationInspection::Unobserved,
    ));
    source.set_inspection(SourceOperationInspection::Applied(Box::new(
        SourceOperationReceipt::Merge(source.merge_receipt(&other_source_request)),
    )));
    let mut sources = SourceCodeProviderRegistry::new();
    sources.register(source.clone()).unwrap();
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
            IssueOperationId::new("different-close").unwrap(),
            issue_request.fingerprint().clone(),
        ),
        issue_request.source_merge().clone(),
    )
    .unwrap();
    let issue = Arc::new(FakeIssueProvider::new(
        issue_descriptor(issue_reference, [IssueCapability::Close], []),
        IssueCloseInspection::Applied(Box::new(issue_close_receipt(&other_issue_request))),
    ));
    let mut issues = IssueProviderRegistry::new();
    issues.register(issue.clone()).unwrap();
    assert!(matches!(
        issues.close(&issue_request).await,
        Err(IssueCallError::InvalidEvidence { .. })
    ));
    assert_eq!(issue.close_calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn linear_issue_close_is_gated_by_github_merge_receipt() {
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
    sources.register(source.clone()).unwrap();
    let identify = SourceIdentifyRepositoryRequest::new(
        source_reference.clone(),
        source_profile(),
        (
            SourceAccountId::new("open-engine").unwrap(),
            SourceCredentialHandleId::new("github-lease").unwrap(),
        ),
        SourceRepositoryReference::new("the-open-engine/zeroshot").unwrap(),
    )
    .unwrap();
    let repository = sources.identify_repository(&identify).await.unwrap();
    let request = source_operation(repository);
    let mut workspace = verified_workspace(&request);
    let merge = match sources
        .operate(&request, workspace.capability())
        .await
        .unwrap()
    {
        SourceOperationReceipt::Merge(receipt) => receipt,
        other => panic!("merge must return a typed merge receipt, got {other:?}"),
    };

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
    issues.register(issue.clone()).unwrap();
    let resolved = issues
        .resolve(
            &IssueResolveRequest::new(
                issue_reference.clone(),
                issue_profile(),
                (
                    IssueAccountId::new("open-engine-linear").unwrap(),
                    IssueCredentialHandleId::new("linear-lease").unwrap(),
                ),
                IssueReference::new("ENG-7").unwrap(),
            )
            .unwrap(),
        )
        .await
        .unwrap();
    let close_request = IssueCloseRequest::new(
        resolved,
        IssueCredentialHandleId::new("linear-lease").unwrap(),
        (
            IssueOperationId::new("close-ENG-7").unwrap(),
            IssueOperationFingerprint::new(digest('d')).unwrap(),
        ),
        merge.clone(),
    )
    .unwrap();
    let close_receipt = issues.close(&close_request).await.unwrap();

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
    registry.register(provider).unwrap();
    let repository = canonical_repository(reference);
    let request = SourceMaterializeRequest::new(
        repository.clone(),
        SourceCredentialHandleId::new("source-lease").unwrap(),
        SourceRevisionId::new("head-sha").unwrap(),
    )
    .unwrap();
    // SAFETY: this harness is used only for the external provider contract and carries no path,
    // descriptor, or persisted workspace authority.
    let target = unsafe { SourceMaterializationContractHarness::new() };
    let receipt = registry
        .materialize(&request, target.destination())
        .await
        .unwrap();
    assert_eq!(target.write_count(), 1);
    assert_eq!(receipt.repository(), &repository);
}
