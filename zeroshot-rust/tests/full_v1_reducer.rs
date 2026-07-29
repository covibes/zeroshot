use async_trait::async_trait;
use openengine_cluster_protocol::{
    CompiledGraphIr, GraphSpec, PositiveInteger, WorkerDescriptor, WorkerOutcome, WorkerRef,
};
use openengine_cluster_server::admission::{GraphVerifier, VerifiedGraph};
use openengine_cluster_server::graph_verifier::ProductionGraphVerifier;
use openengine_cluster_server::worker_registry::{WorkerRegistry, WorkerRegistryError};
use serde_json::{json, Value};
use zeroshot_engine::cluster_ledger::store::Position;
use zeroshot_engine::cluster_ledger::{
    ExecutionId, ExecutionVoidReason, NodeInstanceId, RunSequence, StructuralOccurrence,
};
use zeroshot_engine::full_v1_reducer::{
    Decision, DurableExecution, DurableExecutionState, FullV1Reducer, Reduction, ReductionInput,
    TerminalProjection,
};

struct TestWorkers;

#[async_trait]
impl WorkerRegistry for TestWorkers {
    async fn resolve(&self, worker: &WorkerRef) -> Result<WorkerDescriptor, WorkerRegistryError> {
        serde_json::from_value(json!({
            "worker":worker.as_str(),
            "graphProfiles":["openengine.graph.full/v1"],
            "binding":{"protocol":"acp","version":"1","profile":"openengine.worker.acp/v1"},
            "contract":{
                "input":{"kind":"null"},
                "output":{"kind":"record","fields":{"value":{"type":{"kind":"integer"},"required":true}}},
                "verifier":null,
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

fn verified(root: Value, attempts: Value) -> VerifiedGraph {
    let compiled_ir: CompiledGraphIr = serde_json::from_value(json!({
        "profile": "openengine.graph.full/v1",
        "initialInput": {"kind":"record","fields":{}},
        "policy": {"policy":"policy.test@1","default":"deny"},
        "root": root,
        "bounds": {
            "maxNodeExecutions": 64,
            "peakConcurrency": 16,
            "attemptsPerNode": attempts,
            "termination": {"kind":"acyclic","order":["root"]}
        }
    }))
    .unwrap();
    VerifiedGraph {
        compiled_ir,
        diagnostics: Vec::new(),
    }
}

fn step(name: &str, attempts: u64) -> Value {
    json!({
        "kind":"step", "name":name, "worker":"worker.test@1",
        "input":{"kind":"null"},
        "output":{"kind":"record","fields":{"value":{"type":{"kind":"integer"},"required":true}}},
        "inputBindings":[], "writeBindings":[], "timeoutMs":1, "attempts":attempts
    })
}

fn verifier(name: &str, attempts: u64) -> Value {
    json!({
        "kind":"verifier", "name":name, "worker":"worker.verify@1",
        "input":{"kind":"null"}, "output":{"kind":"record","fields":{}},
        "inputBindings":[], "writeBindings":[], "timeoutMs":1, "attempts":attempts,
        "signals":{"verdict":["accepted","rejected"]},
        "diagnostic":{"kind":"record","fields":{}}
    })
}

fn succeed(name: &str) -> Value {
    json!({"kind":"succeed","name":name,"output":{"kind":"null"},"bindings":[]})
}

fn sequence(name: &str, children: Vec<Value>) -> Value {
    json!({
        "kind":"seq", "name":name, "state":{"kind":"record","fields":{}},
        "children":children, "promotedStatePaths":[]
    })
}

fn settled(
    execution: u64,
    node_instance: u64,
    node: &str,
    map_indices: Vec<u64>,
    attempt: u64,
    position: u64,
    outcome: WorkerOutcome,
) -> DurableExecution {
    DurableExecution {
        dispatch_position: Position::new(position.saturating_sub(1)).unwrap(),
        node_instance: NodeInstanceId::new(node_instance).unwrap(),
        execution: ExecutionId::new(execution).unwrap(),
        occurrence: StructuralOccurrence {
            node: node.parse().unwrap(),
            map_indices,
        },
        attempt: PositiveInteger::new(attempt).unwrap(),
        input: Value::Null,
        state: DurableExecutionState::Settled {
            position: Position::new(position).unwrap(),
            outcome,
        },
    }
}

fn active(
    execution: u64,
    node_instance: u64,
    node: &str,
    position: u64,
) -> DurableExecution {
    DurableExecution {
        dispatch_position: Position::new(position).unwrap(),
        node_instance: NodeInstanceId::new(node_instance).unwrap(),
        execution: ExecutionId::new(execution).unwrap(),
        occurrence: StructuralOccurrence {
            node: node.parse().unwrap(),
            map_indices: Vec::new(),
        },
        attempt: PositiveInteger::new(1).unwrap(),
        input: Value::Null,
        state: DurableExecutionState::Active,
    }
}

fn success(value: i64) -> WorkerOutcome {
    WorkerOutcome::Verified {
        output: json!({"value":value}),
        artifacts: Vec::new(),
    }
}

fn verdict(label: &str) -> WorkerOutcome {
    WorkerOutcome::Verifier {
        output: json!({}),
        signals: [(
            "verdict".parse().unwrap(),
            label.parse().unwrap(),
        )]
        .into_iter()
        .collect(),
        diagnostic: json!({}),
        artifacts: Vec::new(),
    }
}

fn reduce(graph: &VerifiedGraph, input: &Value, executions: &[DurableExecution]) -> Reduction {
    FullV1Reducer::new(graph)
        .reduce(ReductionInput {
            run: RunSequence::new(1).unwrap(),
            initial_input: input,
            executions,
            next_node_instance: executions
                .iter()
                .map(|execution| execution.node_instance.get())
                .max()
                .unwrap_or(0)
                + 1,
            next_execution: executions
                .iter()
                .map(|execution| execution.execution.get())
                .max()
                .unwrap_or(0)
                + 1,
        })
        .unwrap()
}

#[tokio::test]
async fn reducer_accepts_only_the_production_verifiers_verified_graph() {
    let graph: GraphSpec = serde_json::from_value(json!({
        "profile":"openengine.graph.full/v1",
        "initialInput":{"kind":"record","fields":{}},
        "policy":{"policy":"policy.test@1","default":"deny"},
        "root":sequence("root",vec![step("work",1),succeed("done")])
    }))
    .unwrap();
    let verified = ProductionGraphVerifier::new(TestWorkers)
        .verify(&graph)
        .await
        .unwrap();
    let reduction = reduce(&verified, &json!({}), &[]);
    assert!(reduction.decisions.iter().any(|decision| matches!(
        decision,
        Decision::Dispatch { occurrence, .. } if occurrence.node.as_str() == "work"
    )));
}

#[test]
fn step_verifier_seq_choice_succeed_and_fail_follow_authored_control() {
    let choice = json!({
        "kind":"choice", "name":"route", "state":{"kind":"record","fields":{}},
        "branches":[{
            "when":{"kind":"in","value":{"name":"check","source":"signal","field":"verdict"},"labels":["accepted"]},
            "node":succeed("accepted")
        }],
        "otherwise":{"kind":"fail","name":"rejected","reason":"verification_rejected"},
        "promotedStatePaths":[]
    });
    let graph = verified(
        sequence("root", vec![verifier("check", 1), choice]),
        json!({"check":1}),
    );
    let accepted = [settled(1, 1, "check", vec![], 1, 10, verdict("accepted"))];
    assert!(matches!(
        reduce(&graph, &json!({}), &accepted).terminal,
        Some(TerminalProjection::Succeeded { .. })
    ));
    let rejected = [settled(1, 1, "check", vec![], 1, 10, verdict("rejected"))];
    assert_eq!(
        reduce(&graph, &json!({}), &rejected).terminal,
        Some(TerminalProjection::Failed {
            reason: "verification_rejected".to_owned()
        })
    );

    let failed_step_graph = verified(
        sequence("root", vec![step("work", 1), succeed("done")]),
        json!({"work":1}),
    );
    let failed = [settled(
        1,
        1,
        "work",
        vec![],
        1,
        3,
        WorkerOutcome::declared_failure(openengine_cluster_protocol::WorkerErrorCode::Crash),
    )];
    let reduction = reduce(&failed_step_graph, &json!({}), &failed);
    assert!(matches!(
        reduction.terminal,
        Some(TerminalProjection::Succeeded { .. })
    ));
    assert!(!reduction
        .decisions
        .iter()
        .any(|decision| matches!(decision, Decision::Dispatch { .. })));
}

#[test]
fn parallel_any_uses_ledger_position_and_voids_only_active_losers() {
    let graph = verified(
        sequence(
            "root",
            vec![
                json!({
                    "kind":"par", "name":"race", "state":{"kind":"record","fields":{}},
                    "branches":[sequence("left_branch", vec![step("left",1),step("pruned",1)]),step("right",1)],
                    "promotedStatePaths":[], "join":{"kind":"any"}
                }),
                succeed("done"),
            ],
        ),
        json!({"left":1,"pruned":1,"right":1}),
    );
    let history = [active(1, 1, "left", 1), settled(2, 2, "right", vec![], 1, 4, success(2))];
    let reduction = reduce(&graph, &json!({}), &history);
    assert!(reduction.decisions.iter().any(|decision| matches!(
        decision,
        Decision::VoidLoser { execution, reason: ExecutionVoidReason::ParallelJoin, .. }
            if execution.get() == 1
    )));
    assert!(!reduction.decisions.iter().any(|decision| matches!(
        decision,
        Decision::Dispatch { occurrence, .. } if occurrence.node.as_str() == "pruned"
    )));
    assert!(matches!(
        reduction.terminal,
        Some(TerminalProjection::Succeeded { .. })
    ));
}

#[test]
fn all_any_quorum_and_first_use_exact_authored_join_rules() {
    for (join, expected_pending) in [
        (json!({"kind":"all"}), true),
        (json!({"kind":"any"}), false),
        (json!({"kind":"quorum","count":2}), true),
    ] {
        let graph = verified(
            sequence(
                "root",
                vec![
                    json!({
                        "kind":"par", "name":"join", "state":{"kind":"record","fields":{}},
                        "branches":[step("a",1),step("b",1)], "promotedStatePaths":[], "join":join
                    }),
                    succeed("done"),
                ],
            ),
            json!({"a":1,"b":1}),
        );
        let history = [settled(1, 1, "a", vec![], 1, 5, success(1)), active(2, 2, "b", 2)];
        assert_eq!(reduce(&graph, &json!({}), &history).terminal.is_none(), expected_pending);
    }

    let graph = verified(
        sequence(
            "root",
            vec![
                json!({
                    "kind":"par", "name":"first", "state":{"kind":"record","fields":{}},
                    "branches":[verifier("early",1),verifier("later",1)], "promotedStatePaths":[],
                    "join":{"kind":"first","when":{"kind":"in","value":{"name":"later","source":"signal","field":"verdict"},"labels":["accepted"]}}
                }),
                succeed("done"),
            ],
        ),
        json!({"early":1,"later":1}),
    );
    let history = [
        settled(1, 1, "early", vec![], 1, 2, verdict("rejected")),
        settled(2, 2, "later", vec![], 1, 7, verdict("accepted")),
    ];
    assert!(reduce(&graph, &json!({}), &history).terminal.is_some());
}

#[test]
fn bounded_do_while_reuses_occurrence_and_advances_positive_attempts() {
    let graph = verified(
        sequence(
            "root",
            vec![
                json!({
                    "kind":"loop", "name":"retry_loop", "state":{"kind":"record","fields":{}},
                    "body":verifier("check",2),
                    "until":{"kind":"in","value":{"name":"check","source":"signal","field":"verdict"},"labels":["accepted"]},
                    "maxIterations":2,"promotedStatePaths":[]
                }),
                succeed("done"),
            ],
        ),
        json!({"check":2}),
    );
    let first = settled(1, 1, "check", vec![], 1, 3, verdict("rejected"));
    let reduction = reduce(&graph, &json!({}), &[first.clone()]);
    assert!(reduction.decisions.iter().any(|decision| matches!(
        decision,
        Decision::Dispatch { node_instance, attempt, .. }
            if node_instance.get() == 1 && attempt.get() == 2
    )));
    let second = settled(2, 1, "check", vec![], 2, 6, verdict("accepted"));
    assert!(reduce(&graph, &json!({}), &[first, second]).terminal.is_some());
}

#[test]
fn map_is_input_ordered_total_and_assigns_stable_nested_indices() {
    let nested = json!({
        "kind":"map", "name":"outer_map", "state":{"kind":"record","fields":{}},
        "over":{"source":"state","path":["items"]}, "maxItems":3,"promotedStatePaths":[],
        "body":{
            "kind":"map", "name":"inner_map", "state":{"kind":"record","fields":{}},
            "over":{"source":"item","path":["inner"]}, "maxItems":3,"promotedStatePaths":[],
            "body":step("mapped",1)
        }
    });
    let graph = verified(sequence("root", vec![nested, succeed("done")]), json!({"mapped":1}));
    let reduction = reduce(
        &graph,
        &json!({"items":[{"inner":[{"v":1},{"v":2}]},{"inner":[{"v":3}]}]}),
        &[],
    );
    let indices = reduction
        .decisions
        .iter()
        .filter_map(|decision| match decision {
            Decision::Dispatch { occurrence, .. } => Some(occurrence.map_indices.clone()),
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(indices, vec![vec![0, 0], vec![0, 1], vec![1, 0]]);

    let empty = reduce(&graph, &json!({"items":[]}), &[]);
    assert!(empty.terminal.is_some());
}

#[test]
fn authored_frontier_and_bytes_ignore_history_container_order() {
    let graph = verified(
        sequence(
            "root",
            vec![
                json!({
                    "kind":"par", "name":"all", "state":{"kind":"record","fields":{}},
                    "branches":[step("left",1),step("right",1)],"promotedStatePaths":[],"join":{"kind":"all"}
                }),
                succeed("done"),
            ],
        ),
        json!({"left":1,"right":1}),
    );
    let left = settled(1, 1, "left", vec![], 1, 10, success(1));
    let right = settled(2, 2, "right", vec![], 1, 10, success(2));
    let first = reduce(&graph, &json!({}), &[left.clone(), right.clone()]);
    let second = reduce(&graph, &json!({}), &[right, left]);
    assert_eq!(
        first.canonical_decision_bytes().unwrap(),
        second.canonical_decision_bytes().unwrap()
    );
    assert_eq!(
        first.canonical_control_record_bytes().unwrap(),
        second.canonical_control_record_bytes().unwrap()
    );
}

#[test]
fn parallel_and_map_promotions_project_durable_values_in_logical_order() {
    let promoted_step = |name: &str| {
        json!({
            "kind":"step","name":name,"worker":"worker.test@1",
            "input":{"kind":"null"},
            "output":{"kind":"record","fields":{"value":{"type":{"kind":"integer"},"required":true}}},
            "inputBindings":[],
            "writeBindings":[{"value":{"node":name,"channel":"out","path":["value"]},"target":["result"]}],
            "timeoutMs":1,"attempts":1
        })
    };
    let par = json!({
        "kind":"par","name":"winner","state":{"kind":"record","fields":{}},
        "branches":[promoted_step("left"),promoted_step("right")],
        "promotedStatePaths":[["result"]],"join":{"kind":"any"}
    });
    let terminal = json!({
        "kind":"succeed","name":"done",
        "output":{"kind":"record","fields":{"result":{"type":{"kind":"integer"},"required":true}}},
        "bindings":[{"target":["result"],"value":{"source":"state","path":["result"]}}]
    });
    let graph = verified(sequence("root", vec![par, terminal]), json!({"left":1,"right":1}));
    let history = [
        settled(1,1,"left",vec![],1,8,success(7)),
        settled(2,2,"right",vec![],1,9,success(9)),
    ];
    assert_eq!(
        reduce(&graph, &json!({}), &history).terminal,
        Some(TerminalProjection::Succeeded { output: json!({"result":7}) })
    );

    let mapped = json!({
        "kind":"map","name":"items_map","state":{"kind":"record","fields":{}},
        "over":{"source":"state","path":["items"]},"maxItems":2,
        "promotedStatePaths":[["result"]],"body":promoted_step("mapped_value")
    });
    let mapped_terminal = json!({
        "kind":"succeed","name":"mapped_done",
        "output":{"kind":"record","fields":{"result":{"type":{"kind":"array","items":{"kind":"integer"}},"required":true}}},
        "bindings":[{"target":["result"],"value":{"source":"state","path":["result"]}}]
    });
    let map_graph = verified(
        sequence("map_root", vec![mapped, mapped_terminal]),
        json!({"mapped_value":1}),
    );
    let map_history = [
        settled(2,2,"mapped_value",vec![1],1,3,success(20)),
        settled(1,1,"mapped_value",vec![0],1,7,success(10)),
    ];
    assert_eq!(
        reduce(&map_graph, &json!({"items":[1,2]}), &map_history).terminal,
        Some(TerminalProjection::Succeeded { output: json!({"result":[10,20]}) })
    );
}
