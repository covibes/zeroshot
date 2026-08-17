use super::*;

#[tokio::test]
async fn attach_is_live_only_read_only_and_disconnect_does_not_cancel() {
    let mut fixture = live_attach_fixture("live-attach").await;
    persist_output(
        fixture.ledger.as_ref(),
        &fixture.run_id,
        fixture.reference.execution,
        fixture.durable.recv().await.assert_value(),
    )
    .await;

    let (_, mut historical) = fixture
        .service
        .logs(RunLogsParams {
            run_id: fixture.run_id.clone(),
            from_cursor: Some(Cursor::new("v2:2")),
            execution: Some(fixture.registration.public_execution().clone()),
        })
        .await
        .assert_value();
    let first_log = historical.recv().await.assert_value().assert_value();
    assert_eq!(first_log.record.message.as_str(), "before attach");

    let (attach_params, mut attached) = attach_working(&fixture).await;
    let (_, disconnected) = fixture.service.attach(attach_params).await.assert_value();
    drop(disconnected);

    fixture.release.notify_one();
    let event = attached.recv().await.assert_value();
    let text = match event.event {
        AgentAttachEvent::Output { text } => Some(text),
        _ => None,
    };
    let text = text.assert_value_with("the post-attach output must be live");
    assert_eq!(text.as_str(), "after attach");
    persist_output(
        fixture.ledger.as_ref(),
        &fixture.run_id,
        fixture.reference.execution,
        fixture.durable.recv().await.assert_value(),
    )
    .await;
    let completion = fixture.handle.completion().await.assert_value();
    assert!(matches!(completion.outcome, WorkerOutcome::Verified { .. }));
    fixture.registration.close().await;
    assert_attach_settled(&mut attached).await;

    let retained = historical.recv().await.assert_value().assert_value();
    assert_eq!(retained.record.message.as_str(), "after attach");
    assert!(historical.read_available().await.assert_value().is_empty());
}

use openengine_cluster_testkit::assertions::{AssertValue};
