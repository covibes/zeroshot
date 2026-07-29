use async_trait::async_trait;
use openengine_cluster_protocol::{
    GraphSpec, PositiveInteger, WorkerDescriptor, WorkerOutcome, WorkerRef,
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
    Decision, DurableExecution, DurableExecutionState, FullV1Reducer, ReducerError, Reduction,
    ReductionInput, TerminalProjection,
};

struct TestWorkers;

#[async_trait]
impl WorkerRegistry for TestWorkers {
    async fn resolve(&self, worker: &WorkerRef) -> Result<WorkerDescriptor, WorkerRegistryError> {
        let verifier = (worker.as_str() == "worker.verify@1").then(|| {
            json!({
                "signals":{"verdict":["accepted","rejected"]},
                "diagnostic":{"kind":"record","fields":{}}
            })
        });
        let output = if verifier.is_some() {
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
                "input":{"kind":"null"},
                "output":output,
                "verifier":verifier,
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

async fn verified(root: Value, _attempts: Value) -> VerifiedGraph {
    let initial_input = root
        .get("state")
        .cloned()
        .unwrap_or_else(|| json!({"kind":"record","fields":{}}));
    let graph: GraphSpec = serde_json::from_value(json!({
        "profile": "openengine.graph.full/v1",
        "initialInput": initial_input,
        "policy": {"policy":"policy.test@1","default":"deny"},
        "root": root
    }))
    .unwrap();
    ProductionGraphVerifier::new(TestWorkers)
        .verify(&graph)
        .await
        .unwrap()
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

struct SettledSpec<'a> {
    execution: u64,
    node_instance: u64,
    node: &'a str,
    map_indices: Vec<u64>,
    attempt: u64,
    position: u64,
}

impl<'a> SettledSpec<'a> {
    fn new(execution: u64, node_instance: u64, node: &'a str) -> Self {
        Self {
            execution,
            node_instance,
            node,
            map_indices: Vec::new(),
            attempt: 1,
            position: 1,
        }
    }

    fn map_indices(mut self, map_indices: Vec<u64>) -> Self {
        self.map_indices = map_indices;
        self
    }

    fn attempt(mut self, attempt: u64) -> Self {
        self.attempt = attempt;
        self
    }

    fn position(mut self, position: u64) -> Self {
        self.position = position;
        self
    }
}

fn settled(spec: SettledSpec<'_>, outcome: WorkerOutcome) -> DurableExecution {
    DurableExecution {
        run: RunSequence::new(1).unwrap(),
        dispatch_position: Position::new(spec.position.saturating_sub(1)).unwrap(),
        node_instance: NodeInstanceId::new(spec.node_instance).unwrap(),
        execution: ExecutionId::new(spec.execution).unwrap(),
        occurrence: StructuralOccurrence {
            node: spec.node.parse().unwrap(),
            map_indices: spec.map_indices,
        },
        attempt: PositiveInteger::new(spec.attempt).unwrap(),
        input: Value::Null,
        state: DurableExecutionState::Settled {
            position: Position::new(spec.position).unwrap(),
            outcome,
        },
    }
}

fn active(execution: u64, node_instance: u64, node: &str, position: u64) -> DurableExecution {
    DurableExecution {
        run: RunSequence::new(1).unwrap(),
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
        signals: [("verdict".parse().unwrap(), label.parse().unwrap())]
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

#[tokio::test]
async fn step_verifier_seq_choice_succeed_and_fail_follow_authored_control() {
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
    )
    .await;
    let accepted = [settled(
        SettledSpec::new(1, 1, "check").position(10),
        verdict("accepted"),
    )];
    assert!(matches!(
        reduce(&graph, &json!({}), &accepted).terminal,
        Some(TerminalProjection::Succeeded { .. })
    ));
    let rejected = [settled(
        SettledSpec::new(1, 1, "check").position(10),
        verdict("rejected"),
    )];
    assert_eq!(
        reduce(&graph, &json!({}), &rejected).terminal,
        Some(TerminalProjection::Failed {
            reason: "verification_rejected".to_owned()
        })
    );

    let failed_step_graph = verified(
        sequence("root", vec![step("work", 1), succeed("done")]),
        json!({"work":1}),
    )
    .await;
    let failed = [settled(
        SettledSpec::new(1, 1, "work").position(3),
        WorkerOutcome::declared_failure(openengine_cluster_protocol::WorkerErrorCode::Crash),
    )];
    let reduction = reduce(&failed_step_graph, &json!({}), &failed);
    assert!(matches!(
        reduction.terminal,
        Some(TerminalProjection::Succeeded { .. })
    ));
    assert!(
        !reduction
            .decisions
            .iter()
            .any(|decision| matches!(decision, Decision::Dispatch { .. }))
    );
}

#[tokio::test]
async fn parallel_any_uses_ledger_position_and_voids_only_active_losers() {
    let graph = verified(sequence(
        "root",
        vec![
            json!({
                "kind":"par", "name":"race", "state":{"kind":"record","fields":{}},
                "branches":[sequence("left_branch", vec![step("left",1),step("pruned",1)]),step("right",1)],
                "promotedStatePaths":[], "join":{"kind":"any"}
            }),
            succeed("done"),
        ],
    ), json!({"left":1,"pruned":1,"right":1})).await;
    let history = [
        active(1, 1, "left", 1),
        settled(SettledSpec::new(2, 2, "right").position(4), success(2)),
    ];
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

#[tokio::test]
async fn all_any_quorum_and_first_use_exact_authored_join_rules() {
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
        )
        .await;
        let history = [
            settled(SettledSpec::new(1, 1, "a").position(5), success(1)),
            active(2, 2, "b", 2),
        ];
        assert_eq!(
            reduce(&graph, &json!({}), &history).terminal.is_none(),
            expected_pending
        );
    }

    let graph = verified(sequence(
        "root",
        vec![
            json!({
                "kind":"par", "name":"first", "state":{"kind":"record","fields":{}},
                "branches":[verifier("early",1),verifier("later",1)], "promotedStatePaths":[],
                "join":{"kind":"first","when":{"kind":"in","value":{"name":"later","source":"signal","field":"verdict"},"labels":["accepted"]}}
            }),
            succeed("done"),
        ],
    ), json!({"early":1,"later":1})).await;
    let history = [
        settled(
            SettledSpec::new(1, 1, "early").position(2),
            verdict("rejected"),
        ),
        settled(
            SettledSpec::new(2, 2, "later").position(7),
            verdict("accepted"),
        ),
    ];
    assert!(reduce(&graph, &json!({}), &history).terminal.is_some());
}

#[tokio::test]
async fn bounded_do_while_reuses_occurrence_and_advances_positive_attempts() {
    let graph = verified(sequence(
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
    ), json!({"check":2})).await;
    let first = settled(
        SettledSpec::new(1, 1, "check").position(3),
        verdict("rejected"),
    );
    let reduction = reduce(&graph, &json!({}), std::slice::from_ref(&first));
    assert!(reduction.decisions.iter().any(|decision| matches!(
        decision,
        Decision::Dispatch { node_instance, attempt, .. }
            if node_instance.get() == 1 && attempt.get() == 2
    )));
    let second = settled(
        SettledSpec::new(2, 1, "check").attempt(2).position(6),
        verdict("accepted"),
    );
    assert!(
        reduce(&graph, &json!({}), &[first, second])
            .terminal
            .is_some()
    );
}

#[tokio::test]
async fn map_is_input_ordered_total_and_assigns_stable_nested_indices() {
    let state = json!({
        "kind":"record",
        "fields":{
            "outerItems":{"type":{"kind":"array","items":{"kind":"null"}},"required":true},
            "innerItems":{"type":{"kind":"array","items":{"kind":"null"}},"required":true}
        }
    });
    let nested = json!({
        "kind":"map", "name":"outer_map", "state":state.clone(),
        "over":{"source":"state","path":["outerItems"]}, "maxItems":3,"promotedStatePaths":[],
        "body":{
            "kind":"map", "name":"inner_map", "state":state.clone(),
            "over":{"source":"state","path":["innerItems"]}, "maxItems":3,"promotedStatePaths":[],
            "body":step("mapped",1)
        }
    });
    let mut root = sequence("root", vec![nested, succeed("done")]);
    root["state"] = state;
    let graph = verified(root, json!({"mapped":1})).await;
    let reduction = reduce(
        &graph,
        &json!({"outerItems":[null,null],"innerItems":[null,null]}),
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
    assert_eq!(
        indices,
        vec![vec![0, 0], vec![0, 1], vec![1, 0], vec![1, 1]]
    );

    let empty = reduce(
        &graph,
        &json!({"outerItems":[],"innerItems":[null,null]}),
        &[],
    );
    assert!(empty.terminal.is_some());
}

#[tokio::test]
async fn authored_frontier_and_bytes_ignore_history_container_order() {
    let graph = verified(sequence(
        "root",
        vec![
            json!({
                "kind":"par", "name":"all", "state":{"kind":"record","fields":{}},
                "branches":[step("left",1),step("right",1)],"promotedStatePaths":[],"join":{"kind":"all"}
            }),
            succeed("done"),
        ],
    ), json!({"left":1,"right":1})).await;
    let left = settled(SettledSpec::new(1, 1, "left").position(10), success(1));
    let right = settled(SettledSpec::new(2, 2, "right").position(10), success(2));
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

#[tokio::test]
async fn parallel_and_map_promotions_project_durable_values_in_logical_order() {
    let promoted_step = |name: &str, target: &str| {
        json!({
            "kind":"step","name":name,"worker":"worker.test@1",
            "input":{"kind":"null"},
            "output":{"kind":"record","fields":{"value":{"type":{"kind":"integer"},"required":true}}},
            "inputBindings":[],
            "writeBindings":[{"value":{"node":name,"channel":"out","path":["value"]},"target":[target]}],
            "timeoutMs":1,"attempts":1
        })
    };
    let parallel_state = json!({
        "kind":"record",
        "fields":{"result":{"type":{"kind":"integer"},"required":true}}
    });
    let par = json!({
        "kind":"par","name":"winner","state":parallel_state.clone(),
        "branches":[promoted_step("left","result"),promoted_step("right","result")],
        "promotedStatePaths":[["result"]],"join":{"kind":"any"}
    });
    let terminal = json!({
        "kind":"succeed","name":"done",
        "output":{"kind":"record","fields":{"result":{"type":{"kind":"integer"},"required":true}}},
        "bindings":[{"target":["result"],"value":{"source":"state","path":["result"]}}]
    });
    let mut parallel_root = sequence("root", vec![par, terminal]);
    parallel_root["state"] = parallel_state;
    let graph = verified(parallel_root, json!({"left":1,"right":1})).await;
    let history = [
        settled(SettledSpec::new(1, 1, "left").position(10), success(7)),
        settled(SettledSpec::new(2, 2, "right").position(8), success(9)),
    ];
    assert_eq!(
        reduce(&graph, &json!({}), &history).terminal,
        Some(TerminalProjection::Succeeded {
            output: json!({"result":9})
        })
    );

    let map_state = json!({
        "kind":"record",
        "fields":{
            "items":{"type":{"kind":"array","items":{"kind":"null"}},"required":true},
            "results":{"type":{"kind":"array","items":{"kind":"integer"}},"required":true}
        }
    });
    let mapped = json!({
        "kind":"map","name":"items_map","state":map_state.clone(),
        "over":{"source":"state","path":["items"]},"maxItems":2,
        "promotedStatePaths":[["results"]],"body":promoted_step("mapped_value","results")
    });
    let mapped_terminal = json!({
        "kind":"succeed","name":"mapped_done",
        "output":{"kind":"record","fields":{"results":{"type":{"kind":"array","items":{"kind":"integer"}},"required":true}}},
        "bindings":[{"target":["results"],"value":{"source":"state","path":["results"]}}]
    });
    let mut map_root = sequence("map_root", vec![mapped, mapped_terminal]);
    map_root["state"] = map_state;
    let map_graph = verified(map_root, json!({"mapped_value":1})).await;
    let map_history = [
        settled(
            SettledSpec::new(2, 2, "mapped_value")
                .map_indices(vec![1])
                .position(3),
            success(20),
        ),
        settled(
            SettledSpec::new(1, 1, "mapped_value")
                .map_indices(vec![0])
                .position(7),
            success(10),
        ),
    ];
    let map_reduction = reduce(&map_graph, &json!({"items":[1,2]}), &map_history);
    assert_eq!(
        map_reduction.terminal,
        Some(TerminalProjection::Succeeded {
            output: json!({"results":[10,20]})
        })
    );
    let scopes = map_reduction
        .decisions
        .iter()
        .filter_map(|decision| match decision {
            Decision::Promote {
                node, map_indices, ..
            } if node.as_str() == "mapped_value" => Some(map_indices.clone()),
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(scopes, vec![vec![0], vec![1]]);
}

#[tokio::test]
async fn late_parallel_losers_are_voided_in_canonical_dispatch_order() {
    let graph = verified(
        sequence(
            "root",
            vec![
                json!({
                    "kind":"par","name":"race","state":{"kind":"record","fields":{}},
                    "branches":[step("left",1),step("middle",1),step("winner",1)],
                    "promotedStatePaths":[],"join":{"kind":"any"}
                }),
                succeed("done"),
            ],
        ),
        json!({"left":1,"middle":1,"winner":1}),
    )
    .await;
    let history = [
        active(1, 1, "left", 9),
        settled(SettledSpec::new(2, 2, "winner").position(4), success(7)),
        active(3, 3, "middle", 6),
    ];
    let reduction = reduce(&graph, &json!({}), &history);
    let voids = reduction
        .decisions
        .iter()
        .filter_map(|decision| match decision {
            Decision::VoidLoser { execution, .. } => Some(execution.get()),
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(voids, vec![3, 1]);

    let frontier_graph = verified(
        sequence(
            "frontier_root",
            vec![
                json!({
                    "kind":"par","name":"frontier_race","state":{"kind":"record","fields":{}},
                    "branches":[step("frontier_loser",2),step("frontier_winner",1)],
                    "promotedStatePaths":[],"join":{"kind":"any"}
                }),
                succeed("frontier_done"),
            ],
        ),
        json!({"frontier_loser":2,"frontier_winner":1}),
    )
    .await;
    let loser = settled(
        SettledSpec::new(1, 1, "frontier_loser").position(12),
        success(1),
    );
    let mut unreachable_attempt = active(2, 1, "frontier_loser", 14);
    unreachable_attempt.attempt = PositiveInteger::new(2).unwrap();
    let winner = settled(
        SettledSpec::new(3, 2, "frontier_winner").position(10),
        success(2),
    );
    let invalid_history = [loser, unreachable_attempt, winner];
    assert_eq!(
        FullV1Reducer::new(&frontier_graph)
            .reduce(ReductionInput {
                run: RunSequence::new(1).unwrap(),
                initial_input: &json!({}),
                executions: &invalid_history,
                next_node_instance: 3,
                next_execution: 4,
            })
            .unwrap_err(),
        ReducerError::InconsistentHistory
    );
}

#[tokio::test]
async fn map_terminal_is_lazy_and_voids_late_active_items() {
    let state = json!({
        "kind":"record",
        "fields":{"items":{"type":{"kind":"array","items":{"kind":"null"}},"required":true}}
    });
    let body = json!({
        "kind":"seq","name":"item_body","state":state.clone(),
        "children":[step("mapped_work",1),succeed("item_done")],
        "promotedStatePaths":[]
    });
    let mapped = json!({
        "kind":"map","name":"mapped","state":state.clone(),
        "over":{"source":"state","path":["items"]},"maxItems":2,
        "body":body,"promotedStatePaths":[]
    });
    let mut root = sequence("root", vec![mapped, succeed("empty_done")]);
    root["state"] = state;
    let graph = verified(root, json!({"mapped_work":1})).await;
    let winner = settled(
        SettledSpec::new(1, 1, "mapped_work")
            .map_indices(vec![0])
            .position(4),
        success(1),
    );
    let mut loser = active(2, 2, "mapped_work", 10);
    loser.occurrence.map_indices = vec![1];
    let reduction = reduce(&graph, &json!({"items":[null,null]}), &[loser, winner]);
    assert!(reduction.terminal.is_some());
    assert!(reduction.decisions.iter().any(|decision| matches!(
        decision,
        Decision::VoidLoser { execution, reason: ExecutionVoidReason::MapTerminal, .. }
            if execution.get() == 2
    )));
    assert!(!reduction.decisions.iter().any(|decision| matches!(
        decision,
        Decision::Dispatch { occurrence, .. } if occurrence.map_indices == [1]
    )));

    let nested_state = json!({
        "kind":"record",
        "fields":{
            "outerItems":{"type":{"kind":"array","items":{"kind":"null"}},"required":true},
            "innerItems":{"type":{"kind":"array","items":{"kind":"null"}},"required":true}
        }
    });
    let inner_body = json!({
        "kind":"seq","name":"nested_item_body","state":nested_state.clone(),
        "children":[step("nested_work",1),succeed("nested_item_done")],
        "promotedStatePaths":[]
    });
    let inner = json!({
        "kind":"map","name":"inner_terminal_map","state":nested_state.clone(),
        "over":{"source":"state","path":["innerItems"]},"maxItems":2,
        "body":inner_body,"promotedStatePaths":[]
    });
    let outer = json!({
        "kind":"map","name":"outer_terminal_map","state":nested_state.clone(),
        "over":{"source":"state","path":["outerItems"]},"maxItems":1,
        "body":inner,"promotedStatePaths":[]
    });
    let mut nested_root = sequence("nested_root", vec![outer, succeed("nested_empty_done")]);
    nested_root["state"] = nested_state;
    let nested_graph = verified(nested_root, json!({"nested_work":1})).await;
    let nested_winner = settled(
        SettledSpec::new(1, 1, "nested_work")
            .map_indices(vec![0, 0])
            .position(4),
        success(1),
    );
    let mut nested_loser = active(2, 2, "nested_work", 10);
    nested_loser.occurrence.map_indices = vec![0, 1];
    let nested_reduction = reduce(
        &nested_graph,
        &json!({"outerItems":[null],"innerItems":[null,null]}),
        &[nested_loser, nested_winner],
    );
    assert_eq!(
        nested_reduction
            .decisions
            .iter()
            .filter(|decision| matches!(
                decision,
                Decision::VoidLoser { execution, .. } if execution.get() == 2
            ))
            .count(),
        1
    );
}

#[tokio::test]
async fn executable_write_promotions_are_one_scoped_authored_batch() {
    let state = json!({
        "kind":"record",
        "fields":{
            "a":{"type":{"kind":"integer"},"required":true},
            "b":{"type":{"kind":"integer"},"required":true}
        }
    });
    let work = json!({
        "kind":"step","name":"work","worker":"worker.multi@1",
        "input":{"kind":"null"},"output":state.clone(),
        "inputBindings":[],
        "writeBindings":[
            {"value":{"node":"work","channel":"out","path":["a"]},"target":["a"]},
            {"value":{"node":"work","channel":"out","path":["b"]},"target":["b"]}
        ],
        "timeoutMs":1,"attempts":1
    });
    let terminal = json!({
        "kind":"succeed","name":"done","output":state.clone(),
        "bindings":[
            {"target":["a"],"value":{"source":"state","path":["a"]}},
            {"target":["b"],"value":{"source":"state","path":["b"]}}
        ]
    });
    let mut root = sequence("root", vec![work, terminal]);
    root["state"] = state;
    let graph = verified(root, json!({"work":1})).await;
    let history = [settled(
        SettledSpec::new(1, 1, "work").position(3),
        WorkerOutcome::Verified {
            output: json!({"a":1,"b":2}),
            artifacts: Vec::new(),
        },
    )];
    let reduction = reduce(&graph, &json!({}), &history);
    let promotions = reduction
        .decisions
        .iter()
        .filter_map(|decision| match decision {
            Decision::Promote {
                node,
                map_indices,
                values,
            } if node.as_str() == "work" => Some((map_indices, values)),
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(promotions.len(), 1);
    assert!(promotions[0].0.is_empty());
    assert_eq!(
        promotions[0]
            .1
            .iter()
            .map(|value| value.path.segments()[0].as_str())
            .collect::<Vec<_>>(),
        vec!["a", "b"]
    );
}

#[tokio::test]
async fn exhaustive_determinism_across_inputs_positions_permutations_and_environment_hints() {
    let state = json!({
        "kind":"record",
        "fields":{
            "seed":{"type":{"kind":"integer"},"required":true},
            "result":{"type":{"kind":"integer"},"required":true}
        }
    });
    let promoted_step = |name: &str| {
        json!({
            "kind":"step","name":name,"worker":"worker.test@1",
            "input":{"kind":"null"},
            "output":{"kind":"record","fields":{"value":{"type":{"kind":"integer"},"required":true}}},
            "inputBindings":[],
            "writeBindings":[{
                "value":{"node":name,"channel":"out","path":["value"]},
                "target":["result"]
            }],
            "timeoutMs":1,"attempts":1
        })
    };
    let parallel = json!({
        "kind":"par","name":"property_race","state":state.clone(),
        "branches":[promoted_step("property_left"),promoted_step("property_right")],
        "promotedStatePaths":[["result"]],"join":{"kind":"any"}
    });
    let terminal = json!({
        "kind":"succeed","name":"property_done",
        "output":{"kind":"record","fields":{
            "result":{"type":{"kind":"integer"},"required":true}
        }},
        "bindings":[{
            "target":["result"],"value":{"source":"state","path":["result"]}
        }]
    });
    let mut root = sequence("property_root", vec![parallel, terminal]);
    root["state"] = state;
    let graph = verified(root, json!({"property_left":1,"property_right":1})).await;

    for seed in -2_i64..=2 {
        let initial_input = json!({"seed":seed,"result":0});
        let left_value = seed * 10 + 1;
        let right_value = seed * 10 + 2;
        let mut observed_left = false;
        let mut observed_right = false;
        for left_position in 2_u64..=5 {
            for right_position in 2_u64..=5 {
                if left_position == right_position {
                    continue;
                }
                let left = settled(
                    SettledSpec::new(1, 1, "property_left").position(left_position),
                    success(left_value),
                );
                let right = settled(
                    SettledSpec::new(2, 2, "property_right").position(right_position),
                    success(right_value),
                );
                let expected = if left_position < right_position {
                    observed_left = true;
                    left_value
                } else {
                    observed_right = true;
                    right_value
                };
                let histories = [vec![left.clone(), right.clone()], vec![right, left]];
                let mut baseline = None;
                for history in histories {
                    for capacity_hint in [1_usize, 2, 16] {
                        for timing_hint in [0_u64, 1, 1_000] {
                            assert!(capacity_hint > 0);
                            let _irrelevant_timing = timing_hint;
                            let reduction = reduce(&graph, &initial_input, &history);
                            assert_eq!(
                                reduction.terminal,
                                Some(TerminalProjection::Succeeded {
                                    output: json!({"result":expected})
                                })
                            );
                            let bytes = (
                                reduction.canonical_decision_bytes().unwrap(),
                                reduction.canonical_control_record_bytes().unwrap(),
                            );
                            if let Some(expected_bytes) = &baseline {
                                assert_eq!(&bytes, expected_bytes);
                            } else {
                                baseline = Some(bytes);
                            }
                        }
                    }
                }
            }
        }
        assert!(observed_left && observed_right);
    }
}
