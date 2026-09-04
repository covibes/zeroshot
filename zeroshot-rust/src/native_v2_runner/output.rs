use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use openengine_cluster_protocol::{MAX_SAFE_GENERATION, UnixTimestampMillis};
use tokio::sync::{broadcast, mpsc, watch, Notify};

use super::{
    DURABLE_OUTPUT_CAPACITY, DurableNodeEvent, LiveOutput, NodeRunnerError, wait_for_cancellation,
};

/// Built-in providers emit at most four terminal-usage records per execution: the initial turn,
/// one provider continuation, and two correction turns. Mirroring the primary durable capacity
/// leaves generous headroom for custom drivers while keeping cancellation cleanup memory bounded.
pub(super) const CANCELLED_TERMINAL_CAPACITY: usize = DURABLE_OUTPUT_CAPACITY;
pub(super) const CANCELLED_TERMINAL_OVERFLOW_DETAIL: &str =
    "terminal usage exceeded the cancellation-safe durable queue capacity";

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
/// Provider adapters emit bounded chunks while continuously draining the child process. The
/// bounded output queue applies backpressure until the durable consumer has persisted earlier
/// events. Once cancellation begins, terminal usage metadata takes a bounded, nonblocking side
/// channel so process cleanup cannot deadlock behind a saturated output queue. Side-channel
/// overflow is reported immediately and becomes one trailing incomplete-usage marker after both
/// queues close and drain.
pub struct DurableOutput {
    pub(super) receiver: mpsc::Receiver<DurableNodeEvent>,
    pub(super) cancelled_terminal: mpsc::Receiver<DurableNodeEvent>,
    cancelled_terminal_overflowed: Arc<AtomicBool>,
    usage_incomplete_emitted: bool,
    saturated: Arc<Notify>,
}

impl DurableOutput {
    pub(super) fn new(
        receiver: mpsc::Receiver<DurableNodeEvent>,
        cancelled_terminal: mpsc::Receiver<DurableNodeEvent>,
        cancelled_terminal_overflowed: Arc<AtomicBool>,
        saturated: Arc<Notify>,
    ) -> Self {
        Self {
            receiver,
            cancelled_terminal,
            cancelled_terminal_overflowed,
            usage_incomplete_emitted: false,
            saturated,
        }
    }

    pub(super) async fn wait_until_saturated(&self) {
        if self.receiver.capacity() > 0 {
            self.saturated.notified().await;
        }
    }

    pub async fn recv(&mut self) -> Result<DurableNodeEvent, AttachReceiveError> {
        loop {
            if let Some(event) = self.try_recv() {
                return Ok(event);
            }
            match self.recv_pending().await {
                Some(event) => return Ok(event),
                None => {
                    if let Some(result) = self.closed_result() {
                        return result;
                    }
                }
            }
        }
    }

    fn closed_result(&mut self) -> Option<Result<DurableNodeEvent, AttachReceiveError>> {
        if !self.receiver.is_closed() || !self.cancelled_terminal.is_closed() {
            return None;
        }
        Some(
            self.try_recv()
                .or_else(|| self.take_overflow_marker())
                .ok_or(AttachReceiveError::Closed),
        )
    }

    fn try_recv(&mut self) -> Option<DurableNodeEvent> {
        let event = self
            .receiver
            .try_recv()
            .ok()
            .or_else(|| self.cancelled_terminal.try_recv().ok());
        event.map(|event| self.observe(event))
    }

    fn observe(&mut self, event: DurableNodeEvent) -> DurableNodeEvent {
        if matches!(event, DurableNodeEvent::TokenUsage(None)) {
            self.usage_incomplete_emitted = true;
        }
        event
    }

    fn take_overflow_marker(&mut self) -> Option<DurableNodeEvent> {
        if !self
            .cancelled_terminal_overflowed
            .swap(false, Ordering::AcqRel)
            || self.usage_incomplete_emitted
        {
            return None;
        }
        self.usage_incomplete_emitted = true;
        Some(DurableNodeEvent::TokenUsage(None))
    }

