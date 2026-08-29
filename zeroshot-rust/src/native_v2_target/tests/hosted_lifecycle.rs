use openengine_cluster_protocol::{
    Cursor, ExecutionRef, RunForceParams, RunId, RunListParams, RunLogsParams, RunStatusParams,
};
use openengine_cluster_testkit::assertions::AssertValue;
use zeroshot_engine::native_v2_cli::oecp::NamedTargetCliBackend;
use zeroshot_engine::native_v2_cli::{
    CliOutcome, CliRunStatus, CliSubscription, CliSubscriptionItem, NativeV2CliBackend,
    NativeV2CliCommand, NeverDetach, RunSelector, RunWatchCommand, execute_native_v2_cli,
};

use super::super::controller_authority::TargetCredentialStore;
use super::super::*;
use super::fixtures::*;
use super::hosted_authority::*;

#[tokio::test]
async fn hosted_lifecycle_stays_cloud_owned_from_queue_through_completion() {
    let root = temp_root();
    let (origin, server) = spawn_target_authority(50).await;
    let (credentials, authority) = test_authority(&root);
    let target = hosted_target("prod", origin);
    credentials
        .set(&target.id, "refresh-0")
        .await
        .assert_value();
    let registry = MemoryRegistry::default();
    registry.insert(target).assert_value();
    let dialer = FakeDialer::default();
    let backend = NamedTargetCliBackend::new(NativeV2TargetConnector::new(
        registry,
        authority,
        dialer.clone(),
        FakeSourceResolver,
    ));
    let run_id = RunId::new("run-hosted");

    assert_queued(&backend, &run_id).await;
    assert_truncated_watch_reconnects(&backend, &run_id).await;
    assert_retained_logs(&backend, &run_id).await;
    assert_force_while_queued(&backend, &run_id).await;

    assert!(dialer.sessions.lock().assert_value().is_empty());
    assert_cloud_requests(&server.await.assert_value());
}

async fn assert_queued<B>(backend: &B, run_id: &RunId)
where
    B: NativeV2CliBackend,
{
    let listed = backend
        .run_list(Some("prod"), RunListParams {})
        .await
        .assert_value();
    assert!(matches!(
        listed.runs.as_slice(),
        [run] if matches!(run.status, CliRunStatus::Queued(_))
    ));
    let status = backend
        .run_status(
            Some("prod"),
            RunStatusParams {
                run_id: run_id.clone(),
            },
        )
        .await
        .assert_value();
    assert!(matches!(status.status, CliRunStatus::Queued(_)));
}

async fn assert_truncated_watch_reconnects<B>(backend: &B, run_id: &RunId)
where
    B: NativeV2CliBackend,
{
    let mut output = Vec::new();
    let outcome = execute_native_v2_cli(
        NativeV2CliCommand::Watch(RunWatchCommand {
            run: RunSelector {
                target: Some("prod".to_owned()),
                run_id: run_id.clone(),
            },
            after: None,
        }),
        backend,
        &mut NeverDetach,
        &mut output,
    )
    .await
    .assert_value();
    assert_eq!(outcome, CliOutcome::Finished);
    let output = String::from_utf8(output).assert_value();
    assert_eq!(output.matches("\"cursor\":\"cloud:1\"").count(), 1);
    assert_eq!(output.matches("\"cursor\":\"v2:3\"").count(), 1);
}

async fn assert_retained_logs<B>(backend: &B, run_id: &RunId)
where
    B: NativeV2CliBackend,
{
    let execution = ExecutionRef::new("worker/1").assert_value();
    let mut logs = backend
        .run_logs(
            Some("prod"),
            RunLogsParams {
                run_id: run_id.clone(),
                from_cursor: Some(Cursor::new("v2:2")),
                execution: Some(execution.clone()),
            },
        )
        .await
        .assert_value();
    let log = logs.next().await.assert_value().assert_value();
    assert!(matches!(
        log,
        CliSubscriptionItem::Event(ref event)
            if event.cursor == Cursor::new("v2:4")
                && event.execution.as_ref() == Some(&execution)
    ));
}

async fn assert_force_while_queued<B>(backend: &B, run_id: &RunId)
where
    B: NativeV2CliBackend,
{
    let forced = backend
        .run_force(
            Some("prod"),
            RunForceParams {
                run_id: run_id.clone(),
            },
        )
        .await
        .assert_value();
    assert!(matches!(forced.status, CliRunStatus::Queued(_)));
}

fn assert_cloud_requests(requests: &[CapturedHttpRequest]) {
    assert_eq!(requests.len(), 50);
    assert!(
        requests
            .iter()
            .all(|request| request.path != "/native-v2/oecp-session")
    );
    assert!(requests.iter().any(|request| {
        request.path == "/native-v2/runs/run-hosted/watch?from_cursor=cloud%3A1"
    }));
    assert!(requests.iter().any(|request| {
        request.path == "/native-v2/runs/run-hosted/logs?from_cursor=v2%3A2&execution=worker%2F1"
    }));
    assert!(requests.iter().any(|request| {
        request.path == "/native-v2/runs/run-hosted/force" && request.body == "{}"
    }));
}
