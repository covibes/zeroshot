use std::collections::{BTreeMap, BTreeSet};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use zeroshot_engine::issue_provider::*;
use zeroshot_engine::source_code_provider::*;

fn digest(character: char) -> String {
    std::iter::repeat_n(character, 64).collect()
}
fn source_workspace(character: char) -> SourceWorkspaceId {
    SourceWorkspaceId::new(digest(character)).assert_value()
}

fn review() -> SourceReviewIdentity {
    SourceReviewIdentity::new(
        SourceReviewId::new("review-7").assert_value(),
        SourceBranchId::new("main").assert_value(),
        SourceBranchId::new("delivery/7").assert_value(),
    )
    .assert_value()
}

fn satisfied_policy() -> SourceRequiredPolicy {
    SourceRequiredPolicy::new(
        SourcePolicyDigest::new(digest('9')).assert_value(),
        BTreeMap::from([(
            SourceCheckId::new("required/build").assert_value(),
            SourceCheckConclusion::Satisfied,
        )]),
    )
    .assert_value()
}

struct ContractWorkspace {
    identity: SourceWorkspaceId,
    runtime_marker: (),
}

impl ContractWorkspace {
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

fn verified_workspace(request: &SourceOperationRequest) -> ContractWorkspace {
    ContractWorkspace {
        identity: request.workspace().clone(),
        runtime_marker: (),
    }
}

fn source_ref(id: &str, version: u32) -> SourceProviderRef {
    SourceProviderRef::new(SourceProviderId::new(id).assert_value(), version).assert_value()
}

fn source_profile() -> SourceProfileId {
    SourceProfileId::new("production").assert_value()
}

fn source_descriptor(
    reference: SourceProviderRef,
    capabilities: impl IntoIterator<Item = SourceCapability>,
    native: impl IntoIterator<Item = SourceCapability>,
) -> SourceProviderDescriptor {
    SourceProviderDescriptor::new(
        reference,
        BTreeMap::from([(
            source_profile(),
            SourceProfileDescriptor::new(
                capabilities.into_iter().collect(),
                native.into_iter().collect(),
            )
            .assert_value(),
        )]),
    )
    .assert_value()
}

fn canonical_repository(reference: SourceProviderRef) -> CanonicalRepository {
    CanonicalRepository::new(
        reference,
        source_profile(),
        SourceAccountId::new("open-engine").assert_value(),
        SourceRepositoryId::new("the-open-engine/zeroshot").assert_value(),
    )
    .assert_value()
}

fn source_operation(repository: CanonicalRepository) -> SourceOperationRequest {
    SourceOperationRequest::new(
        repository,
        SourceCredentialHandleId::new("source-lease-7").assert_value(),
        (
            source_workspace('7'),
            SourceOperationId::new("merge-7").assert_value(),
        ),
        SourceOperation::Merge {
            review: review(),
            expected_base: SourceRevisionId::new("base-sha").assert_value(),
            expected_head: SourceRevisionId::new("head-sha").assert_value(),
            checked_revision: SourceRevisionId::new("head-sha").assert_value(),
            policy: satisfied_policy(),
            integrated_revision: SourceRevisionId::new("integrated-sha").assert_value(),
        },
    )
    .assert_value()
}

struct FakeSourceProvider {
    descriptor: SourceProviderDescriptor,
    inspection: Mutex<SourceOperationInspection>,
    operation_result: Mutex<Option<SourceOperationReceipt>>,
    identify_calls: AtomicUsize,
    inspect_calls: AtomicUsize,
    operation_calls: AtomicUsize,
}

impl FakeSourceProvider {
    fn new(descriptor: SourceProviderDescriptor, inspection: SourceOperationInspection) -> Self {
        Self {
            descriptor,
            inspection: Mutex::new(inspection),
            operation_result: Mutex::new(None),
            identify_calls: AtomicUsize::new(0),
            inspect_calls: AtomicUsize::new(0),
            operation_calls: AtomicUsize::new(0),
        }
    }

