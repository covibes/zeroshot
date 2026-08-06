use std::collections::BTreeSet;

use zeroshot_engine::execution::SessionScope;
use zeroshot_engine::role_contract::{
    role_contract_pack, RoleContract, RoleContractPack, RoleContractSpec, RoleInstructions,
    RoleName, SchemaId, SchemaRef, ROLE_CONTRACT_PACK_VERSION,
};
use zeroshot_engine::worker_catalog::{
    CapabilityPolicy, CapabilitySupport, DriverFamily, ExecutableMetadata, ExecutableName,
    ModelLevel, ModelPolicy, ModelSelection, ProbeStrategy, ProviderDescriptor,
    ProviderDescriptorSpec, ProviderDisplayName, ProviderId, ReasoningEffort, ReasoningPolicy,
    SessionPolicy, WorkerCapability, WorkerCatalog, WorkerCatalogSpec,
};

#[test]
fn canonical_pack_matches_the_exact_versioned_fixture() {
    let pack = role_contract_pack();
    assert_eq!(pack.version(), ROLE_CONTRACT_PACK_VERSION);
    assert_eq!(pack.contracts().len(), RoleName::ALL.len());
    assert_eq!(
        pack.contracts().keys().copied().collect::<BTreeSet<_>>(),
        BTreeSet::from(RoleName::ALL)
    );

    let classifier = pack
        .contract(RoleName::Classifier)
        .expect("classifier contract");
    assert_eq!(classifier.model_requirement(), ModelLevel::Level1);
    assert_eq!(classifier.reasoning_requirement(), None);
    assert_eq!(
        classifier.input_schema().schema(),
        SchemaId::ClassifierInput
    );
    assert_eq!(
        classifier.output_schema().schema(),
        SchemaId::ClassifierOutput
    );

    let verifier = pack
        .contract(RoleName::Verifier)
        .expect("verifier contract");
    assert_eq!(verifier.model_requirement(), ModelLevel::Level2);
    assert_eq!(
        verifier.reasoning_requirement(),
        Some(ReasoningEffort::Medium)
    );
    assert_eq!(verifier.input_schema().schema(), SchemaId::VerifierInput);
    assert_eq!(verifier.output_schema().schema(), SchemaId::VerifierOutput);

    let worker = pack.contract(RoleName::Worker).expect("worker contract");
    assert_eq!(worker.model_requirement(), ModelLevel::Level2);
    assert_eq!(
        worker.reasoning_requirement(),
        Some(ReasoningEffort::Medium)
    );
    assert_eq!(worker.input_schema().schema(), SchemaId::WorkerInput);
    assert_eq!(worker.output_schema().schema(), SchemaId::WorkerOutput);
}

#[test]
fn canonical_bytes_and_digest_are_stable_across_order_and_repetition() {
    let catalog = valid_catalog();
    let left = RoleContractPack::new(1, valid_specs(), &catalog).expect("valid pack");
    let right = RoleContractPack::new(
        1,
        vec![worker_spec(), classifier_spec(), verifier_spec()],
        &catalog,
    )
    .expect("valid pack");
    assert_eq!(left.canonical_bytes(), right.canonical_bytes());
    assert_eq!(left.digest(), right.digest());
    assert_eq!(left.canonical_bytes(), left.canonical_bytes());
    assert_eq!(left.digest(), left.digest());

    let built_in = role_contract_pack();
    assert_eq!(
        built_in.canonical_bytes(),
        role_contract_pack().canonical_bytes()
    );
    assert_eq!(built_in.digest(), role_contract_pack().digest());
    assert_eq!(built_in.digest().as_str().len(), 64);
}

#[test]
fn changing_role_instructions_changes_the_digest() {
    let catalog = valid_catalog();
    let original = RoleContractPack::new(1, valid_specs(), &catalog).expect("valid pack");

    let mut mutated_specs = valid_specs();
    mutated_specs[0].instructions = instructions("classify the task differently");
    let mutated = RoleContractPack::new(1, mutated_specs, &catalog).expect("valid pack");

    assert_ne!(original.digest(), mutated.digest());
    assert_ne!(original.canonical_bytes(), mutated.canonical_bytes());
}

#[test]
fn duplicate_role_in_pack_fails_closed() {
    let catalog = valid_catalog();
    let error = RoleContractPack::new(
        1,
        vec![classifier_spec(), classifier_spec(), verifier_spec()],
        &catalog,
    )
    .expect_err("duplicate role must fail");
    assert_eq!(error.field(), "role contract pack");
}

#[test]
fn incomplete_pack_missing_a_role_fails_closed() {
    let catalog = valid_catalog();
    let error = RoleContractPack::new(1, vec![classifier_spec(), verifier_spec()], &catalog)
        .expect_err("missing role must fail");
    assert_eq!(error.field(), "role contract pack");
}

