//! Protocol-free, secret-free admission manifest compiler. Composes the worker catalog, role
//! contract pack, and compiled worker binding registry into one bounded, versioned, digested
//! manifest. No config, credential, driver, or graph-compiler concerns.

use std::num::NonZeroU32;

use serde::Serialize;

use crate::execution::{CatalogDigest, ProfileDigest, RegistryDigest, SessionScope};
use crate::provider_value::{canonicalize, parse_version};
use crate::role_contract::{RoleContractDigest, RoleContractPack, RoleName};
use crate::worker_bindings::WorkerBindingRegistry;
use crate::worker_catalog::{
    ModelLevel, ProviderDescriptor, ProviderId, ReasoningEffort, WorkerCatalog,
};

crate::provider_value::contract_error_type!(AdmissionManifestError);
crate::provider_value::bounded_text_type!(
    WorkspacePolicyRef,
    128,
    AdmissionManifestError,
    "workspace policy reference"
);
crate::provider_value::bounded_text_type!(
    SourcePolicyRef,
    128,
    AdmissionManifestError,
    "source policy reference"
);
crate::provider_value::bounded_text_type!(
    ProofGateRef,
    128,
    AdmissionManifestError,
    "proof gate reference"
);
crate::provider_value::digest_type!(
    AdmissionManifestDigest,
    AdmissionManifestError,
    "admission manifest digest"
);

#[derive(Clone, Copy, Debug)]
pub struct AdmissionSources<'a> {
    pub catalog: &'a WorkerCatalog,
    pub roles: &'a RoleContractPack,
    pub registry: &'a WorkerBindingRegistry,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AdmissionSelectionSpec {
    pub provider: ProviderId,
    pub model_level: ModelLevel,
    pub reasoning_effort: Option<ReasoningEffort>,
    pub session_scope: SessionScope,
    pub workspace_ref: WorkspacePolicyRef,
    pub source_ref: SourcePolicyRef,
    pub proof_gate_ref: ProofGateRef,
    pub execution_deadline_ms: u64,
    pub session_deadline_ms: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AdmissionManifest {
    version: NonZeroU32,
    catalog_digest: CatalogDigest,
    profile_digest: ProfileDigest,
    registry_digest: RegistryDigest,
    role_contract_digest: RoleContractDigest,
    provider: ProviderId,
    model_level: ModelLevel,
    reasoning_effort: Option<ReasoningEffort>,
    session_scope: SessionScope,
    workspace_ref: WorkspacePolicyRef,
    source_ref: SourcePolicyRef,
    proof_gate_ref: ProofGateRef,
    execution_deadline_ms: u64,
    session_deadline_ms: u64,
    canonical_bytes: Vec<u8>,
    digest: AdmissionManifestDigest,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CanonicalManifest<'a> {
    version: u32,
    catalog_digest: &'a CatalogDigest,
    profile_digest: &'a ProfileDigest,
    registry_digest: &'a RegistryDigest,
    role_contract_digest: &'a RoleContractDigest,
    provider: &'a ProviderId,
    model_level: ModelLevel,
    reasoning_effort: Option<ReasoningEffort>,
    session_scope: SessionScope,
    workspace_ref: &'a WorkspacePolicyRef,
    source_ref: &'a SourcePolicyRef,
    proof_gate_ref: &'a ProofGateRef,
    execution_deadline_ms: u64,
    session_deadline_ms: u64,
}

fn validate_deadlines(
    execution_deadline_ms: u64,
    session_deadline_ms: u64,
) -> Result<(), AdmissionManifestError> {
    if execution_deadline_ms == 0 {
        return Err(AdmissionManifestError::new(
            "execution deadline",
            "must be greater than zero",
        ));
    }
    if session_deadline_ms == 0 {
        return Err(AdmissionManifestError::new(
            "session deadline",
            "must be greater than zero",
        ));
    }
    if session_deadline_ms > execution_deadline_ms {
        return Err(AdmissionManifestError::new(
            "session deadline",
            "must be less than or equal to the execution deadline",
        ));
    }
    Ok(())
}

fn resolve_selected_provider<'a>(
    catalog: &'a WorkerCatalog,
    selection: &AdmissionSelectionSpec,
) -> Result<&'a ProviderDescriptor, AdmissionManifestError> {
    let provider = catalog
        .resolve(selection.provider.as_str())
        .ok_or_else(|| AdmissionManifestError::new("provider", "unknown provider"))?;
    if provider.id() != &selection.provider {
        return Err(AdmissionManifestError::new(
            "provider",
            "selection must name a canonical provider id, not an alias",
        ));
    }
    if !provider
        .models()
        .levels()
        .contains_key(&selection.model_level)
    {
        return Err(AdmissionManifestError::new(
            "model level",
            "model level is absent from the provider's model policy",
        ));
    }
    if let Some(effort) = selection.reasoning_effort {
        if !provider.reasoning().supports(effort) {
            return Err(AdmissionManifestError::new(
                "reasoning effort",
                "reasoning effort is unsupported by the provider",
            ));
        }
    }
    if !provider.sessions().supports(selection.session_scope) {
        return Err(AdmissionManifestError::new(
            "session scope",
            "session scope is unsupported by the provider",
        ));
    }
    Ok(provider)
}

