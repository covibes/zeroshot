use tokio::sync::{broadcast, oneshot, watch};

use super::{
    DurableEventSender, DurableNodeEvent, LIVE_OUTPUT_CAPACITY, LiveOutput, NodeHandle,
    NodeRunnerError, durable_event_channel,
};
#[cfg(test)]
use super::output::current_timestamp;
use crate::native_v2_contract::{ExecutionRef, NodeCompletion, TokenUsageDelta};
use openengine_cluster_protocol::UnixTimestampMillis;

/// Producer half used only by the private capsule transport.
pub(crate) struct RemoteNodeHandleBridge {
    cancellation_signal: watch::Sender<bool>,
    cancellation: watch::Receiver<bool>,
    output: Option<broadcast::Sender<LiveOutput>>,
    durable_output: Option<DurableEventSender>,
    completion: Option<oneshot::Sender<Result<NodeCompletion, NodeRunnerError>>>,
}

pub(crate) fn remote_node_handle(reference: ExecutionRef) -> (NodeHandle, RemoteNodeHandleBridge) {
    let (cancel, cancellation) = watch::channel(false);
    let (output, _) = broadcast::channel(LIVE_OUTPUT_CAPACITY);
    let (durable_output, durable) = durable_event_channel();
    let (completion, completion_receiver) = oneshot::channel();
    let handle = NodeHandle {
        reference,
        cancel: cancel.clone(),
        output: Some(output.clone()),
        initial_output: Some(durable),
        completion: Some(completion_receiver),
        cancel_on_drop: true,
    };
    let bridge = RemoteNodeHandleBridge {
        cancellation_signal: cancel,
        cancellation,
        output: Some(output),
        durable_output: Some(durable_output),
        completion: Some(completion),
    };
    (handle, bridge)
}

impl RemoteNodeHandleBridge {
    pub(crate) fn cancellation_signal(&self) -> watch::Sender<bool> {
        self.cancellation_signal.clone()
    }

    pub(crate) async fn cancelled(&mut self) {
        while !*self.cancellation.borrow_and_update() {
            if self.cancellation.changed().await.is_err() {
                return;
            }
        }
    }

    #[cfg(test)]
    pub(crate) async fn emit(&self, output: LiveOutput) -> Result<(), NodeRunnerError> {
        self.emit_at(output, current_timestamp()).await
    }

    pub(crate) async fn emit_at(
        &self,
        output: LiveOutput,
        timestamp: UnixTimestampMillis,
    ) -> Result<(), NodeRunnerError> {
        self.send_durable(DurableNodeEvent::Output {
            output: output.clone(),
            timestamp,
        })
        .await?;
        if let Some(live) = &self.output {
            let _ = live.send(output);
        }
        Ok(())
    }

    pub(crate) async fn record_token_usage(
        &self,
        usage: Option<TokenUsageDelta>,
    ) -> Result<(), NodeRunnerError> {
        self.durable_output
            .as_ref()
            .ok_or(NodeRunnerError::DurableOutputClosed)?
            .send_terminal(
                DurableNodeEvent::TokenUsage(usage),
                self.cancellation.clone(),
            )
            .await
    }

    async fn send_durable(&self, event: DurableNodeEvent) -> Result<(), NodeRunnerError> {
        let durable = self
            .durable_output
            .as_ref()
            .ok_or(NodeRunnerError::DurableOutputClosed)?;
        durable.send(event, self.cancellation.clone()).await
    }

    pub(crate) fn finish(mut self, result: Result<NodeCompletion, NodeRunnerError>) {
        self.durable_output.take();
        self.output.take();
        if let Some(completion) = self.completion.take() {
            let _ = completion.send(result);
        }
    }
}
