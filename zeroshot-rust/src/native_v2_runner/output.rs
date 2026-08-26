use tokio::sync::{broadcast, mpsc};

use super::{DurableNodeEvent, LiveOutput};

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
pub enum AttachReceiveError {
    #[error("node output stream closed")]
    Closed,
    #[error("live attachment fell behind; reconnect through durable logs")]
    Lagged,
}

pub struct ReadOnlyAttach {
    receiver: broadcast::Receiver<LiveOutput>,
}

#[derive(Clone)]
pub struct LiveOutputSource {
    pub(super) output: broadcast::Sender<LiveOutput>,
}

impl LiveOutputSource {
    #[must_use]
    pub fn subscribe(&self) -> ReadOnlyAttach {
        ReadOnlyAttach {
            receiver: self.output.subscribe(),
        }
    }
}

pub(super) fn closed_live_attach() -> ReadOnlyAttach {
    let (output, receiver) = broadcast::channel(1);
    drop(output);
    ReadOnlyAttach { receiver }
}

/// Lossless run-local bridge into the durable log writer.
///
/// Harnesses bound the total provider output accepted for one execution, so this queue remains
/// bounded by that harness cap without blocking provider process cleanup.
pub struct DurableOutput {
    pub(super) receiver: mpsc::UnboundedReceiver<DurableNodeEvent>,
}

impl DurableOutput {
    pub async fn recv(&mut self) -> Result<DurableNodeEvent, AttachReceiveError> {
        self.receiver.recv().await.ok_or(AttachReceiveError::Closed)
    }
}

impl ReadOnlyAttach {
    pub async fn recv(&mut self) -> Result<LiveOutput, AttachReceiveError> {
        self.receiver.recv().await.map_err(|error| match error {
            broadcast::error::RecvError::Closed => AttachReceiveError::Closed,
            broadcast::error::RecvError::Lagged(_) => AttachReceiveError::Lagged,
        })
    }
}
