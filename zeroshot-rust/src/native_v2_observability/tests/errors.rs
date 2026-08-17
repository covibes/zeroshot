use super::*;

#[tokio::test]
async fn opaque_selectors_disambiguate_parallel_verifier_attachments() {
    let (ledger, run_id) = ledger_run("parallel-attach").await;
    let left = reference(&run_id, "left", 1);
    let right = reference(&run_id, "right", 2);
    ledger
        .append(
            &run_id,
            vec![RunEvent::RunStarted, started(&left), started(&right)],
        )
        .await
        .assert_value();
    let barrier = Arc::new(Barrier::new(3));
    let admitted = admitted_run();
    let runner = NativeNodeRunner::new(
        &admitted,
        Arc::new(ParallelVerifierDriver {
            release: barrier.clone(),
        }),
        Arc::new(FakeSessions),
    )
    .assert_value();
    let mut left_handle = runner.start(node_request(&left)).await.assert_value();
    let mut right_handle = runner.start(node_request(&right)).await.assert_value();
    let service = NativeV2Observability::new(ledger);
    let left_registration = service
        .register_live_execution(&left, left_handle.live_output_source().assert_value())
        .await
        .assert_value();
    let right_registration = service
        .register_live_execution(&right, right_handle.live_output_source().assert_value())
        .await
        .assert_value();
    let (_, mut left_attach) = service
        .attach(RunAttachParams {
            run_id: run_id.clone(),
            execution: left_registration.public_execution().clone(),
        })
        .await
        .assert_value();
    let (_, mut right_attach) = service
        .attach(RunAttachParams {
            run_id,
            execution: right_registration.public_execution().clone(),
        })
        .await
        .assert_value();
    left_attach.recv().await.assert_value();
    right_attach.recv().await.assert_value();
    barrier.wait().await;

    assert_eq!(attach_text(&mut left_attach).await, "left");
    assert_eq!(attach_text(&mut right_attach).await, "right");
    left_handle.completion().await.assert_value();
    right_handle.completion().await.assert_value();
    left_registration.close().await;
    right_registration.close().await;
}

fn node_request(reference: &ExecutionRef) -> NodeRunRequest {
    let binding = agent_binding();
    NodeRunRequest {
        invocation: NodeInvocation {
            reference: reference.clone(),
            worker: WorkerRef::new(format!("agent.{}@1", reference.node.as_str())).assert_value(),
            input: Value::Null,
            binding: binding.clone(),
        },
        environment: ResolvedEnvironment::exact(&binding, BTreeMap::new()).assert_value(),
    }
}

pub(super) async fn attach_text(subscription: &mut RunAttachSubscription) -> String {
    let event = subscription.recv().await.assert_value().event;
    let text = match event {
        AgentAttachEvent::Output { text } => Some(text),
        _ => None,
    };
    let text = text.assert_value_with("expected live verifier output");
    text.as_str().to_owned()
}

pub(super) async fn persist_output(
    ledger: &dyn RunLedger,
    run_id: &RunId,
    execution: ExecutionId,
    output: LiveOutput,
) {
    let stream = match output.stream {
        LiveOutputStream::Output => SafeLogStream::Output,
        LiveOutputStream::Error => SafeLogStream::Error,
        LiveOutputStream::System => SafeLogStream::System,
    };
    ledger
        .append(
            run_id,
            vec![RunEvent::SafeLog {
                execution: Some(execution),
                stream,
                line: SafeLogLine::new(output.text).assert_value(),
            }],
        )
        .await
        .assert_value();
}

use openengine_cluster_testkit::assertions::{AssertValue};
