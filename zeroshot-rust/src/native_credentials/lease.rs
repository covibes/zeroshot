use std::collections::BTreeMap;
use std::fmt;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use crate::fault::FaultContext;
use crate::observability::ObservationSink;

use super::material::SecretMaterial;
use super::resolver::CredentialClock;
use super::source::CredentialSourceKind;
use super::{CredentialFault, CredentialFaultKind};

/// See the comment on [`super::AdmissionManifestDigest`]: `type` aliases (not `use`) for
/// macro-declared cross-module types keep source-level import checks able to resolve them.
type AdmissionManifestDigest = super::AdmissionManifestDigest;
type CredentialRequirementName = super::CredentialRequirementName;
type CredentialDigest = super::CredentialDigest;

/// Fields minted by a successful source read, bundled to keep `CredentialLease::new` at two
/// arguments (this crate's clippy configuration caps positional arguments at four).
pub(crate) struct AcquiredMaterial {
    pub(crate) kind: CredentialSourceKind,
    pub(crate) digest: CredentialDigest,
    pub(crate) material: SecretMaterial,
    pub(crate) expires_at_ms: u64,
}

#[derive(Debug)]
pub struct CredentialLease {
    requirement: CredentialRequirementName,
    kind: CredentialSourceKind,
    digest: CredentialDigest,
    expires_at_ms: u64,
    material: Mutex<Option<SecretMaterial>>,
    released: AtomicBool,
}

impl CredentialLease {
    pub(crate) fn new(requirement: CredentialRequirementName, acquired: AcquiredMaterial) -> Self {
        Self {
            requirement,
            kind: acquired.kind,
            digest: acquired.digest,
            expires_at_ms: acquired.expires_at_ms,
            material: Mutex::new(Some(acquired.material)),
            released: AtomicBool::new(false),
        }
    }

    /// Releases this lease. Returns `true` exactly once: for the caller whose compare-exchange
    /// wins the race, regardless of how many callers (or threads) race this call concurrently.
    pub fn release(&self) -> bool {
        if self
            .released
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
        {
            let mut guard = self
                .material
                .lock()
                .expect("credential lease mutex must not be poisoned");
            *guard = None;
            true
        } else {
            false
        }
    }

    #[must_use]
    pub fn is_released(&self) -> bool {
        self.released.load(Ordering::SeqCst)
    }

    fn with_material<R>(
        &self,
        now_ms: u64,
        f: impl FnOnce(&[u8]) -> R,
    ) -> Result<R, CredentialFaultKind> {
        if now_ms >= self.expires_at_ms {
            return Err(CredentialFaultKind::Expired);
        }
        let guard = self
            .material
            .lock()
            .expect("credential lease mutex must not be poisoned");
        match guard.as_ref() {
            Some(material) => Ok(f(material.expose())),
            None => Err(CredentialFaultKind::Released),
        }
    }
}

impl Drop for CredentialLease {
    fn drop(&mut self) {
        self.release();
    }
}

/// Ephemeral proof that a lease was resolved for the caller's admitted requirement.
///
/// Neither cloneable nor serializable; cannot be minted by safe downstream code, and its
/// borrowed lifetime prevents retention beyond the owning [`CredentialLeaseSet`].
pub struct CredentialCapability<'a> {
    lease: &'a CredentialLease,
    clock: &'a dyn CredentialClock,
    observations: &'a dyn ObservationSink,
}

impl<'a> CredentialCapability<'a> {
    pub(crate) fn from_lease(
        lease: &'a CredentialLease,
        clock: &'a dyn CredentialClock,
        observations: &'a dyn ObservationSink,
    ) -> Self {
        Self {
            lease,
            clock,
            observations,
        }
    }

    /// Test-support escape hatch for contract tests that have no product resolver authority.
    ///
    /// # Safety
    ///
    /// The caller must ensure `lease` is a genuinely resolved lease and must not substitute this
    /// for resolver-issued capabilities in production.
    #[doc(hidden)]
    pub unsafe fn from_lease_contract_test(
        lease: &'a CredentialLease,
        clock: &'a dyn CredentialClock,
        observations: &'a dyn ObservationSink,
    ) -> Self {
        Self::from_lease(lease, clock, observations)
    }

    #[must_use]
    pub fn identity(&self) -> &CredentialRequirementName {
        &self.lease.requirement
    }

    #[must_use]
    pub fn digest(&self) -> &CredentialDigest {
        &self.lease.digest
    }

    #[must_use]
    pub fn source_kind(&self) -> CredentialSourceKind {
        self.lease.kind
    }

    /// The only path to the raw secret bytes. Fails `Expired` past the lease deadline and
    /// `Released` once the lease has been released.
    pub fn with_material<R>(&self, f: impl FnOnce(&[u8]) -> R) -> Result<R, CredentialFault> {
        let now_ms = self.clock.now_ms();
        self.lease.with_material(now_ms, f).map_err(|kind| {
            CredentialFault::new(
                kind,
                self.lease.requirement.clone(),
                FaultContext::Execution,
                self.observations,
            )
        })
    }
}

impl<'a> fmt::Debug for CredentialCapability<'a> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("CredentialCapability")
            .field("identity", &self.lease.requirement)
            .field("digest", &self.lease.digest)
            .finish()
    }
}

/// The bounded set of leases acquired for one admitted manifest. Releases every lease exactly
/// once, both explicitly via [`CredentialLeaseSet::release_all`] and implicitly on drop.
pub struct CredentialLeaseSet<'a> {
    manifest: AdmissionManifestDigest,
    clock: &'a dyn CredentialClock,
    observations: &'a dyn ObservationSink,
    leases: BTreeMap<CredentialRequirementName, CredentialLease>,
}

impl<'a> CredentialLeaseSet<'a> {
    pub(crate) fn empty(
        manifest: AdmissionManifestDigest,
        clock: &'a dyn CredentialClock,
        observations: &'a dyn ObservationSink,
    ) -> Self {
        Self {
            manifest,
            clock,
            observations,
            leases: BTreeMap::new(),
        }
    }

    pub(crate) fn insert(
        &mut self,
        requirement: CredentialRequirementName,
        lease: CredentialLease,
    ) {
        self.leases.insert(requirement, lease);
    }

    #[must_use]
    pub fn manifest(&self) -> &AdmissionManifestDigest {
        &self.manifest
    }

    pub fn capability(
        &self,
        requirement: &CredentialRequirementName,
    ) -> Result<CredentialCapability<'_>, CredentialFault> {
        self.leases
            .get(requirement)
            .map(|lease| CredentialCapability::from_lease(lease, self.clock, self.observations))
            .ok_or_else(|| {
                CredentialFault::new(
                    CredentialFaultKind::Undeclared,
                    requirement.clone(),
                    FaultContext::Admission,
                    self.observations,
                )
            })
    }

    /// Idempotent. Returns how many leases this call actually released (already-released leases
    /// do not count), so concurrent callers can prove release happens exactly once.
    pub fn release_all(&self) -> usize {
        self.leases.values().filter(|lease| lease.release()).count()
    }
}

impl<'a> fmt::Debug for CredentialLeaseSet<'a> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("CredentialLeaseSet")
            .field("manifest", &self.manifest)
            .field("leases", &self.leases)
            .finish()
    }
}

impl<'a> Drop for CredentialLeaseSet<'a> {
    fn drop(&mut self) {
        self.release_all();
    }
}
