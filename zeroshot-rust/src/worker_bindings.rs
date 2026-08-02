//! Compiles the `WorkerCatalog` and the built-in legacy worker into an immutable,
//! secret-free `WorkerRegistry` snapshot plus runtime binding references. No credential
//! resolution, driver implementation, or graph workflow topology.

use std::collections::BTreeMap;

use async_trait::async_trait;
use openengine_cluster_protocol::{
    ArtifactResultProfile, AutonomyPolicy, CapabilityPolicy, GraphProfile, MediaType, PolicyRef,
    RedactionClass, TypeId, WorkerContract, WorkerDescriptor, WorkerProtocolBinding, WorkerRef,
    LEGACY_ZEROSHOT_WORKER, RUNTIME_WORKER_ERRORS,
};
use openengine_cluster_protocol::{legacy_ship_request_payload_type, legacy_ship_result_payload_type};
use openengine_cluster_server::worker_registry::{WorkerRegistry, WorkerRegistryError};
use serde::Serialize;

use crate::execution::{
    BuiltinWorkerId, BuiltinWorkerRef, ProfileDigest, ProviderLaneId, RegistryDigest, SessionScope,
    WorkerBindingId, WorkerBindingRef, WorkerBindingSpec,
};
use crate::provider_value::canonicalize;
use crate::worker_catalog::{DriverFamily, ProviderId, WorkerCatalog};

crate::provider_value::contract_error_type!(WorkerBindingError);

/// Abstract injected slot for a driver family. Concrete CLI/ACP/Gateway transport types are
/// composed by the caller and stay outside this compiler.
pub trait DriverFamilySlot: Send + Sync {
    fn family(&self) -> DriverFamily;
}

pub struct WorkerBindingCompiler<'a> {
    catalog: &'a WorkerCatalog,
    slots: &'a [&'a dyn DriverFamilySlot],
}

