use super::*;
use serde::{ser, Serializer};
use crate::provider_value::validate_serialized;

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SourceOperationReceipt {
    Branch(SourceBranchReceipt),
    Commit(SourceCommitReceipt),
    Push(SourcePushReceipt),
    PullRequest(SourcePullRequestReceipt),
    Checks(SourceChecksReceipt),
    AutoMerge(SourceAutoMergeReceipt),
    MergeQueue(SourceMergeQueueReceipt),
    Merge(SourceMergeReceipt),
}

#[derive(Serialize)]
#[serde(rename_all = "snake_case", tag = "kind", content = "receipt")]
enum SourceOperationReceiptRef<'a> {
    Branch(&'a SourceBranchReceipt),
    Commit(&'a SourceCommitReceipt),
    Push(&'a SourcePushReceipt),
    PullRequest(&'a SourcePullRequestReceipt),
    Checks(&'a SourceChecksReceipt),
    AutoMerge(&'a SourceAutoMergeReceipt),
    MergeQueue(&'a SourceMergeQueueReceipt),
    Merge(&'a SourceMergeReceipt),
}

impl Serialize for SourceOperationReceipt {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let wire = match self {
            Self::Branch(receipt) => SourceOperationReceiptRef::Branch(receipt),
            Self::Commit(receipt) => SourceOperationReceiptRef::Commit(receipt),
            Self::Push(receipt) => SourceOperationReceiptRef::Push(receipt),
            Self::PullRequest(receipt) => SourceOperationReceiptRef::PullRequest(receipt),
            Self::Checks(receipt) => SourceOperationReceiptRef::Checks(receipt),
            Self::AutoMerge(receipt) => SourceOperationReceiptRef::AutoMerge(receipt),
            Self::MergeQueue(receipt) => SourceOperationReceiptRef::MergeQueue(receipt),
            Self::Merge(receipt) => SourceOperationReceiptRef::Merge(receipt),
        };
        validate_serialized(&wire).map_err(ser::Error::custom)?;
        wire.serialize(serializer)
    }
}

#[derive(Deserialize)]
#[serde(
    rename_all = "snake_case",
    tag = "kind",
    content = "receipt",
    deny_unknown_fields
)]
enum SourceOperationReceiptWire {
    Branch(SourceBranchReceipt),
    Commit(SourceCommitReceipt),
    Push(SourcePushReceipt),
    PullRequest(SourcePullRequestReceipt),
    Checks(SourceChecksReceipt),
    AutoMerge(SourceAutoMergeReceipt),
    MergeQueue(SourceMergeQueueReceipt),
    Merge(SourceMergeReceipt),
}

impl TryFrom<SourceOperationReceiptWire> for SourceOperationReceipt {
    type Error = SourceContractError;

    fn try_from(wire: SourceOperationReceiptWire) -> Result<Self, Self::Error> {
        SourceContractError::checked(match wire {
            SourceOperationReceiptWire::Branch(receipt) => Self::Branch(receipt),
            SourceOperationReceiptWire::Commit(receipt) => Self::Commit(receipt),
            SourceOperationReceiptWire::Push(receipt) => Self::Push(receipt),
            SourceOperationReceiptWire::PullRequest(receipt) => Self::PullRequest(receipt),
            SourceOperationReceiptWire::Checks(receipt) => Self::Checks(receipt),
            SourceOperationReceiptWire::AutoMerge(receipt) => Self::AutoMerge(receipt),
            SourceOperationReceiptWire::MergeQueue(receipt) => Self::MergeQueue(receipt),
            SourceOperationReceiptWire::Merge(receipt) => Self::Merge(receipt),
        })
    }
}

impl<'de> Deserialize<'de> for SourceOperationReceipt {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        SourceOperationReceiptWire::deserialize(deserializer)?
            .try_into()
            .map_err(serde::de::Error::custom)
    }
}

impl SourceOperationReceipt {
    #[must_use]
    pub fn capability(&self) -> SourceCapability {
        match self {
            Self::Branch(_) => SourceCapability::Branch,
            Self::Commit(_) => SourceCapability::Commit,
            Self::Push(_) => SourceCapability::Push,
            Self::PullRequest(_) => SourceCapability::PullRequest,
            Self::Checks(_) => SourceCapability::Checks,
            Self::AutoMerge(_) => SourceCapability::AutoMerge,
            Self::MergeQueue(_) => SourceCapability::MergeQueue,
            Self::Merge(_) => SourceCapability::Merge,
        }
    }

    #[must_use]
    pub fn request(&self) -> &SourceOperationRequest {
        match self {
            Self::Branch(receipt) => receipt.request(),
            Self::Commit(receipt) => receipt.request(),
            Self::Push(receipt) => receipt.request(),
            Self::PullRequest(receipt) => receipt.request(),
            Self::Checks(receipt) => receipt.request(),
            Self::AutoMerge(receipt) => receipt.request(),
            Self::MergeQueue(receipt) => receipt.request(),
            Self::Merge(receipt) => receipt.request(),
        }
    }

    fn evidence_matches_operation(&self) -> bool {
        match (self, self.request().operation()) {
            (
                Self::Branch(receipt),
                SourceOperation::Branch {
                    expected_parent, ..
                },
            ) => receipt.resulting_head() == expected_parent,
            (Self::Commit(_), SourceOperation::Commit { .. }) => true,
            (Self::Push(receipt), SourceOperation::Push { revision, .. }) => {
                receipt.pushed_revision() == revision
            }
            (Self::PullRequest(receipt), SourceOperation::PullRequest { review, .. }) => {
                receipt.review() == review
            }
            (Self::AutoMerge(receipt), SourceOperation::AutoMerge { review, policy, .. }) => {
                receipt.review() == review && policy.is_satisfied()
            }
            (Self::MergeQueue(receipt), SourceOperation::MergeQueue { review, policy, .. }) => {
                receipt.review() == review && policy.is_satisfied()
            }
            (Self::Checks(receipt), SourceOperation::Checks { policy, .. }) => {
                receipt.policy() == policy && receipt.policy().is_satisfied()
            }
            (
                Self::Merge(receipt),
                SourceOperation::Merge {
                    integrated_revision,
                    policy,
                    ..
                },
            ) => receipt.integrated_revision() == integrated_revision && policy.is_satisfied(),
            _ => false,
        }
    }

    pub fn matches_request(&self, request: &SourceOperationRequest) -> bool {
        self.request() == request
            && self.evidence_matches_operation()
            && validate_serialized(self).is_ok()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SourceOperationInspection {
    Unobserved,
    Pending,
    Applied(Box<SourceOperationReceipt>),
    Conflict {
        observed_fingerprint: SourceOperationFingerprint,
    },
    Indeterminate {
        evidence: SourceFailureMessage,
    },
}

#[derive(Serialize)]
#[serde(rename_all = "snake_case", tag = "state", content = "evidence")]
enum SourceOperationInspectionRef<'a> {
    Unobserved,
    Pending,
    Applied(&'a SourceOperationReceipt),
    Conflict {
        observed_fingerprint: &'a SourceOperationFingerprint,
    },
    Indeterminate {
        evidence: &'a SourceFailureMessage,
    },
}

impl Serialize for SourceOperationInspection {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let wire = match self {
            Self::Unobserved => SourceOperationInspectionRef::Unobserved,
            Self::Pending => SourceOperationInspectionRef::Pending,
            Self::Applied(receipt) => SourceOperationInspectionRef::Applied(receipt),
            Self::Conflict {
                observed_fingerprint,
            } => SourceOperationInspectionRef::Conflict {
                observed_fingerprint,
            },
            Self::Indeterminate { evidence } => {
                SourceOperationInspectionRef::Indeterminate { evidence }
            }
        };
        validate_serialized(&wire).map_err(ser::Error::custom)?;
        wire.serialize(serializer)
    }
}

#[derive(Deserialize)]
#[serde(
    rename_all = "snake_case",
    tag = "state",
    content = "evidence",
    deny_unknown_fields
)]
enum SourceOperationInspectionWire {
    Unobserved,
    Pending,
    Applied(Box<SourceOperationReceipt>),
    Conflict {
        observed_fingerprint: SourceOperationFingerprint,
    },
    Indeterminate {
        evidence: SourceFailureMessage,
    },
}

impl TryFrom<SourceOperationInspectionWire> for SourceOperationInspection {
    type Error = SourceContractError;

    fn try_from(wire: SourceOperationInspectionWire) -> Result<Self, Self::Error> {
        SourceContractError::checked(match wire {
            SourceOperationInspectionWire::Unobserved => Self::Unobserved,
            SourceOperationInspectionWire::Pending => Self::Pending,
            SourceOperationInspectionWire::Applied(receipt) => Self::Applied(receipt),
            SourceOperationInspectionWire::Conflict {
                observed_fingerprint,
            } => Self::Conflict {
                observed_fingerprint,
            },
            SourceOperationInspectionWire::Indeterminate { evidence } => {
                Self::Indeterminate { evidence }
            }
        })
    }
}

impl<'de> Deserialize<'de> for SourceOperationInspection {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        SourceOperationInspectionWire::deserialize(deserializer)?
            .try_into()
            .map_err(serde::de::Error::custom)
    }
}

impl SourceOperationInspection {
    #[must_use]
    pub fn permits_invocation(&self, _provider_native_idempotency: bool) -> bool {
        matches!(self, Self::Unobserved)
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SourceProviderFailureCode {
    Unavailable,
    Unauthorized,
    InvalidRequest,
    Conflict,
    Indeterminate,
}

#[derive(Clone, Debug, Deserialize, Eq, Error, PartialEq, Serialize)]
#[error("source provider {code:?}: {message}")]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceProviderFailure {
    code: SourceProviderFailureCode,
    message: SourceFailureMessage,
}

impl SourceProviderFailure {
    pub fn new(
        code: SourceProviderFailureCode,
        message: SourceFailureMessage,
    ) -> Result<Self, SourceContractError> {
        SourceContractError::checked(Self { code, message })
    }

    #[must_use]
    pub fn code(&self) -> SourceProviderFailureCode {
        self.code
    }

    #[must_use]
    pub fn message(&self) -> &SourceFailureMessage {
        &self.message
    }
}

#[async_trait]
pub trait SourceCodeProvider: Send + Sync {
    fn descriptor(&self) -> &SourceProviderDescriptor;

    async fn identify_repository(
        &self,
        request: &SourceIdentifyRepositoryRequest,
    ) -> Result<CanonicalRepository, SourceProviderFailure>;

    async fn inspect_repository(
        &self,
        request: &SourceInspectRepositoryRequest,
    ) -> Result<SourceRepositoryInspection, SourceProviderFailure>;

    async fn materialize(
        &self,
        request: &SourceMaterializeRequest,
        destination: SourceMaterializationDestination<'_>,
    ) -> Result<SourceMaterializationReceipt, SourceProviderFailure>;

    async fn inspect_operation(
        &self,
        request: &SourceOperationRequest,
    ) -> Result<SourceOperationInspection, SourceProviderFailure>;

    async fn operate(
        &self,
        request: &SourceOperationRequest,
        workspace: SourceWorkspaceCapability<'_>,
    ) -> Result<SourceOperationReceipt, SourceProviderFailure>;
}
