use super::*;

#[tokio::test]
async fn parallel_and_map_promotions_project_durable_values_in_logical_order() {
    assert_parallel_promotion().await;
    assert_map_promotion().await;
}

async fn assert_parallel_promotion() {
    let parallel_state = json!({
        "kind":"record",
        "fields":{"result":{"type":{"kind":"integer"},"required":true}}
    });
    let par = json!({
        "kind":"par","name":"winner","state":parallel_state.clone(),
        "branches":[promoted_integer_step("left","result"),promoted_integer_step("right","result")],
        "promotedStatePaths":[["result"]],"join":{"kind":"any"}
    });
    let terminal = json!({
        "kind":"succeed","name":"done",
        "output":{"kind":"record","fields":{"result":{"type":{"kind":"integer"},"required":true}}},
        "bindings":[{"target":["result"],"value":{"source":"state","path":["result"]}}]
    });
    let mut parallel_root = sequence("root", vec![par, terminal]);
    *parallel_root.get_mut("state").assert_value() = parallel_state;
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
}

#[tokio::test]
async fn parallel_all_merges_disjoint_descendants_of_one_promoted_record() {
    let state = json!({
        "kind":"record",
        "fields":{
            "feedback":{"type":{
                "kind":"record",
                "fields":{
                    "left":{"type":{"kind":"integer"},"required":true},
                    "right":{"type":{"kind":"integer"},"required":true}
                }
            },"required":true}
        }
    });
    let parallel = json!({
        "kind":"par","name":"reviews","state":state.clone(),
        "branches":[
            promoted_integer_step_at_path("left_review", &["feedback", "left"]),
            promoted_integer_step_at_path("right_review", &["feedback", "right"])
        ],
        "promotedStatePaths":[["feedback"]],
        "join":{"kind":"all"}
    });
    let terminal = json!({
        "kind":"succeed","name":"done","output":state.clone(),
        "bindings":[
            {"target":["feedback"],"value":{"source":"state","path":["feedback"]}}
        ]
    });
    let seed = json!({
        "kind":"step","name":"seed","worker":"worker.multi@1",
        "input":{"kind":"null"},"output":{
            "kind":"record","fields":{
                "a":{"type":{"kind":"integer"},"required":true},
                "b":{"type":{"kind":"integer"},"required":true}
            }
        },"inputBindings":[],
        "writeBindings":[
            {"value":{"node":"seed","channel":"out","path":["a"]},
             "target":["feedback","left"]},
            {"value":{"node":"seed","channel":"out","path":["b"]},
             "target":["feedback","right"]}
        ],
        "timeoutMs":1,"attempts":1
    });
    let mut root = sequence("root", vec![seed, parallel, terminal]);
    *root.get_mut("state").assert_value() = state;
    let graph = verified(root, json!({"seed":1,"left_review":1,"right_review":1})).await;
    let history = [
        settled(
            SettledSpec::new(1, 1, "seed").position(1),
            WorkerOutcome::Verified {
                output: json!({"a":1,"b":2}),
                artifacts: Vec::new(),
            },
        ),
        settled(
            SettledSpec::new(2, 2, "left_review").position(2),
            success(7),
        ),
        settled(
            SettledSpec::new(3, 3, "right_review").position(3),
            success(9),
        ),
    ];

    assert_eq!(
        reduce(&graph, &json!({}), &history).terminal,
        Some(TerminalProjection::Succeeded {
            output: json!({"feedback":{"left":7,"right":9}})
        })
    );
}

async fn assert_map_promotion() {
    let map_state = required_array_record(&[("items", "null"), ("results", "integer")]);
    let mapped = json!({
        "kind":"map","name":"items_map","state":map_state.clone(),
        "over":{"source":"state","path":["items"]},"maxItems":2,
        "promotedStatePaths":[["results"]],"body":promoted_integer_step("mapped_value","results")
    });
    let mapped_terminal = json!({
        "kind":"succeed","name":"mapped_done",
        "output":{"kind":"record","fields":{
            "results":{
                "type":{"kind":"array","items":{"kind":"integer"}},
                "required":true
            }
        }},
        "bindings":[{"target":["results"],"value":{"source":"state","path":["results"]}}]
    });
    let mut map_root = sequence("map_root", vec![mapped, mapped_terminal]);
    *map_root.get_mut("state").assert_value() = map_state;
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

    let frontier_graph = verified_parallel_sequence(ParallelSequenceSpec {
        root_name: "frontier_root",
        parallel_name: "frontier_race",
        branches: vec![step("frontier_loser", 2), step("frontier_winner", 1)],
        join: json!({"kind":"any"}),
        terminal_name: "frontier_done",
        attempts: json!({"frontier_loser":2,"frontier_winner":1}),
    })
    .await;
    let loser = settled(
        SettledSpec::new(1, 1, "frontier_loser").position(12),
        success(1),
    );
    let mut unreachable_attempt = active(2, 1, "frontier_loser", 14);
    unreachable_attempt.attempt = PositiveInteger::new(2).assert_value();
    let winner = settled(
        SettledSpec::new(3, 2, "frontier_winner").position(10),
        success(2),
    );
    let invalid_history = [loser, unreachable_attempt, winner];
    assert_eq!(
        FullV1Reducer::new(&frontier_graph)
            .reduce(ReductionInput {
                initial_input: &json!({}),
                executions: &invalid_history,
                next_node_instance: 3,
                next_execution: 4,
            })
            .assert_error(),
        ReducerError::InconsistentHistory
    );
}

#[tokio::test]
async fn map_terminal_is_lazy_and_voids_late_active_items() {
    assert_flat_map_terminal().await;
    assert_nested_map_terminal().await;
}

async fn assert_flat_map_terminal() {
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
    *root.get_mut("state").assert_value() = state;
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
}

async fn assert_nested_map_terminal() {
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
    *nested_root.get_mut("state").assert_value() = nested_state;
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
    *root.get_mut("state").assert_value() = state;
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
    assert!(promotions.assert_at(0).0.is_empty());
    assert_eq!(
        promotions
            .assert_at(0)
            .1
            .iter()
            .map(|value| value.path.segments().assert_at(0).as_str())
            .collect::<Vec<_>>(),
        vec!["a", "b"]
    );
}

use openengine_cluster_testkit::assertions::{AssertAt, AssertError, AssertValue};
