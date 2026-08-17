use super::*;

fn request_for(
    requests: &[SourceOperationRequest],
    capability: SourceCapability,
) -> &SourceOperationRequest {
    requests
        .iter()
        .find(|request| request.operation().capability() == capability)
        .assert_value()
}

#[test]
fn every_operation_has_an_exact_closed_receipt() {
    for request in all_requests() {
        let receipt = receipt(&request);
        assert_eq!(receipt.capability(), request.operation().capability());
        assert!(receipt.matches_request(&request));
        let encoded = serde_json::to_string(&receipt).assert_value();
        assert_eq!(
            serde_json::from_str::<SourceOperationReceipt>(&encoded).assert_value(),
            receipt
        );
    }
}

#[tokio::test]
async fn contract_fake_proves_every_mutating_capability_independently() {
    for request in all_requests() {
        let expected = receipt(&request);
        let provider = Arc::new(AuthorityFake::new(
            vec![
                SourceOperationInspection::Unobserved,
                SourceOperationInspection::Applied(Box::new(expected.clone())),
            ],
            Ok(expected.clone()),
        ));
        let registry = registry_with(provider.clone()).await;
        let mut workspace = ContractWorkspace::new(request.workspace().clone());
        let operation = registry.operate(&request, workspace.capability()).await;
        assert_eq!(operation.assert_value(), expected);
        assert_eq!(provider.calls.load(Ordering::SeqCst), 1);
    }
}

#[test]
fn cross_operation_receipts_are_rejected() {
    let requests = all_requests();
    let branch = request_for(&requests, SourceCapability::Branch);
    let commit = request_for(&requests, SourceCapability::Commit);
    assert!(
        SourceBranchReceipt::new(
            commit.clone(),
            SourceRevisionId::new("parent-sha").assert_value()
        )
        .is_err()
    );
    assert!(!receipt(branch).matches_request(commit));
}

#[test]
fn typed_receipts_reject_same_operation_contradictions() {
    let requests = all_requests();
    let find = |capability| {
        requests
            .iter()
            .find(|request| request.operation().capability() == capability)
            .assert_value()
            .clone()
    };

    assert!(
        SourceBranchReceipt::new(
            find(SourceCapability::Branch),
            SourceRevisionId::new("wrong-parent").assert_value(),
        )
        .is_err()
    );
    assert!(
        SourcePushReceipt::new(
            find(SourceCapability::Push),
            SourceRevisionId::new("wrong-push").assert_value(),
        )
        .is_err()
    );
    assert!(
        SourcePullRequestReceipt::new(find(SourceCapability::PullRequest), review("review-other"),)
            .is_err()
    );
    assert!(
        SourceChecksReceipt::new(
            find(SourceCapability::Checks),
            policy('3', SourceCheckConclusion::Satisfied),
        )
        .is_err()
    );
    assert!(
        SourceAutoMergeReceipt::new(find(SourceCapability::AutoMerge), review("review-other"),)
            .is_err()
    );
    assert!(
        SourceMergeQueueReceipt::new(find(SourceCapability::MergeQueue), review("review-other"),)
            .is_err()
    );
    assert!(
        SourceMergeReceipt::new(
            find(SourceCapability::Merge),
            SourceRevisionId::new("wrong-integrated").assert_value(),
        )
        .is_err()
    );

    let failed_merge = merge_request(MergeRequestInput {
        policy: policy('2', SourceCheckConclusion::Failed),
        ..MergeRequestInput::exact()
    });
    assert!(
        SourceMergeReceipt::new(
            failed_merge,
            SourceRevisionId::new("integrated-sha").assert_value(),
        )
        .is_err()
    );
}

#[tokio::test]
async fn workspace_mismatch_and_cross_workspace_replay_fail_before_effect() {
    let request = all_requests().pop().assert_value();
    let expected = receipt(&request);
    let provider = Arc::new(AuthorityFake::new(
        vec![SourceOperationInspection::Unobserved],
        Ok(expected),
    ));
    let registry = registry_with(provider.clone()).await;
    let mut wrong = ContractWorkspace::new(SourceWorkspaceId::new(digest('8')).assert_value());
    assert_eq!(
        registry
            .operate(&request, wrong.capability())
            .await
            .assert_error(),
        SourceCallError::WorkspaceMismatch
    );
    assert_eq!(provider.calls.load(Ordering::SeqCst), 0);

    let replay_request = SourceOperationRequest::new(
        request.repository().clone(),
        request.credential_handle().clone(),
        (
            SourceWorkspaceId::new(digest('8')).assert_value(),
            request.operation_id().clone(),
        ),
        request.operation().clone(),
    )
    .assert_value();
    let mut original = ContractWorkspace::new(request.workspace().clone());
    assert_eq!(
        registry
            .operate(&replay_request, original.capability())
            .await
            .assert_error(),
        SourceCallError::WorkspaceMismatch
    );
    assert_eq!(provider.calls.load(Ordering::SeqCst), 0);
}

#[test]
fn review_base_head_policy_conclusion_and_integrated_revision_are_exact() {
    let exact = merge_request(MergeRequestInput::exact());
    let receipt = receipt(&exact);
    for mismatch in [
        merge_request(MergeRequestInput {
            review: review("review-other"),
            ..MergeRequestInput::exact()
        }),
        merge_request(MergeRequestInput {
            base: "base-other",
            ..MergeRequestInput::exact()
        }),
        merge_request(MergeRequestInput {
            head: "head-other",
            ..MergeRequestInput::exact()
        }),
        merge_request(MergeRequestInput {
            checked: "checked-other",
            ..MergeRequestInput::exact()
        }),
        merge_request(MergeRequestInput {
            policy: policy('3', SourceCheckConclusion::Satisfied),
            ..MergeRequestInput::exact()
        }),
        merge_request(MergeRequestInput {
            policy: policy('2', SourceCheckConclusion::Failed),
            ..MergeRequestInput::exact()
        }),
        merge_request(MergeRequestInput {
            integrated: "integrated-other",
            ..MergeRequestInput::exact()
        }),
    ] {
        assert!(!receipt.matches_request(&mismatch));
    }
}
