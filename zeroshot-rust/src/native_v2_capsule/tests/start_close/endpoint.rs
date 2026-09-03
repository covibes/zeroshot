use std::{
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

use async_trait::async_trait;
use openengine_cluster_protocol::RunId;
use tokio::sync::Notify;

use super::{Gate, join_test_task, spawn_at_readiness, token_usage, within_one_second};
use super::super::request;
use super::super::super::*;
use crate::native_v2_runner::remote_node_handle;
use openengine_cluster_testkit::assertions::{AssertError, AssertValue};

#[derive(Default)]
struct DelayedRunner {
    start: Gate,
    close: Gate,
    cancelled: Arc<Notify>,
    finish: Arc<Notify>,
    start_calls: AtomicUsize,
}

#[async_trait]
impl NodeRunner for DelayedRunner {
    async fn start(&self, request: NodeRunRequest) -> Result<NodeHandle, NodeRunnerError> {
        self.start_calls.fetch_add(1, Ordering::SeqCst);
        self.start.enter().await;
        let (handle, mut bridge) = remote_node_handle(request.invocation.reference);
        let cancelled = self.cancelled.clone();
        let finish = self.finish.clone();
        tokio::spawn(async move {
            bridge.cancelled().await;
            bridge
                .record_token_usage(Some(token_usage()))
                .await
                .assert_value();
            cancelled.notify_one();
            finish.notified().await;
            bridge.finish(Err(NodeRunnerError::Cancelled));
        });
        Ok(handle)
    }

    async fn close_run(&self, _run_id: &RunId) {
        self.close.enter().await;
    }
}

struct PausedEndpointStart {
    runner: Arc<DelayedRunner>,
    endpoint: Arc<NativeCapsuleNodeEndpoint>,
    pause: StartReadinessPause,
    start: tokio::task::JoinHandle<Result<CapsuleExecutionStream, CapsuleConnectionError>>,
}

impl PausedEndpointStart {
    async fn begin(run_id: &str) -> Self {
        let runner = Arc::new(DelayedRunner::default());
        let pause = StartReadinessPause::default();
        let endpoint = Arc::new(
            NativeCapsuleNodeEndpoint::new(runner.clone())
                .with_start_readiness_pause(pause.clone()),
        );
        let start_endpoint = endpoint.clone();
        let run_id = run_id.to_owned();
        let start = spawn_at_readiness(
            async move { start_endpoint.start(request(&run_id, 1)).await },
            &runner.start,
            &pause,
        )
        .await;
        Self {
            runner,
            endpoint,
            pause,
            start,
        }
    }
}

async fn complete_delayed_runner_close(
    runner: &DelayedRunner,
    close: &mut tokio::task::JoinHandle<Result<(), CapsuleConnectionError>>,
) {
    within_one_second(runner.cancelled.notified()).await;
    runner.close.open();
    assert!(
        tokio::time::timeout(Duration::from_millis(20), &mut *close)
            .await
            .is_err(),
        "endpoint close returned before reserved execution cleanup"
    );
    runner.finish.notify_one();
    within_one_second(close).await.assert_value().assert_value();
}

#[tokio::test]
async fn endpoint_close_waits_for_an_active_start_and_preserves_usage() {
    let runner = Arc::new(DelayedRunner::default());
    let endpoint = Arc::new(NativeCapsuleNodeEndpoint::new(runner.clone()));
    let loss = endpoint.connection_loss();

    let start_endpoint = endpoint.clone();
    let start =
        tokio::spawn(async move { start_endpoint.start(request("endpoint-race", 1)).await });
    runner.start.wait().await;
    assert!(matches!(
        endpoint.start(request("endpoint-race", 1)).await,
        Err(CapsuleConnectionError::Rejected(
            CapsuleNodeFailure::ExecutionActive
        ))
    ));
    assert_eq!(runner.start_calls.load(Ordering::SeqCst), 1);

    runner.start.open();
    let mut stream = join_test_task(start).await.assert_value();
    let close_endpoint = endpoint.clone();
    let close =
        tokio::spawn(async move { close_endpoint.close_run(&RunId::new("endpoint-race")).await });
    runner.close.wait().await;
    let mut close = close;
    complete_delayed_runner_close(&runner, &mut close).await;

    let usage = stream.recv().await.assert_value();
    assert!(matches!(
        usage,
        CapsuleNodeEvent::TokenUsage { usage: Some(usage) }
            if usage.input_tokens.get() == 3 && usage.output_tokens.get() == 2
    ));
    assert!(matches!(
        stream.recv().await.assert_value(),
        CapsuleNodeEvent::Failed {
            failure: CapsuleNodeFailure::Cancelled
        }
    ));
    assert!(stream.recv().await.is_none());
    assert!(matches!(
        endpoint.start(request("endpoint-race", 2)).await,
        Err(CapsuleConnectionError::Rejected(
            CapsuleNodeFailure::RunClosed
        ))
    ));
    assert_eq!(runner.start_calls.load(Ordering::SeqCst), 1);
    assert!(!*loss.borrow());
}

#[tokio::test]
async fn dropping_endpoint_start_does_not_strand_its_reservation() {
    let runner = Arc::new(DelayedRunner::default());
    let endpoint = Arc::new(NativeCapsuleNodeEndpoint::new(runner.clone()));
    let start_endpoint = endpoint.clone();
    let start =
        tokio::spawn(async move { start_endpoint.start(request("endpoint-drop", 1)).await });
    runner.start.wait().await;
    start.abort();
    assert!(start.await.assert_error().is_cancelled());

    let close_endpoint = endpoint.clone();
    let close =
        tokio::spawn(async move { close_endpoint.close_run(&RunId::new("endpoint-drop")).await });
    runner.close.wait().await;
    runner.start.open();
    let mut close = close;
    complete_delayed_runner_close(&runner, &mut close).await;
    assert!(matches!(
        endpoint.start(request("endpoint-drop", 2)).await,
        Err(CapsuleConnectionError::Rejected(
            CapsuleNodeFailure::RunClosed
        ))
    ));
}

#[tokio::test]
async fn repeated_endpoint_cancellation_is_coalesced_while_cleanup_is_blocked() {
    let runner = Arc::new(DelayedRunner::default());
    let endpoint = NativeCapsuleNodeEndpoint::new(runner.clone());
    let run = request("endpoint-repeated-cancel", 1);
    let reference = run.invocation.reference.clone();
    let start_endpoint = endpoint.clone();
    let start = tokio::spawn(async move { start_endpoint.start(run).await });
    runner.start.wait().await;
    runner.start.open();
    let mut stream = join_test_task(start).await.assert_value();

    for _ in 0..4_096 {
        endpoint.cancel(&reference).await.assert_value();
    }
    within_one_second(runner.cancelled.notified()).await;
    runner.finish.notify_one();

    assert!(matches!(
        stream.recv().await,
        Some(CapsuleNodeEvent::TokenUsage { usage: Some(_) })
    ));
    assert!(matches!(
        stream.recv().await,
        Some(CapsuleNodeEvent::Failed {
            failure: CapsuleNodeFailure::Cancelled
        })
    ));
    assert!(stream.recv().await.is_none());
}

#[tokio::test]
async fn endpoint_close_rejects_readiness_sent_before_the_caller_can_receive_it() {
    let PausedEndpointStart {
        runner,
        endpoint,
        pause,
        start,
    } = PausedEndpointStart::begin("endpoint-ready-close").await;
    let loss = endpoint.connection_loss();
    assert!(!start.is_finished());

    let close_endpoint = endpoint.clone();
    let close = tokio::spawn(async move {
        close_endpoint
            .close_run(&RunId::new("endpoint-ready-close"))
            .await
    });
    runner.close.wait().await;
    let mut close = close;
    complete_delayed_runner_close(&runner, &mut close).await;
    assert!(!start.is_finished());

    pause.release();
    assert!(matches!(
        join_test_task(start).await,
        Err(CapsuleConnectionError::Rejected(
            CapsuleNodeFailure::RunClosed
        ))
    ));
    assert!(!*loss.borrow());
}

#[tokio::test]
async fn aborting_endpoint_start_after_readiness_cancels_and_drains_the_execution() {
    let PausedEndpointStart {
        runner,
        endpoint,
        pause,
        start,
    } = PausedEndpointStart::begin("endpoint-ready-abort").await;
    let loss = endpoint.connection_loss();
    start.abort();
    assert!(start.await.assert_error().is_cancelled());
    within_one_second(runner.cancelled.notified()).await;

    let close_endpoint = endpoint.clone();
    let mut close = tokio::spawn(async move {
        close_endpoint
            .close_run(&RunId::new("endpoint-ready-abort"))
            .await
    });
    runner.close.wait().await;
    runner.close.open();
    assert!(
        tokio::time::timeout(Duration::from_millis(20), &mut close)
            .await
            .is_err(),
        "endpoint close returned before abandoned execution cleanup"
    );
    runner.finish.notify_one();
    within_one_second(close).await.assert_value().assert_value();
    pause.release();
    assert!(!*loss.borrow());
}
