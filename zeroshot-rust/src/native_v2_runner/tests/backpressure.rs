use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use openengine_cluster_protocol::{TokenCount, WorkerOutcome};
use tokio::sync::{broadcast, watch};

use super::super::{
    AttachReceiveError, DriverControl, DurableNodeEvent, DurableOutput, LiveOutput,
    LiveOutputStream, NodeRunner, NodeRunnerError, DURABLE_OUTPUT_CAPACITY,
};
use super::super::output::{
    CANCELLED_TERMINAL_CAPACITY, CANCELLED_TERMINAL_OVERFLOW_DETAIL,
    durable_event_channel_with_capacity,
};
use crate::native_v2_contract::TokenUsageDelta;
use crate::native_v2_runner::test_support::{FakeFactory, admitted, request};

use openengine_cluster_testkit::assertions::AssertValue;

fn control_with_capacity(capacity: usize) -> (watch::Sender<bool>, DriverControl, DurableOutput) {
    let (cancel, cancellation) = watch::channel(false);
    let (live_output, _) = broadcast::channel(1);
    let (durable_output, durable) = durable_event_channel_with_capacity(capacity);
    (
        cancel,
        DriverControl {
            cancellation,
            live_output,
            durable_output,
        },
        durable,
    )
}

async fn saturated_cancelled_control() -> (DriverControl, DurableOutput) {
    let (cancel, control, durable) = control_with_capacity(1);
    control
        .emit(LiveOutput::new(LiveOutputStream::Output, "queued").assert_value())
        .await
        .assert_value();
    cancel.send_replace(true);
    (control, durable)
}

fn token_usage(input_tokens: u64, output_tokens: u64) -> TokenUsageDelta {
    TokenUsageDelta {
        input_tokens: TokenCount::new(input_tokens).assert_value(),
        output_tokens: TokenCount::new(output_tokens).assert_value(),
        cache_read_input_tokens: None,
        cache_creation_input_tokens: None,
    }
}

#[tokio::test]
async fn durable_output_backpressure_is_lossless_and_ordered() {
    let (_cancel, control, mut durable) = control_with_capacity(1);
    control
        .emit(LiveOutput::new(LiveOutputStream::Output, "first").assert_value())
        .await
        .assert_value();
    let second = control.emit(LiveOutput::new(LiveOutputStream::Output, "second").assert_value());
    tokio::pin!(second);

    assert!(
        tokio::time::timeout(Duration::from_millis(20), &mut second)
            .await
            .is_err()
    );
    assert!(matches!(
        durable.recv().await,
        Ok(DurableNodeEvent::Output { output, .. }) if output.text == "first"
    ));
    second.await.assert_value();
    assert!(matches!(
        durable.recv().await,
        Ok(DurableNodeEvent::Output { output, .. }) if output.text == "second"
    ));
}

#[tokio::test]
async fn cancellation_does_not_discard_reported_token_usage() {
    let (cancel, control, mut durable) = control_with_capacity(1);
    control
        .emit(LiveOutput::new(LiveOutputStream::Output, "queued").assert_value())
        .await
        .assert_value();
    cancel.send_replace(true);
    let usage = token_usage(13, 5);

    tokio::time::timeout(
        Duration::from_millis(100),
        control.record_token_usage(Some(usage)),
    )
    .await
    .assert_value()
    .assert_value();
    assert!(matches!(
        durable.recv().await,
        Ok(DurableNodeEvent::Output { output, .. }) if output.text == "queued"
    ));
    assert_eq!(
        durable.recv().await,
        Ok(DurableNodeEvent::TokenUsage(Some(usage)))
    );
}