    fn set_inspection(&self, inspection: SourceOperationInspection) {
        *self.inspection.lock().assert_value() = inspection;
    }

    fn set_operation_result(&self, receipt: SourceOperationReceipt) {
        *self.operation_result.lock().assert_value() = Some(receipt);
    }

    fn merge_receipt(&self, request: &SourceOperationRequest) -> SourceMergeReceipt {
        let integrated_revision = match request.operation() {
            SourceOperation::Merge {
                integrated_revision,
                ..
            } => Some(integrated_revision),
            _ => None,
        };
        let integrated_revision =
            integrated_revision.assert_value_with("fake expected merge request");
        SourceMergeReceipt::new(request.clone(), integrated_revision.clone()).assert_value()
    }
}

#[async_trait]
impl SourceCodeProvider for FakeSourceProvider {
    fn descriptor(&self) -> &SourceProviderDescriptor {
        &self.descriptor
    }

    async fn identify_repository(
        &self,
        request: &SourceIdentifyRepositoryRequest,
    ) -> Result<CanonicalRepository, SourceProviderFailure> {
        self.identify_calls.fetch_add(1, Ordering::SeqCst);
        Ok(CanonicalRepository::new(
            request.provider().clone(),
            request.profile().clone(),
            request.account().clone(),
            SourceRepositoryId::new(request.reference().as_str()).assert_value(),
        )
        .assert_value())
    }

    async fn inspect_repository(
        &self,
        request: &SourceInspectRepositoryRequest,
    ) -> Result<SourceRepositoryInspection, SourceProviderFailure> {
        Ok(SourceRepositoryInspection::new(
            request.repository().clone(),
            SourceRevisionId::new("head-sha").assert_value(),
            Vec::new(),
        )
        .assert_value())
    }

    async fn materialize(
        &self,
        request: &SourceMaterializeRequest,
        destination: SourceMaterializationDestination<'_>,
    ) -> Result<SourceMaterializationReceipt, SourceProviderFailure> {
        destination
            .write_file("materialized", b"provider-contract")
            .assert_value_with("the engine-owned contract target accepts bounded writes");
        Ok(SourceMaterializationReceipt::new(
            request.repository().clone(),
            request.revision().clone(),
            SourceContentDigest::new(digest('b')).assert_value(),
        )
        .assert_value())
    }

    async fn inspect_operation(
        &self,
        _request: &SourceOperationRequest,
    ) -> Result<SourceOperationInspection, SourceProviderFailure> {
        self.inspect_calls.fetch_add(1, Ordering::SeqCst);
        Ok(self.inspection.lock().assert_value().clone())
    }