    async fn recv_pending(&mut self) -> Option<DurableNodeEvent> {
        let event = match (
            self.receiver.is_closed(),
            self.cancelled_terminal.is_closed(),
        ) {
            (false, false) => tokio::select! {
                biased;
                event = self.receiver.recv() => event,
                event = self.cancelled_terminal.recv() => event,
            },
            (false, true) => self.receiver.recv().await,
            (true, false) => self.cancelled_terminal.recv().await,
            // Closure is monotonic. Recheck both queues only after observing that no sender can
            // race another enqueue; otherwise a terminal event sent between `try_recv` above and
            // these closure observations could be mistaken for an empty stream.
            (true, true) => return self.try_recv(),
        };
        event.map(|event| self.observe(event))
    }

    pub(crate) async fn recv_many(
        &mut self,
        events: &mut Vec<DurableNodeEvent>,
        limit: usize,
    ) -> usize {
        if limit == 0 {
            return 0;
        }
        let initial_len = events.len();
        let Ok(first) = self.recv().await else {
            return 0;
        };
        events.push(first);
        while events.len() - initial_len < limit {
            let Some(event) = self.try_recv() else {
                break;
            };
            events.push(event);
        }
        events.len() - initial_len
    }
}

#[derive(Clone)]
pub(super) struct DurableEventSender {
    events: mpsc::Sender<DurableNodeEvent>,
    cancelled_terminal: mpsc::Sender<DurableNodeEvent>,
    cancelled_terminal_active: Arc<AtomicBool>,
    cancelled_terminal_overflowed: Arc<AtomicBool>,
    saturated: Arc<Notify>,
}

impl DurableEventSender {
    pub(super) async fn send(
        &self,
        event: DurableNodeEvent,
        mut cancellation: watch::Receiver<bool>,
    ) -> Result<(), NodeRunnerError> {
        tokio::select! {
            biased;
            _ = wait_for_cancellation(&mut cancellation) => Err(NodeRunnerError::Cancelled),
            result = self.events.send(event) => {
                result.map_err(|_| NodeRunnerError::DurableOutputClosed)?;
                self.notify_if_saturated();
                Ok(())
            }
        }
    }

    pub(super) async fn send_terminal(
        &self,
        event: DurableNodeEvent,
        mut cancellation: watch::Receiver<bool>,
    ) -> Result<(), NodeRunnerError> {
        if self.cancelled_terminal_active.load(Ordering::Acquire) {
            return self.try_send_cancelled_terminal(event);
        }
        match self.events.try_send(event) {
            Ok(()) => {
                self.notify_if_saturated();
                Ok(())
            }
            Err(mpsc::error::TrySendError::Closed(_)) => Err(NodeRunnerError::DurableOutputClosed),
            Err(mpsc::error::TrySendError::Full(event)) => {
                let permit = self.events.reserve();
                tokio::pin!(permit);
                tokio::select! {
                    biased;
                    _ = wait_for_cancellation(&mut cancellation) => {
                        self.cancelled_terminal_active.store(true, Ordering::Release);
                        self.try_send_cancelled_terminal(event)
                    },
                    result = &mut permit => {
                        let permit = result.map_err(|_| NodeRunnerError::DurableOutputClosed)?;
                        permit.send(event);
                        self.notify_if_saturated();
                        Ok(())
                    }
                }
            }
        }
    }

    fn try_send_cancelled_terminal(&self, event: DurableNodeEvent) -> Result<(), NodeRunnerError> {
        match self.cancelled_terminal.try_send(event) {
            Ok(()) => Ok(()),
            Err(mpsc::error::TrySendError::Closed(_)) => Err(NodeRunnerError::DurableOutputClosed),
            Err(mpsc::error::TrySendError::Full(_)) => {
                self.cancelled_terminal_overflowed
                    .store(true, Ordering::Release);
                Err(NodeRunnerError::DriverDetail(
                    CANCELLED_TERMINAL_OVERFLOW_DETAIL.to_owned(),
                ))
            }
        }
    }

