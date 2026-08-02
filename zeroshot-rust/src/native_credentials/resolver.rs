use std::collections::BTreeMap;

use crate::fault::FaultContext;
use crate::observability::ObservationSink;
use crate::provider_value::validate_collection_len;

use super::lease::{AcquiredMaterial, CredentialLease, CredentialLeaseSet};
use super::source::{CredentialSourceFault, CredentialSourceRef, CredentialSourceRegistry};
use super::{CredentialFault, CredentialFaultKind, CredentialRequirementSet};

/// See the comment on [`super::AdmissionManifestDigest`]: `type` aliases (not `use`) for
/// macro-declared cross-module types keep source-level import checks able to resolve them.
type CredentialRequirementName = super::CredentialRequirementName;
type CredentialError = super::CredentialError;

pub trait CredentialClock: Send + Sync {
    fn now_ms(&self) -> u64;
}

pub trait CancellationSignal: Send + Sync {
    fn is_cancelled(&self) -> bool;
}

pub struct AcquisitionBudget<'a> {
    deadline_ms: u64,
    ttl_ms: u64,
    cancel: &'a dyn CancellationSignal,
}

impl<'a> AcquisitionBudget<'a> {
    #[must_use]
    pub const fn new(deadline_ms: u64, ttl_ms: u64, cancel: &'a dyn CancellationSignal) -> Self {
        Self {
            deadline_ms,
            ttl_ms,
            cancel,
        }
    }
}

/// Declared, ordered credential sources per requirement. Rejects an empty source list and
/// duplicate source references within one requirement.
#[derive(Debug)]
pub struct CredentialSourcePolicy(BTreeMap<CredentialRequirementName, Vec<CredentialSourceRef>>);

impl CredentialSourcePolicy {
    pub fn new(
        entries: BTreeMap<CredentialRequirementName, Vec<CredentialSourceRef>>,
    ) -> Result<Self, CredentialError> {
        for sources in entries.values() {
            if sources.is_empty() {
                return Err(CredentialError::new(
                    "credential source policy",
                    "requirement must declare at least one source",
                ));
            }
            validate_collection_len(sources.len())
                .map_err(|error| CredentialError::new("credential source policy", error))?;
            for (index, left) in sources.iter().enumerate() {
                if sources[index + 1..].iter().any(|right| right == left) {
                    return Err(CredentialError::new(
                        "credential source policy",
                        "duplicate credential source",
                    ));
                }
            }
        }
        Ok(Self(entries))
    }

    fn sources_for(
        &self,
        requirement: &CredentialRequirementName,
    ) -> Option<&[CredentialSourceRef]> {
        self.0.get(requirement).map(Vec::as_slice)
    }
}

/// Resolves an admitted [`CredentialRequirementSet`] into a [`CredentialLeaseSet`]. Never
/// consults a requirement outside the admitted set, never mutates the manifest, and never
/// selects a driver or issues a provider request.
pub struct NativeCredentialResolver<'a> {
    policy: CredentialSourcePolicy,
    registry: CredentialSourceRegistry,
    clock: &'a dyn CredentialClock,
    observations: &'a dyn ObservationSink,
}

impl<'a> NativeCredentialResolver<'a> {
    pub fn new(
        policy: CredentialSourcePolicy,
        registry: CredentialSourceRegistry,
        clock: &'a dyn CredentialClock,
        observations: &'a dyn ObservationSink,
    ) -> Self {
        Self {
            policy,
            registry,
            clock,
            observations,
        }
    }

    pub fn acquire(
        &self,
        requirements: &CredentialRequirementSet,
        budget: &AcquisitionBudget<'_>,
    ) -> Result<CredentialLeaseSet<'a>, CredentialFault> {
        let mut set = CredentialLeaseSet::empty(
            requirements.manifest().clone(),
            self.clock,
            self.observations,
        );
        for requirement in requirements.requirements() {
            if let Err(fault) = self.validate_budget(requirement, budget) {
                set.release_all();
                return Err(fault);
            }
            match self.resolve_one(requirement, budget) {
                Ok(lease) => set.insert(requirement.clone(), lease),
                Err(fault) => {
                    set.release_all();
                    return Err(fault);
                }
            }
        }
        Ok(set)
    }

    fn fault(
        &self,
        kind: CredentialFaultKind,
        requirement: &CredentialRequirementName,
    ) -> CredentialFault {
        CredentialFault::new(
            kind,
            requirement.clone(),
            FaultContext::Admission,
            self.observations,
        )
    }
    fn validate_budget(
        &self,
        requirement: &CredentialRequirementName,
        budget: &AcquisitionBudget<'_>,
    ) -> Result<u64, CredentialFault> {
        if budget.cancel.is_cancelled() {
            return Err(self.fault(CredentialFaultKind::Cancelled, requirement));
        }
        let now_ms = self.clock.now_ms();
        if now_ms >= budget.deadline_ms {
            return Err(self.fault(CredentialFaultKind::DeadlineExceeded, requirement));
        }
        Ok(now_ms)
    }

    fn resolve_one(
        &self,
        requirement: &CredentialRequirementName,
        budget: &AcquisitionBudget<'_>,
    ) -> Result<CredentialLease, CredentialFault> {
        let sources = self
            .policy
            .sources_for(requirement)
            .ok_or_else(|| self.fault(CredentialFaultKind::Missing, requirement))?;
        for source in sources {
            let Some(port) = self.registry.port(source.kind()) else {
                return Err(self.fault(CredentialFaultKind::Missing, requirement));
            };
            let loaded = port.load(source);
            let now_ms = self.validate_budget(requirement, budget)?;
            match loaded {
                Ok(Some(material)) => {
                    let digest = material.digest(requirement);
                    let expires_at_ms =
                        now_ms.saturating_add(budget.ttl_ms).min(budget.deadline_ms);
                    return Ok(CredentialLease::new(
                        requirement.clone(),
                        AcquiredMaterial {
                            kind: source.kind(),
                            digest,
                            material,
                            expires_at_ms,
                        },
                    ));
                }
                Ok(None) => continue,
                Err(source_fault) => {
                    return Err(
                        self.fault(credential_fault_kind_for_source(source_fault), requirement)
                    );
                }
            }
        }
        Err(self.fault(CredentialFaultKind::Missing, requirement))
    }
}

const fn credential_fault_kind_for_source(fault: CredentialSourceFault) -> CredentialFaultKind {
    match fault {
        CredentialSourceFault::PermissionDenied => CredentialFaultKind::PermissionDenied,
        CredentialSourceFault::AuthenticationRequired => {
            CredentialFaultKind::AuthenticationRequired
        }
        CredentialSourceFault::Malformed => CredentialFaultKind::Malformed,
        CredentialSourceFault::Unavailable => CredentialFaultKind::Missing,
    }
}
