use tokio::sync::{broadcast, oneshot, watch};

use super::output::closed_live_attach;
use super::{DurableOutput, LiveOutput, LiveOutputSource, NodeRunnerError, ReadOnlyAttach};
use crate::native_v2_contract::{ExecutionRef, NodeCompletion};

pub struct NodeHandle {
    pub(super) reference: ExecutionRef,
    pub(super) cancel: watch::Sender<bool>,
    pub(super) output: Option<broadcast::Sender<LiveOutput>>,
    pub(super) initial_output: Option<DurableOutput>,
    pub(super) completion: Option<oneshot::Receiver<Result<NodeCompletion, NodeRunnerError>>>,
    pub(super) cancel_on_drop: bool,
}

impl NodeHandle {
    #[must_use]
    pub fn reference(&self) -> &ExecutionRef {
        &self.reference
    }

    pub fn cancel(&self) {
        let _ = self.cancel.send(true);
    }

    #[must_use]
    pub fn attach(&self) -> ReadOnlyAttach {
        self.live_output_source()
            .map_or_else(closed_live_attach, |source| source.subscribe())
    }

    /// Returns read-only subscription authority for an active execution.
    #[must_use]
    pub fn live_output_source(&self) -> Option<LiveOutputSource> {
        self.output.as_ref().map(|output| LiveOutputSource {
            output: output.clone(),
        })
    }

    /// Takes the receiver established before execution starts for durable log bridging.
    pub fn take_initial_output(&mut self) -> Option<DurableOutput> {
        self.initial_output.take()
    }

    /// Waits for completion without consuming the handle.
    ///
    /// Cancelling this wait leaves the receiver intact so a supervisor can signal cancellation
    /// and then wait again for the driver's cleanup acknowledgement. If the initial durable
    /// receiver was not taken, this wait drains it as needed so bounded producer backpressure
    /// cannot deadlock completion. Callers that need durable events must take the receiver first.
    pub async fn completion(&mut self) -> Result<NodeCompletion, NodeRunnerError> {
        let completed_while_draining = {
            let completion = self
                .completion
                .as_mut()
                .ok_or(NodeRunnerError::CompletionClosed)?;
            if let Some(output) = self.initial_output.as_mut() {
                loop {
                    tokio::select! {
                        biased;
                        result = &mut *completion => break Some(result),
                        () = output.wait_until_saturated() => {
                            let event = output.recv().await;
                            if event.is_err() {
                                break None;
                            }
                        }
                    }
                }
            } else {
                None
            }
        };
        let result = match completed_while_draining {
            Some(result) => result,
            None => {
                self.completion
                    .as_mut()
                    .ok_or(NodeRunnerError::CompletionClosed)?
                    .await
            }
        }
        .map_err(|_| NodeRunnerError::CompletionClosed)?;
        self.completion.take();
        self.output.take();
        self.cancel_on_drop = false;
        result
    }
}

impl Drop for NodeHandle {
    fn drop(&mut self) {
        if self.cancel_on_drop {
            let _ = self.cancel.send(true);
        }
    }
}
