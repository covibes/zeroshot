use super::*;

#[tokio::test]
async fn drives_every_full_v1_construct_through_the_real_reducer() {
    let harness = harness(
        all_constructs_graph(),
        json!({"items": ["one", "two"]}),
        all_constructs_driver(),
    )
    .await;

    assert_eq!(
        harness
            .supervisor
            .drive()
            .await
            .assert_value_with("terminal"),
        TerminalResult::Succeeded {
            output: Value::Null
        }
    );
    assert_eq!(harness.driver.starts("worker"), 1);
    assert_eq!(harness.driver.starts("choice_work"), 1);
    assert_eq!(harness.driver.starts("choice_other"), 0);
    assert_eq!(harness.driver.starts("loop_check"), 2);
    assert_eq!(harness.driver.starts("map_check"), 2);
    assert!(harness.driver.max_active() >= 2);
    let stored = stored_run(&harness.ledger).await;
    let loop_visits = stored
        .snapshot
        .executions
        .values()
        .filter(|execution| execution.reference.node.as_str() == "loop_check")
        .collect::<Vec<_>>();
    assert_eq!(loop_visits.len(), 2);
    assert_eq!(
        loop_visits.assert_at(0).reference.node_instance,
        loop_visits.assert_at(1).reference.node_instance
    );
    assert_ne!(
        loop_visits.assert_at(0).reference.execution,
        loop_visits.assert_at(1).reference.execution
    );
    assert!(loop_visits.iter().all(|visit| visit.attempt.get() == 1));
}

#[tokio::test]
async fn fail_terminal_is_reduced_without_dispatch() {
    let harness = harness(
        graph(
            json!({"kind": "fail", "name": "failed", "reason": "rejected"}),
            null_type(),
        ),
        Value::Null,
        FakeDriver::default(),
    )
    .await;
    assert_eq!(
        harness
            .supervisor
            .drive()
            .await
            .assert_value_with("terminal"),
        TerminalResult::Failed {
            reason: EnumLabel::new("rejected").assert_value_with("label")
        }
    );
    assert_eq!(harness.driver.state().starts.len(), 0);
}

async fn assert_cancelling_parallel_join(case: &str, join: Value, branches: Vec<Value>) {
    let driver = FakeDriver::scripted([
        (
            "fast",
            vec![Behavior::Complete {
                delay: Duration::from_millis(5),
                outcome: verifier_outcome("accepted"),
            }],
        ),
        (
            "second",
            vec![Behavior::Complete {
                delay: Duration::from_millis(10),
                outcome: verifier_outcome("accepted"),
            }],
        ),
        ("slow", vec![Behavior::Hang]),
    ]);
    let harness = harness(parallel(join, branches), Value::Null, driver).await;
    assert!(matches!(
        harness.supervisor.drive().await.assert_value_with(case),
        TerminalResult::Succeeded { .. }
    ));
    assert!(harness.driver.max_active() >= 2, "{case}");
    assert_eq!(harness.driver.cancellations("slow"), 1, "{case}");
    let stored = stored_run(&harness.ledger).await;
    let slow = stored
        .snapshot
        .executions
        .values()
        .find(|execution| execution.reference.node.as_str() == "slow")
        .assert_value_with("slow execution");
    assert!(matches!(slow.state, NodeState::Voided { .. }));
    let execution = slow.reference.execution;
    let tail = harness
        .ledger
        .snapshot_and_tail(&RunId::new("run-supervisor-test"), None)
        .await
        .assert_value_with("tail");
    let log = tail
        .events
        .iter()
        .position(|event| {
            matches!(
                event.event,
                RunEvent::SafeLog {
                    execution: Some(observed),
                    ..
                } if observed == execution
            )
        })
        .assert_value_with("loser log");
    let voided = tail
        .events
        .iter()
        .position(|event| {
            matches!(
                &event.event,
                RunEvent::ExecutionVoided { reference, .. }
                    if reference.execution == execution
            )
        })
        .assert_value_with("void settlement");
    let terminal = tail
        .events
        .iter()
        .position(|event| matches!(event.event, RunEvent::Terminal { .. }))
        .assert_value_with("terminal event");
    assert!(log < voided && voided < terminal, "{case}");
}

#[tokio::test]
async fn every_parallel_join_observes_completion_order_and_cancels_losers() {
    for (case, join, branches) in [
        (
            "any",
            json!({"kind": "any"}),
            vec![verifier("fast", 1_000), verifier("slow", 1_000)],
        ),
        (
            "quorum",
            json!({"kind": "quorum", "count": 2}),
            vec![
                verifier("fast", 1_000),
                verifier("second", 1_000),
                verifier("slow", 1_000),
            ],
        ),
        (
            "first",
            json!({"kind": "first", "when": signal_guard("fast", "accepted")}),
            vec![verifier("fast", 1_000), verifier("slow", 1_000)],
        ),
    ] {
        assert_cancelling_parallel_join(case, join, branches).await;
    }

    let all = harness(
        parallel(
            json!({"kind": "all"}),
            vec![verifier("fast", 1_000), verifier("slow", 1_000)],
        ),
        Value::Null,
        FakeDriver::scripted([
            (
                "fast",
                vec![Behavior::Complete {
                    delay: Duration::from_millis(5),
                    outcome: verifier_outcome("accepted"),
                }],
            ),
            (
                "slow",
                vec![Behavior::Complete {
                    delay: Duration::from_millis(15),
                    outcome: verifier_outcome("accepted"),
                }],
            ),
        ]),
    )
    .await;
    assert!(matches!(
        all.supervisor.drive().await.assert_value_with("all"),
        TerminalResult::Succeeded { .. }
    ));
    assert_eq!(all.driver.cancellations("slow"), 0);
}

use openengine_cluster_testkit::assertions::{AssertAt, AssertValue};
