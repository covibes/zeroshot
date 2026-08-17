use super::*;

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
    assert_eq!(
        transitions
            .iter()
            .map(|event| event.cursor.as_str())
            .collect::<Vec<_>>(),
        ["v2:2", "v2:3", "v2:5"]
    );
    let saved_watch_cursor = transitions.assert_at(1).cursor.clone();
    drop(watch);
    let (_, mut resumed_watch) = service
        .watch(RunWatchParams {
            run_id: run_id.clone(),
            from_cursor: Some(saved_watch_cursor),
        })
        .await
        .assert_value();
    assert_eq!(
        resumed_watch
            .read_available()
            .await
            .assert_value()
            .iter()
            .map(|event| event.cursor.as_str())
            .collect::<Vec<_>>(),
        ["v2:5"]
    );

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
}

use openengine_cluster_testkit::assertions::{AssertAt, AssertValue};
