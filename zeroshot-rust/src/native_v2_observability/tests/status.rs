use super::*;

#[tokio::test]
async fn status_lists_every_parallel_execution_with_opaque_selectors() {
    let (ledger, run_id) = ledger_run("parallel-status").await;
    let left = reference(&run_id, "left", 1);
    let right = reference(&run_id, "right", 2);
    ledger
        .append(
            &run_id,
            vec![RunEvent::RunStarted, started(&left), started(&right)],
        )
        .await
        .assert_value();
    let service = NativeV2Observability::new(ledger);

    let status = service
        .status(RunStatusParams {
            run_id: run_id.clone(),
        })
        .await
        .assert_value();
    let admitted = admitted_run();
    assert_eq!(&status.title, &admitted.title);
    assert_eq!(&status.source, &admitted.source);
    assert_eq!(status.size, admitted.runtime.size());
    let active_executions = match status.status {
        RunStatus::Running { active_executions } => Some(active_executions),
        _ => None,
    };
    let active_executions = active_executions.assert_value_with("run must be running");
    assert_eq!(active_executions.len(), 2);
    assert_eq!(active_executions.assert_at(0).node.as_str(), "left");
    assert_eq!(active_executions.assert_at(1).node.as_str(), "right");
    assert_ne!(
        active_executions.assert_at(0).execution,
        active_executions.assert_at(1).execution
    );
    let encoded = serde_json::to_string(&active_executions).assert_value();
    assert!(!encoded.contains("nodeInstance"));
    assert!(!encoded.contains("executionId"));
    assert!(!encoded.contains(run_id.as_str()));
}

pub(super) async fn cursor_fixture() -> (
    Arc<FakeRunLedger>,
    RunId,
    ExecutionRef,
    ExecutionRef,
    NativeV2Observability,
) {
    let (ledger, run_id) = ledger_run("cursor-resume").await;
    let left = reference(&run_id, "left", 1);
    let right = reference(&run_id, "right", 2);
    ledger
        .append(
            &run_id,
            vec![
                RunEvent::RunStarted,
                started(&left),
                started(&right),
                RunEvent::SafeLog {
                    execution: Some(left.execution),
                    stream: SafeLogStream::Output,
                    line: SafeLogLine::new("first").assert_value(),
                },
                completed(&left, Value::Null),
                RunEvent::SafeLog {
                    execution: Some(left.execution),
                    stream: SafeLogStream::Output,
                    line: SafeLogLine::new("second").assert_value(),
                },
            ],
        )
        .await
        .assert_value();
    let service = NativeV2Observability::new(ledger.clone());
    (ledger, run_id, left, right, service)
}

use openengine_cluster_testkit::assertions::{AssertAt, AssertValue};
