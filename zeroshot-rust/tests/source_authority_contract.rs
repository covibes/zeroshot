use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use async_trait::async_trait;
use tokio::sync::Mutex;
use zeroshot_engine::source_code_provider::*;

fn digest(character: char) -> String {
    std::iter::repeat_n(character, 64).collect()
}

struct ContractWorkspace {
    identity: SourceWorkspaceId,
    runtime_marker: (),
}

impl ContractWorkspace {
    fn new(identity: SourceWorkspaceId) -> Self {
        Self {
            identity,
            runtime_marker: (),
        }
    }

    fn capability(&mut self) -> SourceWorkspaceCapability<'_> {
        // SAFETY: this test-only marker is the runtime handle for exactly `identity`.
        unsafe {
            SourceWorkspaceCapability::from_verified_contract_test(
                self.identity.clone(),
                &mut self.runtime_marker,
            )
        }
    }
}

fn repository() -> CanonicalRepository {
    CanonicalRepository::new(
        SourceProviderRef::new(SourceProviderId::new("source.fake").unwrap(), 1).unwrap(),
        SourceProfileId::new("production").unwrap(),
        SourceAccountId::new("authority-tests").unwrap(),
        SourceRepositoryId::new("open-engine/zeroshot").unwrap(),
    )
    .unwrap()
}

fn review(name: &str) -> SourceReviewIdentity {
    SourceReviewIdentity::new(
        SourceReviewId::new(name).unwrap(),
        SourceBranchId::new("main").unwrap(),
        SourceBranchId::new("delivery/758").unwrap(),
    )
    .unwrap()
}

fn policy(digest_character: char, conclusion: SourceCheckConclusion) -> SourceRequiredPolicy {
    SourceRequiredPolicy::new(
        SourcePolicyDigest::new(digest(digest_character)).unwrap(),
        BTreeMap::from([(SourceCheckId::new("required/build").unwrap(), conclusion)]),
    )
    .unwrap()
}

fn request(operation_id: &str, operation: SourceOperation) -> SourceOperationRequest {
    SourceOperationRequest::new(
        repository(),
        SourceCredentialHandleId::new("credential-handle").unwrap(),
        (
            SourceWorkspaceId::new(digest('1')).unwrap(),
            SourceOperationId::new(operation_id).unwrap(),
        ),
        operation,
    )
    .unwrap()
}

struct MergeRequestInput {
    review: SourceReviewIdentity,
    base: &'static str,
    head: &'static str,
    checked: &'static str,
    policy: SourceRequiredPolicy,
    integrated: &'static str,
}

impl MergeRequestInput {
    fn exact() -> Self {
        Self {
            review: review("review-758"),
            base: "base-sha",
            head: "head-sha",
            checked: "head-sha",
            policy: policy('2', SourceCheckConclusion::Satisfied),
            integrated: "integrated-sha",
        }
    }
}

fn merge_request(input: MergeRequestInput) -> SourceOperationRequest {
    request(
        "merge-758",
        SourceOperation::Merge {
            review: input.review,
            expected_base: SourceRevisionId::new(input.base).unwrap(),
            expected_head: SourceRevisionId::new(input.head).unwrap(),
            checked_revision: SourceRevisionId::new(input.checked).unwrap(),
            policy: input.policy,
            integrated_revision: SourceRevisionId::new(input.integrated).unwrap(),
        },
    )
}

