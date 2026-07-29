use std::collections::BTreeMap;

use sha2::{Digest, Sha256};

use super::*;

/// Canonical, provider-independent identity of one code review.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceReviewIdentity {
    review: SourceReviewId,
    base_branch: SourceBranchId,
    head_branch: SourceBranchId,
}

impl SourceReviewIdentity {
    pub fn new(
        review: SourceReviewId,
        base_branch: SourceBranchId,
        head_branch: SourceBranchId,
    ) -> Result<Self, SourceContractError> {
        SourceContractError::checked(Self {
            review,
            base_branch,
            head_branch,
        })
    }

    #[must_use]
    pub fn review(&self) -> &SourceReviewId {
        &self.review
    }

    #[must_use]
    pub fn base_branch(&self) -> &SourceBranchId {
        &self.base_branch
    }

    #[must_use]
    pub fn head_branch(&self) -> &SourceBranchId {
        &self.head_branch
    }
}

/// Closed conclusion vocabulary used as authoritative check evidence.
#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SourceCheckConclusion {
    Pending,
    Satisfied,
    Failed,
    Cancelled,
    Skipped,
}

/// Exact required-policy identity and its canonical, sorted conclusions.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(try_from = "SourceRequiredPolicyWire", rename_all = "camelCase")]
pub struct SourceRequiredPolicy {
    digest: SourcePolicyDigest,
    conclusions: BoundedMap<SourceCheckId, SourceCheckConclusion>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SourceRequiredPolicyWire {
    digest: SourcePolicyDigest,
    conclusions: BoundedMap<SourceCheckId, SourceCheckConclusion>,
}

impl TryFrom<SourceRequiredPolicyWire> for SourceRequiredPolicy {
    type Error = SourceContractError;

    fn try_from(wire: SourceRequiredPolicyWire) -> Result<Self, Self::Error> {
        SourceContractError::checked(Self {
            digest: wire.digest,
            conclusions: wire.conclusions,
        })
    }
}

impl SourceRequiredPolicy {
    pub fn new(
        digest: SourcePolicyDigest,
        conclusions: BTreeMap<SourceCheckId, SourceCheckConclusion>,
    ) -> Result<Self, SourceContractError> {
        SourceContractError::checked(Self {
            digest,
            conclusions: BoundedMap::new(conclusions)
                .map_err(|error| SourceContractError::new("required check conclusions", error))?,
        })
    }

    #[must_use]
    pub fn digest(&self) -> &SourcePolicyDigest {
        &self.digest
    }

    #[must_use]
    pub fn conclusions(&self) -> &BTreeMap<SourceCheckId, SourceCheckConclusion> {
        self.conclusions.as_map()
    }

