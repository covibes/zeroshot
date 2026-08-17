use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use openengine_cluster_protocol::{
    CompiledGraphIr, IdempotencyKey, NodeName, PositiveInteger, RunId, Sha256Digest,
    TerminalResult, WorkerOutcome,
};
use serde_json::{Value, json};

use super::fake::FakeRunLedger;
use super::sqlite::SqliteRunLedger;
use super::{
    CreateRun, CreateRunOutcome, NodeState, RunEvent, RunLedger, RunLedgerError, RunPhase,
    SafeLogLine, SafeLogStream, cursor_for,
};
use crate::full_v1_reducer::{ExecutionVoidReason, StructuralOccurrence};
use crate::native_v2_contract::{
    AdmittedRun, CodexProvider, ExecutionId, ExecutionRef, NodeCompletion, NodeInstanceId,
    RuntimePlan,
};

fn admitted_run() -> AdmittedRun {
    let graph: CompiledGraphIr = serde_json::from_str(include_str!(
        "../../../protocol/openengine-cluster/v1/fixtures/graph/canonical/base.json"
    ))
    .unwrap();
    AdmittedRun {
        graph,
        initial_input: Value::Null,
        runtime: RuntimePlan::Codex {
            provider: CodexProvider::OpenAi,
            nodes: Default::default(),
        },
        ship: false,
    }
}

fn create(run: &str, key: &str, digest_byte: char) -> CreateRun {
    CreateRun {
        run_id: RunId::new(run),
        submission_key: IdempotencyKey::new(key).unwrap(),
        submission_digest: Sha256Digest::new(digest_byte.to_string().repeat(64)).unwrap(),
        admitted: admitted_run(),
    }
}

fn reference(run: &RunId, execution: u64) -> ExecutionRef {
    ExecutionRef {
        run_id: run.clone(),
        node: NodeName::new("worker").unwrap(),
        node_instance: NodeInstanceId::new(execution).unwrap(),
        execution: ExecutionId::new(execution).unwrap(),
    }
}

fn started(reference: ExecutionRef) -> RunEvent {
    RunEvent::NodeStarted {
        reference,
        occurrence: StructuralOccurrence {
            node: NodeName::new("worker").unwrap(),
            map_indices: Vec::new(),
        },
        attempt: PositiveInteger::new(1).unwrap(),
        input: json!({ "request": "edit" }),
    }
}

fn completed(reference: ExecutionRef, output: Value) -> RunEvent {
    RunEvent::NodeCompleted {
        completion: NodeCompletion {
            reference,
            outcome: WorkerOutcome::Verified {
                output,
                artifacts: Vec::new(),
            },
        },
    }
}

#[tokio::test]
async fn fake_create_is_exactly_idempotent_and_conflicts_fail_closed() {
    let ledger = FakeRunLedger::new();
    let request = create("run-1", "submission-1", 'a');

    assert!(matches!(
        ledger.create_or_get(request.clone()).await.unwrap(),
        CreateRunOutcome::Created(_)
    ));
    let existing = ledger
        .create_or_get(CreateRun {
            run_id: RunId::new("ignored-retry-id"),
            ..request.clone()
        })
        .await
        .unwrap();
    assert!(matches!(existing, CreateRunOutcome::Existing(_)));
    assert_eq!(existing.stored().snapshot.run_id, request.run_id);

    let conflict = ledger
        .create_or_get(CreateRun {
            submission_digest: Sha256Digest::new("b".repeat(64)).unwrap(),
            ..request.clone()
        })
        .await
        .unwrap_err();
    assert!(matches!(
        conflict,
        RunLedgerError::SubmissionConflict { .. }
    ));

    let run_id_conflict = ledger
        .create_or_get(create("run-1", "submission-2", 'c'))
        .await
        .unwrap_err();
    assert_eq!(run_id_conflict, RunLedgerError::RunIdConflict);
}

#[tokio::test]
async fn fake_projects_outputs_voids_safe_logs_and_terminal_in_order() {
    let ledger = FakeRunLedger::new();
    let request = create("run-events", "submission-events", 'd');
    let run_id = request.run_id.clone();
    ledger.create_or_get(request).await.unwrap();
    let first = reference(&run_id, 1);
    let second = reference(&run_id, 2);

    let appended = ledger
        .append(
            &run_id,
            vec![
                RunEvent::RunStarted,
                started(first.clone()),
                started(second.clone()),
                RunEvent::SafeLog {
                    execution: Some(first.execution),
                    stream: SafeLogStream::Output,
                    line: SafeLogLine::new("working").unwrap(),
                },
                completed(first.clone(), json!({ "changed": true })),
                RunEvent::ExecutionVoided {
                    reference: second.clone(),
                    reason: ExecutionVoidReason::ParallelJoin,
                },
                RunEvent::Terminal {
                    result: TerminalResult::Succeeded {
                        output: json!({ "merged": true }),
                    },
                },
            ],
        )
        .await
        .unwrap();

    assert_eq!(appended.events.len(), 7);
    assert_eq!(appended.snapshot.cursor, cursor_for(7));
    assert_eq!(appended.snapshot.phase, RunPhase::Finished);
    assert!(matches!(
        appended.snapshot.executions[&first.execution].state,
        NodeState::Completed { .. }
    ));
    assert!(matches!(
        appended.snapshot.executions[&second.execution].state,
        NodeState::Voided {
            reason: ExecutionVoidReason::ParallelJoin,
            ..
        }
    ));

    let observation = ledger
        .snapshot_and_tail(&run_id, Some(&cursor_for(3)))
        .await
        .unwrap();
    assert_eq!(observation.snapshot.cursor, cursor_for(7));
    assert_eq!(observation.events.len(), 4);
    assert_eq!(observation.events[0].cursor, cursor_for(4));
    assert!(matches!(
        observation.events[0].event,
        RunEvent::SafeLog { .. }
    ));

    assert_eq!(
        ledger
            .append(&run_id, vec![RunEvent::RunStarted])
            .await
            .unwrap_err(),
        RunLedgerError::InvalidEvent("run is already terminal")
    );
}

