use super::*;

fn correlated_flow_writer() -> Value {
    json!({
        "kind":"seq","name":"writerBranch","state":record(),
        "children":[
            {
                "kind":"step","name":"sharedWriter","worker":"worker.main@1",
                "input":record(),
                "output":{"kind":"record","fields":{
                    "result":{"type":{"kind":"number"},"required":true}
                }},
                "inputBindings":[
                    {"target":["value"],"value":{"source":"state","path":["value"]}}
                ],
                "writeBindings":[{
                    "value":{"node":"sharedWriter","channel":"out","path":["result"]},
                    "target":["result"]
                }],
                "timeoutMs":1,"attempts":1
            },
            {
                "kind":"choice","name":"writerOutcome","state":record(),
                "branches":[{
                    "when":{
                        "kind":"in","value":{"name":"sharedWriter","source":"error"},
                        "labels":["timeout","crash","malformed","refusal"]
                    },
                    "node":{
                        "kind":"succeed","name":"writerFailed",
                        "output":{"kind":"null"},"bindings":[]
                    }
                }],
                "otherwise":{
                    "kind":"step","name":"writerContinuation","worker":"worker.main@1",
                    "input":record(),
                    "output":{"kind":"record","fields":{
                        "result":{"type":{"kind":"number"},"required":true}
                    }},
                    "inputBindings":[
                        {"target":["value"],"value":{"source":"state","path":["value"]}}
                    ],
                    "writeBindings":[],"timeoutMs":1,"attempts":1
                },
                "promotedStatePaths":[]
            }
        ],
        "promotedStatePaths":[["result"]]
    })
}

#[tokio::test]
async fn quorum_flow_uses_only_jointly_satisfiable_completion_sets() {
    let graph = graph_with_valid_tail_nodes(json!([
        {
            "kind":"par", "name":"correlatedFlowQuorum", "state":record(),
            "branches":[
                conditional_quorum_branch(
                    "acceptedBranch","accepted","acceptedWork","rejectedDone"
                ),
                correlated_flow_writer(),
                conditional_quorum_branch(
                    "rejectedBranch","rejected","rejectedWork","acceptedDone"
                )
            ],
            "promotedStatePaths":[["result"]],
            "join":{"kind":"quorum","count":2}
        },
        {
            "kind":"choice","name":"afterCorrelatedQuorum","state":record(),
            "branches":[{
                "when":{
                    "kind":"in",
                    "value":{
                        "name":"correlatedFlowQuorum",
                        "source":"group",
                        "field":"joined"
                    },
                    "labels":["reached"]
                },
                "node":{
                    "kind":"succeed", "name":"done",
                    "output":{
                        "kind":"record",
                        "fields":{"result":{"type":{"kind":"number"},"required":true}}
                    },
                    "bindings":[{
                        "target":["result"],
                        "value":{"source":"state","path":["result"]}
                    }]
                }
            }],
            "otherwise":{
                "kind":"succeed","name":"correlatedQuorumFailed",
                "output":{"kind":"null"},"bindings":[]
            },
            "promotedStatePaths":[]
        }
    ]));

    assert_graph_accepted(&graph).await;
}

#[tokio::test]
async fn output_signal_and_diagnostic_binding_channels_are_type_checked_and_admitted() {
    let graph = graph_with_root_child(json!({
        "kind":"seq","name":"root","state":record(),"children":[
            {"kind":"verifier","name":"verify","worker":"worker.verify@1",
             "input":{"kind":"null"},
             "output":{"kind":"record","fields":{"result":{"type":{"kind":"number"},"required":true}}},
             "inputBindings":[],
             "writeBindings":[
                {"value":{"node":"verify","channel":"out","path":["result"]},"target":["result"]},
                {"value":{"node":"verify","channel":"signal","path":["verdict"]},"target":["verdict"]},
                {"value":{"node":"verify","channel":"diagnostic","path":["code"]},"target":["diagnostic"]}
             ],
             "timeoutMs":1,"attempts":1,
             "signals":{"verdict":["accepted","rejected"]},
             "diagnostic":{"kind":"record","fields":{"code":{"type":{"kind":"number"},"required":true}}}},
            {"kind":"succeed","name":"done","output":{"kind":"null"},"bindings":[]}
        ],"promotedStatePaths":[]
    }));
    assert_graph_accepted(&graph).await;
}
