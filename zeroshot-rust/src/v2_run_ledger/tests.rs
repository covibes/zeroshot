use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use openengine_cluster_protocol::{
    ArtifactRef, CompiledGraphIr, IdempotencyKey, NodeName, PositiveInteger, RunId, Sha256Digest,
    RunSize, RunTitle, SourceBranchId, SourceRepositoryId, SourceRevisionId, ResolvedSource,
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
    .assert_value();
    AdmittedRun {
        title: RunTitle::new("Ledger test").assert_value(),
        graph,
        initial_input: Value::Null,
        runtime: RuntimePlan::Codex {
            provider: CodexProvider::OpenAi,
            size: RunSize::Standard,
            nodes: Default::default(),
        },
        source: ResolvedSource {
            repository: SourceRepositoryId::new("open-engine/zeroshot").assert_value(),
            branch: SourceBranchId::new("main").assert_value(),
            revision: SourceRevisionId::new("0123456789abcdef0123456789abcdef01234567")
                .assert_value(),
        },
    }
}

fn create(run: &str, key: &str, digest_byte: char) -> CreateRun {
    CreateRun {
        run_id: RunId::new(run),
        submission_key: IdempotencyKey::new(key).assert_value(),
        submission_digest: Sha256Digest::new(digest_byte.to_string().repeat(64)).assert_value(),
        admitted: admitted_run(),
    }
}

fn reference(run: &RunId, execution: u64) -> ExecutionRef {
    ExecutionRef {
        run_id: run.clone(),
        node: NodeName::new("worker").assert_value(),
        node_instance: NodeInstanceId::new(execution).assert_value(),
        execution: ExecutionId::new(execution).assert_value(),
    }
}

