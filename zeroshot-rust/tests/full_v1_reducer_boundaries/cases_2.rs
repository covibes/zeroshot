use super::*;

#[tokio::test]
async fn equal_position_parallel_ties_are_broken_by_authored_branch_position() {
    let par = json!({
        "kind":"par","name":"race","state":{"kind":"record","fields":{}},
        "branches":[step("left",1),step("right",1)],"promotedStatePaths":[],"join":{"kind":"any"}
    });
    let graph = verified(seq(vec![par, succeed("done")]), json!({"left":1,"right":1})).await;
    let history = [
        execution(ExecutionSpec::new(2, 2, "right").settled_at(5), success()),
        execution(ExecutionSpec::new(1, 1, "left").settled_at(5), success()),
    ];
    let reduction = FullV1Reducer::new(&graph)
        .reduce(input(&json!({}), &history))
        .assert_value();
    let continued = reduction
        .decisions
        .iter()
        .filter_map(|decision| match decision {
            Decision::Continue { node } => Some(node.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>();
    assert!(continued.contains(&"left"));
    assert!(!continued.contains(&"right"));
}

#[tokio::test]
async fn earlier_history_position_wins_first_independent_of_authored_and_history_order() {
    let first = json!({
        "kind":"par","name":"position_first","state":boundary_state(),
        "branches":[verifier("authored_first",1),verifier("settled_first",1)],
        "promotedStatePaths":[],
        "join":{"kind":"first","when":{
            "kind":"k_of_n","count":1,
            "values":[
                {"name":"authored_first","source":"signal","field":"verdict"},
                {"name":"settled_first","source":"signal","field":"verdict"}
            ],
            "labels":["accepted"]
        }}
    });
    let graph = verified(
        seq(vec![first, succeed("position_done")]),
        json!({"authored_first":1,"settled_first":1}),
    )
    .await;
    let authored = execution(
        ExecutionSpec::new(1, 1, "authored_first").settled_at(10),
        verdict("accepted"),
    );
    let earlier = execution(
        ExecutionSpec::new(2, 2, "settled_first").settled_at(3),
        verdict("accepted"),
    );
    let first_order = FullV1Reducer::new(&graph)
        .reduce(input(&json!({}), &[authored.clone(), earlier.clone()]))
        .assert_value();
    let reversed_order = FullV1Reducer::new(&graph)
        .reduce(input(&json!({}), &[earlier, authored]))
        .assert_value();
    assert!(first_order.decisions.iter().any(|decision| matches!(
        decision,
        Decision::Continue { node } if node.as_str() == "settled_first"
    )));
    assert!(!first_order.decisions.iter().any(|decision| matches!(
        decision,
        Decision::Continue { node } if node.as_str() == "authored_first"
    )));
    assert_eq!(
        first_order.canonical_decision_bytes().assert_value(),
        reversed_order.canonical_decision_bytes().assert_value()
    );
}

#[tokio::test]
async fn voided_executions_require_authored_parallel_or_map_loser_ownership() {
    assert_unowned_void_rejected().await;
    assert_parallel_void_ownership().await;
    assert_map_void_ownership().await;
}

async fn assert_unowned_void_rejected() {
    let sequential = verified(
        seq(vec![step("ordinary_work", 1), succeed("ordinary_done")]),
        json!({"ordinary_work":1}),
    )
    .await;
    let mut unowned = execution(
        ExecutionSpec::new(1, 1, "ordinary_work").settled_at(2),
        success(),
    );
    unowned.state = DurableExecutionState::Voided {
        position: HistoryPosition::new(5).assert_value(),
        reason: ExecutionVoidReason::ParallelJoin,
    };
    assert_eq!(
        FullV1Reducer::new(&sequential)
            .reduce(input(&json!({}), std::slice::from_ref(&unowned)))
            .assert_error(),
        ReducerError::InconsistentHistory
    );
}

async fn assert_parallel_void_ownership() {
    let parallel = verified(
        seq(vec![
            json!({
                "kind":"par","name":"owned_race","state":boundary_state(),
                "branches":[step("owned_loser",1),step("owned_winner",1)],
                "promotedStatePaths":[],"join":{"kind":"any"}
            }),
            succeed("owned_done"),
        ]),
        json!({"owned_loser":1,"owned_winner":1}),
    )
    .await;
    let mut premature_parallel = execution(
        ExecutionSpec::new(1, 1, "owned_loser").settled_at(2),
        success(),
    );
    premature_parallel.state = DurableExecutionState::Voided {
        position: HistoryPosition::new(2).assert_value(),
        reason: ExecutionVoidReason::ParallelJoin,
    };
    let later_parallel_winner = execution(
        ExecutionSpec::new(2, 2, "owned_winner").settled_at(5),
        success(),
    );
    assert_eq!(
        FullV1Reducer::new(&parallel)
            .reduce(input(
                &json!({}),
                &[premature_parallel, later_parallel_winner],
            ))
            .assert_error(),
        ReducerError::InconsistentHistory
    );

    let mut owned = execution(
        ExecutionSpec::new(1, 1, "owned_loser").settled_at(2),
        success(),
    );
    owned.state = DurableExecutionState::Voided {
        position: HistoryPosition::new(5).assert_value(),
        reason: ExecutionVoidReason::ParallelJoin,
    };
    let winner = execution(
        ExecutionSpec::new(2, 2, "owned_winner").settled_at(3),
        success(),
    );
    let mut wrong_parallel_reason = owned.clone();
    wrong_parallel_reason.state = DurableExecutionState::Voided {
        position: HistoryPosition::new(5).assert_value(),
        reason: ExecutionVoidReason::MapTerminal,
    };
    assert_eq!(
        FullV1Reducer::new(&parallel)
            .reduce(input(&json!({}), &[wrong_parallel_reason, winner.clone()],))
            .assert_error(),
        ReducerError::InconsistentHistory
    );
    let reduction = FullV1Reducer::new(&parallel)
        .reduce(input(&json!({}), &[owned, winner]))
        .assert_value();
    assert!(reduction.terminal.is_some());
    assert!(
        !reduction
            .decisions
            .iter()
            .any(|decision| matches!(decision, Decision::VoidLoser { .. }))
    );
}

async fn assert_map_void_ownership() {
    let (map_graph, map_winner) = map_void_fixture().await;
    assert_premature_map_void(&map_graph, &map_winner);
    assert_map_void_reason(&map_graph, map_winner);
}

async fn map_void_fixture() -> (VerifiedGraph, DurableExecution) {
    let map_body = json!({
        "kind":"seq","name":"causal_map_body","state":boundary_state(),
        "children":[step("causal_map_work",1),succeed("causal_map_item_done")],
        "promotedStatePaths":[]
    });
    let causal_map = json!({
        "kind":"map","name":"causal_map","state":boundary_state(),
        "over":{"source":"state","path":["items"]},"maxItems":2,
        "body":map_body,"promotedStatePaths":[]
    });
    let map_graph = verified(
        seq(vec![causal_map, succeed("causal_map_empty_done")]),
        json!({"causal_map_work":1}),
    )
    .await;
    let winner = execution(
        ExecutionSpec::new(1, 1, "causal_map_work")
            .indices(vec![0])
            .settled_at(5),
        success(),
    );
    (map_graph, winner)
}

fn assert_premature_map_void(map_graph: &VerifiedGraph, map_winner: &DurableExecution) {
    let mut premature_map_void = execution(
        ExecutionSpec::new(2, 2, "causal_map_work")
            .indices(vec![1])
            .settled_at(2),
        success(),
    );
    premature_map_void.state = DurableExecutionState::Voided {
        position: HistoryPosition::new(2).assert_value(),
        reason: ExecutionVoidReason::MapTerminal,
    };
    assert_eq!(
        FullV1Reducer::new(map_graph)
            .reduce(input(
                &json!({"items":[null,null]}),
                &[premature_map_void, map_winner.clone()],
            ))
            .assert_error(),
        ReducerError::InconsistentHistory
    );
}

fn assert_map_void_reason(map_graph: &VerifiedGraph, map_winner: DurableExecution) {
    let mut wrong_map_reason = execution(
        ExecutionSpec::new(2, 2, "causal_map_work")
            .indices(vec![1])
            .settled_at(6),
        success(),
    );
    wrong_map_reason.state = DurableExecutionState::Voided {
        position: HistoryPosition::new(6).assert_value(),
        reason: ExecutionVoidReason::ParallelJoin,
    };
    assert_eq!(
        FullV1Reducer::new(map_graph)
            .reduce(input(
                &json!({"items":[null,null]}),
                &[wrong_map_reason, map_winner.clone()],
            ))
            .assert_error(),
        ReducerError::InconsistentHistory
    );
    let mut correct_map_reason = execution(
        ExecutionSpec::new(2, 2, "causal_map_work")
            .indices(vec![1])
            .settled_at(6),
        success(),
    );
    correct_map_reason.state = DurableExecutionState::Voided {
        position: HistoryPosition::new(6).assert_value(),
        reason: ExecutionVoidReason::MapTerminal,
    };
    assert!(
        FullV1Reducer::new(map_graph)
            .reduce(input(
                &json!({"items":[null,null]}),
                &[correct_map_reason, map_winner],
            ))
            .assert_value()
            .terminal
            .is_some()
    );
}

use openengine_cluster_testkit::assertions::{AssertValue, AssertError};
