use super::*;

#[tokio::test]
async fn nested_parallel_void_provenance_is_owned_during_outer_map_probing() {
    let graph = nested_void_graph().await;
    assert_inner_parallel_void(&graph);
    assert_post_prune_void(&graph);
}

async fn nested_void_graph() -> VerifiedGraph {
    let inner_parallel = json!({
        "kind":"par","name":"nested_inner_race","state":boundary_state(),
        "branches":[step("nested_inner_loser",1),step("nested_inner_winner",1)],
        "promotedStatePaths":[],"join":{"kind":"any"}
    });
    let map_body = json!({
        "kind":"seq","name":"nested_item_body","state":boundary_state(),
        "children":[inner_parallel,step("nested_after_inner",1),succeed("nested_item_done")],
        "promotedStatePaths":[]
    });
    let nested_map = json!({
        "kind":"map","name":"nested_outer_map","state":boundary_state(),
        "over":{"source":"state","path":["items"]},"maxItems":2,
        "body":map_body,"promotedStatePaths":[]
    });
    verified(
        seq(vec![nested_map, succeed("nested_empty_done")]),
        json!({
            "nested_inner_loser":1,
            "nested_inner_winner":1,
            "nested_after_inner":1
        }),
    )
    .await
}

fn assert_inner_parallel_void(graph: &VerifiedGraph) {
    let mut inner_loser = execution(
        ExecutionSpec::new(1, 1, "nested_inner_loser")
            .indices(vec![0])
            .settled_at(2),
        success(),
    );
    inner_loser.state = DurableExecutionState::Voided {
        position: HistoryPosition::new(4).assert_value(),
        reason: ExecutionVoidReason::ParallelJoin,
    };
    let item_zero_inner_winner = execution(
        ExecutionSpec::new(2, 2, "nested_inner_winner")
            .indices(vec![0])
            .settled_at(3),
        success(),
    );
    let item_one_inner_winner = execution(
        ExecutionSpec::new(3, 3, "nested_inner_winner")
            .indices(vec![1])
            .settled_at(6),
        success(),
    );
    let item_one_terminal = execution(
        ExecutionSpec::new(4, 4, "nested_after_inner")
            .indices(vec![1])
            .settled_at(8),
        success(),
    );
    let history = [
        inner_loser.clone(),
        item_zero_inner_winner.clone(),
        item_one_inner_winner.clone(),
        item_one_terminal.clone(),
    ];
    let reduction = FullV1Reducer::new(graph)
        .reduce(input(&json!({"items":[null,null]}), &history))
        .assert_value();
    assert!(reduction.terminal.is_some());
    assert!(!reduction.decisions.iter().any(|decision| {
        matches!(
            decision,
            Decision::VoidLoser { execution, .. } if *execution == inner_loser.execution
        )
    }));

    let mut wrong_reason = inner_loser;
    wrong_reason.state = DurableExecutionState::Voided {
        position: HistoryPosition::new(4).assert_value(),
        reason: ExecutionVoidReason::MapTerminal,
    };
    assert_eq!(
        FullV1Reducer::new(graph)
            .reduce(input(
                &json!({"items":[null,null]}),
                &[
                    wrong_reason,
                    item_zero_inner_winner,
                    item_one_inner_winner,
                    item_one_terminal,
                ],
            ))
            .assert_error(),
        ReducerError::InconsistentHistory
    );
}

fn assert_post_prune_void(graph: &VerifiedGraph) {
    let mut post_prune_inner_loser = execution(
        ExecutionSpec::new(5, 5, "nested_inner_loser")
            .indices(vec![0])
            .settled_at(15),
        success(),
    );
    post_prune_inner_loser.state = DurableExecutionState::Voided {
        position: HistoryPosition::new(22).assert_value(),
        reason: ExecutionVoidReason::ParallelJoin,
    };
    let late_item_zero_inner_winner = execution(
        ExecutionSpec::new(6, 6, "nested_inner_winner")
            .indices(vec![0])
            .settled_at(20),
        success(),
    );
    let early_item_one_inner_winner = execution(
        ExecutionSpec::new(7, 7, "nested_inner_winner")
            .indices(vec![1])
            .settled_at(16),
        success(),
    );
    let early_item_one_terminal = execution(
        ExecutionSpec::new(8, 8, "nested_after_inner")
            .indices(vec![1])
            .settled_at(18),
        success(),
    );
    assert_eq!(
        FullV1Reducer::new(graph)
            .reduce(input(
                &json!({"items":[null,null]}),
                &[
                    post_prune_inner_loser.clone(),
                    late_item_zero_inner_winner.clone(),
                    early_item_one_inner_winner.clone(),
                    early_item_one_terminal.clone(),
                ],
            ))
            .assert_error(),
        ReducerError::InconsistentHistory
    );

    post_prune_inner_loser.state = DurableExecutionState::Voided {
        position: HistoryPosition::new(22).assert_value(),
        reason: ExecutionVoidReason::MapTerminal,
    };
    let post_prune_execution = post_prune_inner_loser.execution;
    let reduction = FullV1Reducer::new(graph)
        .reduce(input(
            &json!({"items":[null,null]}),
            &[
                post_prune_inner_loser,
                late_item_zero_inner_winner,
                early_item_one_inner_winner,
                early_item_one_terminal,
            ],
        ))
        .assert_value();
    assert!(reduction.terminal.is_some());
    assert!(!reduction.decisions.iter().any(|decision| {
        matches!(
            decision,
            Decision::VoidLoser { execution, .. } if *execution == post_prune_execution
        )
    }));
}

