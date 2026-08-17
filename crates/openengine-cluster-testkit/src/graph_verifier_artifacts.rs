//! Deterministic production-verifier conformance envelopes.

use crate::fixture::*;

use std::collections::{BTreeMap, BTreeSet};

use async_trait::async_trait;
use openengine_cluster_protocol::{GraphProfile, GraphSpec, WorkerDescriptor, WorkerRef};
use openengine_cluster_server::admission::{GraphVerifier, VerificationError, VerifiedGraph};
use openengine_cluster_server::graph_verifier::ProductionGraphVerifier;
use openengine_cluster_server::worker_registry::{WorkerRegistry, WorkerRegistryError};
use serde_json::{json, Value};

use crate::artifacts::Artifact;

const ROOT: &str = "protocol/openengine-cluster/v1/fixtures/verifier";

mod case_catalog;
mod fixture_builders;
mod fixture_controls;
mod fixture_negative;

use case_catalog::{negative_cases, positive_cases};
use fixture_negative::{
    data_input_type, data_state_type, diagnostic_integer_type, diagnostic_number_type,
    json_artifact, null_type, result_integer_type, result_number_type, worker_ref,
};

#[derive(Clone)]
pub struct VerifierFixtureRegistry {
    descriptors: BTreeMap<WorkerRef, WorkerDescriptor>,
    version_unavailable: BTreeSet<WorkerRef>,
}

#[async_trait]
impl WorkerRegistry for VerifierFixtureRegistry {
    async fn resolve(&self, worker: &WorkerRef) -> Result<WorkerDescriptor, WorkerRegistryError> {
        if self.version_unavailable.contains(worker) {
            return Err(WorkerRegistryError::VersionUnavailable {
                worker: worker.clone(),
            });
        }
        self.descriptors
            .get(worker)
            .cloned()
            .ok_or_else(|| WorkerRegistryError::NotFound {
                worker: worker.clone(),
            })
    }
}

#[must_use]
pub fn verifier_fixture_registry() -> VerifierFixtureRegistry {
    let mut descriptors = BTreeMap::new();
    insert_descriptor(
        &mut descriptors,
        "fixture.worker@1",
        descriptor_value("fixture.worker@1", null_type(), null_type(), None),
    );
    insert_descriptor(
        &mut descriptors,
        "fixture.data@1",
        descriptor_value(
            "fixture.data@1",
            data_input_type(),
            result_integer_type(),
            None,
        ),
    );
    insert_descriptor(
        &mut descriptors,
        "fixture.verifier@1",
        descriptor_value(
            "fixture.verifier@1",
            null_type(),
            result_integer_type(),
            Some(verifier_contract()),
        ),
    );
    insert_registry_fault_descriptors(&mut descriptors);
    VerifierFixtureRegistry {
        descriptors,
        version_unavailable: BTreeSet::from([worker_ref("fixture.version-unavailable@2")]),
    }
}

fn insert_descriptor(
    descriptors: &mut BTreeMap<WorkerRef, WorkerDescriptor>,
    requested: &str,
    value: Value,
) {
    descriptors.insert(
        worker_ref(requested),
        serde_json::from_value(value).assert_value_with("fixture descriptor is valid"),
    );
}

fn insert_registry_fault_descriptors(descriptors: &mut BTreeMap<WorkerRef, WorkerDescriptor>) {
    let mut invalid: WorkerDescriptor = serde_json::from_value(descriptor_value(
        "fixture.invalid-contract@1",
        null_type(),
        null_type(),
        None,
    ))
    .assert_value();
    invalid.contract.errors.pop();
    descriptors.insert(worker_ref("fixture.invalid-contract@1"), invalid);

    insert_descriptor(
        descriptors,
        "fixture.identity@1",
        descriptor_value("fixture.returned-other@1", null_type(), null_type(), None),
    );
    let mut profile: WorkerDescriptor = serde_json::from_value(descriptor_value(
        "fixture.profile@1",
        null_type(),
        null_type(),
        None,
    ))
    .assert_value();
    profile.graph_profiles = vec![GraphProfile::SingleWorker];
    descriptors.insert(worker_ref("fixture.profile@1"), profile);
}

fn descriptor_value(worker: &str, input: Value, output: Value, verifier: Option<Value>) -> Value {
    json!({
        "worker": worker,
        "graphProfiles": ["openengine.graph.full/v1"],
        "binding": { "protocol": "acp", "version": "1", "profile": "openengine.worker.acp/v1" },
        "contract": {
            "input": input,
            "output": output,
            "verifier": verifier,
            "errors": ["timeout", "crash", "malformed", "refusal"]
        },
        "capabilityPolicy": { "autonomy": "strict", "permissionPolicy": "policy.strict@1" },
        "artifactProfile": {
            "allowedTypeIds": ["openengine.result@1"],
            "allowedMediaTypes": ["application/json"],
            "minimumRedaction": "internal"
        },
        "credentialRequirements": []
    })
}

fn verifier_contract() -> Value {
    json!({
        "signals": { "verdict": ["accepted", "rejected"] },
        "diagnostic": diagnostic_integer_type()
    })
}

pub async fn verify_fixture_graph(graph: &GraphSpec) -> Result<VerifiedGraph, VerificationError> {
    ProductionGraphVerifier::new(verifier_fixture_registry())
        .verify(graph)
        .await
}

pub async fn graph_verifier_fixture_artifacts() -> Vec<Artifact> {
    let mut artifacts = Vec::new();
    for (name, graph_value) in positive_cases().into_iter().chain(negative_cases()) {
        let graph: GraphSpec = serde_json::from_value(graph_value.clone())
            .assert_value_with("verifier fixture graph must satisfy the wire contract");
        let expected = result_value(verify_fixture_graph(&graph).await);
        artifacts.push(json_artifact(
            format!("{ROOT}/{name}"),
            json!({ "graph": graph_value, "expected": expected }),
        ));
    }
    artifacts
}

#[must_use]
pub fn result_value(result: Result<VerifiedGraph, VerificationError>) -> Value {
    match result {
        Ok(verified) => json!({
            "status": "verified",
            "compiledIr": verified.compiled_ir,
            "diagnostics": verified.diagnostics
        }),
        Err(VerificationError::Rejected { diagnostics }) => {
            json!({ "status": "rejected", "diagnostics": diagnostics })
        }
        Err(VerificationError::Internal(message)) => {
            json!({ "status": "internal-error", "message": message })
        }
    }
}
