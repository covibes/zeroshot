use super::*;

fn auto_merge_request(
    policy: SourceRequiredPolicy,
    review: &SourceReviewIdentity,
) -> Option<SourceOperationRequest> {
    SourceOperationRequest::new(
        repository(),
        SourceCredentialHandleId::new("credential-handle").ok()?,
        (
            SourceWorkspaceId::new(digest('1')).ok()?,
            SourceOperationId::new("auto-merge-size-bound").ok()?,
        ),
        SourceOperation::AutoMerge {
            review: review.clone(),
            expected_base: SourceRevisionId::new("base-sha").ok()?,
            expected_head: SourceRevisionId::new("head-sha").ok()?,
            checked_revision: SourceRevisionId::new("head-sha").ok()?,
            policy,
        },
    )
    .ok()
}

fn large_auto_merge_receipt(
    emoji_characters: usize,
    tail_characters: usize,
) -> Option<SourceAutoMergeReceipt> {
    let mut conclusions = BTreeMap::new();
    for index in 0..63 {
        conclusions.insert(
            SourceCheckId::new(format!("{index:02}{}", "😀".repeat(emoji_characters))).ok()?,
            SourceCheckConclusion::Satisfied,
        );
    }
    conclusions.insert(
        SourceCheckId::new(format!("zz{}", "x".repeat(tail_characters))).ok()?,
        SourceCheckConclusion::Satisfied,
    );
    let review = review("review-size-bound");
    let policy =
        SourceRequiredPolicy::new(SourcePolicyDigest::new(digest('6')).ok()?, conclusions).ok()?;
    let request = auto_merge_request(policy, &review)?;
    SourceAutoMergeReceipt::new(request, review).ok()
}

fn operation_envelope_value(
    receipt: &SourceAutoMergeReceipt,
    inspection: bool,
) -> serde_json::Value {
    let receipt = serde_json::json!({
        "kind": "auto_merge",
        "receipt": receipt,
    });
    if inspection {
        serde_json::json!({
            "state": "applied",
            "evidence": receipt,
        })
    } else {
        receipt
    }
}

fn receipt_at_envelope_size(target: usize, inspection: bool) -> SourceAutoMergeReceipt {
    for emoji_characters in 200..=254 {
        let Some(baseline) = large_auto_merge_receipt(emoji_characters, 0) else {
            continue;
        };
        let baseline_size = serde_json::to_vec(&operation_envelope_value(&baseline, inspection))
            .assert_value()
            .len();
        let Some(tail_characters) = target.checked_sub(baseline_size) else {
            continue;
        };
        if tail_characters > 254 {
            continue;
        }
        let candidate = large_auto_merge_receipt(emoji_characters, tail_characters).assert_value();
        if serde_json::to_vec(&operation_envelope_value(&candidate, inspection))
            .assert_value()
            .len()
            == target
        {
            return candidate;
        }
    }
    None.assert_value_with(&format!(
        "could not construct a valid {target}-byte operation envelope"
    ))
}

#[test]
fn complete_receipt_and_inspection_envelopes_enforce_the_total_bound() {
    for target in [65_535, 65_536, 65_537] {
        let receipt = receipt_at_envelope_size(target, false);
        let raw = operation_envelope_value(&receipt, false);
        let outer = SourceOperationReceipt::AutoMerge(receipt);
        if target <= 65_536 {
            assert_eq!(serde_json::to_vec(&outer).assert_value().len(), target);
            assert!(serde_json::from_value::<SourceOperationReceipt>(raw).is_ok());
        } else {
            assert!(serde_json::to_vec(&outer).is_err());
            assert!(serde_json::from_value::<SourceOperationReceipt>(raw).is_err());
        }

        let receipt = receipt_at_envelope_size(target, true);
        let raw = operation_envelope_value(&receipt, true);
        let outer = SourceOperationInspection::Applied(Box::new(
            SourceOperationReceipt::AutoMerge(receipt),
        ));
        if target <= 65_536 {
            assert_eq!(serde_json::to_vec(&outer).assert_value().len(), target);
            assert!(serde_json::from_value::<SourceOperationInspection>(raw).is_ok());
        } else {
            assert!(serde_json::to_vec(&outer).is_err());
            assert!(serde_json::from_value::<SourceOperationInspection>(raw).is_err());
        }
    }
}