#[tokio::test]
async fn duplicate_gap_and_cross_occurrence_identity_histories_fail_closed() {
    let graph = verified(
        seq(vec![step("work", 2), succeed("done")]),
        json!({"work":2}),
    )
    .await;
    assert_execution_identity_failures(&graph);
    assert_cross_occurrence_alias_rejected().await;
}

fn assert_execution_identity_failures(graph: &VerifiedGraph) {
    let duplicate = [
        execution(ExecutionSpec::new(1, 1, "work").settled_at(2), success()),
        execution(
            ExecutionSpec::new(1, 1, "work").attempt(2).settled_at(4),
            success(),
        ),
    ];
    assert_eq!(
        FullV1Reducer::new(graph)
            .reduce(input(&json!({}), &duplicate))
            .assert_error(),
        ReducerError::InconsistentHistory
    );
    let gap = [execution(
        ExecutionSpec::new(2, 1, "work").attempt(2).settled_at(4),
        success(),
    )];
    assert_eq!(
        FullV1Reducer::new(graph)
            .reduce(input(&json!({}), &gap))
            .assert_error(),
        ReducerError::InconsistentHistory
    );
    let crossed = [
        execution(ExecutionSpec::new(1, 1, "work").settled_at(2), success()),
        execution(
            ExecutionSpec::new(2, 2, "work").attempt(2).settled_at(4),
            success(),
        ),
    ];
    assert_eq!(
        FullV1Reducer::new(graph)
            .reduce(input(&json!({}), &crossed))
            .assert_error(),
        ReducerError::InconsistentHistory
    );
    for rejected in [
        execution(ExecutionSpec::new(1, 1, "ghost").settled_at(2), success()),
        execution(
            ExecutionSpec::new(1, 1, "work")
                .indices(vec![0])
                .settled_at(2),
            success(),
        ),
    ] {
        assert_eq!(
            FullV1Reducer::new(graph)
                .reduce(input(&json!({}), std::slice::from_ref(&rejected)))
                .assert_error(),
            ReducerError::InconsistentHistory
        );
    }
    let mut mismatched_input = execution(ExecutionSpec::new(1, 1, "work").settled_at(2), success());
    mismatched_input.input = json!({"not":"the bound null input"});
    assert_eq!(
        FullV1Reducer::new(graph)
            .reduce(input(&json!({}), &[mismatched_input]))
            .assert_error(),
        ReducerError::InconsistentHistory
    );
}

async fn assert_cross_occurrence_alias_rejected() {
    let alias_graph = verified(
        seq(vec![
            json!({
                "kind":"par","name":"all","state":boundary_state(),
                "branches":[step("left",1),step("right",1)],
                "promotedStatePaths":[],"join":{"kind":"all"}
            }),
            succeed("alias_done"),
        ]),
        json!({"left":1,"right":1}),
    )
    .await;
    let aliases = [
        execution(ExecutionSpec::new(1, 1, "left").settled_at(2), success()),
        execution(ExecutionSpec::new(2, 1, "right").settled_at(3), success()),
    ];
    assert_eq!(
        FullV1Reducer::new(&alias_graph)
            .reduce(input(&json!({}), &aliases))
            .assert_error(),
        ReducerError::InconsistentHistory
    );
}

#[tokio::test]
async fn nested_map_item_attempt_counters_are_independent() {
    let map = json!({
        "kind":"map","name":"outer","state":boundary_state(),
        "over":{"source":"state","path":["items"]},"maxItems":2,"promotedStatePaths":[],
        "body":{
            "kind":"loop","name":"per_item_loop","state":{"kind":"record","fields":{}},
            "body":verifier("check",2),
            "until":{"kind":"in","value":{"name":"check","source":"signal","field":"verdict"},"labels":["accepted"]},
            "maxIterations":2,"promotedStatePaths":[]
        }
    });
    let graph = verified(seq(vec![map, succeed("done")]), json!({"check":2})).await;
    let history = [
        execution(
            ExecutionSpec::new(1, 1, "check")
                .indices(vec![0])
                .settled_at(2),
            verdict("rejected"),
        ),
        execution(
            ExecutionSpec::new(2, 2, "check")
                .indices(vec![1])
                .settled_at(3),
            verdict("accepted"),
        ),
    ];
    let reduction = FullV1Reducer::new(&graph)
        .reduce(input(&json!({"items":[1,2]}), &history))
        .assert_value();
    assert!(reduction.decisions.iter().any(|decision| matches!(
        decision,
        Decision::Dispatch { occurrence, node_instance, attempt, .. }
            if occurrence.map_indices == [0] && node_instance.get() == 1 && attempt.get() == 2
    )));
}

use openengine_cluster_testkit::assertions::{AssertValue, AssertError};
