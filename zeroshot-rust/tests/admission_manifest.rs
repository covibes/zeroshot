use zeroshot_engine::admission_manifest::{
    AdmissionManifest, AdmissionSelectionSpec, AdmissionSources, ProofGateRef, SourcePolicyRef,
    WorkspacePolicyRef,
};
use zeroshot_engine::execution::SessionScope;
use zeroshot_engine::role_contract::{
    role_contract_pack, RoleContractPack, RoleContractSpec, RoleInstructions, RoleName, SchemaId,
    SchemaRef,
};
use zeroshot_engine::worker_bindings::{DriverFamilySlot, WorkerBindingCompiler, WorkerBindingRegistry};
use zeroshot_engine::worker_catalog::{
    worker_catalog, CapabilityPolicy, CapabilitySupport, DriverFamily, ExecutableMetadata,
    ExecutableName, ModelLevel, ModelPolicy, ModelSelection, ProbeStrategy, ProviderDescriptor,
    ProviderDescriptorSpec, ProviderDisplayName, ProviderId, ReasoningEffort, ReasoningPolicy,
    SessionPolicy, WorkerCapability, WorkerCatalog, WorkerCatalogSpec,
};

struct FakeSlot(DriverFamily);

impl DriverFamilySlot for FakeSlot {
    fn family(&self) -> DriverFamily {
        self.0
    }
}

fn all_family_slots() -> Vec<FakeSlot> {
    vec![
        FakeSlot(DriverFamily::CliProcess),
        FakeSlot(DriverFamily::AcpStdio),
        FakeSlot(DriverFamily::GatewayHttp),
    ]
}

fn compiled_registry(catalog: &WorkerCatalog) -> WorkerBindingRegistry {
    let slots = all_family_slots();
    let refs: Vec<&dyn DriverFamilySlot> = slots
        .iter()
        .map(|slot| slot as &dyn DriverFamilySlot)
        .collect();
    WorkerBindingCompiler::new(catalog, &refs)
        .compile()
        .expect("compilation with every driver family slot must succeed")
}

fn provider_id(value: &str) -> ProviderId {
    ProviderId::new(value).expect("test provider id")
}

fn workspace_ref(value: &str) -> WorkspacePolicyRef {
    WorkspacePolicyRef::new(value).expect("test workspace ref")
}

fn source_ref(value: &str) -> SourcePolicyRef {
    SourcePolicyRef::new(value).expect("test source ref")
}

fn proof_gate_ref(value: &str) -> ProofGateRef {
    ProofGateRef::new(value).expect("test proof gate ref")
}

fn selection(provider: &str) -> AdmissionSelectionSpec {
    AdmissionSelectionSpec {
        provider: provider_id(provider),
        model_level: ModelLevel::Level2,
        reasoning_effort: Some(ReasoningEffort::Medium),
        session_scope: SessionScope::Execution,
        workspace_ref: workspace_ref("workspace.default@1"),
        source_ref: source_ref("source.default@1"),
        proof_gate_ref: proof_gate_ref("proof.default@1"),
        execution_deadline_ms: 60_000,
        session_deadline_ms: 30_000,
    }
}

fn minimal_catalog(display_name: &str, extra_provider: bool) -> WorkerCatalog {
    let mut providers = vec![minimal_provider("alpha", display_name)];
    if extra_provider {
        providers.push(minimal_provider("beta", "Beta"));
    }
    WorkerCatalog::new(WorkerCatalogSpec {
        version: 1,
        default_provider: provider_id("alpha"),
        providers,
    })
    .expect("valid minimal catalog")
}

fn catalog_without_level_three() -> WorkerCatalog {
    let provider =
        provider_with_levels("alpha", "Alpha", &[ModelLevel::Level1, ModelLevel::Level2]);
    WorkerCatalog::new(WorkerCatalogSpec {
        version: 1,
        default_provider: provider_id("alpha"),
        providers: vec![provider],
    })
    .expect("valid catalog missing level three")
}

fn minimal_provider(id: &str, display_name: &str) -> ProviderDescriptor {
    provider_with_levels(
        id,
        display_name,
        &[ModelLevel::Level1, ModelLevel::Level2, ModelLevel::Level3],
    )
}

