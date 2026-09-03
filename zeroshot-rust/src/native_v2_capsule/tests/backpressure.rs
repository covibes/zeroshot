use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use async_trait::async_trait;
use openengine_cluster_protocol::{RunId, TokenCount};
use tokio::sync::{Notify, mpsc, oneshot};

use super::request;
use super::super::*;
use crate::native_v2_contract::TokenUsageDelta;
use crate::native_v2_runner::{
    AttachReceiveError, DURABLE_OUTPUT_CAPACITY, DurableOutput, ReadOnlyAttach, remote_node_handle,
};

use openengine_cluster_testkit::assertions::AssertValue;

#[derive(Default)]
struct SaturatingRunner {
    saturated: Arc<Notify>,
    cleaned: Arc<AtomicBool>,
}

#[async_trait]
impl NodeRunner for SaturatingRunner {
    async fn start(&self, request: NodeRunRequest) -> Result<NodeHandle, NodeRunnerError> {
        let reference = request.invocation.reference;
        let (handle, bridge) = remote_node_handle(reference);
        let saturated = self.saturated.clone();
        let cleaned = self.cleaned.clone();
        tokio::spawn(async move {
            for index in 0.. {
                if index == DURABLE_OUTPUT_CAPACITY * 2 + 1 {
                    saturated.notify_one();
                }
                let output =
                    LiveOutput::new(LiveOutputStream::Output, index.to_string()).assert_value();
                if bridge.emit(output).await.is_err() {
                    break;
                }
            }
            bridge
                .record_token_usage(Some(TokenUsageDelta {
                    input_tokens: TokenCount::new(21).assert_value(),
                    output_tokens: TokenCount::new(8).assert_value(),
                    cache_read_input_tokens: None,
                    cache_creation_input_tokens: None,
                }))
                .await
                .assert_value();
            cleaned.store(true, Ordering::SeqCst);
            bridge.finish(Err(NodeRunnerError::Cancelled));
        });
        Ok(handle)
    }

    async fn close_run(&self, _run_id: &RunId) {}
}

#[tokio::test]
async fn full_capsule_queue_cancels_cleanly_and_retains_usage() {
    let runner = Arc::new(SaturatingRunner::default());
    let endpoint = NativeCapsuleNodeEndpoint::new(runner.clone());
    let run_id = RunId::new("bounded-capsule");
    let mut stream = endpoint
        .start(request(run_id.as_str(), 1))
        .await
        .assert_value();
    tokio::time::timeout(Duration::from_secs(1), runner.saturated.notified())
        .await
        .assert_value();

    tokio::time::timeout(Duration::from_secs(1), endpoint.close_run(&run_id))
        .await
        .assert_value()
        .assert_value();
    assert!(runner.cleaned.load(Ordering::SeqCst));

    let mut outputs = 0;
    let mut usage = None;
    let mut failed = false;
    let mut unexpected = Vec::new();
    while let Some(event) = stream.recv().await {
        match event {
            CapsuleNodeEvent::Output { .. } => outputs += 1,
            CapsuleNodeEvent::TokenUsage { usage: observed } => usage = observed,
            CapsuleNodeEvent::Failed {
                failure: CapsuleNodeFailure::Cancelled,
            } => failed = true,
            event => unexpected.push(event),
        }
    }
    assert_eq!(outputs, DURABLE_OUTPUT_CAPACITY);
    assert_eq!(usage.assert_value().input_tokens.get(), 21);
    assert!(failed);
    assert!(unexpected.is_empty(), "unexpected events: {unexpected:?}");
}

#[tokio::test]
async fn cancelling_a_receive_does_not_lose_the_terminal_event() {
    let (events, receiver) = mpsc::channel(1);
    let (terminal, terminal_receiver) = oneshot::channel();
    let mut stream = CapsuleExecutionStream::from_bounded_receiver(receiver, terminal_receiver);
    drop(events);

    assert!(
        tokio::time::timeout(Duration::from_millis(20), stream.recv())
            .await
            .is_err()
    );
    terminal
        .send(vec![CapsuleNodeEvent::Failed {
            failure: CapsuleNodeFailure::Cancelled,
        }])
        .assert_value();
    assert!(matches!(
        stream.recv().await,
        Some(CapsuleNodeEvent::Failed {
            failure: CapsuleNodeFailure::Cancelled
        })
    ));
}

#[derive(Clone)]
struct SaturatingChannel {
    release: Arc<Notify>,
    loss: watch::Sender<bool>,
    events: Arc<StdMutex<Vec<RemoteEventSink>>>,
    cancel_calls: Arc<AtomicUsize>,
    close_calls: Arc<AtomicUsize>,
    hold_close: Arc<AtomicBool>,
    close_started: Arc<Notify>,
    close_release: Arc<Notify>,
}

