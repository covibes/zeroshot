use std::sync::Arc;

use async_trait::async_trait;
use openengine_cluster_protocol::{canonical_value_bytes, GraphSpec, WorkerDescriptor, WorkerRef};
use openengine_cluster_server::admission::{GraphVerifier, VerifiedGraph};
use openengine_cluster_server::graph_verifier::ProductionGraphVerifier;
use openengine_cluster_server::worker_registry::{WorkerRegistry, WorkerRegistryError};
use serde::Serialize;
use serde_json::{json, Value};
use zeroshot_engine::cluster_ledger::mutations::{AdmissionRequest, ReductionDispatchRequest};
use zeroshot_engine::cluster_ledger::record::{CanonicalDigest, StructuralOccurrence};
use zeroshot_engine::cluster_ledger::store::sqlite::SqliteLedgerStore;
use zeroshot_engine::cluster_ledger::store::{IdempotencyId, LedgerStore};
use zeroshot_engine::cluster_ledger::{ClusterLedger, OwnerId, ResourceId};
use zeroshot_engine::full_v1_reducer::{
    durable_executions_from_replay, FullV1Reducer, Reduction, ReductionInput,
};

use super::native_execution::deterministic_graph;
use super::native_process::TempState;

#[derive(Clone)]
struct Registry(Option<WorkerDescriptor>);

#[async_trait]
impl WorkerRegistry for Registry {
    async fn resolve(&self, worker: &WorkerRef) -> Result<WorkerDescriptor, WorkerRegistryError> {
        self.0
            .as_ref()
            .filter(|descriptor| descriptor.worker == *worker)
            .cloned()
            .ok_or_else(|| WorkerRegistryError::NotFound {
                worker: worker.clone(),
            })
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CatalogSnapshot<'a> {
    version: u8,
    workers: &'a [WorkerDescriptor],
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProfileSnapshot<'a> {
    descriptors: &'a [WorkerDescriptor],
}

pub fn descriptor() -> WorkerDescriptor {
    serde_json::from_value(json!({
        "worker": "native.deterministic@1",
        "graphProfiles": ["openengine.graph.full/v1"],
        "binding": {
            "protocol": "builtin",
            "version": "1",
            "profile": "openengine.worker.builtin/v1"
        },
        "contract": {
            "input": { "kind": "null" },
            "output": {
                "kind": "record",
                "fields": {
                    "value": { "type": { "kind": "integer" }, "required": true }
                }
            },
            "verifier": null,
            "errors": ["timeout", "crash", "malformed", "refusal"]
        },
        "capabilityPolicy": {
            "autonomy": "strict",
            "permissionPolicy": "policy.default@1"
        },
        "artifactProfile": {
            "allowedTypeIds": ["native.deterministic.output@1"],
            "allowedMediaTypes": ["application/json"],
            "minimumRedaction": "internal"
        },
        "credentialRequirements": []
    }))
    .unwrap()
}

pub fn predecessor_graph() -> GraphSpec {
    serde_json::from_value(json!({
        "profile": "openengine.graph.full/v1",
        "initialInput": { "kind": "null" },
        "policy": { "policy": "policy.default@1", "default": "deny" },
        "root": {
            "kind": "succeed",
            "name": "predecessor",
            "output": { "kind": "null" },
            "bindings": []
        }
    }))
    .unwrap()
}

fn identity_digests(descriptors: &[WorkerDescriptor]) -> (CanonicalDigest, CanonicalDigest) {
    let catalog = canonical_value_bytes(
        &serde_json::to_value(CatalogSnapshot {
            version: 1,
            workers: descriptors,
        })
        .unwrap(),
    )
    .unwrap();
    let profile =
        canonical_value_bytes(&serde_json::to_value(ProfileSnapshot { descriptors }).unwrap())
            .unwrap();
    (CanonicalDigest::of(&catalog), CanonicalDigest::of(&profile))
}

async fn verify(graph: &GraphSpec, registry: Registry) -> VerifiedGraph {
    ProductionGraphVerifier::new(registry)
        .verify(graph)
        .await
        .unwrap()
}

pub struct SeedAdmission {
    pub graph: GraphSpec,
    pub input: Value,
    pub descriptor: Option<WorkerDescriptor>,
    pub corrupt_compiled_ir: bool,
}

pub async fn seed_admission(
    state: &TempState,
    cluster: &str,
    seed: SeedAdmission,
) -> ClusterLedger {
    let resource = ResourceId::new(cluster).unwrap();
    let store: Arc<dyn LedgerStore> = Arc::new(SqliteLedgerStore::new(state.path()).unwrap());
    let ledger = ClusterLedger::create(
        store,
        resource,
        OwnerId::new("recovery-seed").unwrap(),
        10_000,
    )
    .await
    .unwrap();
    let descriptors = seed.descriptor.clone().into_iter().collect::<Vec<_>>();
    let (catalog_digest, profile_digest) = identity_digests(&descriptors);
    let verified = verify(&seed.graph, Registry(seed.descriptor)).await;
    let canonical_graph =
        canonical_value_bytes(&serde_json::to_value(&seed.graph).unwrap()).unwrap();
    let verified_input = canonical_value_bytes(&seed.input).unwrap();
    let canonical_compiled_ir = if seed.corrupt_compiled_ir {
        b"corrupt-compiled-ir".to_vec()
    } else {
        verified.compiled_ir.canonical_bytes().unwrap()
    };
    ledger
        .admit(
            IdempotencyId::new("seed-admission").unwrap(),
            [1; 32],
            AdmissionRequest {
                graph_digest: CanonicalDigest::of(&canonical_graph),
                input_digest: CanonicalDigest::of(&verified_input),
                policy_digest: CanonicalDigest::of(b"policy"),
                catalog_digest,
                profile_digest,
                absolute_deadline_ms: 1_900_000_000_000,
                verified_input,
                canonical_graph,
                canonical_compiled_ir,
            },
        )
        .await
        .unwrap();
    ledger
}

pub async fn seed_dispatch(
    ledger: &ClusterLedger,
) -> zeroshot_engine::cluster_ledger::DispatchAllocation {
    ledger
        .dispatch_reduction_fixture(
            IdempotencyId::new("seed-dispatch").unwrap(),
            [2; 32],
            ReductionDispatchRequest {
                occurrence: StructuralOccurrence {
                    node: "deterministic".parse().unwrap(),
                    map_indices: Vec::new(),
                },
                attempt: openengine_cluster_protocol::PositiveInteger::new(1).unwrap(),
                canonical_input: b"null".to_vec(),
            },
        )
        .await
        .unwrap()
        .value
}

pub async fn reduce(ledger: &ClusterLedger) -> Reduction {
    let state = ledger.state().await.unwrap();
    let admission = state.admission.as_ref().unwrap();
    let graph = deterministic_graph();
    let verified = verify(&graph, Registry(Some(descriptor()))).await;
    let input: Value = serde_json::from_slice(
        &state
            .verified_inputs
            .get(&admission.run)
            .unwrap()
            .canonical_bytes,
    )
    .unwrap();
    let executions = durable_executions_from_replay(&state, admission.run).unwrap();
    FullV1Reducer::new(&verified)
        .reduce(ReductionInput {
            run: admission.run,
            snapshot: state.reduction_snapshot(),
            initial_input: &input,
            executions: &executions,
            next_node_instance: state.identities.next_node_instance,
            next_execution: state.identities.next_execution,
        })
        .unwrap()
}
