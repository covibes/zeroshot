use super::*;

fn optional_nested_state() -> Value {
    json!({
        "kind":"record",
        "fields":{
            "value":{"type":{"kind":"integer"},"required":true},
            "object":{
                "type":{
                    "kind":"record",
                    "fields":{
                        "value":{"type":{"kind":"number"},"required":true}
                    }
                },
                "required":false
            }
        }
    })
}

struct RoutedWriter<'a> {
    name: &'a str,
    worker: &'a str,
    output: &'a Value,
    target: Value,
    state: &'a Value,
}

fn nested_routed_writer(writer: RoutedWriter<'_>) -> Value {
    let RoutedWriter {
        name,
        worker,
        output,
        target,
        state,
    } = writer;
    json!({
        "kind":"seq","name":format!("{name}Branch"),"state":state,
        "children":[
            {
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
            },
            {
                "kind":"choice","name":format!("{name}Route"),"state":state,
                "branches":[{
                    "when":{
                        "kind":"in",
                        "value":{"name":name,"source":"error","field":null},
                        "labels":["timeout","crash","malformed","refusal"]
                    },
                    "node":{
                        "kind":"fail","name":format!("{name}Failed"),
                        "reason":"worker_failed"
                    }
                }],
                "otherwise":{
                    "kind":"step","name":format!("{name}Continued"),
                    "worker":"worker.main@1","input":record(),
                    "output":{
                        "kind":"record",
                        "fields":{
                            "result":{
                                "type":{"kind":"integer"},
                                "required":true
                            }
                        }
                    },
                    "inputBindings":[{
                        "target":["value"],
                        "value":{"source":"state","path":["value"]}
                    }],
                    "writeBindings":[],"timeoutMs":1,"attempts":1
                },
                "promotedStatePaths":[]
            }
        ],
        "promotedStatePaths":[target]
    })
}

struct ParallelWriter<'a> {
    name: &'a str,
    prefix: &'a str,
    worker: &'a str,
    output: &'a Value,
    target: Value,
    state: &'a Value,
}

fn nested_parallel_writer(writer: ParallelWriter<'_>) -> Value {
    let left = nested_routed_writer(RoutedWriter {
        name: &format!("{}Left", writer.prefix),
        worker: writer.worker,
        output: writer.output,
        target: writer.target.clone(),
        state: writer.state,
    });
    let right = nested_routed_writer(RoutedWriter {
        name: &format!("{}Right", writer.prefix),
        worker: writer.worker,
        output: writer.output,
        target: writer.target.clone(),
        state: writer.state,
    });
    json!({
        "kind":"par","name":writer.name,"state":writer.state,
        "branches":[left,right],
        "promotedStatePaths":[writer.target],
        "join":{"kind":"any"}
    })
}

fn narrow_ancestor_route(state: &Value) -> Value {
    json!({
        "kind":"choice","name":"routeBoth","state":state,
        "branches":[{
            "when":{
                "kind":"all",
                "guards":[
                    {
                        "kind":"in",
                        "value":{
                            "name":"firstParallel",
                            "source":"group",
                            "field":"joined"
                        },
                        "labels":["reached"]
                    },
                    {
                        "kind":"in",
                        "value":{
                            "name":"secondParallel",
                            "source":"group",
                            "field":"joined"
                        },
                        "labels":["reached"]
                    }
                ]
            },
            "node":{
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
            }
        }],
        "otherwise":{
            "kind":"succeed","name":"otherResult",
            "output":{"kind":"null"},"bindings":[]
        },
        "promotedStatePaths":[]
    })
}

fn sequential_overlapping_parallel_writes_graph() -> (GraphSpec, MemoryRegistry) {
    let state = optional_nested_state();
    let object_output = worker_object_output();
    let number_output = worker_number_output();
    let first = nested_parallel_writer(ParallelWriter {
        name: "firstParallel",
        prefix: "first",
        worker: "worker.object@1",
        output: &object_output,
        target: json!(["object"]),
        state: &state,
    });
    let second = nested_parallel_writer(ParallelWriter {
        name: "secondParallel",
        prefix: "second",
        worker: "worker.number@1",
        output: &number_output,
        target: json!(["object", "value"]),
        state: &state,
    });
    let graph = graph_with_state_children(
        state.clone(),
        json!([first, second, narrow_ancestor_route(&state)]),
    );
    let registry = registry_with_worker_outputs(object_output, number_output);
    (graph, registry)
}

#[tokio::test]
async fn jointly_successful_sequential_parallels_invalidate_stale_ancestor_types() {
    let (graph, registry) = sequential_overlapping_parallel_writes_graph();
    let error = ProductionGraphVerifier::new(registry)
        .verify(&graph)
        .await
        .assert_error();
    assert!(rejection_codes(error).contains(&GraphDiagnosticCode::SchemaSafety));
}
