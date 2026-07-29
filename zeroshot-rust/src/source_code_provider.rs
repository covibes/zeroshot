//! Secret-free contracts for source-code providers.
//!
//! Source identities cannot be substituted for issue identities:
//!
//! ```compile_fail
//! use zeroshot_engine::issue_provider::IssueProviderId;
//! use zeroshot_engine::source_code_provider::SourceProviderId;
//!
//! let issue = IssueProviderId::new("issue.linear").unwrap();
//! let source: SourceProviderId = issue;
//! ```
//!
//! Profile, account, and credential-handle namespaces are also distinct:
//!
//! ```compile_fail
//! use zeroshot_engine::issue_provider::IssueProfileId;
//! use zeroshot_engine::source_code_provider::SourceProfileId;
//!
//! let issue = IssueProfileId::new("production").unwrap();
//! let source: SourceProfileId = issue;
//! ```
//!
//! ```compile_fail
//! use zeroshot_engine::issue_provider::IssueAccountId;
//! use zeroshot_engine::source_code_provider::SourceAccountId;
//!
//! let issue = IssueAccountId::new("account").unwrap();
//! let source: SourceAccountId = issue;
//! ```
//!
//! ```compile_fail
//! use zeroshot_engine::issue_provider::IssueCredentialHandleId;
//! use zeroshot_engine::source_code_provider::SourceCredentialHandleId;
//!
//! let issue = IssueCredentialHandleId::new("lease-handle").unwrap();
//! let source: SourceCredentialHandleId = issue;
//! ```
//!
//! Registries accept only their own provider-reference domain:
//!
//! ```compile_fail
//! use zeroshot_engine::issue_provider::{IssueProviderId, IssueProviderRef};
//! use zeroshot_engine::source_code_provider::SourceCodeProviderRegistry;
//!
//! let issue = IssueProviderRef::new(IssueProviderId::new("issue.linear").unwrap(), 1).unwrap();
//! SourceCodeProviderRegistry::new().lookup(&issue).unwrap();
//! ```
//!
//! ```compile_fail
//! use zeroshot_engine::issue_provider::IssueProviderRegistry;
//! use zeroshot_engine::source_code_provider::{SourceProviderId, SourceProviderRef};
//!
//! let source = SourceProviderRef::new(SourceProviderId::new("source.github").unwrap(), 1).unwrap();
//! IssueProviderRegistry::new().lookup(&source).unwrap();
//! ```
//!
//! A materialization destination is deliberately ephemeral and cannot be serialized:
//!
//! ```compile_fail
//! use zeroshot_engine::source_code_provider::SourceMaterializationDestination;
//!
//! let mut destination = ();
//! let destination = SourceMaterializationDestination::new(&mut destination);
//! serde_json::to_string(&destination).unwrap();
//! ```
//!
//! A verified workspace capability cannot be minted, serialized, or cloned by safe downstream
//! code:
//!
//! ```compile_fail
//! use zeroshot_engine::source_code_provider::{SourceWorkspaceCapability, SourceWorkspaceId};
//!
//! let id = SourceWorkspaceId::new("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa").unwrap();
//! let mut runtime = ();
//! let capability = SourceWorkspaceCapability::from_verified(id, &mut runtime);
//! serde_json::to_string(&capability).unwrap();
//! let _replay = capability.clone();
//! ```

use std::any::Any;
use std::sync::Arc;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::provider_value::{
    bounded_bytes_type, bounded_text_type, digest_type, profile_descriptor_type,
    provider_contract_types, provider_descriptor_type, BoundedMap, BoundedVec, ValueError,
};

const PROFILE_ID_MAX: usize = 128;
const EXTERNAL_ID_MAX: usize = 256;
const PUBLIC_URL_MAX: usize = 2_048;

provider_contract_types!(
    SourceContractError,
    SourceProviderId,
    SourceProfileId,
    SourceAccountId,
    SourceCredentialHandleId,
    SourceOperationId,
    SourceOperationFingerprint,
    SourceProviderRef,
    PROFILE_ID_MAX,
    "source"
);
bounded_text_type!(
    SourceRepositoryReference,
    EXTERNAL_ID_MAX,
    SourceContractError,
    "repository reference"
);
bounded_text_type!(
    SourceRepositoryId,
    EXTERNAL_ID_MAX,
    SourceContractError,
    "repository id"
);
bounded_text_type!(
    SourceRevisionId,
    EXTERNAL_ID_MAX,
    SourceContractError,
    "revision id"
);
bounded_text_type!(
    SourceBranchId,
    EXTERNAL_ID_MAX,
    SourceContractError,
    "branch id"
);
bounded_text_type!(
    SourceReviewId,
    EXTERNAL_ID_MAX,
    SourceContractError,
    "review id"
);
bounded_text_type!(
    SourceRemoteId,
    EXTERNAL_ID_MAX,
    SourceContractError,
    "remote id"
);
bounded_text_type!(
    SourceCheckId,
    EXTERNAL_ID_MAX,
    SourceContractError,
    "check id"
);
bounded_bytes_type!(
    SourcePublicUrl,
    PUBLIC_URL_MAX,
    SourceContractError,
    "public URL"
);
bounded_text_type!(
    SourceFailureMessage,
    EXTERNAL_ID_MAX,
    SourceContractError,
    "failure message"
);
digest_type!(SourceContentDigest, SourceContractError, "content digest");
digest_type!(SourceWorkspaceId, SourceContractError, "workspace id");
digest_type!(
    SourceStateDigest,
    SourceContractError,
    "pre-effect state digest"
);
digest_type!(
    SourceMessageDigest,
    SourceContractError,
    "commit message digest"
);
digest_type!(
    SourcePolicyDigest,
    SourceContractError,
    "required policy digest"
);

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SourceCapability {
    Read,
    Branch,
    Commit,
    Push,
    PullRequest,
    Checks,
    AutoMerge,
    MergeQueue,
    Merge,
}

profile_descriptor_type!(
    SourceProfileDescriptor,
    SourceProfileDescriptorWire,
    "SourceProfileDescriptorWire",
    SourceCapability,
    SourceContractError,
    "source capabilities"
);

provider_descriptor_type!(
    SourceProviderDescriptor,
    SourceProviderDescriptorWire,
    "SourceProviderDescriptorWire",
    SourceProviderRef,
    SourceProfileId,
    SourceProfileDescriptor,
    SourceContractError,
    "source profiles"
);

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CanonicalRepository {
    provider: SourceProviderRef,
    profile: SourceProfileId,
    account: SourceAccountId,
    repository: SourceRepositoryId,
}

impl CanonicalRepository {
    pub fn new(
        provider: SourceProviderRef,
        profile: SourceProfileId,
        account: SourceAccountId,
        repository: SourceRepositoryId,
    ) -> Result<Self, SourceContractError> {
        SourceContractError::checked(Self {
            provider,
            profile,
            account,
            repository,
        })
    }

    #[must_use]
    pub fn provider(&self) -> &SourceProviderRef {
        &self.provider
    }

    #[must_use]
    pub fn profile(&self) -> &SourceProfileId {
        &self.profile
    }

    #[must_use]
    pub fn account(&self) -> &SourceAccountId {
        &self.account
    }

    #[must_use]
    pub fn repository(&self) -> &SourceRepositoryId {
        &self.repository
    }
}

mod evidence;
mod operation;
mod registry;
mod repository;

pub use evidence::*;
pub use operation::*;
pub use registry::*;
pub use repository::*;
