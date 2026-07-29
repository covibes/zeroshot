use super::*;

/// Account and opaque credential handle used to identify a repository.
pub type SourceRepositoryAccess = (SourceAccountId, SourceCredentialHandleId);

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceIdentifyRepositoryRequest {
    provider: SourceProviderRef,
    profile: SourceProfileId,
    account: SourceAccountId,
    credential_handle: SourceCredentialHandleId,
    reference: SourceRepositoryReference,
}

impl SourceIdentifyRepositoryRequest {
    pub fn new(
        provider: SourceProviderRef,
        profile: SourceProfileId,
        access: SourceRepositoryAccess,
        reference: SourceRepositoryReference,
    ) -> Result<Self, SourceContractError> {
        let (account, credential_handle) = access;
        SourceContractError::checked(Self {
            provider,
            profile,
            account,
            credential_handle,
            reference,
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
    pub fn credential_handle(&self) -> &SourceCredentialHandleId {
        &self.credential_handle
    }

    #[must_use]
    pub fn reference(&self) -> &SourceRepositoryReference {
        &self.reference
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceInspectRepositoryRequest {
    repository: CanonicalRepository,
    credential_handle: SourceCredentialHandleId,
}

impl SourceInspectRepositoryRequest {
    pub fn new(
        repository: CanonicalRepository,
        credential_handle: SourceCredentialHandleId,
    ) -> Result<Self, SourceContractError> {
        SourceContractError::checked(Self {
            repository,
            credential_handle,
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
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(try_from = "SourceRepositoryInspectionWire")]
#[serde(rename_all = "camelCase")]
pub struct SourceRepositoryInspection {
    repository: CanonicalRepository,
    default_revision: SourceRevisionId,
    public_urls: BoundedVec<SourcePublicUrl>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SourceRepositoryInspectionWire {
    repository: CanonicalRepository,
    default_revision: SourceRevisionId,
    public_urls: BoundedVec<SourcePublicUrl>,
}

impl TryFrom<SourceRepositoryInspectionWire> for SourceRepositoryInspection {
    type Error = SourceContractError;

    fn try_from(wire: SourceRepositoryInspectionWire) -> Result<Self, Self::Error> {
        SourceContractError::checked(Self {
            repository: wire.repository,
            default_revision: wire.default_revision,
            public_urls: wire.public_urls,
        })
    }
}

impl SourceRepositoryInspection {
    pub fn new(
        repository: CanonicalRepository,
        default_revision: SourceRevisionId,
        public_urls: Vec<SourcePublicUrl>,
    ) -> Result<Self, SourceContractError> {
        SourceContractError::checked(Self {
            repository,
            default_revision,
            public_urls: BoundedVec::new(public_urls)
                .map_err(|error| SourceContractError::new("public URLs", error))?,
        })
    }

    #[must_use]
    pub fn repository(&self) -> &CanonicalRepository {
        &self.repository
    }

    #[must_use]
    pub fn default_revision(&self) -> &SourceRevisionId {
        &self.default_revision
    }

    #[must_use]
    pub fn public_urls(&self) -> &[SourcePublicUrl] {
        self.public_urls.as_slice()
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceMaterializeRequest {
    repository: CanonicalRepository,
    credential_handle: SourceCredentialHandleId,
    revision: SourceRevisionId,
}

impl SourceMaterializeRequest {
    pub fn new(
        repository: CanonicalRepository,
        credential_handle: SourceCredentialHandleId,
        revision: SourceRevisionId,
    ) -> Result<Self, SourceContractError> {
        SourceContractError::checked(Self {
            repository,
            credential_handle,
            revision,
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
    pub fn revision(&self) -> &SourceRevisionId {
        &self.revision
    }
}

pub struct SourceMaterializationDestination<'a> {
    handle: &'a mut (dyn Any + Send),
}

impl<'a> SourceMaterializationDestination<'a> {
    pub fn new<T: Any + Send>(handle: &'a mut T) -> Self {
        Self { handle }
    }

    pub fn downcast_mut<T: Any + Send>(&mut self) -> Option<&mut T> {
        self.handle.downcast_mut::<T>()
    }
}
/// Ephemeral proof that a previously verified workspace is the mutation target.
///
/// The capability is neither cloneable nor serializable, and its exclusive runtime handle makes
/// one capability single-use. Normal safe callers cannot mint one; serializable requests carry
/// only the stable, secret-free workspace identity.
pub struct SourceWorkspaceCapability<'a> {
    workspace: SourceWorkspaceId,
    handle: &'a mut (dyn Any + Send),
}

impl<'a> SourceWorkspaceCapability<'a> {
    pub(crate) fn from_verified<T: Any + Send>(
        workspace: SourceWorkspaceId,
        handle: &'a mut T,
    ) -> Self {
        Self { workspace, handle }
    }

    /// Test-support escape hatch for contract tests that have no product workspace authority.
    ///
    /// # Safety
    ///
    /// The caller must ensure `workspace` is the verified identity of `handle`. Production code
    /// must use the crate-private verified-workspace authority instead.
    #[doc(hidden)]
    pub unsafe fn from_verified_contract_test<T: Any + Send>(
        workspace: SourceWorkspaceId,
        handle: &'a mut T,
    ) -> Self {
        Self::from_verified(workspace, handle)
    }

    #[must_use]
    pub fn workspace(&self) -> &SourceWorkspaceId {
        &self.workspace
    }

    pub fn downcast_mut<T: Any + Send>(&mut self) -> Option<&mut T> {
        self.handle.downcast_mut::<T>()
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceMaterializationReceipt {
    repository: CanonicalRepository,
    revision: SourceRevisionId,
    content_digest: SourceContentDigest,
}

impl SourceMaterializationReceipt {
    pub fn new(
        repository: CanonicalRepository,
        revision: SourceRevisionId,
        content_digest: SourceContentDigest,
    ) -> Result<Self, SourceContractError> {
        SourceContractError::checked(Self {
            repository,
            revision,
            content_digest,
        })
    }

    #[must_use]
    pub fn repository(&self) -> &CanonicalRepository {
        &self.repository
    }

    #[must_use]
    pub fn revision(&self) -> &SourceRevisionId {
        &self.revision
    }

    #[must_use]
    pub fn content_digest(&self) -> &SourceContentDigest {
        &self.content_digest
    }
}