fn all_requests() -> Vec<SourceOperationRequest> {
    let exact_review = review("review-758");
    let exact_policy = policy('2', SourceCheckConclusion::Satisfied);
    vec![
        request(
            "branch-758",
            SourceOperation::Branch {
                expected_parent: SourceRevisionId::new("parent-sha").unwrap(),
                branch: SourceBranchId::new("delivery/758").unwrap(),
                pre_effect: SourceStateDigest::new(digest('3')).unwrap(),
            },
        ),
        request(
            "commit-758",
            SourceOperation::Commit {
                expected_head: SourceRevisionId::new("parent-sha").unwrap(),
                branch: SourceBranchId::new("delivery/758").unwrap(),
                message_digest: SourceMessageDigest::new(digest('4')).unwrap(),
                change_digest: SourceContentDigest::new(digest('5')).unwrap(),
                pre_effect: SourceStateDigest::new(digest('6')).unwrap(),
            },
        ),
        request(
            "push-758",
            SourceOperation::Push {
                expected_head: SourceRevisionId::new("commit-sha").unwrap(),
                branch: SourceBranchId::new("delivery/758").unwrap(),
                remote: SourceRemoteId::new("origin").unwrap(),
                expected_remote_head: Some(SourceRevisionId::new("parent-sha").unwrap()),
                revision: SourceRevisionId::new("commit-sha").unwrap(),
                pre_effect: SourceStateDigest::new(digest('7')).unwrap(),
            },
        ),
        request(
            "pull-request-758",
            SourceOperation::PullRequest {
                review: exact_review.clone(),
                expected_base: SourceRevisionId::new("base-sha").unwrap(),
                expected_head: SourceRevisionId::new("head-sha").unwrap(),
                checked_revision: SourceRevisionId::new("head-sha").unwrap(),
                policy: exact_policy.clone(),
            },
        ),
        request(
            "checks-758",
            SourceOperation::Checks {
                review: exact_review.clone(),
                expected_base: SourceRevisionId::new("base-sha").unwrap(),
                expected_head: SourceRevisionId::new("head-sha").unwrap(),
                checked_revision: SourceRevisionId::new("head-sha").unwrap(),
                policy: exact_policy.clone(),
            },
        ),
        request(
            "auto-merge-758",
            SourceOperation::AutoMerge {
                review: exact_review.clone(),
                expected_base: SourceRevisionId::new("base-sha").unwrap(),
                expected_head: SourceRevisionId::new("head-sha").unwrap(),
                checked_revision: SourceRevisionId::new("head-sha").unwrap(),
                policy: exact_policy.clone(),
            },
        ),
        request(
            "merge-queue-758",
            SourceOperation::MergeQueue {
                review: exact_review.clone(),
                expected_base: SourceRevisionId::new("base-sha").unwrap(),
                expected_head: SourceRevisionId::new("head-sha").unwrap(),
                checked_revision: SourceRevisionId::new("head-sha").unwrap(),
                policy: exact_policy.clone(),
            },
        ),
        merge_request(MergeRequestInput {
            review: exact_review,
            policy: exact_policy,
            ..MergeRequestInput::exact()
        }),
    ]
}

fn receipt(request: &SourceOperationRequest) -> SourceOperationReceipt {
    match request.operation() {
        SourceOperation::Branch {
            expected_parent, ..
        } => SourceOperationReceipt::Branch(
            SourceBranchReceipt::new(request.clone(), expected_parent.clone()).unwrap(),
        ),
        SourceOperation::Commit { .. } => SourceOperationReceipt::Commit(
            SourceCommitReceipt::new(
                request.clone(),
                SourceRevisionId::new("committed-sha").unwrap(),
            )
            .unwrap(),
        ),
        SourceOperation::Push { revision, .. } => SourceOperationReceipt::Push(
            SourcePushReceipt::new(request.clone(), revision.clone()).unwrap(),
        ),
        SourceOperation::PullRequest { review, .. } => SourceOperationReceipt::PullRequest(
            SourcePullRequestReceipt::new(request.clone(), review.clone()).unwrap(),
        ),
        SourceOperation::Checks { policy, .. } => SourceOperationReceipt::Checks(
            SourceChecksReceipt::new(request.clone(), policy.clone()).unwrap(),
        ),
        SourceOperation::AutoMerge { review, .. } => SourceOperationReceipt::AutoMerge(
            SourceAutoMergeReceipt::new(request.clone(), review.clone()).unwrap(),
        ),
        SourceOperation::MergeQueue { review, .. } => SourceOperationReceipt::MergeQueue(
            SourceMergeQueueReceipt::new(request.clone(), review.clone()).unwrap(),
        ),
        SourceOperation::Merge {
            integrated_revision,
            ..
        } => SourceOperationReceipt::Merge(
            SourceMergeReceipt::new(request.clone(), integrated_revision.clone()).unwrap(),
        ),
    }
}