type RemoteEventSink = (ExecutionRef, mpsc::Sender<CapsuleNodeEvent>);

impl SaturatingChannel {
    fn new() -> Self {
        let (loss, _) = watch::channel(false);
        Self {
            release: Arc::new(Notify::new()),
            loss,
            events: Arc::new(StdMutex::new(Vec::new())),
            cancel_calls: Arc::new(AtomicUsize::new(0)),
            close_calls: Arc::new(AtomicUsize::new(0)),
            hold_close: Arc::new(AtomicBool::new(false)),
            close_started: Arc::new(Notify::new()),
            close_release: Arc::new(Notify::new()),
        }
    }

    fn lose_connection(&self) {
        self.loss.send_replace(true);
    }

    fn hold_close(&self) {
        self.hold_close.store(true, Ordering::SeqCst);
    }

    async fn wait_for_close(&self) {
        self.close_started.notified().await;
    }

    fn release_close(&self) {
        self.close_release.notify_one();
    }

    async fn send_cancelled(&self, matches: impl Fn(&ExecutionRef) -> bool) {
        let streams = self
            .events
            .lock()
            .assert_value()
            .iter()
            .filter(|(reference, _)| matches(reference))
            .map(|(_, events)| events.clone())
            .collect::<Vec<_>>();
        for events in streams {
            let usage = TokenUsageDelta {
                input_tokens: TokenCount::new(1).assert_value(),
                output_tokens: TokenCount::new(1).assert_value(),
                cache_read_input_tokens: None,
                cache_creation_input_tokens: None,
            };
            let _ = events
                .send(CapsuleNodeEvent::TokenUsage { usage: Some(usage) })
                .await;
            let _ = events
                .send(CapsuleNodeEvent::Failed {
                    failure: CapsuleNodeFailure::Cancelled,
                })
                .await;
        }
    }
}

#[async_trait]
impl CapsuleNodeChannel for SaturatingChannel {
    async fn start(
        &self,
        request: NodeRunRequest,
    ) -> Result<CapsuleExecutionStream, CapsuleConnectionError> {
        let (events, receiver) = mpsc::channel(DURABLE_OUTPUT_CAPACITY);
        self.events
            .lock()
            .assert_value()
            .push((request.invocation.reference, events.clone()));
        let release = self.release.clone();
        tokio::spawn(async move {
            release.notified().await;
            for index in 0..=DURABLE_OUTPUT_CAPACITY {
                let output =
                    LiveOutput::new(LiveOutputStream::Output, index.to_string()).assert_value();
                if events
                    .send(CapsuleNodeEvent::Output {
                        output: output.into(),
                        timestamp: openengine_cluster_protocol::UnixTimestampMillis::new(1)
                            .assert_value(),
                    })
                    .await
                    .is_err()
                {
                    return;
                }
            }
        });
        Ok(CapsuleExecutionStream::from_receiver(receiver))
    }

    async fn cancel(&self, reference: &ExecutionRef) -> Result<(), CapsuleConnectionError> {
        self.cancel_calls.fetch_add(1, Ordering::SeqCst);
        self.send_cancelled(|candidate| candidate == reference)
            .await;
        Ok(())
    }

    async fn close_run(&self, run_id: &RunId) -> Result<(), CapsuleConnectionError> {
        self.close_calls.fetch_add(1, Ordering::SeqCst);
        if self.hold_close.load(Ordering::SeqCst) {
            self.close_started.notify_one();
            self.close_release.notified().await;
        }
        self.send_cancelled(|reference| &reference.run_id == run_id)
            .await;
        Ok(())
    }

    fn connection_loss(&self) -> watch::Receiver<bool> {
        self.loss.subscribe()
    }
}

async fn saturate_remote_bridge(
    channel: &SaturatingChannel,
    live: &mut ReadOnlyAttach,
) -> Result<(), AttachReceiveError> {
    channel.release.notify_one();
    let last = (DURABLE_OUTPUT_CAPACITY - 1).to_string();
    loop {
        match tokio::time::timeout(Duration::from_secs(1), live.recv())
            .await
            .assert_value()
        {
            Ok(output) if output.text == last => break,
            Ok(_) | Err(AttachReceiveError::Lagged) => {}
            Err(error) => return Err(error),
        }
    }
    tokio::task::yield_now().await;
    Ok(())
}

async fn saturated_remote(
    run_id: &str,
    control_timeout: Option<Duration>,
) -> (
    Arc<SaturatingChannel>,
    RemoteCapsuleNodeRunner,
    NodeHandle,
    DurableOutput,
) {
    let channel = Arc::new(SaturatingChannel::new());
    let mut proxy = RemoteCapsuleNodeRunner::new(channel.clone());
    if let Some(timeout) = control_timeout {
        proxy = proxy.with_control_timeout(timeout);
    }
    let mut handle = proxy.start(request(run_id, 1)).await.assert_value();
    let durable = handle.take_initial_output().assert_value();
    let mut live = handle.attach();
    saturate_remote_bridge(&channel, &mut live)
        .await
        .assert_value();
    (channel, proxy, handle, durable)
}