fn provider_with_levels(id: &str, display_name: &str, levels: &[ModelLevel]) -> ProviderDescriptor {
    let selections = levels
        .iter()
        .map(|level| ModelSelection::new(*level, None, None));
    ProviderDescriptor::new(ProviderDescriptorSpec {
        id: provider_id(id),
        aliases: vec![],
        display_name: ProviderDisplayName::new(display_name).expect("test display name"),
        driver_family: DriverFamily::CliProcess,
        models: ModelPolicy::new(levels[0], selections).expect("test model policy"),
        reasoning: ReasoningPolicy::new([ReasoningEffort::Medium]).expect("test reasoning policy"),
        sessions: SessionPolicy::new([SessionScope::Execution]).expect("test session policy"),
        capabilities: CapabilityPolicy::new([(
            WorkerCapability::ReasoningEffort,
            CapabilitySupport::Stable,
        )])
        .expect("test capabilities"),
        executable: Some(
            ExecutableMetadata::new(
                ExecutableName::new(format!("{id}-cli")).expect("test executable name"),
                vec![],
                ProbeStrategy::Version,
            )
            .expect("test executable metadata"),
        ),
        credential_requirements: vec![],
    })
    .expect("valid minimal provider")
}

fn minimal_role_pack(catalog: &WorkerCatalog, classifier_text: &str) -> RoleContractPack {
    RoleContractPack::new(
        1,
        vec![
            RoleContractSpec {
                role: RoleName::Classifier,
                instructions: instructions(classifier_text),
                model_requirement: ModelLevel::Level1,
                reasoning_requirement: None,
                input_schema: schema_ref(SchemaId::ClassifierInput, 1),
                output_schema: schema_ref(SchemaId::ClassifierOutput, 1),
            },
            RoleContractSpec {
                role: RoleName::Verifier,
                instructions: instructions("verify the task"),
                model_requirement: ModelLevel::Level2,
                reasoning_requirement: Some(ReasoningEffort::Medium),
                input_schema: schema_ref(SchemaId::VerifierInput, 1),
                output_schema: schema_ref(SchemaId::VerifierOutput, 1),
            },
            RoleContractSpec {
                role: RoleName::Worker,
                instructions: instructions("do the task"),
                model_requirement: ModelLevel::Level2,
                reasoning_requirement: Some(ReasoningEffort::Medium),
                input_schema: schema_ref(SchemaId::WorkerInput, 1),
                output_schema: schema_ref(SchemaId::WorkerOutput, 1),
            },
        ],
        catalog,
    )
    .expect("valid minimal role pack")
}

fn instructions(value: &str) -> RoleInstructions {
    RoleInstructions::new(value).expect("test instructions")
}

fn schema_ref(schema: SchemaId, version: u32) -> SchemaRef {
    SchemaRef::new(schema, version).expect("test schema reference")
}

fn compile(
    catalog: &WorkerCatalog,
    roles: &RoleContractPack,
    registry: &WorkerBindingRegistry,
    provider: &str,
) -> Result<AdmissionManifest, zeroshot_engine::admission_manifest::AdmissionManifestError> {
    AdmissionManifest::compile(
        1,
        selection(provider),
        AdmissionSources {
            catalog,
            roles,
            registry,
        },
    )
}

#[test]
fn compiling_twice_with_identical_inputs_produces_byte_identical_output() {
    let catalog = worker_catalog();
    let roles = role_contract_pack();
    let registry = compiled_registry(catalog);

    let first = compile(catalog, roles, &registry, "claude").expect("valid manifest");
    let second = compile(catalog, roles, &registry, "claude").expect("valid manifest");

    assert_eq!(first.canonical_bytes(), second.canonical_bytes());
    assert_eq!(first.digest(), second.digest());
    assert_eq!(first.digest().as_str().len(), 64);
}

