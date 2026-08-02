//! Resolves admitted, manifest-declared logical credential requirements into bounded ephemeral
//! capabilities and leases through explicitly declared native sources, without persisting secret
//! values or reading ambient Node.js, OS credential store, or unrelated config state.
//!
//! `CredentialCapability` cannot be minted, cloned, serialized, or retained beyond its borrowed
//! lifetime by safe downstream code:
//!
//! ```compile_fail
//! use zeroshot_engine::native_credentials::CredentialCapability;
//!
//! let lease = ();
//! let clock = ();
//! let observations = ();
//! let _capability = CredentialCapability::from_lease(&lease, &clock, &observations);
//! ```
//!
//! ```compile_fail
//! use zeroshot_engine::native_credentials::CredentialCapability;
//!
//! fn clone_capability(capability: CredentialCapability<'_>) {
//!     let _escaped = capability.clone();
//! }
//! ```
//!
//! ```compile_fail
//! use zeroshot_engine::native_credentials::CredentialCapability;
//!
//! fn serialize_capability(capability: &CredentialCapability<'_>) {
//!     serde_json::to_string(capability).unwrap();
//! }
//! ```
//!
//! ```compile_fail
//! use zeroshot_engine::native_credentials::CredentialCapability;
//!
//! fn retain<'a>(capability: CredentialCapability<'a>) -> CredentialCapability<'static> {
//!     capability
//! }
//! ```
//!
//! `SecretMaterial` cannot be constructed or have its bytes exposed by safe downstream code:
//!
//! ```compile_fail
//! use zeroshot_engine::native_credentials::SecretMaterial;
//!
//! let _material = SecretMaterial::new(vec![1, 2, 3]);
//! ```
//!
//! ```compile_fail
//! use zeroshot_engine::native_credentials::SecretMaterial;
//!
//! fn expose(material: &SecretMaterial) -> &[u8] {
//!     material.expose()
//! }
//! ```

use std::collections::BTreeSet;

use serde::Serialize;

use crate::admission_manifest::AdmissionManifest;
use crate::fault::{
    EngineFault, EvidenceClass, FaultContext, FaultFactory, FaultModule, ModuleEvidence,
    RawDiagnostic, RedactionMarker,
};
use crate::native_settings::NativeSettingsSchema;
use crate::observability::ObservationSink;
use crate::provider_value::BoundedSet;
use crate::worker_catalog::WorkerCatalog;

/// `admission_manifest::AdmissionManifestDigest` is declared through `digest_type!`, a
/// macro-expanded item that source-level import checks cannot see; aliasing it here (rather than
/// `use`-ing it) keeps this module's cross-module reference resolvable by those checks.
pub type AdmissionManifestDigest = crate::admission_manifest::AdmissionManifestDigest;
/// `worker_catalog::CredentialRequirementName` is declared through `bounded_text_type!`; see
/// [`AdmissionManifestDigest`] for why this is a `type` alias rather than a `use`.
pub type CredentialRequirementName = crate::worker_catalog::CredentialRequirementName;

mod lease;
mod material;
mod resolver;
mod source;

pub mod fake;

pub use lease::{CredentialCapability, CredentialLease, CredentialLeaseSet};
pub use material::SecretMaterial;
pub use resolver::{
    AcquisitionBudget, CancellationSignal, CredentialClock, CredentialSourcePolicy,
    NativeCredentialResolver,
};
pub use source::{
    CredentialSourceFault, CredentialSourceKind, CredentialSourcePort, CredentialSourceRef,
    CredentialSourceRegistry, EnvSnapshotCredentialSource,
};

crate::provider_value::contract_error_type!(CredentialError);
crate::provider_value::digest_type!(CredentialDigest, CredentialError, "credential digest");

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CredentialFaultKind {
    Missing,
    PermissionDenied,
    AuthenticationRequired,
    Malformed,
    Expired,
    Released,
    Cancelled,
    DeadlineExceeded,
    Undeclared,
}

impl CredentialFaultKind {
    const fn evidence_class(self) -> EvidenceClass {
        match self {
            Self::Missing => EvidenceClass::Unavailable,
            Self::PermissionDenied => EvidenceClass::PermissionDenied,
            Self::AuthenticationRequired => EvidenceClass::AuthenticationRequired,
            Self::Malformed => EvidenceClass::MalformedExternalData,
            Self::Expired | Self::Released => EvidenceClass::SessionLost,
            Self::Cancelled | Self::DeadlineExceeded => EvidenceClass::Timeout,
            Self::Undeclared => EvidenceClass::InvariantViolation,
        }
    }
}

/// A safe, typed credential fault. Never carries a raw value, header, token, helper output, or
/// source path.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CredentialFault {
    kind: CredentialFaultKind,
    requirement: CredentialRequirementName,
    fault: EngineFault,
}

impl CredentialFault {
    fn new(
        kind: CredentialFaultKind,
        requirement: CredentialRequirementName,
        context: FaultContext,
        observations: &dyn ObservationSink,
    ) -> Self {
        let diagnostic = RawDiagnostic::new(RedactionMarker::Credential, requirement.as_str())
            .expect("bounded credential requirement name fits the diagnostic bound");
        let evidence = ModuleEvidence::new(FaultModule::Credential, context, kind.evidence_class())
            .with_diagnostic(diagnostic);
        let fault = FaultFactory::new(observations).create(evidence);
        Self {
            kind,
            requirement,
            fault,
        }
    }

    #[must_use]
    pub fn kind(&self) -> CredentialFaultKind {
        self.kind
    }

    #[must_use]
    pub fn requirement(&self) -> &CredentialRequirementName {
        &self.requirement
    }

    #[must_use]
    pub fn engine_fault(&self) -> &EngineFault {
        &self.fault
    }
}

/// The admitted set of credential requirements: the provider catalog's requirements for the
/// admitted provider, unioned with the native settings' declared requirements.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialRequirementSet {
    manifest: AdmissionManifestDigest,
    requirements: BoundedSet<CredentialRequirementName>,
}

impl CredentialRequirementSet {
    pub fn from_admitted(
        manifest: &AdmissionManifest,
        catalog: &WorkerCatalog,
        settings: &NativeSettingsSchema,
    ) -> Result<Self, CredentialError> {
        if catalog.digest() != manifest.catalog_digest() {
            return Err(CredentialError::new(
                "worker catalog",
                "catalog snapshot does not match the admitted manifest",
            ));
        }
        let provider = catalog
            .resolve(manifest.provider().as_str())
            .ok_or_else(|| {
                CredentialError::new(
                    "worker catalog",
                    "admitted provider is absent from the catalog",
                )
            })?;
        let mut requirements: BTreeSet<CredentialRequirementName> =
            provider.credential_requirements().iter().cloned().collect();
        for requirement in settings.credential_requirements() {
            let requirement =
                CredentialRequirementName::new(requirement.as_str()).map_err(|error| {
                    CredentialError::new("native settings credential requirement", error)
                })?;
            requirements.insert(requirement);
        }
        let requirements = BoundedSet::new(requirements)
            .map_err(|error| CredentialError::new("credential requirements", error))?;
        CredentialError::checked(Self {
            manifest: manifest.digest().clone(),
            requirements,
        })
    }

    #[must_use]
    pub fn manifest(&self) -> &AdmissionManifestDigest {
        &self.manifest
    }

    #[must_use]
    pub fn requirements(&self) -> &BTreeSet<CredentialRequirementName> {
        self.requirements.as_set()
    }
}