#[tokio::test]
async fn cancelled_terminal_queue_accepts_its_wide_capacity_without_blocking() {
    let (control, mut durable) = saturated_cancelled_control().await;

    for _ in 0..CANCELLED_TERMINAL_CAPACITY {
        tokio::time::timeout(Duration::from_millis(100), control.record_token_usage(None))
            .await
            .assert_value()
            .assert_value();
    }

    let mut events = Vec::with_capacity(CANCELLED_TERMINAL_CAPACITY + 1);
    assert_eq!(
        durable
            .recv_many(&mut events, CANCELLED_TERMINAL_CAPACITY + 1)
            .await,
        CANCELLED_TERMINAL_CAPACITY + 1
    );
    let (first, terminal) = events.split_first().assert_value();
    assert!(matches!(
        first,
        DurableNodeEvent::Output { output, .. } if output.text == "queued"
    ));
    assert!(
        terminal
            .iter()
            .all(|event| matches!(event, DurableNodeEvent::TokenUsage(None)))
    );
}

#[tokio::test]
async fn cancelled_terminal_queue_reports_immediate_safe_overflow() {
    let (control, mut durable) = saturated_cancelled_control().await;
    let usage = token_usage(1, 1);

    for _ in 0..CANCELLED_TERMINAL_CAPACITY {
        control.record_token_usage(Some(usage)).await.assert_value();
    }
    let result = tokio::time::timeout(
        Duration::from_millis(100),
        control.record_token_usage(Some(usage)),
    )
    .await
    .assert_value();
    assert_eq!(
        result,
        Err(NodeRunnerError::DriverDetail(
            CANCELLED_TERMINAL_OVERFLOW_DETAIL.to_owned()
        ))
    );

    drop(control);
    assert!(matches!(
        durable.recv().await,
        Ok(DurableNodeEvent::Output { output, .. }) if output.text == "queued"
    ));
    for _ in 0..CANCELLED_TERMINAL_CAPACITY {
        assert_eq!(
            durable.recv().await,
            Ok(DurableNodeEvent::TokenUsage(Some(usage)))
        );
    }
    assert_eq!(durable.recv().await, Ok(DurableNodeEvent::TokenUsage(None)));
    assert_eq!(durable.recv().await, Err(AttachReceiveError::Closed));
}

#[tokio::test]
async fn primary_events_remain_ordered_before_cancelled_terminal_events() {
    let (control, mut durable) = saturated_cancelled_control().await;
    let first = token_usage(1, 2);
    let second = token_usage(3, 4);
    control.record_token_usage(Some(first)).await.assert_value();

    assert!(matches!(
        durable.recv().await,
        Ok(DurableNodeEvent::Output { output, .. }) if output.text == "queued"
    ));

    // Once cancellation diverts a terminal event, later terminal events stay in that lane even
    // after the primary queue regains capacity. This keeps their send order observable.
    control
        .record_token_usage(Some(second))
        .await
        .assert_value();

    assert_eq!(
        durable.recv().await,
        Ok(DurableNodeEvent::TokenUsage(Some(first)))
    );
    assert_eq!(
        durable.recv().await,
        Ok(DurableNodeEvent::TokenUsage(Some(second)))
    );
}

struct CompletionBurstDriver;

#[async_trait]
impl super::super::NodeDriver for CompletionBurstDriver {
    async fn run(
        &self,
        _invocation: super::super::DriverInvocation,
        control: DriverControl,
    ) -> Result<WorkerOutcome, super::super::NodeRunnerError> {
        for index in 0..DURABLE_OUTPUT_CAPACITY + 1 {
            control
                .emit(LiveOutput::new(
                    LiveOutputStream::Output,
                    index.to_string(),
                )?)
                .await?;
        }
        Ok(WorkerOutcome::Verified {
            output: serde_json::Value::Null,
            artifacts: Vec::new(),
        })
    }
}

#[tokio::test]
async fn completion_without_a_durable_consumer_does_not_deadlock() {
    let runner = super::super::NativeNodeRunner::new(
        &admitted(),
        Arc::new(CompletionBurstDriver),
        Arc::new(FakeFactory::default()),
    )
    .assert_value();
    let mut handle = runner
        .start(request("completion-drain", "worker", (1, 1)))
        .await
        .assert_value();

    tokio::time::timeout(Duration::from_secs(1), handle.completion())
        .await
        .assert_value()
        .assert_value();
}