#[test]
fn changing_model_level_reasoning_session_or_provider_changes_the_digest() {
    let catalog = worker_catalog();
    let roles = role_contract_pack();
    let registry = compiled_registry(catalog);
    let baseline = compile(catalog, roles, &registry, "claude").expect("valid manifest");

    let mut model_changed = selection("claude");
    model_changed.model_level = ModelLevel::Level3;
    let model_changed = AdmissionManifest::compile(
        1,
        model_changed,
        AdmissionSources {
            catalog,
            roles,
            registry: &registry,
        },
    )
    .expect("valid manifest");
    assert_ne!(baseline.digest(), model_changed.digest());

    let mut reasoning_changed = selection("claude");
    reasoning_changed.reasoning_effort = Some(ReasoningEffort::High);
    let reasoning_changed = AdmissionManifest::compile(
        1,
        reasoning_changed,
        AdmissionSources {
            catalog,
            roles,
            registry: &registry,
        },
    )
    .expect("valid manifest");
    assert_ne!(baseline.digest(), reasoning_changed.digest());

    let mut deadline_changed = selection("claude");
    deadline_changed.execution_deadline_ms = 120_000;
    let deadline_changed = AdmissionManifest::compile(
        1,
        deadline_changed,
        AdmissionSources {
            catalog,
            roles,
            registry: &registry,
        },
    )
    .expect("valid manifest");
    assert_ne!(baseline.digest(), deadline_changed.digest());

    let provider_changed = compile(catalog, roles, &registry, "codex").expect("valid manifest");
    assert_ne!(baseline.digest(), provider_changed.digest());
    assert_ne!(
        baseline.canonical_bytes(),
        provider_changed.canonical_bytes()
    );
}

#[test]
fn changing_the_catalog_or_registry_changes_the_digest() {
    let catalog_a = minimal_catalog("Alpha", false);
    let registry_a = compiled_registry(&catalog_a);
    let roles_a = minimal_role_pack(&catalog_a, "classify the task");
    let baseline = compile(&catalog_a, &roles_a, &registry_a, "alpha").expect("valid manifest");

    let catalog_b = minimal_catalog("Alpha", true);
    let registry_b = compiled_registry(&catalog_b);
    let roles_b = minimal_role_pack(&catalog_b, "classify the task");
    let mutated = compile(&catalog_b, &roles_b, &registry_b, "alpha").expect("valid manifest");

    assert_ne!(baseline.catalog_digest(), mutated.catalog_digest());
    assert_ne!(baseline.registry_digest(), mutated.registry_digest());
    assert_ne!(baseline.digest(), mutated.digest());
}

#[test]
fn role_pack_from_a_different_catalog_snapshot_fails_closed() {
    let catalog_a = minimal_catalog("Alpha", false);
    let roles_a = minimal_role_pack(&catalog_a, "classify the task");

    let catalog_b = minimal_catalog("Alpha", true);
    let registry_b = compiled_registry(&catalog_b);

    let error = compile(&catalog_b, &roles_a, &registry_b, "alpha")
        .expect_err("role pack from a different catalog snapshot must fail");
    assert_eq!(error.field(), "role contract pack");
}

#[test]
fn changing_role_instructions_changes_the_digest() {
    let catalog = minimal_catalog("Alpha", false);
    let registry = compiled_registry(&catalog);
    let roles = minimal_role_pack(&catalog, "classify the task");
    let baseline = compile(&catalog, &roles, &registry, "alpha").expect("valid manifest");

    let mutated_roles = minimal_role_pack(&catalog, "classify the task differently");
    let mutated = compile(&catalog, &mutated_roles, &registry, "alpha").expect("valid manifest");

    assert_ne!(
        baseline.role_contract_digest(),
        mutated.role_contract_digest()
    );
    assert_ne!(baseline.digest(), mutated.digest());
}

#[test]
fn unknown_provider_fails_closed() {
    let catalog = worker_catalog();
    let roles = role_contract_pack();
    let registry = compiled_registry(catalog);

    let mut spec = selection("claude");
    spec.provider = provider_id("does-not-exist");
    let error = AdmissionManifest::compile(
        1,
        spec,
        AdmissionSources {
            catalog,
            roles,
            registry: &registry,
        },
    )
    .expect_err("unknown provider must fail");
    assert_eq!(error.field(), "provider");
}