#[test]
fn canonical_intent_is_stable_bounded_and_strict() {
    let first_policy = SourceRequiredPolicy::new(
        SourcePolicyDigest::new(digest('2')).assert_value(),
        BTreeMap::from([
            (
                SourceCheckId::new("required/test").assert_value(),
                SourceCheckConclusion::Satisfied,
            ),
            (
                SourceCheckId::new("required/build").assert_value(),
                SourceCheckConclusion::Satisfied,
            ),
        ]),
    )
    .assert_value();
    let mut reversed = BTreeMap::new();
    reversed.insert(
        SourceCheckId::new("required/build").assert_value(),
        SourceCheckConclusion::Satisfied,
    );
    reversed.insert(
        SourceCheckId::new("required/test").assert_value(),
        SourceCheckConclusion::Satisfied,
    );
    let second_policy = SourceRequiredPolicy::new(
        SourcePolicyDigest::new(digest('2')).assert_value(),
        reversed,
    )
    .assert_value();
    let first = merge_request(MergeRequestInput {
        policy: first_policy,
        ..MergeRequestInput::exact()
    });
    let second = merge_request(MergeRequestInput {
        policy: second_policy,
        ..MergeRequestInput::exact()
    });
    assert_eq!(first.fingerprint(), second.fingerprint());
    assert_eq!(
        serde_json::to_vec(&first).assert_value(),
        serde_json::to_vec(&second).assert_value()
    );

    let mut unknown = serde_json::to_value(&first).assert_value();
    unknown.as_object_mut().assert_value().insert(
        "providerMetadata".to_owned(),
        serde_json::json!({"requestId": "opaque"}),
    );
    assert!(serde_json::from_value::<SourceOperationRequest>(unknown).is_err());
    let mut unknown_receipt = serde_json::to_value(receipt(&first)).assert_value();
    unknown_receipt
        .get_mut("receipt")
        .assert_value()
        .as_object_mut()
        .assert_value()
        .insert("providerMetadata".to_owned(), serde_json::json!("opaque"));
    assert!(serde_json::from_value::<SourceOperationReceipt>(unknown_receipt).is_err());

    let oversized = (0..65)
        .map(|index| {
            (
                SourceCheckId::new(format!("required/{index}")).assert_value(),
                SourceCheckConclusion::Satisfied,
            )
        })
        .collect();
    assert!(
        SourceRequiredPolicy::new(
            SourcePolicyDigest::new(digest('2')).assert_value(),
            oversized
        )
        .is_err()
    );
    let encoded = serde_json::to_string(&first).assert_value();
    assert!(!encoded.contains("/home/"));
    assert!(!encoded.contains("runtime_marker"));
}

#[test]
fn stale_or_failed_policy_cannot_produce_satisfied_receipts() {
    let failed = request(
        "checks-failed",
        SourceOperation::Checks {
            review: review("review-758"),
            expected_base: SourceRevisionId::new("base-sha").assert_value(),
            expected_head: SourceRevisionId::new("head-sha").assert_value(),
            checked_revision: SourceRevisionId::new("head-sha").assert_value(),
            policy: policy('2', SourceCheckConclusion::Failed),
        },
    );
    let policy = match failed.operation() {
        SourceOperation::Checks { policy, .. } => Some(policy),
        _ => None,
    };
    let policy = policy.assert_value_with("test request must be checks");
    assert!(SourceChecksReceipt::new(failed.clone(), policy.clone()).is_err());
}