fn started(reference: ExecutionRef) -> RunEvent {
    RunEvent::NodeStarted {
        reference,
        occurrence: StructuralOccurrence {
            node: NodeName::new("worker").assert_value(),
            map_indices: Vec::new(),
        },
        attempt: PositiveInteger::new(1).assert_value(),
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
async fn node_completion_with_artifact_reference_is_never_persisted() {
    let ledger = FakeRunLedger::new();
    let run_id = RunId::new("artifact-free-run");
    ledger
        .create_or_get(create(run_id.as_str(), "artifact-free", 'a'))
        .await
        .assert_value();
    let reference = reference(&run_id, 1);
    ledger
        .append(
            &run_id,
            vec![RunEvent::RunStarted, started(reference.clone())],
        )
        .await
        .assert_value();
    let artifact: ArtifactRef = serde_json::from_str(include_str!(
        "../../../protocol/openengine-cluster/v1/fixtures/graph/positive/artifact-ref.json"
    ))
    .assert_value();
    let rejected = ledger
        .append(
            &run_id,
            vec![RunEvent::NodeCompleted {
                completion: NodeCompletion {
                    reference: reference.clone(),
                    outcome: WorkerOutcome::Verified {
                        output: Value::Null,
                        artifacts: vec![artifact],
                    },
                },
            }],
        )
        .await;
    assert_eq!(
        rejected,
        Err(RunLedgerError::InvalidEvent(
            "native-v2 node outcomes cannot contain artifact references"
        ))
    );
    let stored = ledger.get(&run_id).await.assert_value().assert_value();
    assert!(matches!(
        stored
            .snapshot
            .executions
            .get(&reference.execution)
            .assert_value()
            .state,
        NodeState::Active
    ));
}

#[tokio::test]
async fn fake_create_is_exactly_idempotent_and_conflicts_fail_closed() {
    let ledger = FakeRunLedger::new();
    let request = create("run-1", "submission-1", 'a');

    assert!(matches!(
        ledger.create_or_get(request.clone()).await.assert_value(),
        CreateRunOutcome::Created(_)
    ));
    let existing = ledger
        .create_or_get(CreateRun {
            run_id: RunId::new("ignored-retry-id"),
            ..request.clone()
        })
        .await
        .assert_value();
    assert!(matches!(existing, CreateRunOutcome::Existing(_)));
    assert_eq!(existing.stored().snapshot.run_id, request.run_id);

    let conflict = ledger
        .create_or_get(CreateRun {
            submission_digest: Sha256Digest::new("b".repeat(64)).assert_value(),
            ..request.clone()
        })
        .await
        .assert_error();
    assert!(matches!(
        conflict,
        RunLedgerError::SubmissionConflict { .. }
    ));

    let run_id_conflict = ledger
        .create_or_get(create("run-1", "submission-2", 'c'))
        .await
        .assert_error();
    assert_eq!(run_id_conflict, RunLedgerError::RunIdConflict);
}

#[tokio::test]
async fn fake_projects_outputs_voids_safe_logs_and_terminal_in_order() {
    let ledger = FakeRunLedger::new();
    let request = create("run-events", "submission-events", 'd');
    let run_id = request.run_id.clone();
    ledger.create_or_get(request).await.assert_value();
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
                    line: SafeLogLine::new("working").assert_value(),
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
        .assert_value();

    assert_eq!(appended.events.len(), 7);
    assert_eq!(appended.snapshot.cursor, cursor_for(7));
    assert_eq!(appended.snapshot.phase, RunPhase::Finished);
    assert!(matches!(
        appended
            .snapshot
            .executions
            .get(&first.execution)
            .assert_value()
            .state,
        NodeState::Completed { .. }
    ));
    assert!(matches!(
        appended
            .snapshot
            .executions
            .get(&second.execution)
            .assert_value()
            .state,
        NodeState::Voided {
            reason: ExecutionVoidReason::ParallelJoin,
            ..
        }
    ));

    let observation = ledger
        .snapshot_and_tail(&run_id, Some(&cursor_for(3)))
        .await
        .assert_value();
    assert_eq!(observation.snapshot.cursor, cursor_for(7));
    assert_eq!(observation.events.len(), 4);
    assert_eq!(observation.events.assert_at(0).cursor, cursor_for(4));
    assert!(matches!(
        observation.events.assert_at(0).event,
        RunEvent::SafeLog { .. }
    ));

    assert_eq!(
        ledger
            .append(&run_id, vec![RunEvent::RunStarted])
            .await
            .assert_error(),
        RunLedgerError::InvalidEvent("run is already terminal")
    );
}

#[tokio::test]
async fn force_stop_is_idempotent_and_prevents_new_dispatches() {
    let ledger = FakeRunLedger::new();
    let request = create("run-stop", "submission-stop", 'e');
    let run_id = request.run_id.clone();
    ledger.create_or_get(request).await.assert_value();
    ledger
        .append(&run_id, vec![RunEvent::RunStarted])
        .await
        .assert_value();

    let first = ledger.request_force_stop(&run_id).await.assert_value();
    assert_eq!(first.events.len(), 1);
    assert!(first.snapshot.force_stop_requested);
    assert_eq!(first.snapshot.phase, RunPhase::Stopping);
    let second = ledger.request_force_stop(&run_id).await.assert_value();
    assert!(second.events.is_empty());
    assert_eq!(second.snapshot.cursor, first.snapshot.cursor);

    assert_eq!(
        ledger
            .append(&run_id, vec![started(reference(&run_id, 1))])
            .await
            .assert_error(),
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
    ledger.create_or_get(request).await.assert_value();
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
        .assert_value();

    let first_completion = vec![completed(first.clone(), json!("first"))];
    let second_completion = vec![completed(second.clone(), json!("second"))];
    let (first_result, second_result) = tokio::join!(
        ledger.append(&run_id, first_completion),
        ledger.append(&run_id, second_completion),
    );
    let first_result = first_result.assert_value();
    let second_result = second_result.assert_value();
    let mut completion_cursors = [
        first_result.events.assert_at(0).cursor.clone(),
        second_result.events.assert_at(0).cursor.clone(),
    ];
    completion_cursors.sort();
    assert_eq!(completion_cursors, [cursor_for(4), cursor_for(5)]);

    let observation = ledger
        .snapshot_and_tail(&run_id, Some(&cursor_for(3)))
        .await
        .assert_value();
    assert_eq!(observation.snapshot.cursor, cursor_for(5));
    assert_eq!(observation.events.len(), 2);
    assert!(matches!(
        observation
            .snapshot
            .executions
            .get(&first.execution)
            .assert_value()
            .state,
        NodeState::Completed { .. }
    ));
    assert!(matches!(
        observation
            .snapshot
            .executions
            .get(&second.execution)
            .assert_value()
            .state,
        NodeState::Completed { .. }
    ));
}

#[tokio::test]
async fn sqlite_survives_reopen_and_preserves_cursor_tail_and_identity() {
    let path = unique_database_path();
    let request = create("run-sqlite", "submission-sqlite", 'f');
    let run_id = request.run_id.clone();
    {
        let ledger = SqliteRunLedger::open(&path).assert_value();
        ledger.create_or_get(request.clone()).await.assert_value();
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
            .assert_value();
    }

    let reopened = SqliteRunLedger::open(&path).assert_value();
    let stored = reopened.get(&run_id).await.assert_value().assert_value();
    assert_eq!(stored.snapshot.cursor, cursor_for(3));
    assert!(matches!(
        reopened.create_or_get(request).await.assert_value(),
        CreateRunOutcome::Existing(_)
    ));
    let observation = reopened
        .snapshot_and_tail(&run_id, Some(&cursor_for(1)))
        .await
        .assert_value();
    assert_eq!(observation.events.len(), 2);
    assert_eq!(observation.events.assert_at(0).cursor, cursor_for(2));

    drop(reopened);
    std::fs::remove_file(&path).assert_value();
}

fn unique_database_path() -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .assert_value()
        .as_nanos();
    std::env::temp_dir().join(format!(
        "zeroshot-v2-run-ledger-{}-{nonce}.sqlite",
        std::process::id()
    ))
}

use openengine_cluster_testkit::assertions::{AssertAt, AssertError, AssertValue};
