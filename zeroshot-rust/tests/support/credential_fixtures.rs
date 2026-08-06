use zeroshot_engine::admission_manifest::{
    AdmissionManifest, AdmissionSelectionSpec, AdmissionSources, ProofGateRef, SourcePolicyRef,
    WorkspacePolicyRef,
};
use zeroshot_engine::execution::SessionScope;
use zeroshot_engine::native_credentials::fake::{FakeCancellation, FakeCredentialClock};
use zeroshot_engine::native_credentials::{
    CredentialRequirementSet, CredentialSourceKind, CredentialSourcePolicy, CredentialSourceRef,
    CredentialSourceRegistry, NativeCredentialResolver,
};
use zeroshot_engine::native_settings::NativeSettingsSchema;
use zeroshot_engine::observability::NoopObservationSink;
use zeroshot_engine::role_contract::{role_contract_pack, RoleContractPack};
use zeroshot_engine::worker_bindings::{DriverFamilySlot, WorkerBindingCompiler, WorkerBindingRegistry};
use zeroshot_engine::worker_catalog::{
    worker_catalog, CredentialRequirementName, DriverFamily, ModelLevel, ProviderId,
    ReasoningEffort, WorkerCatalog,
};

struct CredentialFixtureSlot {
    family: DriverFamily,
}

impl DriverFamilySlot for CredentialFixtureSlot {
    fn family(&self) -> DriverFamily {
        let CredentialFixtureSlot { family } = self;
        *family
    }
}

const ALL_DRIVER_FAMILIES: [DriverFamily; 3] = [
    DriverFamily::CliProcess,
    DriverFamily::AcpStdio,
    DriverFamily::GatewayHttp,
];

pub fn compiled_registry(catalog: &WorkerCatalog) -> WorkerBindingRegistry {
    let slots = ALL_DRIVER_FAMILIES.map(|family| CredentialFixtureSlot { family });
    let slot_refs: Vec<&dyn DriverFamilySlot> = slots
        .iter()
        .map(|slot| slot as &dyn DriverFamilySlot)
        .collect();
    WorkerBindingCompiler::new(catalog, &slot_refs)
        .compile()
        .expect("compiling with every driver family slot registered must succeed")
}

pub fn claude_selection() -> AdmissionSelectionSpec {
    AdmissionSelectionSpec {
        provider: ProviderId::new("claude").expect("test provider id"),
        model_level: ModelLevel::Level2,
        reasoning_effort: Some(ReasoningEffort::Medium),
        session_scope: SessionScope::Execution,
        workspace_ref: WorkspacePolicyRef::new("workspace.default@1").expect("test workspace ref"),
        source_ref: SourcePolicyRef::new("source.default@1").expect("test source ref"),
        proof_gate_ref: ProofGateRef::new("proof.default@1").expect("test proof gate ref"),
        execution_deadline_ms: 60_000,
        session_deadline_ms: 30_000,
    }
}

pub fn claude_manifest() -> AdmissionManifest {
    let catalog = worker_catalog();
    let roles: &RoleContractPack = role_contract_pack();
    let registry = compiled_registry(catalog);
    AdmissionManifest::compile(
        1,
        claude_selection(),
        AdmissionSources {
            catalog,
            roles,
            registry: &registry,
        },
    )
    .expect("valid manifest")
}

pub fn claude_requirements() -> CredentialRequirementSet {
    CredentialRequirementSet::from_admitted(
        &claude_manifest(),
        worker_catalog(),
        &NativeSettingsSchema::default(),
    )
    .expect("valid requirement set")
}

pub fn requirement(value: &str) -> CredentialRequirementName {
    CredentialRequirementName::new(value).expect("test credential requirement name")
}

pub fn source_ref(kind: CredentialSourceKind, locator: &str) -> CredentialSourceRef {
    CredentialSourceRef::new(kind, locator).expect("test credential source ref")
}

/// A default clock (fixed at `0`), cancellation signal (never cancelled), and no-op observation
/// sink, bundled so a test can build a [`NativeCredentialResolver`] in one call.
pub struct ResolverFixture {
    pub clock: FakeCredentialClock,
    pub cancel: FakeCancellation,
    pub observations: NoopObservationSink,
}

impl ResolverFixture {
    pub fn new() -> Self {
        Self {
            clock: FakeCredentialClock::new(0),
            cancel: FakeCancellation::default(),
            observations: NoopObservationSink,
        }
    }

    pub fn resolver(
        &self,
        policy: CredentialSourcePolicy,
        registry: CredentialSourceRegistry,
    ) -> NativeCredentialResolver<'_> {
        NativeCredentialResolver::new(policy, registry, &self.clock, &self.observations)
    }
}
