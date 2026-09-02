use super::*;

#[tokio::test]
async fn bounded_do_while_reuses_occurrence_and_advances_positive_attempts() {
    let graph = verified(
        sequence(
            "root",
            vec![
                json!({
                    "kind":"loop", "name":"retry_loop", "state":{"kind":"record","fields":{}},
                    "body":verifier("check",2),
                    "until":{"kind":"in","value":{"name":"check","source":"signal",
                        "field":"verdict"},"labels":["accepted"]},
                    "maxIterations":2,"promotedStatePaths":[]
                }),
                succeed("done"),
            ],
        ),
        json!({"check":2}),
    )
    .await;
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
async fn native_v2_loop_reuses_node_instance_with_fresh_attempt_one_executions() {
    let graph = verified(
        sequence(
            "root",
            vec![
                json!({
                    "kind":"loop", "name":"native_loop", "state":{"kind":"record","fields":{}},
                    "body":verifier("check",1),
                    "until":{
                        "kind":"in",
                        "value":{"name":"check","source":"signal","field":"verdict"},
                        "labels":["accepted"]
                    },
                    "maxIterations":3,"promotedStatePaths":[]
                }),
                succeed("done"),
            ],
        ),
        json!({"check":1}),
    )
    .await;
    let first = settled(
        SettledSpec::new(1, 1, "check").position(3),
        verdict("rejected"),
    );
    let reduction = FullV1Reducer::native_v2(&graph)
        .reduce(ReductionInput {
            initial_input: &json!({}),
            executions: std::slice::from_ref(&first),
            next_node_instance: 2,
            next_execution: 2,
        })
        .assert_value();
    assert!(reduction.decisions.iter().any(|decision| matches!(
        decision,
        Decision::Dispatch { node_instance, execution, attempt, .. }
            if node_instance.get() == 1 && execution.get() == 2 && attempt.get() == 1
    )));

    let second = settled(
        SettledSpec::new(2, 1, "check").position(6),
        verdict("accepted"),
    );
    assert!(
        FullV1Reducer::native_v2(&graph)
            .reduce(ReductionInput {
                initial_input: &json!({}),
                executions: &[first, second],
                next_node_instance: 2,
                next_execution: 3,
            })
            .assert_value()
            .terminal
            .is_some()
    );
}

#[tokio::test]
async fn map_is_input_ordered_total_and_assigns_stable_nested_indices() {
    let state = required_array_record(&[("outerItems", "null"), ("innerItems", "null")]);
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
    *root.get_mut("state").assert_value() = state;
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
async fn repeated_map_items_do_not_restore_stale_sibling_controls() {
    let state = required_array_record(&[("items", "null")]);
    let mapped = json!({
        "kind":"map", "name":"reviews", "state":state.clone(),
        "over":{"source":"state","path":["items"]}, "maxItems":2,
        "promotedStatePaths":[], "body":verifier("check",1)
    });
    let route = json!({
        "kind":"choice", "name":"review_result", "state":state.clone(),
        "branches":[{
            "when":{
                "kind":"k_of_map", "count":2,
                "value":{"name":"check","source":"signal","field":"verdict"},
                "labels":["accepted"]
            },
            "node":succeed("done")
        }],
        "otherwise":step("repair",1), "promotedStatePaths":[]
    });
    let review_loop = json!({
        "kind":"loop", "name":"review_loop", "state":state.clone(),
        "body":{
            "kind":"seq", "name":"review_iteration", "state":state.clone(),
            "children":[mapped,route], "promotedStatePaths":[]
        },
        "maxIterations":3, "promotedStatePaths":[]
    });
    let mut root = sequence(
        "root",
        vec![
            review_loop,
            json!({"kind":"fail","name":"exhausted","reason":"exhausted"}),
        ],
    );
    *root.get_mut("state").assert_value() = state;
    let graph = verified(root, json!({"check":1})).await;
    let history = [
        settled(
            SettledSpec::new(1, 1, "check")
                .map_indices(vec![0])
                .position(2),
            verdict("rejected"),
        ),
        settled(
            SettledSpec::new(2, 2, "check")
                .map_indices(vec![1])
                .position(3),
            verdict("accepted"),
        ),
        settled(SettledSpec::new(3, 3, "repair").position(4), success(0)),
        settled(
            SettledSpec::new(4, 1, "check")
                .map_indices(vec![0])
                .position(8),
            verdict("accepted"),
        ),
        settled(
            SettledSpec::new(5, 2, "check")
                .map_indices(vec![1])
                .position(7),
            verdict("accepted"),
        ),
    ];

    assert!(matches!(
        FullV1Reducer::native_v2(&graph)
            .reduce(ReductionInput {
                initial_input: &json!({"items":[null,null]}),
                executions: &history,
                next_node_instance: 4,
                next_execution: 6,
            })
            .assert_value()
            .terminal,
        Some(TerminalProjection::Succeeded { .. })
    ));
}

#[tokio::test]
async fn authored_frontier_and_bytes_ignore_history_container_order() {
    let graph = verified_parallel_sequence(ParallelSequenceSpec {
        root_name: "root",
        parallel_name: "all",
        branches: vec![step("left", 1), step("right", 1)],
        join: json!({"kind":"all"}),
        terminal_name: "done",
        attempts: json!({"left":1,"right":1}),
    })
    .await;
    let left = settled(SettledSpec::new(1, 1, "left").position(10), success(1));
    let right = settled(SettledSpec::new(2, 2, "right").position(10), success(2));
    let first = reduce(&graph, &json!({}), &[left.clone(), right.clone()]);
    let second = reduce(&graph, &json!({}), &[right, left]);
    assert_eq!(
        first.canonical_decision_bytes().assert_value(),
        second.canonical_decision_bytes().assert_value()
    );
    assert_eq!(
        first.canonical_decision_bytes().assert_value(),
        second.canonical_decision_bytes().assert_value()
    );
}

use openengine_cluster_testkit::assertions::{AssertValue};
