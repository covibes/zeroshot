use std::{
    sync::{
        Arc, Mutex as StdMutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

use async_trait::async_trait;
use openengine_cluster_protocol::RunId;
use tokio::sync::{Notify, mpsc, watch};

use super::{Gate, join_test_task, spawn_at_readiness, token_usage, within_one_second};
use super::super::request;
use super::super::super::*;
use crate::native_v2_contract::ExecutionRef;
use openengine_cluster_testkit::assertions::{AssertError, AssertValue};

#[derive(Clone)]
struct DelayedChannel {
    start: Gate,
    close: Gate,
    fail_close: Arc<std::sync::atomic::AtomicBool>,
    loss: watch::Sender<bool>,
    events: Arc<StdMutex<Option<EventSender>>>,
    cancel_calls: Arc<AtomicUsize>,
    cancelled: Arc<Notify>,
    usage_sent: Arc<Notify>,
    failure_release: Arc<Notify>,
    start_calls: Arc<AtomicUsize>,
}

type EventSender = mpsc::Sender<CapsuleNodeEvent>;

impl DelayedChannel {
    fn new() -> Self {
        let (loss, _) = watch::channel(false);
        Self {
            start: Gate::default(),
            close: Gate::default(),
            fail_close: Arc::default(),
            loss,
            events: Arc::default(),
            cancel_calls: Arc::default(),
            cancelled: Arc::default(),
            usage_sent: Arc::default(),
            failure_release: Arc::default(),
            start_calls: Arc::default(),
        }
    }

    fn fail_close(&self) {
        self.fail_close.store(true, Ordering::SeqCst);
    }
}

#[async_trait]
impl CapsuleNodeChannel for DelayedChannel {
    async fn start(
        &self,
        _request: NodeRunRequest,
    ) -> Result<CapsuleExecutionStream, CapsuleConnectionError> {
        self.start_calls.fetch_add(1, Ordering::SeqCst);
        self.start.enter().await;
        let (events, receiver) = mpsc::channel(DURABLE_OUTPUT_CAPACITY);
        *self.events.lock().assert_value() = Some(events);
        Ok(CapsuleExecutionStream::from_receiver(receiver))
    }

    async fn cancel(&self, _reference: &ExecutionRef) -> Result<(), CapsuleConnectionError> {
        self.cancel_calls.fetch_add(1, Ordering::SeqCst);
        let events = self.events.lock().assert_value().clone().assert_value();
        events
            .send(CapsuleNodeEvent::Failed {
                failure: CapsuleNodeFailure::Cancelled,
            })
            .await
            .assert_value();
        self.cancelled.notify_one();
        Ok(())
    }

    async fn close_run(&self, _run_id: &RunId) -> Result<(), CapsuleConnectionError> {
        if self.fail_close.load(Ordering::SeqCst) {
            return Err(CapsuleConnectionError::Lost);
        }
        self.close.enter().await;
        let events = self.events.lock().assert_value().clone().assert_value();
        events
            .send(CapsuleNodeEvent::TokenUsage {
                usage: Some(token_usage()),
            })
            .await
            .assert_value();
        self.usage_sent.notify_one();
        self.failure_release.notified().await;
        events
            .send(CapsuleNodeEvent::Failed {
                failure: CapsuleNodeFailure::Cancelled,
            })
            .await
            .assert_value();
        Ok(())
    }

    fn connection_loss(&self) -> watch::Receiver<bool> {
        self.loss.subscribe()
    }
}

struct PausedRemoteStart {
    channel: Arc<DelayedChannel>,
    proxy: RemoteCapsuleNodeRunner,
    pause: StartReadinessPause,
    start: tokio::task::JoinHandle<Result<NodeHandle, NodeRunnerError>>,
}

impl PausedRemoteStart {
    async fn begin(run_id: &str) -> Self {
        let channel = Arc::new(DelayedChannel::new());
        let pause = StartReadinessPause::default();
        let proxy =
            RemoteCapsuleNodeRunner::new(channel.clone()).with_start_readiness_pause(pause.clone());
        let start_proxy = proxy.clone();
        let run_id = run_id.to_owned();
        let start = spawn_at_readiness(
            async move { start_proxy.start(request(&run_id, 1)).await },
            &channel.start,
            &pause,
        )
        .await;
        Self {
            channel,
            proxy,
            pause,
            start,
        }
    }
}

async fn begin_remote_close(
    proxy: &RemoteCapsuleNodeRunner,
    channel: &DelayedChannel,
    run_id: &str,
) -> tokio::task::JoinHandle<()> {
    let close_proxy = proxy.clone();
    let run_id = RunId::new(run_id);
    let close = tokio::spawn(async move {
        close_proxy.close_run(&run_id).await;
    });
    channel.close.wait().await;
    channel.close.open();
    within_one_second(channel.usage_sent.notified()).await;
    close
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn failed_remote_close_always_classifies_active_execution_as_connection_loss() {
    for execution in 1..=128 {
        let channel = Arc::new(DelayedChannel::new());
        channel.start.open();
        channel.fail_close();
        let proxy = RemoteCapsuleNodeRunner::new(channel.clone());
        let mut handle = proxy
            .start(request("proxy-close-failure", execution))
            .await
            .assert_value();

        proxy.close_run(&RunId::new("proxy-close-failure")).await;

        let completion = handle.completion().await;
        assert_eq!(
            completion,
            Err(NodeRunnerError::ConnectionLost),
            "cancel calls: {}",
            channel.cancel_calls.load(Ordering::SeqCst)
        );
        assert!(*proxy.connection_loss().borrow());
    }
}

#[tokio::test]
async fn remote_proxy_close_waits_for_an_active_start_and_preserves_usage() {
    let channel = Arc::new(DelayedChannel::new());
    let proxy = RemoteCapsuleNodeRunner::new(channel.clone());
    let loss = proxy.connection_loss();

    let start_proxy = proxy.clone();
    let start = tokio::spawn(async move { start_proxy.start(request("proxy-race", 1)).await });
    channel.start.wait().await;
    assert!(matches!(
        proxy.start(request("proxy-race", 1)).await,
        Err(NodeRunnerError::ExecutionActive)
    ));
    assert_eq!(channel.start_calls.load(Ordering::SeqCst), 1);

    channel.start.open();
    let mut handle = join_test_task(start).await.assert_value();
    let mut durable = handle.take_initial_output().assert_value();
    let close = begin_remote_close(&proxy, &channel, "proxy-race").await;
    let usage = within_one_second(durable.recv()).await.assert_value();
    assert!(matches!(
        usage,
        DurableNodeEvent::TokenUsage(Some(usage))
            if usage.input_tokens.get() == 3 && usage.output_tokens.get() == 2
    ));
    let mut close = close;
    assert!(
        tokio::time::timeout(Duration::from_millis(20), &mut close)
            .await
            .is_err(),
        "proxy close returned before the reserved start finished cleanup"
    );
    channel.failure_release.notify_one();
    within_one_second(close).await.assert_value();
    assert_eq!(handle.completion().await, Err(NodeRunnerError::Cancelled));
    assert!(!*loss.borrow());
    assert_eq!(channel.cancel_calls.load(Ordering::SeqCst), 0);
    assert!(matches!(
        proxy.start(request("proxy-race", 2)).await,
        Err(NodeRunnerError::RunClosed)
    ));
    assert_eq!(channel.start_calls.load(Ordering::SeqCst), 1);

    channel.start.open();
    let unrelated = proxy.start(request("proxy-unrelated", 2)).await;
    assert!(unrelated.is_ok());
    assert_eq!(channel.start_calls.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn dropping_remote_start_does_not_strand_its_reservation() {
    let channel = Arc::new(DelayedChannel::new());
    let proxy = RemoteCapsuleNodeRunner::new(channel.clone());
    let start_proxy = proxy.clone();
    let start = tokio::spawn(async move { start_proxy.start(request("proxy-drop", 1)).await });
    channel.start.wait().await;
    start.abort();
    assert!(start.await.assert_error().is_cancelled());

    let close_proxy = proxy.clone();
    let close = tokio::spawn(async move {
        close_proxy.close_run(&RunId::new("proxy-drop")).await;
    });
    channel.close.wait().await;
    channel.start.open();
    channel.close.open();
    within_one_second(channel.usage_sent.notified()).await;
    let mut close = close;
    assert!(
        tokio::time::timeout(Duration::from_millis(20), &mut close)
            .await
            .is_err(),
        "proxy close returned before abandoned-start cleanup"
    );
    channel.failure_release.notify_one();
    within_one_second(close).await.assert_value();
    assert!(matches!(
        proxy.start(request("proxy-drop", 2)).await,
        Err(NodeRunnerError::RunClosed)
    ));
    assert!(!*proxy.connection_loss().borrow());
}

#[tokio::test]
async fn remote_close_rejects_readiness_sent_before_the_caller_can_receive_it() {
    let PausedRemoteStart {
        channel,
        proxy,
        pause,
        start,
    } = PausedRemoteStart::begin("proxy-ready-close").await;
    let loss = proxy.connection_loss();
    assert!(!start.is_finished());

    let mut close = begin_remote_close(&proxy, &channel, "proxy-ready-close").await;
    assert!(
        tokio::time::timeout(Duration::from_millis(20), &mut close)
            .await
            .is_err(),
        "proxy close returned before terminal usage and cleanup completed"
    );
    channel.failure_release.notify_one();
    within_one_second(close).await.assert_value();
    assert!(!start.is_finished());

    pause.release();
    assert!(matches!(
        join_test_task(start).await,
        Err(NodeRunnerError::RunClosed)
    ));
    assert_eq!(channel.cancel_calls.load(Ordering::SeqCst), 0);
    assert!(!*loss.borrow());
}

#[tokio::test]
async fn aborting_remote_start_after_readiness_cancels_and_drains_the_execution() {
    let PausedRemoteStart {
        channel,
        proxy,
        pause,
        start,
    } = PausedRemoteStart::begin("proxy-ready-abort").await;
    let run_id = RunId::new("proxy-ready-abort");
    start.abort();
    assert!(start.await.assert_error().is_cancelled());
    within_one_second(channel.cancelled.notified()).await;
    within_one_second(proxy.wait_for_test_run_settled(&run_id)).await;

    pause.release();
    assert_eq!(channel.cancel_calls.load(Ordering::SeqCst), 1);
    assert!(!*proxy.connection_loss().borrow());
}