fn validate_graph_worker_closure(
    registry: &WorkerBindingRegistry,
    provider_id: &ProviderId,
) -> Result<(), AdmissionManifestError> {
    if !registry.agents().contains_key(provider_id) {
        return Err(AdmissionManifestError::new(
            "worker binding",
            "provider has no compiled worker binding",
        ));
    }
    if registry.builtins().is_empty() {
        return Err(AdmissionManifestError::new(
            "worker binding",
            "no built-in worker binding compiled",
        ));
    }
    Ok(())
}

fn validate_role_closure(roles: &RoleContractPack) -> Result<(), AdmissionManifestError> {
    if roles.contracts().len() != RoleName::ALL.len() {
        return Err(AdmissionManifestError::new(
            "role contract pack",
            "role pack must define every native role exactly once",
        ));
    }
    Ok(())
}

impl AdmissionManifest {
    pub fn compile(
        version: u32,
        selection: AdmissionSelectionSpec,
        sources: AdmissionSources<'_>,
    ) -> Result<Self, AdmissionManifestError> {
        let AdmissionSources {
            catalog,
            roles,
            registry,
        } = sources;
        let version = parse_version(version)
            .map_err(|error| AdmissionManifestError::new("manifest version", error))?;

        let provider = resolve_selected_provider(catalog, &selection)?;
        validate_graph_worker_closure(registry, provider.id())?;
        validate_role_closure(roles)?;
        validate_deadlines(
            selection.execution_deadline_ms,
            selection.session_deadline_ms,
        )?;

        let canonical = AdmissionManifestError::checked(CanonicalManifest {
            version: version.get(),
            catalog_digest: catalog.digest(),
            profile_digest: registry.profile_digest(),
            registry_digest: registry.digest(),
            role_contract_digest: roles.digest(),
            provider: &selection.provider,
            model_level: selection.model_level,
            reasoning_effort: selection.reasoning_effort,
            session_scope: selection.session_scope,
            workspace_ref: &selection.workspace_ref,
            source_ref: &selection.source_ref,
            proof_gate_ref: &selection.proof_gate_ref,
            execution_deadline_ms: selection.execution_deadline_ms,
            session_deadline_ms: selection.session_deadline_ms,
        })?;
        let (canonical_bytes, digest_hex) = canonicalize(&canonical)
            .map_err(|error| AdmissionManifestError::new("canonical admission manifest", error))?;
        let digest = AdmissionManifestDigest::new(digest_hex)?;

        Ok(Self {
            version,
            catalog_digest: catalog.digest().clone(),
            profile_digest: registry.profile_digest().clone(),
            registry_digest: registry.digest().clone(),
            role_contract_digest: roles.digest().clone(),
            provider: selection.provider,
            model_level: selection.model_level,
            reasoning_effort: selection.reasoning_effort,
            session_scope: selection.session_scope,
            workspace_ref: selection.workspace_ref,
            source_ref: selection.source_ref,
            proof_gate_ref: selection.proof_gate_ref,
            execution_deadline_ms: selection.execution_deadline_ms,
            session_deadline_ms: selection.session_deadline_ms,
            canonical_bytes,
            digest,
        })
    }

    #[must_use]
    pub fn version(&self) -> u32 {
        self.version.get()
    }

    #[must_use]
    pub fn catalog_digest(&self) -> &CatalogDigest {
        &self.catalog_digest
    }

    #[must_use]
    pub fn profile_digest(&self) -> &ProfileDigest {
        &self.profile_digest
    }

    #[must_use]
    pub fn registry_digest(&self) -> &RegistryDigest {
        &self.registry_digest
    }

    #[must_use]
    pub fn role_contract_digest(&self) -> &RoleContractDigest {
        &self.role_contract_digest
    }

    #[must_use]
    pub fn provider(&self) -> &ProviderId {
        &self.provider
    }

    #[must_use]
    pub const fn model_level(&self) -> ModelLevel {
        self.model_level
    }

    #[must_use]
    pub const fn reasoning_effort(&self) -> Option<ReasoningEffort> {
        self.reasoning_effort
    }

    #[must_use]
    pub const fn session_scope(&self) -> SessionScope {
        self.session_scope
    }

    #[must_use]
    pub fn workspace_ref(&self) -> &WorkspacePolicyRef {
        &self.workspace_ref
    }

    #[must_use]
    pub fn source_ref(&self) -> &SourcePolicyRef {
        &self.source_ref
    }

    #[must_use]
    pub fn proof_gate_ref(&self) -> &ProofGateRef {
        &self.proof_gate_ref
    }

    #[must_use]
    pub const fn execution_deadline_ms(&self) -> u64 {
        self.execution_deadline_ms
    }

    #[must_use]
    pub const fn session_deadline_ms(&self) -> u64 {
        self.session_deadline_ms
    }

    #[must_use]
    pub fn canonical_bytes(&self) -> &[u8] {
        &self.canonical_bytes
    }

    #[must_use]
    pub fn digest(&self) -> &AdmissionManifestDigest {
        &self.digest
    }
}