#[tokio::test]
async fn success_requires_matching_authoritative_post_effect_inspection() {
    let request = all_requests().pop().assert_value();
    let receipt = receipt(&request);
    let provider = Arc::new(AuthorityFake::new(
        vec![
            SourceOperationInspection::Unobserved,
            SourceOperationInspection::Applied(Box::new(receipt.clone())),
        ],
        Ok(receipt.clone()),
    ));
    let registry = registry_with(provider.clone()).await;
    let mut workspace = ContractWorkspace::new(request.workspace().clone());
    assert_eq!(
        registry
            .operate(&request, workspace.capability())
            .await
            .assert_value(),
        receipt
    );
    assert_eq!(provider.calls.load(Ordering::SeqCst), 1);
    assert_eq!(provider.inspection_calls.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn invalid_direct_success_still_performs_authoritative_inspection() {
    let request = all_requests().pop().assert_value();
    let exact = receipt(&request);
    let mismatched_request = merge_request(MergeRequestInput {
        review: review("review-other"),
        ..MergeRequestInput::exact()
    });
    let provider = Arc::new(AuthorityFake::new(
        vec![
            SourceOperationInspection::Unobserved,
            SourceOperationInspection::Applied(Box::new(exact)),
        ],
        Ok(receipt(&mismatched_request)),
    ));
    let registry = registry_with(provider.clone()).await;
    let mut workspace = ContractWorkspace::new(request.workspace().clone());
    assert!(matches!(
        registry.operate(&request, workspace.capability()).await,
        Err(SourceCallError::PostEffectInvalidEvidence {
            outcome: SourceInvocationOutcome::ReturnedReceipt,
            ..
        })
    ));
    assert_eq!(provider.calls.load(Ordering::SeqCst), 1);
    assert_eq!(provider.inspection_calls.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn post_effect_inspection_errors_preserve_the_invocation_stage() {
    let request = all_requests().pop().assert_value();
    let exact = receipt(&request);
    let unavailable = SourceProviderFailure::new(
        SourceProviderFailureCode::Unavailable,
        SourceFailureMessage::new("authority unavailable").assert_value(),
    )
    .assert_value();
    let returned = Arc::new(AuthorityFake::with_inspection_results(
        vec![
            Ok(SourceOperationInspection::Unobserved),
            Err(unavailable.clone()),
        ],
        Ok(exact),
    ));
    let returned_registry = registry_with(returned.clone()).await;
    let mut workspace = ContractWorkspace::new(request.workspace().clone());
    assert_eq!(
        returned_registry
            .operate(&request, workspace.capability())
            .await
            .assert_error(),
        SourceCallError::PostEffectInspectionFailed {
            outcome: SourceInvocationOutcome::ReturnedReceipt,
            failure: unavailable.clone(),
        }
    );

    let indeterminate = SourceProviderFailure::new(
        SourceProviderFailureCode::Indeterminate,
        SourceFailureMessage::new("response lost").assert_value(),
    )
    .assert_value();
    let uncertain = Arc::new(AuthorityFake::with_inspection_results(
        vec![
            Ok(SourceOperationInspection::Unobserved),
            Err(unavailable.clone()),
        ],
        Err(indeterminate),
    ));
    let uncertain_registry = registry_with(uncertain.clone()).await;
    assert_eq!(
        uncertain_registry
            .operate(&request, workspace.capability())
            .await
            .assert_error(),
        SourceCallError::PostEffectInspectionFailed {
            outcome: SourceInvocationOutcome::Indeterminate,
            failure: unavailable,
        }
    );
    assert_eq!(returned.inspection_calls.load(Ordering::SeqCst), 2);
    assert_eq!(uncertain.inspection_calls.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn post_uncertainty_reconciles_only_exact_authority() {
    let request = all_requests().pop().assert_value();
    let exact_receipt = receipt(&request);
    let uncertainty = SourceProviderFailure::new(
        SourceProviderFailureCode::Indeterminate,
        SourceFailureMessage::new("response lost after possible effect").assert_value(),
    )
    .assert_value();
    let exact = Arc::new(AuthorityFake::new(
        vec![
            SourceOperationInspection::Unobserved,
            SourceOperationInspection::Applied(Box::new(exact_receipt.clone())),
        ],
        Err(uncertainty.clone()),
    ));
    let exact_registry = registry_with(exact.clone()).await;
    let mut workspace = ContractWorkspace::new(request.workspace().clone());
    assert_eq!(
        exact_registry
            .operate(&request, workspace.capability())
            .await
            .assert_value(),
        exact_receipt
    );

    let mismatch_request = merge_request(MergeRequestInput {
        review: review("review-other"),
        ..MergeRequestInput::exact()
    });
    let mismatch = receipt(&mismatch_request);
    let wrong = Arc::new(AuthorityFake::new(
        vec![
            SourceOperationInspection::Unobserved,
            SourceOperationInspection::Applied(Box::new(mismatch)),
        ],
        Err(uncertainty),
    ));
    let wrong_registry = registry_with(wrong.clone()).await;
    assert!(matches!(
        wrong_registry
            .operate(&request, workspace.capability())
            .await,
        Err(SourceCallError::PostEffectInvalidEvidence { .. })
    ));
    assert_eq!(exact.calls.load(Ordering::SeqCst), 1);
    assert_eq!(wrong.calls.load(Ordering::SeqCst), 1);
}