fn descriptor() -> SourceProviderDescriptor {
    let capabilities = BTreeSet::from([
        SourceCapability::Branch,
        SourceCapability::Commit,
        SourceCapability::Push,
        SourceCapability::PullRequest,
        SourceCapability::Checks,
        SourceCapability::AutoMerge,
        SourceCapability::MergeQueue,
        SourceCapability::Merge,
    ]);
    SourceProviderDescriptor::new(
        repository().provider().clone(),
        BTreeMap::from([(
            SourceProfileId::new("production").unwrap(),
            SourceProfileDescriptor::new(capabilities, BTreeSet::new()).unwrap(),
        )]),
    )
    .unwrap()
}

struct AuthorityFake {
    descriptor: SourceProviderDescriptor,
    inspections: Mutex<VecDeque<Result<SourceOperationInspection, SourceProviderFailure>>>,
    performed: Result<SourceOperationReceipt, SourceProviderFailure>,
    inspection_calls: AtomicUsize,
    calls: AtomicUsize,
}

impl AuthorityFake {
    fn new(
        inspections: Vec<SourceOperationInspection>,
        performed: Result<SourceOperationReceipt, SourceProviderFailure>,
    ) -> Self {
        Self::with_inspection_results(inspections.into_iter().map(Ok).collect(), performed)
    }

    fn with_inspection_results(
        inspections: Vec<Result<SourceOperationInspection, SourceProviderFailure>>,
        performed: Result<SourceOperationReceipt, SourceProviderFailure>,
    ) -> Self {
        Self {
            descriptor: descriptor(),
            inspections: Mutex::new(inspections.into()),
            performed,
            inspection_calls: AtomicUsize::new(0),
            calls: AtomicUsize::new(0),
        }
    }
}

#[async_trait]
impl SourceCodeProvider for AuthorityFake {
    fn descriptor(&self) -> &SourceProviderDescriptor {
        &self.descriptor
    }

    async fn identify_repository(
        &self,
        _request: &SourceIdentifyRepositoryRequest,
    ) -> Result<CanonicalRepository, SourceProviderFailure> {
        unreachable!("authority fake has no repository adapter")
    }

    async fn inspect_repository(
        &self,
        _request: &SourceInspectRepositoryRequest,
    ) -> Result<SourceRepositoryInspection, SourceProviderFailure> {
        unreachable!("authority fake has no repository adapter")
    }

    async fn materialize(
        &self,
        _request: &SourceMaterializeRequest,
        _destination: SourceMaterializationDestination<'_>,
    ) -> Result<SourceMaterializationReceipt, SourceProviderFailure> {
        unreachable!("authority fake has no source delivery")
    }

    async fn inspect_operation(
        &self,
        _request: &SourceOperationRequest,
    ) -> Result<SourceOperationInspection, SourceProviderFailure> {
        self.inspection_calls.fetch_add(1, Ordering::SeqCst);
        self.inspections
            .lock()
            .await
            .pop_front()
            .expect("scripted authoritative inspection")
    }

    async fn operate(
        &self,
        _request: &SourceOperationRequest,
        _workspace: SourceWorkspaceCapability<'_>,
    ) -> Result<SourceOperationReceipt, SourceProviderFailure> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.performed.clone()
    }
}

async fn registry_with(provider: Arc<AuthorityFake>) -> SourceCodeProviderRegistry {
    let mut registry = SourceCodeProviderRegistry::new();
    registry.register(provider).unwrap();
    registry
}

