use super::*;

fn assert_watch_cursors(events: &[RunWatchEventNotification], expected: &[&str]) {
    assert_eq!(
        events
            .iter()
            .map(|event| event.cursor.as_str())
            .collect::<Vec<_>>(),
        expected
    );
}

#[tokio::test]
async fn durable_watch_resumes_exclusively_without_gaps_or_duplicates() {
    let (ledger, run_id, _left, right, service) = cursor_fixture().await;

    let (_, mut watch) = service
        .watch(RunWatchParams {
            run_id: run_id.clone(),
            from_cursor: Some(Cursor::new("v2:1")),
        })
        .await
        .assert_value();
    let transitions = watch.read_available().await.assert_value();
    assert_watch_cursors(&transitions, &["v2:2", "v2:3", "v2:5"]);
    assert_watch_metadata(&transitions, &admitted_run());
    let saved_watch_cursor = transitions.assert_at(1).cursor.clone();
    drop(watch);
    let (_, mut resumed_watch) = service
        .watch(RunWatchParams {
            run_id: run_id.clone(),
            from_cursor: Some(saved_watch_cursor),
        })
        .await
        .assert_value();
    let resumed = resumed_watch.read_available().await.assert_value();
    assert_watch_cursors(&resumed, &["v2:5"]);
    assert_watch_metadata(&resumed, &admitted_run());

    // Disconnecting a watcher cannot mutate or cancel an active execution.
    assert!(
        ledger
            .get(&run_id)
            .await
            .assert_value()
            .assert_value()
            .snapshot
            .executions
            .get(&right.execution)
            .assert_value()
            .state
            .eq(&NodeState::Active)
    );

    let terminal_output = serde_json::json!({
        "kind": "verification_receipt",
        "summary": "checkout repaired",
        "passed": true
    });
    ledger
        .append(
            &run_id,
            vec![
                completed(&right, Value::Null),
                RunEvent::Terminal {
                    result: TerminalResult::Succeeded {
                        output: terminal_output.clone(),
                    },
                },
            ],
        )
        .await
        .assert_value();
    let terminal_transitions = resumed_watch.read_available().await.assert_value();
    assert_watch_cursors(&terminal_transitions, &["v2:7", "v2:8"]);
    assert_watch_metadata(&terminal_transitions, &admitted_run());
    assert_eq!(
        &terminal_transitions.assert_at(1).status,
        &RunStatus::Finished {
            terminal_result: TerminalResult::Succeeded {
                output: terminal_output,
            },
        }
    );
}

use openengine_cluster_testkit::assertions::{AssertAt, AssertValue};