#[tokio::test]
async fn saturated_remote_cancel_is_forwarded_once_and_preserves_usage() {
    let (channel, _proxy, mut handle, mut durable) = saturated_remote("remote-cancel", None).await;

    handle.cancel();
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(1), handle.completion())
            .await
            .assert_value(),
        Err(NodeRunnerError::Cancelled)
    );
    assert_eq!(channel.cancel_calls.load(Ordering::SeqCst), 1);

    let mut usage = None;
    while let Ok(event) = durable.recv().await {
        if let DurableNodeEvent::TokenUsage(observed) = event {
            usage = observed;
        }
    }
    assert_eq!(usage.assert_value().input_tokens.get(), 1);
}

async fn assert_ordered_cancelled_output(mut durable: DurableOutput) {
    let mut outputs = 0;
    let mut usage = None;
    while let Ok(event) = durable.recv().await {
        match event {
            DurableNodeEvent::Output { output, .. } => {
                assert!(usage.is_none(), "output arrived after terminal usage");
                assert_eq!(output.text, outputs.to_string());
                outputs += 1;
            }
            DurableNodeEvent::TokenUsage(observed) => {
                assert!(usage.is_none(), "terminal usage was duplicated");
                usage = observed;
            }
        }
    }
    assert_eq!(outputs, DURABLE_OUTPUT_CAPACITY);
    assert_eq!(usage.assert_value().input_tokens.get(), 1);
}

#[tokio::test]
async fn connection_loss_interrupts_a_saturated_remote_send() {
    let (channel, _proxy, mut handle, _durable) = saturated_remote("remote-loss", None).await;

    channel.lose_connection();
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(1), handle.completion())
            .await
            .assert_value(),
        Err(NodeRunnerError::ConnectionLost)
    );
}

#[tokio::test]
async fn close_run_interrupts_a_saturated_remote_send() {
    let (channel, proxy, mut handle, durable) =
        saturated_remote("remote-close", Some(Duration::from_millis(20))).await;
    let loss = proxy.connection_loss();

    tokio::time::timeout(
        Duration::from_secs(1),
        proxy.close_run(&RunId::new("remote-close")),
    )
    .await
    .assert_value();
    assert_eq!(channel.close_calls.load(Ordering::SeqCst), 1);
    assert_eq!(channel.cancel_calls.load(Ordering::SeqCst), 0);
    assert!(!*loss.borrow());
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(1), handle.completion())
            .await
            .assert_value(),
        Err(NodeRunnerError::Cancelled)
    );

    assert_ordered_cancelled_output(durable).await;
}

#[tokio::test]
async fn close_run_does_not_interrupt_an_unrelated_execution() {
    let (channel, proxy, mut closing, durable) =
        saturated_remote("closing-run", Some(Duration::from_millis(20))).await;
    channel.hold_close();
    let mut unrelated = proxy
        .start(request("unrelated-run", 2))
        .await
        .assert_value();
    let loss = proxy.connection_loss();

    let close_proxy = proxy.clone();
    let mut close = tokio::spawn(async move {
        close_proxy.close_run(&RunId::new("closing-run")).await;
    });
    tokio::time::timeout(Duration::from_secs(1), channel.wait_for_close())
        .await
        .assert_value();
    assert!(
        tokio::time::timeout(Duration::from_millis(60), &mut close)
            .await
            .is_err(),
        "close_run used the shorter 20ms control timeout"
    );
    assert!(!*loss.borrow());
    assert!(
        tokio::time::timeout(Duration::from_millis(20), unrelated.completion())
            .await
            .is_err(),
        "slow close_run completed an execution from another run"
    );

    channel.release_close();
    tokio::time::timeout(Duration::from_secs(1), close)
        .await
        .assert_value()
        .assert_value();

    assert_eq!(closing.completion().await, Err(NodeRunnerError::Cancelled));
    assert!(!*loss.borrow());
    assert!(
        tokio::time::timeout(Duration::from_millis(20), unrelated.completion())
            .await
            .is_err(),
        "close_run completed an execution from another run"
    );
    assert_ordered_cancelled_output(durable).await;

    unrelated.cancel();
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(1), unrelated.completion())
            .await
            .assert_value(),
        Err(NodeRunnerError::Cancelled)
    );
    assert_eq!(channel.close_calls.load(Ordering::SeqCst), 1);
    assert_eq!(channel.cancel_calls.load(Ordering::SeqCst), 1);
}

#[path = "backpressure/endpoint_metadata.rs"]
mod endpoint_metadata;