#[tokio::test]
async fn force_stop_is_idempotent_and_prevents_new_dispatches() {
    let ledger = FakeRunLedger::new();
    let request = create("run-stop", "submission-stop", 'e');
    let run_id = request.run_id.clone();
    ledger.create_or_get(request).await.unwrap();
    ledger
        .append(&run_id, vec![RunEvent::RunStarted])
        .await
        .unwrap();

    let first = ledger.request_force_stop(&run_id).await.unwrap();
    assert_eq!(first.events.len(), 1);
    assert!(first.snapshot.force_stop_requested);
    assert_eq!(first.snapshot.phase, RunPhase::Stopping);
    let second = ledger.request_force_stop(&run_id).await.unwrap();
    assert!(second.events.is_empty());
    assert_eq!(second.snapshot.cursor, first.snapshot.cursor);

    assert_eq!(
        ledger
            .append(&run_id, vec![started(reference(&run_id, 1))])
            .await
            .unwrap_err(),
        RunLedgerError::InvalidEvent("run is not dispatchable")
    );
}

#[tokio::test]
async fn parallel_completions_receive_one_durable_order() {
    let ledger = FakeRunLedger::new();
    let request = create("run-parallel", "submission-parallel", '7');
    let run_id = request.run_id.clone();
    let first = reference(&run_id, 1);
    let second = reference(&run_id, 2);
    ledger.create_or_get(request).await.unwrap();
    ledger
        .append(
            &run_id,
            vec![
                RunEvent::RunStarted,
                started(first.clone()),
                started(second.clone()),
            ],
        )
        .await
        .unwrap();

    let first_completion = vec![completed(first.clone(), json!("first"))];
    let second_completion = vec![completed(second.clone(), json!("second"))];
    let (first_result, second_result) = tokio::join!(
        ledger.append(&run_id, first_completion),
        ledger.append(&run_id, second_completion),
    );
    let first_result = first_result.unwrap();
    let second_result = second_result.unwrap();
    let mut completion_cursors = [
        first_result.events[0].cursor.clone(),
        second_result.events[0].cursor.clone(),
    ];
    completion_cursors.sort();
    assert_eq!(completion_cursors, [cursor_for(4), cursor_for(5)]);

    let observation = ledger
        .snapshot_and_tail(&run_id, Some(&cursor_for(3)))
        .await
        .unwrap();
    assert_eq!(observation.snapshot.cursor, cursor_for(5));
    assert_eq!(observation.events.len(), 2);
    assert!(matches!(
        observation.snapshot.executions[&first.execution].state,
        NodeState::Completed { .. }
    ));
    assert!(matches!(
        observation.snapshot.executions[&second.execution].state,
        NodeState::Completed { .. }
    ));
}

#[tokio::test]
async fn sqlite_survives_reopen_and_preserves_cursor_tail_and_identity() {
    let path = unique_database_path();
    let request = create("run-sqlite", "submission-sqlite", 'f');
    let run_id = request.run_id.clone();
    {
        let ledger = SqliteRunLedger::open(&path).unwrap();
        ledger.create_or_get(request.clone()).await.unwrap();
        ledger
            .append(
                &run_id,
                vec![
                    RunEvent::RunStarted,
                    started(reference(&run_id, 1)),
                    completed(reference(&run_id, 1), json!("done")),
                ],
            )
            .await
            .unwrap();
    }

    let reopened = SqliteRunLedger::open(&path).unwrap();
    let stored = reopened.get(&run_id).await.unwrap().unwrap();
    assert_eq!(stored.snapshot.cursor, cursor_for(3));
    assert!(matches!(
        reopened.create_or_get(request).await.unwrap(),
        CreateRunOutcome::Existing(_)
    ));
    let observation = reopened
        .snapshot_and_tail(&run_id, Some(&cursor_for(1)))
        .await
        .unwrap();
    assert_eq!(observation.events.len(), 2);
    assert_eq!(observation.events[0].cursor, cursor_for(2));

    drop(reopened);
    std::fs::remove_file(&path).unwrap();
}

fn unique_database_path() -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    std::env::temp_dir().join(format!(
        "zeroshot-v2-run-ledger-{}-{nonce}.sqlite",
        std::process::id()
    ))
}