#[test]
fn schema_reference_mismatched_to_role_fails_closed() {
    let catalog = valid_catalog();
    let mut mismatched = classifier_spec();
    mismatched.input_schema = schema_ref(SchemaId::VerifierInput, 1);
    let error = RoleContract::new(mismatched, &catalog).expect_err("schema mismatch must fail");
    assert_eq!(error.field(), "schema reference");
}

#[test]
fn model_level_unsupported_by_catalog_fails_closed() {
    let restricted = catalog(&[ModelLevel::Level1], &[ReasoningEffort::Medium]);
    let error = RoleContract::new(verifier_spec(), &restricted)
        .expect_err("unsupported model level must fail");
    assert_eq!(error.field(), "provider catalog policy");
}

#[test]
fn reasoning_effort_unsupported_by_catalog_fails_closed() {
    let restricted = catalog(
        &[ModelLevel::Level1, ModelLevel::Level2, ModelLevel::Level3],
        &[],
    );
    let error = RoleContract::new(verifier_spec(), &restricted)
        .expect_err("unsupported reasoning effort must fail");
    assert_eq!(error.field(), "provider catalog policy");
}

fn valid_specs() -> Vec<RoleContractSpec> {
    vec![classifier_spec(), verifier_spec(), worker_spec()]
}

fn classifier_spec() -> RoleContractSpec {
    RoleContractSpec {
        role: RoleName::Classifier,
        instructions: instructions("classify the task"),
        model_requirement: ModelLevel::Level1,
        reasoning_requirement: None,
        input_schema: schema_ref(SchemaId::ClassifierInput, 1),
        output_schema: schema_ref(SchemaId::ClassifierOutput, 1),
    }
}

fn verifier_spec() -> RoleContractSpec {
    RoleContractSpec {
        role: RoleName::Verifier,
        instructions: instructions("verify the task"),
        model_requirement: ModelLevel::Level2,
        reasoning_requirement: Some(ReasoningEffort::Medium),
        input_schema: schema_ref(SchemaId::VerifierInput, 1),
        output_schema: schema_ref(SchemaId::VerifierOutput, 1),
    }
}

fn worker_spec() -> RoleContractSpec {
    RoleContractSpec {
        role: RoleName::Worker,
        instructions: instructions("do the task"),
        model_requirement: ModelLevel::Level2,
        reasoning_requirement: Some(ReasoningEffort::Medium),
        input_schema: schema_ref(SchemaId::WorkerInput, 1),
        output_schema: schema_ref(SchemaId::WorkerOutput, 1),
    }
}

fn instructions(value: &str) -> RoleInstructions {
    RoleInstructions::new(value).expect("test instructions")
}

fn schema_ref(schema: SchemaId, version: u32) -> SchemaRef {
    SchemaRef::new(schema, version).expect("test schema reference")
}

fn valid_catalog() -> WorkerCatalog {
    catalog(
        &[ModelLevel::Level1, ModelLevel::Level2, ModelLevel::Level3],
        &[ReasoningEffort::Medium],
    )
}

fn catalog(levels: &[ModelLevel], efforts: &[ReasoningEffort]) -> WorkerCatalog {
    let selections = levels
        .iter()
        .map(|level| ModelSelection::new(*level, None, None));
    let capabilities = if efforts.is_empty() {
        vec![]
    } else {
        vec![(WorkerCapability::ReasoningEffort, CapabilitySupport::Stable)]
    };
    let provider = ProviderDescriptor::new(ProviderDescriptorSpec {
        id: provider_id("alpha"),
        aliases: vec![],
        display_name: ProviderDisplayName::new("Alpha").expect("test display"),
        driver_family: DriverFamily::CliProcess,
        models: ModelPolicy::new(levels[0], selections).expect("test model policy"),
        reasoning: ReasoningPolicy::new(efforts.iter().copied()).expect("test reasoning policy"),
        sessions: SessionPolicy::new([SessionScope::Execution]).expect("test session policy"),
        capabilities: CapabilityPolicy::new(capabilities).expect("test capabilities"),
        executable: Some(
            ExecutableMetadata::new(
                ExecutableName::new("test-provider").expect("test executable"),
                vec![],
                ProbeStrategy::Version,
            )
            .expect("test executable metadata"),
        ),
        credential_requirements: vec![],
    })
    .expect("valid test provider");

    WorkerCatalog::new(WorkerCatalogSpec {
        version: 1,
        default_provider: provider_id("alpha"),
        providers: vec![provider],
    })
    .expect("valid test catalog")
}

fn provider_id(value: &str) -> ProviderId {
    ProviderId::new(value).expect("test provider id")
}