impl<'a> WorkerBindingCompiler<'a> {
    #[must_use]
    pub const fn new(catalog: &'a WorkerCatalog, slots: &'a [&'a dyn DriverFamilySlot]) -> Self {
        Self { catalog, slots }
    }

    pub fn compile(&self) -> Result<WorkerBindingRegistry, WorkerBindingError> {
        let agents = self.compile_agents()?;
        let (builtin_id, builtin_ref) = compile_legacy_builtin()?;
        let (worker_ref, descriptor) = compile_legacy_descriptor()?;

        WorkerBindingRegistry::new(
            agents,
            BTreeMap::from([(builtin_id, builtin_ref)]),
            BTreeMap::from([(worker_ref, descriptor)]),
        )
    }

    fn compile_agents(&self) -> Result<BTreeMap<ProviderId, WorkerBindingRef>, WorkerBindingError> {
        let mut agents = BTreeMap::new();
        for provider in self.catalog.providers() {
            let family = provider.driver_family();
            let has_slot = match family {
                DriverFamily::CliProcess | DriverFamily::AcpStdio | DriverFamily::GatewayHttp => {
                    self.slots.iter().any(|slot| slot.family() == family)
                }
            };
            if !has_slot {
                return Err(WorkerBindingError::new(
                    "driver family slot",
                    format!("no injected slot for {family:?}"),
                ));
            }

            let binding = WorkerBindingRef::new(WorkerBindingSpec {
                binding_id: WorkerBindingId::new(provider.id().as_str())
                    .map_err(|error| WorkerBindingError::new("worker binding id", error))?,
                driver_family: provider.driver_family_id(),
                provider_lane: ProviderLaneId::new(provider.id().as_str())
                    .map_err(|error| WorkerBindingError::new("provider lane id", error))?,
                version: self.catalog.version(),
                supports_node_instance: provider.sessions().supports(SessionScope::NodeInstance),
            })
            .map_err(|error| WorkerBindingError::new("worker binding ref", error))?;

            agents.insert(provider.id().clone(), binding);
        }
        Ok(agents)
    }
}

fn compile_legacy_builtin() -> Result<(BuiltinWorkerId, BuiltinWorkerRef), WorkerBindingError> {
    let builtin_id = BuiltinWorkerId::new("legacy.zeroshot.ship")
        .map_err(|error| WorkerBindingError::new("builtin worker id", error))?;
    let builtin_ref = BuiltinWorkerRef::new(builtin_id.clone(), 1)
        .map_err(|error| WorkerBindingError::new("builtin worker ref", error))?;
    Ok((builtin_id, builtin_ref))
}

fn compile_legacy_descriptor() -> Result<(WorkerRef, WorkerDescriptor), WorkerBindingError> {
    let worker_ref = WorkerRef::new(LEGACY_ZEROSHOT_WORKER)
        .map_err(|error| WorkerBindingError::new("legacy worker reference", error))?;
    let descriptor = WorkerDescriptor {
        worker: worker_ref.clone(),
        graph_profiles: vec![GraphProfile::SingleWorker],
        binding: WorkerProtocolBinding::legacy_zeroshot_ship_v1(),
        contract: WorkerContract {
            input: legacy_ship_request_payload_type(),
            output: legacy_ship_result_payload_type(),
            verifier: None,
            errors: RUNTIME_WORKER_ERRORS.to_vec(),
        },
        capability_policy: CapabilityPolicy {
            autonomy: AutonomyPolicy::Strict,
            permission_policy: PolicyRef::new("policy.strict@1")
                .map_err(|error| WorkerBindingError::new("permission policy", error))?,
        },
        artifact_profile: ArtifactResultProfile {
            allowed_type_ids: vec![
                TypeId::new("openengine.result@1")
                    .map_err(|error| WorkerBindingError::new("artifact type id", error))?,
            ],
            allowed_media_types: vec![
                MediaType::new("application/json")
                    .map_err(|error| WorkerBindingError::new("artifact media type", error))?,
            ],
            minimum_redaction: RedactionClass::Internal,
        },
        credential_requirements: vec![],
    };
    descriptor
        .validate()
        .map_err(|error| WorkerBindingError::new("legacy worker descriptor", error))?;
    let descriptor = WorkerBindingError::checked(descriptor)?;
    Ok((worker_ref, descriptor))
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkerBindingRegistry {
    agents: BTreeMap<ProviderId, WorkerBindingRef>,
    builtins: BTreeMap<BuiltinWorkerId, BuiltinWorkerRef>,
    descriptors: BTreeMap<WorkerRef, WorkerDescriptor>,
    profile_digest: ProfileDigest,
    canonical_bytes: Vec<u8>,
    digest: RegistryDigest,
}

#[derive(Serialize)]
struct CanonicalRegistry<'a> {
    agents: &'a BTreeMap<ProviderId, WorkerBindingRef>,
    builtins: &'a BTreeMap<BuiltinWorkerId, BuiltinWorkerRef>,
    descriptors: &'a BTreeMap<WorkerRef, WorkerDescriptor>,
}

impl WorkerBindingRegistry {
    fn new(
        agents: BTreeMap<ProviderId, WorkerBindingRef>,
        builtins: BTreeMap<BuiltinWorkerId, BuiltinWorkerRef>,
        descriptors: BTreeMap<WorkerRef, WorkerDescriptor>,
    ) -> Result<Self, WorkerBindingError> {
        let (_, profile_digest_hex) = canonicalize(&descriptors)
            .map_err(|error| WorkerBindingError::new("worker profile digest", error))?;
        let profile_digest = ProfileDigest::new(profile_digest_hex)
            .map_err(|error| WorkerBindingError::new("worker profile digest", error))?;

        let (canonical_bytes, digest_hex) = canonicalize(&CanonicalRegistry {
            agents: &agents,
            builtins: &builtins,
            descriptors: &descriptors,
        })
        .map_err(|error| WorkerBindingError::new("worker binding registry", error))?;
        let digest = RegistryDigest::new(digest_hex)
            .map_err(|error| WorkerBindingError::new("worker binding registry digest", error))?;

        Ok(Self {
            agents,
            builtins,
            descriptors,
            profile_digest,
            canonical_bytes,
            digest,
        })
    }

    #[must_use]
    pub fn agents(&self) -> &BTreeMap<ProviderId, WorkerBindingRef> {
        &self.agents
    }

    #[must_use]
    pub fn builtins(&self) -> &BTreeMap<BuiltinWorkerId, BuiltinWorkerRef> {
        &self.builtins
    }

    #[must_use]
    pub fn profile_digest(&self) -> &ProfileDigest {
        &self.profile_digest
    }

    #[must_use]
    pub fn canonical_bytes(&self) -> &[u8] {
        &self.canonical_bytes
    }

    #[must_use]
    pub fn digest(&self) -> &RegistryDigest {
        &self.digest
    }
}

#[async_trait]
impl WorkerRegistry for WorkerBindingRegistry {
    async fn resolve(&self, worker: &WorkerRef) -> Result<WorkerDescriptor, WorkerRegistryError> {
        self.descriptors
            .get(worker)
            .cloned()
            .ok_or_else(|| WorkerRegistryError::NotFound {
                worker: worker.clone(),
            })
    }
}
