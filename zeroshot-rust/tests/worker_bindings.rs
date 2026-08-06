use openengine_cluster_protocol::{
    legacy_ship_request_payload_type, legacy_ship_result_payload_type, GraphNode, GraphProfile,
    GraphSpec, NodeName, PolicyBinding, PolicyDefault, PolicyRef, PositiveInteger, StepNode,
    WorkerRef,
};
use openengine_cluster_server::graph_verifier::ProductionGraphVerifier;
use openengine_cluster_server::worker_registry::{check_graph_workers, WorkerRegistry};
use zeroshot_engine::execution::BuiltinWorkerId;
use zeroshot_engine::worker_bindings::{DriverFamilySlot, WorkerBindingCompiler, WorkerBindingRegistry};
use zeroshot_engine::worker_catalog::{worker_catalog, DriverFamily, WorkerCatalog};

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

fn slot_refs(slots: &[FakeSlot]) -> Vec<&dyn DriverFamilySlot> {
    slots
        .iter()
        .map(|slot| slot as &dyn DriverFamilySlot)
        .collect()
}

fn compiled_registry(catalog: &WorkerCatalog, slots: &[FakeSlot]) -> WorkerBindingRegistry {
    let refs = slot_refs(slots);
    WorkerBindingCompiler::new(catalog, &refs)
        .compile()
        .expect("compilation with every driver family slot must succeed")
}

#[test]
fn compiles_one_binding_per_catalog_provider_and_the_legacy_builtin() {
    let catalog = worker_catalog();
    let slots = all_family_slots();
    let registry = compiled_registry(catalog, &slots);

    assert_eq!(registry.agents().len(), catalog.providers().len());
    assert_eq!(registry.agents().len(), 8);
    assert_eq!(registry.builtins().len(), 1);
    assert!(
        registry
            .builtins()
            .contains_key(&BuiltinWorkerId::new("legacy.zeroshot.ship").unwrap())
    );

    for provider in catalog.providers() {
        let binding = registry
            .agents()
            .get(provider.id())
            .unwrap_or_else(|| panic!("missing compiled binding for {}", provider.id()));
        assert_eq!(binding.driver_family(), &provider.driver_family_id());
        assert_eq!(binding.version(), catalog.version());
    }
}

#[test]
fn digests_and_canonical_bytes_are_stable_across_repeated_compilation() {
    let catalog = worker_catalog();
    let slots = all_family_slots();
    let first = compiled_registry(catalog, &slots);
    let second = compiled_registry(catalog, &slots);

    assert_eq!(first.digest(), second.digest());
    assert_eq!(first.profile_digest(), second.profile_digest());
    assert_eq!(first.canonical_bytes(), second.canonical_bytes());
    assert_eq!(first.digest().as_str().len(), 64);
    assert_eq!(first.profile_digest().as_str().len(), 64);
}

#[test]
fn missing_driver_family_slot_fails_closed_with_a_bounded_named_error() {
    let catalog = worker_catalog();
    let slots = vec![
        FakeSlot(DriverFamily::CliProcess),
        FakeSlot(DriverFamily::AcpStdio),
    ];
    let refs = slot_refs(&slots);
    let error = WorkerBindingCompiler::new(catalog, &refs)
        .compile()
        .expect_err("missing gateway-http slot must fail closed");
    assert_eq!(error.field(), "driver family slot");
    assert!(error.reason().contains("GatewayHttp"));
}

#[test]
fn no_injected_slots_at_all_fails_closed() {
    let catalog = worker_catalog();
    let refs: Vec<&dyn DriverFamilySlot> = Vec::new();
    let error = WorkerBindingCompiler::new(catalog, &refs)
        .compile()
        .expect_err("compiling with no slots must fail closed");
    assert_eq!(error.field(), "driver family slot");
}

fn single_worker_graph() -> GraphSpec {
    GraphSpec {
        profile: GraphProfile::SingleWorker,
        initial_input: legacy_ship_request_payload_type(),
        policy: PolicyBinding {
            policy: PolicyRef::new("policy.default@1").unwrap(),
            default: PolicyDefault::Deny,
        },
        root: GraphNode::Step(StepNode {
            name: NodeName::new("worker").unwrap(),
            worker: WorkerRef::new("legacy.zeroshot.ship@1").unwrap(),
            input: legacy_ship_request_payload_type(),
            output: legacy_ship_result_payload_type(),
            input_bindings: vec![],
            write_bindings: vec![],
            timeout_ms: PositiveInteger::new(60_000).unwrap(),
            attempts: PositiveInteger::new(1).unwrap(),
        }),
    }
}

#[tokio::test]
async fn production_graph_verifier_consumes_the_compiled_registry_directly_without_an_adapter() {
    let catalog = worker_catalog();
    let slots = all_family_slots();
    let registry = compiled_registry(catalog, &slots);
    let verifier = ProductionGraphVerifier::new(registry);

    let graph = single_worker_graph();
    check_graph_workers(&graph, verifier.registry())
        .await
        .expect("compiled legacy descriptor must satisfy its own single-worker contract");
}

#[tokio::test]
async fn unknown_worker_reference_is_not_found() {
    let catalog = worker_catalog();
    let slots = all_family_slots();
    let registry = compiled_registry(catalog, &slots);

    let unknown = WorkerRef::new("unknown.worker@1").unwrap();
    let error = registry
        .resolve(&unknown)
        .await
        .expect_err("unknown worker must not resolve");
    assert!(matches!(
        error,
        openengine_cluster_server::worker_registry::WorkerRegistryError::NotFound { worker } if worker == unknown
    ));
}

#[tokio::test]
async fn legacy_worker_reference_resolves_to_its_pinned_descriptor() {
    let catalog = worker_catalog();
    let slots = all_family_slots();
    let registry = compiled_registry(catalog, &slots);

    let worker = WorkerRef::new("legacy.zeroshot.ship@1").unwrap();
    let descriptor = registry
        .resolve(&worker)
        .await
        .expect("legacy worker must resolve");
    assert_eq!(descriptor.worker, worker);
    descriptor
        .validate()
        .expect("resolved descriptor must be valid");
}
