use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use async_trait::async_trait;
use openengine_cluster_testkit::assertions::{AssertError, AssertValue};
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
        SourceProviderRef::new(SourceProviderId::new("source.fake").assert_value(), 1)
            .assert_value(),
        SourceProfileId::new("production").assert_value(),
        SourceAccountId::new("authority-tests").assert_value(),
        SourceRepositoryId::new("open-engine/zeroshot").assert_value(),
    )
    .assert_value()
}

fn review(name: &str) -> SourceReviewIdentity {
    SourceReviewIdentity::new(
        SourceReviewId::new(name).assert_value(),
        SourceBranchId::new("main").assert_value(),
        SourceBranchId::new("delivery/758").assert_value(),
    )
    .assert_value()
}

fn policy(digest_character: char, conclusion: SourceCheckConclusion) -> SourceRequiredPolicy {
    SourceRequiredPolicy::new(
        SourcePolicyDigest::new(digest(digest_character)).assert_value(),
        BTreeMap::from([(
            SourceCheckId::new("required/build").assert_value(),
            conclusion,
        )]),
    )
    .assert_value()
}

fn request(operation_id: &str, operation: SourceOperation) -> SourceOperationRequest {
    SourceOperationRequest::new(
        repository(),
        SourceCredentialHandleId::new("credential-handle").assert_value(),
        (
            SourceWorkspaceId::new(digest('1')).assert_value(),
            SourceOperationId::new(operation_id).assert_value(),
        ),
        operation,
    )
    .assert_value()
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
            expected_base: SourceRevisionId::new(input.base).assert_value(),
            expected_head: SourceRevisionId::new(input.head).assert_value(),
            checked_revision: SourceRevisionId::new(input.checked).assert_value(),
            policy: input.policy,
            integrated_revision: SourceRevisionId::new(input.integrated).assert_value(),
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
                expected_parent: SourceRevisionId::new("parent-sha").assert_value(),
                branch: SourceBranchId::new("delivery/758").assert_value(),
                pre_effect: SourceStateDigest::new(digest('3')).assert_value(),
            },
        ),
        request(
            "commit-758",
            SourceOperation::Commit {
                expected_head: SourceRevisionId::new("parent-sha").assert_value(),
                branch: SourceBranchId::new("delivery/758").assert_value(),
                message_digest: SourceMessageDigest::new(digest('4')).assert_value(),
                change_digest: SourceContentDigest::new(digest('5')).assert_value(),
                pre_effect: SourceStateDigest::new(digest('6')).assert_value(),
            },
        ),
        request(
            "push-758",
            SourceOperation::Push {
                expected_head: SourceRevisionId::new("commit-sha").assert_value(),
                branch: SourceBranchId::new("delivery/758").assert_value(),
                remote: SourceRemoteId::new("origin").assert_value(),
                expected_remote_head: Some(SourceRevisionId::new("parent-sha").assert_value()),
                revision: SourceRevisionId::new("commit-sha").assert_value(),
                pre_effect: SourceStateDigest::new(digest('7')).assert_value(),
            },
        ),
        request(
            "pull-request-758",
            SourceOperation::PullRequest {
                review: exact_review.clone(),
                expected_base: SourceRevisionId::new("base-sha").assert_value(),
                expected_head: SourceRevisionId::new("head-sha").assert_value(),
                checked_revision: SourceRevisionId::new("head-sha").assert_value(),
                policy: exact_policy.clone(),
            },
        ),
        request(
            "checks-758",
            SourceOperation::Checks {
                review: exact_review.clone(),
                expected_base: SourceRevisionId::new("base-sha").assert_value(),
                expected_head: SourceRevisionId::new("head-sha").assert_value(),
                checked_revision: SourceRevisionId::new("head-sha").assert_value(),
                policy: exact_policy.clone(),
            },
        ),
        request(
            "auto-merge-758",
            SourceOperation::AutoMerge {
                review: exact_review.clone(),
                expected_base: SourceRevisionId::new("base-sha").assert_value(),
                expected_head: SourceRevisionId::new("head-sha").assert_value(),
                checked_revision: SourceRevisionId::new("head-sha").assert_value(),
                policy: exact_policy.clone(),
            },
        ),
        request(
            "merge-queue-758",
            SourceOperation::MergeQueue {
                review: exact_review.clone(),
                expected_base: SourceRevisionId::new("base-sha").assert_value(),
                expected_head: SourceRevisionId::new("head-sha").assert_value(),
                checked_revision: SourceRevisionId::new("head-sha").assert_value(),
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
            SourceBranchReceipt::new(request.clone(), expected_parent.clone()).assert_value(),
        ),
        SourceOperation::Commit { .. } => SourceOperationReceipt::Commit(
            SourceCommitReceipt::new(
                request.clone(),
                SourceRevisionId::new("committed-sha").assert_value(),
            )
            .assert_value(),
        ),
        SourceOperation::Push { revision, .. } => SourceOperationReceipt::Push(
            SourcePushReceipt::new(request.clone(), revision.clone()).assert_value(),
        ),
        SourceOperation::PullRequest { review, .. } => SourceOperationReceipt::PullRequest(
            SourcePullRequestReceipt::new(request.clone(), review.clone()).assert_value(),
        ),
        SourceOperation::Checks { policy, .. } => SourceOperationReceipt::Checks(
            SourceChecksReceipt::new(request.clone(), policy.clone()).assert_value(),
        ),
        SourceOperation::AutoMerge { review, .. } => SourceOperationReceipt::AutoMerge(
            SourceAutoMergeReceipt::new(request.clone(), review.clone()).assert_value(),
        ),
        SourceOperation::MergeQueue { review, .. } => SourceOperationReceipt::MergeQueue(
            SourceMergeQueueReceipt::new(request.clone(), review.clone()).assert_value(),
        ),
        SourceOperation::Merge {
            integrated_revision,
            ..
        } => SourceOperationReceipt::Merge(
            SourceMergeReceipt::new(request.clone(), integrated_revision.clone()).assert_value(),
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
            SourceProfileId::new("production").assert_value(),
            SourceProfileDescriptor::new(capabilities, BTreeSet::new()).assert_value(),
        )]),
    )
    .assert_value()
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
        None.assert_value_with("authority fake has no repository adapter")
    }

    async fn inspect_repository(
        &self,
        _request: &SourceInspectRepositoryRequest,
    ) -> Result<SourceRepositoryInspection, SourceProviderFailure> {
        None.assert_value_with("authority fake has no repository adapter")
    }

    async fn materialize(
        &self,
        _request: &SourceMaterializeRequest,
        _destination: SourceMaterializationDestination<'_>,
    ) -> Result<SourceMaterializationReceipt, SourceProviderFailure> {
        None.assert_value_with("authority fake has no source delivery")
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
            .assert_value_with("scripted authoritative inspection")
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
    registry.register(provider).assert_value();
    registry
}

#[path = "source_authority_contract/core_cases.rs"]
mod core_cases;
#[path = "source_authority_contract/envelope_cases.rs"]
mod envelope_cases;
