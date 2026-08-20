use async_trait::async_trait;
use openengine_cluster_protocol::{GraphSpec, WorkerDescriptor, WorkerRef};
use openengine_cluster_server::admission::{GraphVerifier, VerifiedGraph};
use openengine_cluster_server::graph_verifier::ProductionGraphVerifier;
use openengine_cluster_server::worker_registry::{WorkerRegistry, WorkerRegistryError};
use serde_json::{json, Value};

pub fn step_node(name: &str, attempts: u64, output: Value) -> Value {
    json!({
        "kind":"step","name":name,"worker":"worker.test@1",
        "input":{"kind":"null"},"output":output,
        "inputBindings":[],"writeBindings":[],"timeoutMs":1,"attempts":attempts
    })
}

pub fn verifier(name: &str, attempts: u64) -> Value {
    json!({
        "kind":"verifier","name":name,"worker":"worker.verify@1",
        "input":{"kind":"null"},"output":{"kind":"record","fields":{}},
        "inputBindings":[],"writeBindings":[],"timeoutMs":1,"attempts":attempts,
        "signals":{"verdict":["accepted","rejected"]},
        "diagnostic":{"kind":"record","fields":{}}
    })
}

pub struct TestWorkers {
    pub rich_outputs: bool,
}

#[async_trait]
impl WorkerRegistry for TestWorkers {
    async fn resolve(&self, worker: &WorkerRef) -> Result<WorkerDescriptor, WorkerRegistryError> {
        let verifier = (worker.as_str() == "worker.verify@1").then(|| {
            json!({
                "signals":{"verdict":["accepted","rejected"]},
                "diagnostic":{"kind":"record","fields":{}}
            })
        });
        let output = if verifier.is_some() || !self.rich_outputs {
            json!({"kind":"record","fields":{}})
        } else if worker.as_str() == "worker.multi@1" {
            json!({"kind":"record","fields":{
                "a":{"type":{"kind":"integer"},"required":true},
                "b":{"type":{"kind":"integer"},"required":true}
            }})
        } else {
            json!({"kind":"record","fields":{"value":{"type":{"kind":"integer"},"required":true}}})
        };
        serde_json::from_value(json!({
            "worker":worker.as_str(),
            "graphProfiles":["openengine.graph.full/v1"],
            "binding":{"protocol":"acp","version":"1","profile":"openengine.worker.acp/v1"},
            "contract":{
                "input":{"kind":"null"},"output":output,"verifier":verifier,
                "errors":["timeout","crash","malformed","refusal"]
            },
            "capabilityPolicy":{"autonomy":"strict","permissionPolicy":"policy.strict@1"},
            "artifactProfile":{
                "allowedTypeIds":["openengine.result@1"],
                "allowedMediaTypes":["application/json"],
                "minimumRedaction":"internal"
            },
            "credentialRequirements":[]
        }))
        .map_err(|_| WorkerRegistryError::NotFound {
            worker: worker.clone(),
        })
    }
}

pub async fn verified_graph(
    root: Value,
    initial_input: Value,
    rich_outputs: bool,
) -> VerifiedGraph {
    let graph: GraphSpec = serde_json::from_value(json!({
        "profile":"openengine.graph.full/v1",
        "initialInput":initial_input,
        "policy":{"policy":"policy.test@1","default":"deny"},
        "root":root
    }))
    .assert_value();
    ProductionGraphVerifier::new(TestWorkers { rich_outputs })
        .verify(&graph)
        .await
        .assert_value()
}

use openengine_cluster_testkit::assertions::{AssertValue};