#[test]
fn model_level_absent_from_provider_policy_fails_closed() {
    let catalog = catalog_without_level_three();
    let roles = minimal_role_pack(&catalog, "classify the task");
    let registry = compiled_registry(&catalog);

    let mut spec = selection("alpha");
    spec.model_level = ModelLevel::Level3;
    spec.reasoning_effort = None;
    let error = AdmissionManifest::compile(
        1,
        spec,
        AdmissionSources {
            catalog: &catalog,
            roles: &roles,
            registry: &registry,
        },
    )
    .expect_err("catalog does not declare model level three");
    assert_eq!(error.field(), "model level");
}

#[test]
fn unsupported_reasoning_effort_fails_closed() {
    let catalog = worker_catalog();
    let roles = role_contract_pack();
    let registry = compiled_registry(catalog);

    let mut spec = selection("gateway");
    spec.model_level = ModelLevel::Level2;
    spec.reasoning_effort = Some(ReasoningEffort::Medium);
    let error = AdmissionManifest::compile(
        1,
        spec,
        AdmissionSources {
            catalog,
            roles,
            registry: &registry,
        },
    )
    .expect_err("gateway declares no reasoning efforts");
    assert_eq!(error.field(), "reasoning effort");
}

#[test]
fn unsupported_session_scope_fails_closed() {
    let catalog = worker_catalog();
    let roles = role_contract_pack();
    let registry = compiled_registry(catalog);

    let mut spec = selection("claude");
    spec.session_scope = SessionScope::NodeInstance;
    let error = AdmissionManifest::compile(
        1,
        spec,
        AdmissionSources {
            catalog,
            roles,
            registry: &registry,
        },
    )
    .expect_err("worker catalog v1 has no node-instance evidence");
    assert_eq!(error.field(), "session scope");
}

#[test]
fn zero_and_inverted_deadlines_fail_closed() {
    let catalog = worker_catalog();
    let roles = role_contract_pack();
    let registry = compiled_registry(catalog);

    let mut zero_execution = selection("claude");
    zero_execution.execution_deadline_ms = 0;
    let error = AdmissionManifest::compile(
        1,
        zero_execution,
        AdmissionSources {
            catalog,
            roles,
            registry: &registry,
        },
    )
    .expect_err("zero execution deadline must fail");
    assert_eq!(error.field(), "execution deadline");

    let mut zero_session = selection("claude");
    zero_session.session_deadline_ms = 0;
    let error = AdmissionManifest::compile(
        1,
        zero_session,
        AdmissionSources {
            catalog,
            roles,
            registry: &registry,
        },
    )
    .expect_err("zero session deadline must fail");
    assert_eq!(error.field(), "session deadline");

    let mut inverted = selection("claude");
    inverted.execution_deadline_ms = 1_000;
    inverted.session_deadline_ms = 2_000;
    let error = AdmissionManifest::compile(
        1,
        inverted,
        AdmissionSources {
            catalog,
            roles,
            registry: &registry,
        },
    )
    .expect_err("session deadline exceeding execution deadline must fail");
    assert_eq!(error.field(), "session deadline");
}

#[test]
fn worker_registry_from_a_different_catalog_snapshot_fails_closed() {
    let full_catalog = worker_catalog();
    let roles = role_contract_pack();
    let sparse_catalog = minimal_catalog("Alpha", false);
    let sparse_registry = compiled_registry(&sparse_catalog);

    let spec = selection("claude");
    let error = AdmissionManifest::compile(
        1,
        spec,
        AdmissionSources {
            catalog: full_catalog,
            roles,
            registry: &sparse_registry,
        },
    )
    .expect_err("worker registry from a different catalog snapshot must fail");
    assert_eq!(error.field(), "worker binding registry");
}

#[test]
fn canonical_bytes_contain_no_secret_or_environment_markers() {
    let catalog = worker_catalog();
    let roles = role_contract_pack();
    let registry = compiled_registry(catalog);
    let manifest = compile(catalog, roles, &registry, "claude").expect("valid manifest");

    let text =
        std::str::from_utf8(manifest.canonical_bytes()).expect("canonical bytes must be UTF-8");
    for forbidden in [
        "password", "secret", "token=", "Bearer ", "://", "/home/", "/etc/",
    ] {
        assert!(
            !text.contains(forbidden),
            "admission manifest leaked a forbidden marker: {forbidden}"
        );
    }
}
