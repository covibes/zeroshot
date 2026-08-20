use tokio::sync::{broadcast, mpsc, oneshot, watch};

use super::{DurableOutput, LIVE_OUTPUT_CAPACITY, LiveOutput, NodeHandle, NodeRunnerError};
use crate::native_v2_contract::{ExecutionRef, NodeCompletion};

/// Producer half used only by the private capsule transport.
pub(crate) struct RemoteNodeHandleBridge {
    cancellation: watch::Receiver<bool>,
    output: Option<broadcast::Sender<LiveOutput>>,
    durable_output: Option<mpsc::UnboundedSender<LiveOutput>>,
    completion: Option<oneshot::Sender<Result<NodeCompletion, NodeRunnerError>>>,
}

pub(crate) fn remote_node_handle(reference: ExecutionRef) -> (NodeHandle, RemoteNodeHandleBridge) {
    let (cancel, cancellation) = watch::channel(false);
    let (output, _) = broadcast::channel(LIVE_OUTPUT_CAPACITY);
    let (durable_output, durable_receiver) = mpsc::unbounded_channel();
    let (completion, completion_receiver) = oneshot::channel();
    let handle = NodeHandle {
        reference,
        cancel,
        output: Some(output.clone()),
        initial_output: Some(DurableOutput {
            receiver: durable_receiver,
        }),
        completion: Some(completion_receiver),
        cancel_on_drop: true,
    };
    let bridge = RemoteNodeHandleBridge {
        cancellation,
        output: Some(output),
        durable_output: Some(durable_output),
        completion: Some(completion),
    };
    (handle, bridge)
}

impl RemoteNodeHandleBridge {
    pub(crate) async fn cancelled(&mut self) {
        while !*self.cancellation.borrow_and_update() {
            if self.cancellation.changed().await.is_err() {
                return;
            }
        }
    }

    pub(crate) fn emit(&self, output: LiveOutput) -> Result<(), NodeRunnerError> {
        self.durable_output
            .as_ref()
            .ok_or(NodeRunnerError::DurableOutputClosed)?
            .send(output.clone())
            .map_err(|_| NodeRunnerError::DurableOutputClosed)?;
        if let Some(live) = &self.output {
            let _ = live.send(output);
        }
        Ok(())
    }

    pub(crate) fn finish(mut self, result: Result<NodeCompletion, NodeRunnerError>) {
        self.durable_output.take();
        self.output.take();
        if let Some(completion) = self.completion.take() {
            let _ = completion.send(result);
        }
    }
}