#[test]
fn every_operation_has_an_exact_closed_receipt() {
    for request in all_requests() {
        let receipt = receipt(&request);
        assert_eq!(receipt.capability(), request.operation().capability());
        assert!(receipt.matches_request(&request));
        let encoded = serde_json::to_string(&receipt).unwrap();
        assert_eq!(
            serde_json::from_str::<SourceOperationReceipt>(&encoded).unwrap(),
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
        assert_eq!(
            registry
                .operate(&request, workspace.capability())
                .await
                .unwrap(),
            expected
        );
        assert_eq!(provider.calls.load(Ordering::SeqCst), 1);
    }
}

#[test]
fn cross_operation_receipts_are_rejected() {
    let requests = all_requests();
    let branch = requests
        .iter()
        .find(|request| request.operation().capability() == SourceCapability::Branch)
        .unwrap();
    let commit = requests
        .iter()
        .find(|request| request.operation().capability() == SourceCapability::Commit)
        .unwrap();
    assert!(
        SourceBranchReceipt::new(commit.clone(), SourceRevisionId::new("parent-sha").unwrap())
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
            .unwrap()
            .clone()
    };

    assert!(
        SourceBranchReceipt::new(
            find(SourceCapability::Branch),
            SourceRevisionId::new("wrong-parent").unwrap(),
        )
        .is_err()
    );
    assert!(
        SourcePushReceipt::new(
            find(SourceCapability::Push),
            SourceRevisionId::new("wrong-push").unwrap(),
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
            SourceRevisionId::new("wrong-integrated").unwrap(),
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
            SourceRevisionId::new("integrated-sha").unwrap(),
        )
        .is_err()
    );
}

#[tokio::test]
async fn workspace_mismatch_and_cross_workspace_replay_fail_before_effect() {
    let request = all_requests().pop().unwrap();
    let expected = receipt(&request);
    let provider = Arc::new(AuthorityFake::new(
        vec![SourceOperationInspection::Unobserved],
        Ok(expected),
    ));
    let registry = registry_with(provider.clone()).await;
    let mut wrong = ContractWorkspace::new(SourceWorkspaceId::new(digest('8')).unwrap());
    assert_eq!(
        registry
            .operate(&request, wrong.capability())
            .await
            .unwrap_err(),
        SourceCallError::WorkspaceMismatch
    );
    assert_eq!(provider.calls.load(Ordering::SeqCst), 0);

    let replay_request = SourceOperationRequest::new(
        request.repository().clone(),
        request.credential_handle().clone(),
        (
            SourceWorkspaceId::new(digest('8')).unwrap(),
            request.operation_id().clone(),
        ),
        request.operation().clone(),
    )
    .unwrap();
    let mut original = ContractWorkspace::new(request.workspace().clone());
    assert_eq!(
        registry
            .operate(&replay_request, original.capability())
            .await
            .unwrap_err(),
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
    let request = SourceOperationRequest::new(
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
    .ok()?;
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
            .unwrap()
            .len();
        let Some(tail_characters) = target.checked_sub(baseline_size) else {
            continue;
        };
        if tail_characters > 254 {
            continue;
        }
        let candidate = large_auto_merge_receipt(emoji_characters, tail_characters).unwrap();
        if serde_json::to_vec(&operation_envelope_value(&candidate, inspection))
            .unwrap()
            .len()
            == target
        {
            return candidate;
        }
    }
    panic!("could not construct a valid {target}-byte operation envelope")
}

#[test]
fn complete_receipt_and_inspection_envelopes_enforce_the_total_bound() {
    for target in [65_535, 65_536, 65_537] {
        let receipt = receipt_at_envelope_size(target, false);
        let raw = operation_envelope_value(&receipt, false);
        let outer = SourceOperationReceipt::AutoMerge(receipt);
        if target <= 65_536 {
            assert_eq!(serde_json::to_vec(&outer).unwrap().len(), target);
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
            assert_eq!(serde_json::to_vec(&outer).unwrap().len(), target);
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
        SourcePolicyDigest::new(digest('2')).unwrap(),
        BTreeMap::from([
            (
                SourceCheckId::new("required/test").unwrap(),
                SourceCheckConclusion::Satisfied,
            ),
            (
                SourceCheckId::new("required/build").unwrap(),
                SourceCheckConclusion::Satisfied,
            ),
        ]),
    )
    .unwrap();
    let mut reversed = BTreeMap::new();
    reversed.insert(
        SourceCheckId::new("required/build").unwrap(),
        SourceCheckConclusion::Satisfied,
    );
    reversed.insert(
        SourceCheckId::new("required/test").unwrap(),
        SourceCheckConclusion::Satisfied,
    );
    let second_policy =
        SourceRequiredPolicy::new(SourcePolicyDigest::new(digest('2')).unwrap(), reversed).unwrap();
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
        serde_json::to_vec(&first).unwrap(),
        serde_json::to_vec(&second).unwrap()
    );

    let mut unknown = serde_json::to_value(&first).unwrap();
    unknown["providerMetadata"] = serde_json::json!({"requestId": "opaque"});
    assert!(serde_json::from_value::<SourceOperationRequest>(unknown).is_err());
    let mut unknown_receipt = serde_json::to_value(receipt(&first)).unwrap();
    unknown_receipt["receipt"]["providerMetadata"] = serde_json::json!("opaque");
    assert!(serde_json::from_value::<SourceOperationReceipt>(unknown_receipt).is_err());

    let oversized = (0..65)
        .map(|index| {
            (
                SourceCheckId::new(format!("required/{index}")).unwrap(),
                SourceCheckConclusion::Satisfied,
            )
        })
        .collect();
    assert!(
        SourceRequiredPolicy::new(SourcePolicyDigest::new(digest('2')).unwrap(), oversized)
            .is_err()
    );
    let encoded = serde_json::to_string(&first).unwrap();
    assert!(!encoded.contains("/home/"));
    assert!(!encoded.contains("runtime_marker"));
}

#[test]
fn stale_or_failed_policy_cannot_produce_satisfied_receipts() {
    let failed = request(
        "checks-failed",
        SourceOperation::Checks {
            review: review("review-758"),
            expected_base: SourceRevisionId::new("base-sha").unwrap(),
            expected_head: SourceRevisionId::new("head-sha").unwrap(),
            checked_revision: SourceRevisionId::new("head-sha").unwrap(),
            policy: policy('2', SourceCheckConclusion::Failed),
        },
    );
    let SourceOperation::Checks { policy, .. } = failed.operation() else {
        panic!("test request must be checks")
    };
    assert!(SourceChecksReceipt::new(failed.clone(), policy.clone()).is_err());
}

#[tokio::test]
async fn success_requires_matching_authoritative_post_effect_inspection() {
    let request = all_requests().pop().unwrap();
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
            .unwrap(),
        receipt
    );
    assert_eq!(provider.calls.load(Ordering::SeqCst), 1);
    assert_eq!(provider.inspection_calls.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn invalid_direct_success_still_performs_authoritative_inspection() {
    let request = all_requests().pop().unwrap();
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
    let request = all_requests().pop().unwrap();
    let exact = receipt(&request);
    let unavailable = SourceProviderFailure::new(
        SourceProviderFailureCode::Unavailable,
        SourceFailureMessage::new("authority unavailable").unwrap(),
    )
    .unwrap();
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
            .unwrap_err(),
        SourceCallError::PostEffectInspectionFailed {
            outcome: SourceInvocationOutcome::ReturnedReceipt,
            failure: unavailable.clone(),
        }
    );

    let indeterminate = SourceProviderFailure::new(
        SourceProviderFailureCode::Indeterminate,
        SourceFailureMessage::new("response lost").unwrap(),
    )
    .unwrap();
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
            .unwrap_err(),
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
    let request = all_requests().pop().unwrap();
    let exact_receipt = receipt(&request);
    let uncertainty = SourceProviderFailure::new(
        SourceProviderFailureCode::Indeterminate,
        SourceFailureMessage::new("response lost after possible effect").unwrap(),
    )
    .unwrap();
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
            .unwrap(),
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
