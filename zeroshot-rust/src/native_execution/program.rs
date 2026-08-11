use std::sync::Arc;

use async_trait::async_trait;
use openengine_cluster_protocol::{
    canonical_value_bytes, DiagnosticSeverity, GraphDiagnostic, GraphDiagnosticCode, GraphNode,
    GraphSpec, WorkerDescriptor, WorkerRef,
};
use openengine_cluster_server::admission::{GraphVerifier, VerificationError, VerifiedGraph};
use openengine_cluster_server::graph_verifier::ProductionGraphVerifier;
use openengine_cluster_server::worker_registry::{WorkerRegistry, WorkerRegistryError};
use serde::Serialize;
use serde_json::json;

use crate::cluster_ledger::record::CanonicalDigest;
use crate::cluster_ledger::ReplayState;
use crate::native_admission::native_worker_protocol::WORKER_REF;

pub(super) const NATIVE_PROCESS_TIMEOUT_MS: u64 = 10_000;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeCatalogSnapshot<'a> {
    version: u8,
    workers: &'a [WorkerDescriptor],
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeProfileSnapshot<'a> {
    descriptors: &'a [WorkerDescriptor],
}

#[derive(Clone, Debug)]
pub(crate) struct NativeExecutionRegistry {
    descriptors: Arc<[WorkerDescriptor]>,
    catalog_digest: CanonicalDigest,
    profile_digest: CanonicalDigest,
}

impl NativeExecutionRegistry {
    pub(crate) fn production() -> Self {
        Self::from_descriptors(Arc::from([deterministic_descriptor()]))
    }

    pub(crate) fn predecessor_digests() -> (CanonicalDigest, CanonicalDigest) {
        let empty = Self::from_descriptors(Arc::from([]));
        (empty.catalog_digest, empty.profile_digest)
    }

    fn from_descriptors(descriptors: Arc<[WorkerDescriptor]>) -> Self {
        let catalog = canonical_value_bytes(
            &serde_json::to_value(NativeCatalogSnapshot {
                version: 1,
                workers: &descriptors,
            })
            .expect("native catalog snapshot must serialize"),
        )
        .expect("native catalog snapshot must canonicalize");
        let profile = canonical_value_bytes(
            &serde_json::to_value(NativeProfileSnapshot {
                descriptors: &descriptors,
            })
            .expect("native profile snapshot must serialize"),
        )
        .expect("native profile snapshot must canonicalize");
        Self {
            descriptors,
            catalog_digest: CanonicalDigest::of(&catalog),
            profile_digest: CanonicalDigest::of(&profile),
        }
    }

    pub(crate) const fn catalog_digest(&self) -> CanonicalDigest {
        self.catalog_digest
    }

    pub(crate) const fn profile_digest(&self) -> CanonicalDigest {
        self.profile_digest
    }

    pub(crate) fn matches_current(&self, state: &ReplayState) -> bool {
        state.admission.as_ref().is_none_or(|admission| {
            admission.catalog_digest == self.catalog_digest
                && admission.profile_digest == self.profile_digest
        })
    }

    pub(crate) fn descriptor(&self) -> &WorkerDescriptor {
        self.descriptors
            .first()
            .expect("production native registry has one descriptor")
    }
}

#[async_trait]
impl WorkerRegistry for NativeExecutionRegistry {
    async fn resolve(&self, worker: &WorkerRef) -> Result<WorkerDescriptor, WorkerRegistryError> {
        self.descriptors
            .iter()
            .find(|descriptor| descriptor.worker == *worker)
            .cloned()
            .ok_or_else(|| WorkerRegistryError::NotFound {
                worker: worker.clone(),
            })
    }
}

pub(crate) struct NativeGraphVerifier {
    inner: ProductionGraphVerifier<NativeExecutionRegistry>,
}

impl NativeGraphVerifier {
    pub(crate) fn new(registry: NativeExecutionRegistry) -> Self {
        Self {
            inner: ProductionGraphVerifier::new(registry),
        }
    }
}

#[async_trait]
impl GraphVerifier for NativeGraphVerifier {
    async fn verify(&self, graph: &GraphSpec) -> Result<VerifiedGraph, VerificationError> {
        let verified = self.inner.verify(graph).await?;
        if !contains_executable(&graph.root) || is_deterministic_graph(graph) {
            return Ok(verified);
        }
        Err(VerificationError::Rejected {
            diagnostics: vec![GraphDiagnostic {
                severity: DiagnosticSeverity::Error,
                code: GraphDiagnosticCode::InvalidGraphShape,
                message: "native execution permits only the fixed one-step graph".to_owned(),
                path: Vec::new(),
                related_nodes: Vec::new(),
            }],
        })
    }
}

pub(crate) fn deterministic_graph() -> GraphSpec {
    serde_json::from_value(json!({
        "profile": "openengine.graph.full/v1",
        "initialInput": {
            "kind": "record",
            "fields": {
                "value": { "type": { "kind": "integer" }, "required": true }
            }
        },
        "policy": { "policy": "policy.default@1", "default": "deny" },
        "root": {
            "kind": "seq",
            "name": "root",
            "state": {
                "kind": "record",
                "fields": {
                    "value": { "type": { "kind": "integer" }, "required": true }
                }
            },
            "children": [
                {
                    "kind": "step",
                    "name": "deterministic",
                    "worker": WORKER_REF,
                    "input": { "kind": "null" },
                    "output": {
                        "kind": "record",
                        "fields": {
                            "value": { "type": { "kind": "integer" }, "required": true }
                        }
                    },
                    "inputBindings": [],
                    "writeBindings": [{
                        "value": {
                            "node": "deterministic",
                            "channel": "out",
                            "path": ["value"]
                        },
                        "target": ["value"]
                    }],
                    "timeoutMs": NATIVE_PROCESS_TIMEOUT_MS,
                    "attempts": 1
                },
                {
                    "kind": "succeed",
                    "name": "done",
                    "output": {
                        "kind": "record",
                        "fields": {
                            "value": { "type": { "kind": "integer" }, "required": true }
                        }
                    },
                    "bindings": [{
                        "target": ["value"],
                        "value": { "source": "state", "path": ["value"] }
                    }]
                }
            ],
            "promotedStatePaths": []
        }
    }))
    .expect("fixed native deterministic graph must decode")
}

pub(crate) fn is_deterministic_graph(graph: &GraphSpec) -> bool {
    *graph == deterministic_graph()
}

pub(crate) fn is_worker_free_graph(graph: &GraphSpec) -> bool {
    !contains_executable(&graph.root)
}

fn contains_executable(node: &GraphNode) -> bool {
    match node {
        GraphNode::Step(_) | GraphNode::Verifier(_) => true,
        GraphNode::Seq(group) => group.children.as_slice().iter().any(contains_executable),
        GraphNode::Choice(group) => {
            group
                .branches
                .as_slice()
                .iter()
                .any(|branch| contains_executable(&branch.node))
                || group.otherwise.as_deref().is_some_and(contains_executable)
        }
        GraphNode::Par(group) => group.branches.as_slice().iter().any(contains_executable),
        GraphNode::Loop(group) => contains_executable(&group.body),
        GraphNode::Map(group) => contains_executable(&group.body),
        GraphNode::Succeed(_) | GraphNode::Fail(_) => false,
    }
}

fn deterministic_descriptor() -> WorkerDescriptor {
    serde_json::from_value(json!({
        "worker": WORKER_REF,
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
    .expect("fixed native deterministic descriptor must decode")
}
