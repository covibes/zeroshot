use super::*;

#[tokio::test]
async fn reducer_accepts_only_the_production_verifiers_verified_graph() {
    let graph: GraphSpec = serde_json::from_value(json!({
        "profile":"openengine.graph.full/v1",
        "initialInput":{"kind":"record","fields":{}},
        "policy":{"policy":"policy.test@1","default":"deny"},
        "root":sequence("root",vec![step("work",1),succeed("done")])
    }))
    .assert_value();
    let verified = ProductionGraphVerifier::new(TestWorkers { rich_outputs: true })
        .verify(&graph)
        .await
        .assert_value();
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
            reason: "verification_rejected".parse().assert_value()
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
async fn parallel_any_uses_history_position_and_voids_only_active_losers() {
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

    let graph = verified(
        sequence(
            "root",
            vec![
                json!({
                    "kind":"par", "name":"first", "state":{"kind":"record","fields":{}},
                    "branches":[verifier("early",1),verifier("later",1)], "promotedStatePaths":[],
                    "join":{
                        "kind":"first",
                        "when":{
                            "kind":"in",
                            "value":{"name":"later","source":"signal","field":"verdict"},
                            "labels":["accepted"]
                        }
                    }
                }),
                succeed("done"),
            ],
        ),
        json!({"early":1,"later":1}),
    )
    .await;
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

use openengine_cluster_testkit::assertions::{AssertValue};
