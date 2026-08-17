use super::*;

#[tokio::test]
async fn exact_map_limit_dispatches_every_item_but_overflow_prunes_all_identities() {
    let map = json!({
        "kind":"map","name":"mapped","state":boundary_state(),
        "body":step("item_work",1),"over":{"source":"state","path":["items"]},
        "maxItems":2,"promotedStatePaths":[]
    });
    let graph = verified(seq(vec![map, succeed("done")]), json!({"item_work":1})).await;
    let at_limit = FullV1Reducer::new(&graph)
        .reduce(input(&json!({"items":[1,2]}), &[]))
        .assert_value();
    assert_eq!(
        at_limit
            .decisions
            .iter()
            .filter(|decision| matches!(decision, Decision::Dispatch { .. }))
            .count(),
        2
    );
    let overflow = FullV1Reducer::new(&graph)
        .reduce(input(&json!({"items":[1,2,3]}), &[]))
        .assert_value();
    assert!(
        !overflow
            .decisions
            .iter()
            .any(|decision| matches!(decision, Decision::Dispatch { .. }))
    );
    assert!(overflow.terminal.is_some());
}

#[tokio::test]
async fn attempt_ceiling_terminalizes_authored_reentry_without_automatic_retry() {
    let loop_node = json!({
        "kind":"loop","name":"bounded","state":{"kind":"record","fields":{}},
        "body":verifier("check",1),
        "until":{"kind":"in","value":{"name":"check","source":"signal","field":"verdict"},"labels":["accepted"]},
        "maxIterations":2,"promotedStatePaths":[]
    });
    let graph = verified(seq(vec![loop_node, succeed("done")]), json!({"check":1})).await;
    let history = [execution(
        ExecutionSpec::new(1, 1, "check").settled_at(2),
        verdict("rejected"),
    )];
    let reduction = FullV1Reducer::new(&graph)
        .reduce(input(&json!({}), &history))
        .assert_value();
    assert_eq!(
        reduction.terminal,
        Some(TerminalProjection::Failed {
            reason: "attempts_exhausted".parse().assert_value()
        })
    );
    assert!(
        !reduction
            .decisions
            .iter()
            .any(|decision| matches!(decision, Decision::Dispatch { .. }))
    );
}

#[tokio::test]
async fn loop_exhaustion_is_a_routable_group_control_not_an_implicit_retry_or_failure() {
    let loop_node = json!({
        "kind":"loop","name":"bounded","state":{"kind":"record","fields":{}},
        "body":verifier("check",2),
        "until":{"kind":"in","value":{"name":"check","source":"signal","field":"verdict"},"labels":["accepted"]},
        "maxIterations":2,"promotedStatePaths":[]
    });
    let route = json!({
        "kind":"choice","name":"after_loop","state":{"kind":"record","fields":{}},
        "branches":[{
            "when":{
                "kind":"in",
                "value":{"name":"bounded","source":"group","field":"terminated"},
                "labels":["exhausted"]
            },
            "node":succeed("exhausted")
        }],
        "otherwise":{"kind":"fail","name":"unexpected","reason":"unexpected"},
        "promotedStatePaths":[]
    });
    let graph = verified(seq(vec![loop_node, route]), json!({"check":2})).await;
    let history = [
        execution(
            ExecutionSpec::new(1, 1, "check").settled_at(2),
            verdict("rejected"),
        ),
        execution(
            ExecutionSpec::new(2, 1, "check").attempt(2).settled_at(4),
            verdict("rejected"),
        ),
    ];
    assert!(matches!(
        FullV1Reducer::new(&graph)
            .reduce(input(&json!({}), &history))
            .assert_value()
            .terminal,
        Some(TerminalProjection::Succeeded { .. })
    ));
}

use openengine_cluster_testkit::assertions::{AssertValue};
