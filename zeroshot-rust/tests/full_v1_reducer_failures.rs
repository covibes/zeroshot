use async_trait::async_trait;
use openengine_cluster_protocol::{
    GraphSpec, PositiveInteger, WorkerDescriptor, WorkerErrorCode, WorkerOutcome, WorkerRef,
};
use openengine_cluster_server::admission::{GraphVerifier, VerifiedGraph};
use openengine_cluster_server::graph_verifier::ProductionGraphVerifier;
use openengine_cluster_server::worker_registry::{WorkerRegistry, WorkerRegistryError};
use serde_json::json;
use zeroshot_engine::cluster_ledger::store::Position;
use zeroshot_engine::cluster_ledger::{ExecutionId, NodeInstanceId, RunSequence, StructuralOccurrence};
use zeroshot_engine::full_v1_reducer::{
    DurableExecution, DurableExecutionState, FullV1Reducer, ReductionInput, TerminalProjection,
};

struct TestWorker;

#[async_trait]
impl WorkerRegistry for TestWorker {
    async fn resolve(&self, worker: &WorkerRef) -> Result<WorkerDescriptor, WorkerRegistryError> {
        serde_json::from_value(json!({
            "worker": worker.as_str(),
            "graphProfiles": ["openengine.graph.full/v1"],
            "binding": {
                "protocol": "acp",
                "version": "1",
                "profile": "openengine.worker.acp/v1"
            },
            "contract": {
                "input": {"kind":"null"},
                "output": {
                    "kind":"record",
                    "fields":{"value":{"type":{"kind":"integer"},"required":true}}
                },
                "verifier": null,
                "errors": ["timeout", "crash", "malformed", "refusal"]
            },
            "capabilityPolicy": {
                "autonomy": "strict",
                "permissionPolicy": "policy.strict@1"
            },
            "artifactProfile": {
                "allowedTypeIds": ["openengine.result@1"],
                "allowedMediaTypes": ["application/json"],
                "minimumRedaction": "internal"
            },
            "credentialRequirements": []
        }))
        .map_err(|_| WorkerRegistryError::NotFound {
            worker: worker.clone(),
        })
    }
}

async fn verified_graph() -> VerifiedGraph {
    let state = json!({
        "kind":"record",
        "fields":{"value":{"type":{"kind":"integer"},"required":false}}
    });
    let graph: GraphSpec = serde_json::from_value(json!({
        "profile":"openengine.graph.full/v1",
        "initialInput":state.clone(),
        "policy":{"policy":"policy.test@1","default":"deny"},
        "root":{
            "kind":"seq", "name":"root", "state":state.clone(),
            "children":[
                {
                    "kind":"step", "name":"work", "worker":"worker.test@1",
                    "input":{"kind":"null"},
                    "output":{
                        "kind":"record",
                        "fields":{"value":{"type":{"kind":"integer"},"required":true}}
                    },
                    "inputBindings":[],
                    "writeBindings":[{
                        "value":{"node":"work","channel":"out","path":["value"]},
                        "target":["value"]
                    }],
                    "timeoutMs":1, "attempts":1
                },
                {
                    "kind":"choice", "name":"route", "state":state,
                    "branches":[{
                        "when":{
                            "kind":"in",
                            "value":{"name":"work","source":"error","field":null},
                            "labels":["crash"]
                        },
                        "node":{"kind":"fail","name":"failed","reason":"worker_failed"}
                    }],
                    "otherwise":{
                        "kind":"succeed", "name":"done",
                        "output":{"kind":"null"}, "bindings":[]
                    },
                    "promotedStatePaths":[]
                }
            ],
            "promotedStatePaths":[]
        }
    }))
    .unwrap();
    ProductionGraphVerifier::new(TestWorker)
        .verify(&graph)
        .await
        .unwrap()
}

#[tokio::test]
async fn failed_step_does_not_promote_success_only_writes_before_error_routing() {
    let execution = DurableExecution {
        run: RunSequence::new(1).unwrap(),
        dispatch_position: Position::new(2).unwrap(),
        node_instance: NodeInstanceId::new(1).unwrap(),
        execution: ExecutionId::new(1).unwrap(),
        occurrence: StructuralOccurrence {
            node: "work".parse().unwrap(),
            map_indices: Vec::new(),
        },
        attempt: PositiveInteger::new(1).unwrap(),
        input: serde_json::Value::Null,
        state: DurableExecutionState::Settled {
            position: Position::new(3).unwrap(),
            outcome: WorkerOutcome::declared_failure(WorkerErrorCode::Crash),
        },
    };
    let reduction = FullV1Reducer::new(&verified_graph().await)
        .reduce(ReductionInput {
            run: RunSequence::new(1).unwrap(),
            snapshot: None,
            initial_input: &json!({}),
            executions: &[execution],
            next_node_instance: 2,
            next_execution: 2,
        })
        .unwrap();
    assert_eq!(
        reduction.terminal,
        Some(TerminalProjection::Failed {
            reason: "worker_failed".parse().unwrap()
        })
    );
}