    async fn operate(
        &self,
        request: &SourceOperationRequest,
        _workspace: SourceWorkspaceCapability<'_>,
    ) -> Result<SourceOperationReceipt, SourceProviderFailure> {
        self.operation_calls.fetch_add(1, Ordering::SeqCst);
        let receipt = self
            .operation_result
            .lock()
            .assert_value()
            .clone()
            .unwrap_or_else(|| SourceOperationReceipt::Merge(self.merge_receipt(request)));
        *self.inspection.lock().assert_value() =
            SourceOperationInspection::Applied(Box::new(receipt.clone()));
        Ok(receipt)
    }
}

fn issue_ref(id: &str, version: u32) -> IssueProviderRef {
    IssueProviderRef::new(IssueProviderId::new(id).assert_value(), version).assert_value()
}

fn issue_profile() -> IssueProfileId {
    IssueProfileId::new("production").assert_value()
}

fn issue_descriptor(
    reference: IssueProviderRef,
    capabilities: impl IntoIterator<Item = IssueCapability>,
    native: impl IntoIterator<Item = IssueCapability>,
) -> IssueProviderDescriptor {
    IssueProviderDescriptor::new(
        reference,
        BTreeMap::from([(
            issue_profile(),
            IssueProfileDescriptor::new(
                capabilities.into_iter().collect(),
                native.into_iter().collect(),
            )
            .assert_value(),
        )]),
    )
    .assert_value()
}

fn merge_receipt_for_issue() -> SourceMergeReceipt {
    let request = source_operation(canonical_repository(source_ref("source.github", 1)));
    SourceMergeReceipt::new(
        request,
        SourceRevisionId::new("integrated-sha").assert_value(),
    )
    .assert_value()
}

fn resolved_linear_issue(reference: IssueProviderRef) -> ResolvedIssue {
    ResolvedIssue::new(
        reference,
        issue_profile(),
        (
            IssueAccountId::new("open-engine-linear").assert_value(),
            IssueId::new("ENG-7").assert_value(),
        ),
        (IssueState::Open, Vec::new()),
    )
    .assert_value()
}

fn issue_close_request(reference: IssueProviderRef) -> IssueCloseRequest {
    IssueCloseRequest::new(
        resolved_linear_issue(reference),
        IssueCredentialHandleId::new("linear-lease").assert_value(),
        (
            IssueOperationId::new("close-ENG-7").assert_value(),
            IssueOperationFingerprint::new(digest('d')).assert_value(),
        ),
        merge_receipt_for_issue(),
    )
    .assert_value()
}

fn issue_close_receipt(request: &IssueCloseRequest) -> IssueCloseReceipt {
    IssueCloseReceipt::new(
        request.issue().clone(),
        (
            request.operation_id().clone(),
            request.fingerprint().clone(),
        ),
        request.source_merge().clone(),
        Vec::new(),
    )
    .assert_value()
}

struct FakeIssueProvider {
    descriptor: IssueProviderDescriptor,
    inspection: Mutex<IssueCloseInspection>,
    resolve_calls: AtomicUsize,
    inspect_calls: AtomicUsize,
    close_calls: AtomicUsize,
}

impl FakeIssueProvider {
    fn new(descriptor: IssueProviderDescriptor, inspection: IssueCloseInspection) -> Self {
        Self {
            descriptor,
            inspection: Mutex::new(inspection),
            resolve_calls: AtomicUsize::new(0),
            inspect_calls: AtomicUsize::new(0),
            close_calls: AtomicUsize::new(0),
        }
    }
}

#[async_trait]
impl IssueProvider for FakeIssueProvider {
    fn descriptor(&self) -> &IssueProviderDescriptor {
        &self.descriptor
    }

    async fn resolve(
        &self,
        request: &IssueResolveRequest,
    ) -> Result<ResolvedIssue, IssueProviderFailure> {
        self.resolve_calls.fetch_add(1, Ordering::SeqCst);
        Ok(ResolvedIssue::new(
            request.provider().clone(),
            request.profile().clone(),
            (
                request.account().clone(),
                IssueId::new(request.reference().as_str()).assert_value(),
            ),
            (
                IssueState::Open,
                vec![IssuePublicUrl::new("https://linear.app/issue/ENG-7").assert_value()],
            ),
        )
        .assert_value())
    }

    async fn inspect_close(
        &self,
        _request: &IssueCloseRequest,
    ) -> Result<IssueCloseInspection, IssueProviderFailure> {
        self.inspect_calls.fetch_add(1, Ordering::SeqCst);
        Ok(self.inspection.lock().assert_value().clone())
    }

    async fn close(
        &self,
        request: &IssueCloseRequest,
    ) -> Result<IssueCloseReceipt, IssueProviderFailure> {
        self.close_calls.fetch_add(1, Ordering::SeqCst);
        Ok(IssueCloseReceipt::new(
            request.issue().clone(),
            (
                request.operation_id().clone(),
                request.fingerprint().clone(),
            ),
            request.source_merge().clone(),
            vec![IssuePublicUrl::new("https://linear.app/issue/ENG-7").assert_value()],
        )
        .assert_value())
    }
}

#[path = "provider_contracts/cases.rs"]
mod cases;
#[path = "provider_contracts/merge_evidence.rs"]
mod merge_evidence;

use openengine_cluster_testkit::assertions::{AssertValue};