    fn notify_if_saturated(&self) {
        if self.events.capacity() == 0 {
            self.saturated.notify_one();
        }
    }
}

pub(super) fn durable_event_channel() -> (DurableEventSender, DurableOutput) {
    durable_event_channel_with_capacity(DURABLE_OUTPUT_CAPACITY)
}

pub(super) fn durable_event_channel_with_capacity(
    capacity: usize,
) -> (DurableEventSender, DurableOutput) {
    let (events, receiver) = mpsc::channel(capacity);
    let (cancelled_terminal, cancelled_terminal_receiver) =
        mpsc::channel(CANCELLED_TERMINAL_CAPACITY);
    let cancelled_terminal_active = Arc::new(AtomicBool::new(false));
    let cancelled_terminal_overflowed = Arc::new(AtomicBool::new(false));
    let saturated = Arc::new(Notify::new());
    (
        DurableEventSender {
            events,
            cancelled_terminal,
            cancelled_terminal_active,
            cancelled_terminal_overflowed: cancelled_terminal_overflowed.clone(),
            saturated: saturated.clone(),
        },
        DurableOutput::new(
            receiver,
            cancelled_terminal_receiver,
            cancelled_terminal_overflowed,
            saturated,
        ),
    )
}

pub(super) fn durable_output_event(output: LiveOutput) -> DurableNodeEvent {
    DurableNodeEvent::Output {
        output,
        timestamp: current_timestamp(),
    }
}

pub(super) fn current_timestamp() -> UnixTimestampMillis {
    let milliseconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .map_or(1, |duration| {
            u64::try_from(duration.as_millis())
                .unwrap_or(MAX_SAFE_GENERATION)
                .min(MAX_SAFE_GENERATION)
        })
        .max(1);
    UnixTimestampMillis::new(milliseconds).unwrap_or(UnixTimestampMillis::MIN)
}

impl ReadOnlyAttach {
    pub async fn recv(&mut self) -> Result<LiveOutput, AttachReceiveError> {
        self.receiver.recv().await.map_err(|error| match error {
            broadcast::error::RecvError::Closed => AttachReceiveError::Closed,
            broadcast::error::RecvError::Lagged(_) => AttachReceiveError::Lagged,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn closed_output_with_terminal_event() -> DurableOutput {
        let (sender, mut output) = durable_event_channel_with_capacity(1);
        assert!(output.try_recv().is_none());
        assert!(
            sender
                .cancelled_terminal
                .try_send(DurableNodeEvent::TokenUsage(None))
                .is_ok()
        );
        drop(sender);
        output
    }

    #[tokio::test]
    async fn closure_recheck_drains_terminal_event_enqueued_after_initial_probe() {
        let mut output = closed_output_with_terminal_event();

        assert_eq!(
            output.recv_pending().await,
            Some(DurableNodeEvent::TokenUsage(None))
        );
        assert_eq!(output.recv().await, Err(AttachReceiveError::Closed));
    }

    #[tokio::test]
    async fn closed_result_rechecks_the_other_lane_after_a_closed_lane_wakes_receive() {
        let mut output = closed_output_with_terminal_event();

        assert_eq!(
            output.closed_result(),
            Some(Ok(DurableNodeEvent::TokenUsage(None)))
        );
        assert_eq!(
            output.closed_result(),
            Some(Err(AttachReceiveError::Closed))
        );
    }

    #[tokio::test]
    async fn overflow_does_not_duplicate_an_existing_incomplete_marker() {
        let (sender, mut output) = durable_event_channel_with_capacity(1);
        sender
            .cancelled_terminal_overflowed
            .store(true, Ordering::Release);
        assert!(
            sender
                .cancelled_terminal
                .try_send(DurableNodeEvent::TokenUsage(None))
                .is_ok()
        );
        drop(sender);

        assert_eq!(output.recv().await, Ok(DurableNodeEvent::TokenUsage(None)));
        assert_eq!(output.recv().await, Err(AttachReceiveError::Closed));
    }
}