    #[must_use]
    pub fn is_satisfied(&self) -> bool {
        !self.conclusions().is_empty()
            && self
                .conclusions()
                .values()
                .all(|conclusion| *conclusion == SourceCheckConclusion::Satisfied)
    }
}

/// Closed source mutation intent. Every field is stable, bounded, and secret-free.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case", tag = "kind", deny_unknown_fields)]
pub enum SourceOperation {
    Branch {
        expected_parent: SourceRevisionId,
        branch: SourceBranchId,
        pre_effect: SourceStateDigest,
    },
    Commit {
        expected_head: SourceRevisionId,
        branch: SourceBranchId,
        message_digest: SourceMessageDigest,
        change_digest: SourceContentDigest,
        pre_effect: SourceStateDigest,
    },
    Push {
        expected_head: SourceRevisionId,
        branch: SourceBranchId,
        remote: SourceRemoteId,
        expected_remote_head: Option<SourceRevisionId>,
        revision: SourceRevisionId,
        pre_effect: SourceStateDigest,
    },
    PullRequest {
        review: SourceReviewIdentity,
        expected_base: SourceRevisionId,
        expected_head: SourceRevisionId,
        checked_revision: SourceRevisionId,
        policy: SourceRequiredPolicy,
    },
    Checks {
        review: SourceReviewIdentity,
        expected_base: SourceRevisionId,
        expected_head: SourceRevisionId,
        checked_revision: SourceRevisionId,
        policy: SourceRequiredPolicy,
    },
    AutoMerge {
        review: SourceReviewIdentity,
        expected_base: SourceRevisionId,
        expected_head: SourceRevisionId,
        checked_revision: SourceRevisionId,
        policy: SourceRequiredPolicy,
    },
    MergeQueue {
        review: SourceReviewIdentity,
        expected_base: SourceRevisionId,
        expected_head: SourceRevisionId,
        checked_revision: SourceRevisionId,
        policy: SourceRequiredPolicy,
    },
    Merge {
        review: SourceReviewIdentity,
        expected_base: SourceRevisionId,
        expected_head: SourceRevisionId,
        checked_revision: SourceRevisionId,
        policy: SourceRequiredPolicy,
        integrated_revision: SourceRevisionId,
    },
}

impl SourceOperation {
    #[must_use]
    pub fn capability(&self) -> SourceCapability {
        match self {
            Self::Branch { .. } => SourceCapability::Branch,
            Self::Commit { .. } => SourceCapability::Commit,
            Self::Push { .. } => SourceCapability::Push,
            Self::PullRequest { .. } => SourceCapability::PullRequest,
            Self::Checks { .. } => SourceCapability::Checks,
            Self::AutoMerge { .. } => SourceCapability::AutoMerge,
            Self::MergeQueue { .. } => SourceCapability::MergeQueue,
            Self::Merge { .. } => SourceCapability::Merge,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceOperationRequest {
    repository: CanonicalRepository,
    credential_handle: SourceCredentialHandleId,
    workspace: SourceWorkspaceId,
    operation_id: SourceOperationId,
    fingerprint: SourceOperationFingerprint,
    operation: SourceOperation,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SourceOperationRequestWire {
    repository: CanonicalRepository,
    credential_handle: SourceCredentialHandleId,
    workspace: SourceWorkspaceId,
    operation_id: SourceOperationId,
    fingerprint: SourceOperationFingerprint,
    operation: SourceOperation,
}

struct SourceOperationRequestInput {
    repository: CanonicalRepository,
    credential_handle: SourceCredentialHandleId,
    workspace: SourceWorkspaceId,
    operation_id: SourceOperationId,
    operation: SourceOperation,
}

impl<'de> Deserialize<'de> for SourceOperationRequest {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let SourceOperationRequestWire {
            repository,
            credential_handle,
            workspace,
            operation_id,
            fingerprint,
            operation,
        } = SourceOperationRequestWire::deserialize(deserializer)?;
        let request = Self::build(SourceOperationRequestInput {
            repository,
            credential_handle,
            workspace,
            operation_id,
            operation,
        })
        .map_err(serde::de::Error::custom)?;
        if request.fingerprint != fingerprint {
            return Err(serde::de::Error::custom(
                "source operation fingerprint does not match canonical intent",
            ));
        }
        Ok(request)
    }
}

impl SourceOperationRequest {
    pub fn new(
        repository: CanonicalRepository,
        credential_handle: SourceCredentialHandleId,
        identity: (SourceWorkspaceId, SourceOperationId),
        operation: SourceOperation,
    ) -> Result<Self, SourceContractError> {
        let (workspace, operation_id) = identity;
        Self::build(SourceOperationRequestInput {
            repository,
            credential_handle,
            workspace,
            operation_id,
            operation,
        })
    }

    fn build(input: SourceOperationRequestInput) -> Result<Self, SourceContractError> {
        let SourceOperationRequestInput {
            repository,
            credential_handle,
            workspace,
            operation_id,
            operation,
        } = input;
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct CanonicalIntent<'a> {
            repository: &'a CanonicalRepository,
            credential_handle: &'a SourceCredentialHandleId,
            workspace: &'a SourceWorkspaceId,
            operation_id: &'a SourceOperationId,
            operation: &'a SourceOperation,
        }

        let bytes = serde_json::to_vec(&CanonicalIntent {
            repository: &repository,
            credential_handle: &credential_handle,
            workspace: &workspace,
            operation_id: &operation_id,
            operation: &operation,
        })
        .map_err(|error| SourceContractError::new("canonical source intent", error))?;
        let fingerprint = SourceOperationFingerprint::new(format!("{:x}", Sha256::digest(bytes)))?;
        SourceContractError::checked(Self {
            repository,
            credential_handle,
            workspace,
            operation_id,
            fingerprint,
            operation,
        })
    }

    #[must_use]
    pub fn repository(&self) -> &CanonicalRepository {
        &self.repository
    }

    #[must_use]
    pub fn credential_handle(&self) -> &SourceCredentialHandleId {
        &self.credential_handle
    }

    #[must_use]
    pub fn workspace(&self) -> &SourceWorkspaceId {
        &self.workspace
    }

    #[must_use]
    pub fn operation_id(&self) -> &SourceOperationId {
        &self.operation_id
    }

    #[must_use]
    pub fn fingerprint(&self) -> &SourceOperationFingerprint {
        &self.fingerprint
    }

    #[must_use]
    pub fn operation(&self) -> &SourceOperation {
        &self.operation
    }
}

macro_rules! source_receipt {
    ($name:ident, $variant:ident, $capability:ident, $field:ident : $field_ty:ty, $valid:expr) => {
        #[derive(Clone, Debug, Eq, PartialEq, Serialize)]
        #[serde(rename_all = "camelCase")]
        pub struct $name {
            request: SourceOperationRequest,
            $field: $field_ty,
        }

        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct $variant {
            request: SourceOperationRequest,
            $field: $field_ty,
        }

        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
            where
                D: serde::Deserializer<'de>,
            {
                let wire = $variant::deserialize(deserializer)?;
                Self::new(wire.request, wire.$field).map_err(serde::de::Error::custom)
            }
        }

        impl $name {
            pub fn new(
                request: SourceOperationRequest,
                $field: $field_ty,
            ) -> Result<Self, SourceContractError> {
                if request.operation().capability() != SourceCapability::$capability {
                    return Err(SourceContractError::new(
                        "source operation receipt",
                        concat!(
                            stringify!($name),
                            " requires a ",
                            stringify!($capability),
                            " request"
                        ),
                    ));
                }
                if !($valid)(&request, &$field) {
                    return Err(SourceContractError::new(
                        "source operation receipt evidence",
                        concat!(stringify!($name), " contradicts its request"),
                    ));
                }
                SourceContractError::checked(Self { request, $field })
            }

            #[must_use]
            pub fn request(&self) -> &SourceOperationRequest {
                &self.request
            }

            #[must_use]
            pub fn $field(&self) -> &$field_ty {
                &self.$field
            }
        }
    };
}

source_receipt!(
    SourceBranchReceipt,
    SourceBranchReceiptWire,
    Branch,
    resulting_head: SourceRevisionId,
    |request: &SourceOperationRequest, evidence: &SourceRevisionId| matches!(
        request.operation(),
        SourceOperation::Branch {
            expected_parent,
            ..
        } if evidence == expected_parent
    )
);
source_receipt!(
    SourceCommitReceipt,
    SourceCommitReceiptWire,
    Commit,
    committed_revision: SourceRevisionId,
    |_request: &SourceOperationRequest, _evidence: &SourceRevisionId| true
);
source_receipt!(
    SourcePushReceipt,
    SourcePushReceiptWire,
    Push,
    pushed_revision: SourceRevisionId,
    |request: &SourceOperationRequest, evidence: &SourceRevisionId| matches!(
        request.operation(),
        SourceOperation::Push { revision, .. } if evidence == revision
    )
);
source_receipt!(
    SourcePullRequestReceipt,
    SourcePullRequestReceiptWire,
    PullRequest,
    review: SourceReviewIdentity,
    |request: &SourceOperationRequest, evidence: &SourceReviewIdentity| matches!(
        request.operation(),
        SourceOperation::PullRequest { review, .. } if evidence == review
    )
);
source_receipt!(
    SourceChecksReceipt,
    SourceChecksReceiptWire,
    Checks,
    policy: SourceRequiredPolicy,
    |request: &SourceOperationRequest, evidence: &SourceRequiredPolicy| matches!(
        request.operation(),
        SourceOperation::Checks { policy, .. }
            if evidence == policy && policy.is_satisfied()
    )
);
source_receipt!(
    SourceAutoMergeReceipt,
    SourceAutoMergeReceiptWire,
    AutoMerge,
    review: SourceReviewIdentity,
    |request: &SourceOperationRequest, evidence: &SourceReviewIdentity| matches!(
        request.operation(),
        SourceOperation::AutoMerge { review, policy, .. }
            if evidence == review && policy.is_satisfied()
    )
);
source_receipt!(
    SourceMergeQueueReceipt,
    SourceMergeQueueReceiptWire,
    MergeQueue,
    review: SourceReviewIdentity,
    |request: &SourceOperationRequest, evidence: &SourceReviewIdentity| matches!(
        request.operation(),
        SourceOperation::MergeQueue { review, policy, .. }
            if evidence == review && policy.is_satisfied()
    )
);
source_receipt!(
    SourceMergeReceipt,
    SourceMergeReceiptWire,
    Merge,
    integrated_revision: SourceRevisionId,
    |request: &SourceOperationRequest, evidence: &SourceRevisionId| matches!(
        request.operation(),
        SourceOperation::Merge {
            policy,
            integrated_revision,
            ..
        } if evidence == integrated_revision && policy.is_satisfied()
    )
);
