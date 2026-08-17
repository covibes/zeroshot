use super::*;

fn nested_record_state(value_type: Value) -> Value {
    json!({
        "kind":"record",
        "fields":{
            "value":{"type":{"kind":"integer"},"required":true},
            "object":{
                "type":{
                    "kind":"record",
                    "fields":{
                        "value":{"type":value_type,"required":true}
                    }
                },
                "required":true
            }
        }
    })
}

fn narrow_ancestor_consumer() -> Value {
    json!({
        "kind":"succeed","name":"narrowConsumer",
        "output":{
            "kind":"record",
            "fields":{
                "object":{
                    "type":{
                        "kind":"record",
                        "fields":{
                            "value":{
                                "type":{"kind":"integer"},
                                "required":true
                            }
                        }
                    },
                    "required":true
                }
            }
        },
        "bindings":[{
            "target":["object"],
            "value":{"source":"state","path":["object"]}
        }]
    })
}

fn descendant_overwrite_graph() -> GraphSpec {
    let initial = nested_record_state(json!({"kind":"integer"}));
    let widened = nested_record_state(json!({"kind":"number"}));
    serde_json::from_value(json!({
        "profile":"openengine.graph.full/v1",
        "initialInput":initial,
        "policy":{"policy":"policy.strict@1","default":"deny"},
        "root":{
            "kind":"seq","name":"root","state":widened,
            "children":[
                {
                    "kind":"step","name":"writer","worker":"worker.main@1",
                    "input":record(),
                    "output":{
                        "kind":"record",
                        "fields":{"result":{"type":{"kind":"number"},"required":true}}
                    },
                    "inputBindings":[{
                        "target":["value"],
                        "value":{"source":"state","path":["value"]}
                    }],
                    "writeBindings":[{
                        "value":{"node":"writer","channel":"out","path":["result"]},
                        "target":["object","value"]
                    }],
                    "timeoutMs":1,"attempts":1
                },
                {
                    "kind":"choice","name":"writerRoute","state":widened,
                    "branches":[{
                        "when":{
                            "kind":"in",
                            "value":{"name":"writer","source":"error","field":null},
                            "labels":["timeout","crash","malformed","refusal"]
                        },
                        "node":{"kind":"fail","name":"writerFailed","reason":"worker_failed"}
                    }],
                    "otherwise":{
                        "kind":"step","name":"writerContinued","worker":"worker.main@1",
                        "input":record(),
                        "output":{
                            "kind":"record",
                            "fields":{"result":{"type":{"kind":"integer"},"required":true}}
                        },
                        "inputBindings":[{
                            "target":["value"],
                            "value":{"source":"state","path":["value"]}
                        }],
                        "writeBindings":[],
                        "timeoutMs":1,"attempts":1
                    },
                    "promotedStatePaths":[]
                },
                narrow_ancestor_consumer()
            ],
            "promotedStatePaths":[]
        }
    }))
    .assert_value()
}

#[tokio::test]
async fn descendant_writes_invalidate_stale_ancestor_type_facts() {
    let graph = descendant_overwrite_graph();
    let error = assert_graph_rejected(&graph).await;
    let diagnostics = rejection_diagnostics(error);
    assert!(diagnostics.iter().any(|diagnostic| {
        diagnostic.code == GraphDiagnosticCode::SchemaSafety
            && diagnostic.message == "binding source is not a subtype of its target"
    }));
}

fn routed_write_step(name: &str, worker: &str, output: Value, target: Value) -> Value {
    json!({
        "kind":"step","name":name,"worker":worker,
        "input":record(),"output":output,
        "inputBindings":[{
            "target":["value"],
            "value":{"source":"state","path":["value"]}
        }],
        "writeBindings":[{
            "value":{"node":name,"channel":"out","path":["result"]},
            "target":target
        }],
        "timeoutMs":1,"attempts":1
    })
}

fn writers_route(state: &Value) -> Value {
    json!({
        "kind":"choice","name":"writersRoute","state":state,
        "branches":[{
            "when":{
                "kind":"any",
                "guards":[
                    {
                        "kind":"in",
                        "value":{
                            "name":"objectWriter",
                            "source":"error",
                            "field":null
                        },
                        "labels":["timeout","crash","malformed","refusal"]
                    },
                    {
                        "kind":"in",
                        "value":{
                            "name":"descendantWriter",
                            "source":"error",
                            "field":null
                        },
                        "labels":["timeout","crash","malformed","refusal"]
                    }
                ]
            },
            "node":{
                "kind":"fail","name":"writerFailed",
                "reason":"worker_failed"
            }
        }],
        "otherwise":{
            "kind":"step","name":"writersContinued",
            "worker":"worker.main@1","input":record(),
            "output":worker_number_output(),
            "inputBindings":[{
                "target":["value"],
                "value":{"source":"state","path":["value"]}
            }],
            "writeBindings":[],"timeoutMs":1,"attempts":1
        },
        "promotedStatePaths":[]
    })
}

fn nested_ancestor_promotion_graph() -> (GraphSpec, MemoryRegistry) {
    let narrow = nested_record_state(json!({"kind":"integer"}));
    let widened = nested_record_state(json!({"kind":"number"}));
    let object_output = worker_object_output();
    let number_output = worker_number_output();
    let object_writer = routed_write_step(
        "objectWriter",
        "worker.object@1",
        object_output.clone(),
        json!(["object"]),
    );
    let descendant_writer = routed_write_step(
        "descendantWriter",
        "worker.number@1",
        number_output.clone(),
        json!(["object", "value"]),
    );
    let children = vec![object_writer, descendant_writer, writers_route(&widened)];
    let graph: GraphSpec = serde_json::from_value(json!({
        "profile":"openengine.graph.full/v1",
        "initialInput":narrow,
        "policy":{"policy":"policy.strict@1","default":"deny"},
        "root":{
            "kind":"seq","name":"root","state":widened,
            "children":[
                {
                    "kind":"seq","name":"nested","state":widened,
                    "children":children,
                    "promotedStatePaths":[["object"]]
                },
                narrow_ancestor_consumer()
            ],
            "promotedStatePaths":[]
        }
    }))
    .assert_value();
    let registry = registry_with_worker_outputs(object_output, number_output);
    (graph, registry)
}

#[tokio::test]
async fn nested_ancestor_promotion_preserves_the_latest_descendant_write_type() {
    let (graph, registry) = nested_ancestor_promotion_graph();
    let error = ProductionGraphVerifier::new(registry)
        .verify(&graph)
        .await
        .assert_error();
    assert!(rejection_codes(error).contains(&GraphDiagnosticCode::SchemaSafety));
}
