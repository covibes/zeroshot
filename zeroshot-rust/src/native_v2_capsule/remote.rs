use super::*;

mod activity;
mod execution;
mod start;
use activity::{ProxyActivity, ProxyRegistration};
use execution::drive_remote_execution;

#[derive(Clone)]
pub struct RemoteCapsuleNodeRunner {
    channel: Arc<dyn CapsuleNodeChannel>,
    connection_loss: watch::Receiver<bool>,
    loss: RunnerLoss,
    activity: ProxyActivity,
    control_timeout: Duration,
    close_timeout: Duration,
    #[cfg(test)]
    start_readiness_pause: Option<StartReadinessPause>,
}

impl RemoteCapsuleNodeRunner {
    #[must_use]
    pub fn new(channel: Arc<dyn CapsuleNodeChannel>) -> Self {
        let channel_loss = channel.connection_loss();
        let initially_lost = connection_is_lost(&channel_loss);
        let (loss, connection_loss) = RunnerLoss::new(initially_lost);
        if !initially_lost {
            let forward = loss.clone();
            tokio::spawn(async move {
                let mut channel_loss = channel_loss;
                wait_for_signal(&mut channel_loss).await;
                forward.promote();
            });
        }
        Self {
            channel,
            connection_loss,
            loss,
            activity: ProxyActivity::default(),
            control_timeout: CONTROL_RPC_TIMEOUT,
            close_timeout: CLOSE_RPC_TIMEOUT,
            #[cfg(test)]
            start_readiness_pause: None,
        }
    }

    #[cfg(test)]
    pub(super) async fn wait_for_test_run_settled(&self, run_id: &RunId) {
        self.activity.wait_run(run_id).await;
    }

    #[cfg(test)]
    pub(super) fn with_control_timeout(mut self, timeout: Duration) -> Self {
        self.control_timeout = timeout;
        self
    }

    #[cfg(test)]
    pub(super) fn with_close_timeout(mut self, timeout: Duration) -> Self {
        self.close_timeout = timeout;
        self
    }

    #[must_use]
    pub fn connection_loss(&self) -> watch::Receiver<bool> {
        self.connection_loss.clone()
    }
}

#[async_trait]
impl NodeRunner for RemoteCapsuleNodeRunner {
    async fn start(&self, request: NodeRunRequest) -> Result<NodeHandle, NodeRunnerError> {
        start::remote_start(self, request).await
    }

    async fn close_run(&self, run_id: &RunId) {
        self.activity.begin_close(run_id).await;
        let mut connection_loss = self.connection_loss.clone();
        let closed = control_rpc(
            self.channel.close_run(run_id),
            &mut connection_loss,
            self.close_timeout,
        )
        .await;
        if !closed {
            self.loss.promote();
        }
        self.activity.complete_close(run_id).await;
        if closed {
            self.activity.wait_run(run_id).await;
        } else {
            let _ =
                tokio::time::timeout(self.control_timeout, self.activity.wait_run(run_id)).await;
        }
    }
}

#[cfg(test)]
impl WithStartReadinessPause for RemoteCapsuleNodeRunner {
    fn start_readiness_pause(&mut self) -> &mut Option<StartReadinessPause> {
        &mut self.start_readiness_pause
    }
}

#[derive(Clone)]
struct RunnerLoss {
    raised: Arc<AtomicBool>,
    signal: watch::Sender<bool>,
}

impl RunnerLoss {
    fn new(initially_lost: bool) -> (Self, watch::Receiver<bool>) {
        let (signal, receiver) = watch::channel(initially_lost);
        (
            Self {
                raised: Arc::new(AtomicBool::new(initially_lost)),
                signal,
            },
            receiver,
        )
    }

    fn promote(&self) {
        if self
            .raised
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
        {
            self.signal.send_replace(true);
        }
    }
}

struct ProxyRuntime {
    channel: Arc<dyn CapsuleNodeChannel>,
    connection_loss: watch::Receiver<bool>,
    loss: RunnerLoss,
    activity: ProxyActivity,
    control_timeout: Duration,
}

struct RemoteExecutionTask {
    runtime: ProxyRuntime,
    reference: ExecutionRef,
    stream: CapsuleExecutionStream,
    bridge: RemoteNodeHandleBridge,
    registration: ProxyRegistration,
    acceptance: Option<oneshot::Receiver<()>>,
}

struct RemoteEventContext<'a> {
    runtime: &'a ProxyRuntime,
    reference: &'a ExecutionRef,
    bridge: &'a mut RemoteNodeHandleBridge,
    connection_loss: &'a mut watch::Receiver<bool>,
    closing: &'a mut watch::Receiver<bool>,
    pending_bridge_failure: &'a mut Option<NodeRunnerError>,
}

enum RemoteInput {
    Event(Option<CapsuleNodeEvent>),
    Cancel,
    Closing,
    Closed,
    Lost,
    Acceptance(Result<(), oneshot::error::RecvError>),
}

async fn settle_remote_acceptance(
    acceptance: &mut Option<oneshot::Receiver<()>>,
    connection_loss: &mut watch::Receiver<bool>,
    closing: &mut watch::Receiver<bool>,
) {
    if acceptance.is_none() {
        return;
    }
    tokio::select! {
        biased;
        () = wait_for_signal(connection_loss) => {}
        () = wait_for_signal(closing) => {}
        _ = receive_start_acceptance(acceptance) => {}
    }
    acceptance.take();
}

async fn handle_remote_cancel(
    context: RemoteCancelContext<'_>,
) -> Option<Result<NodeCompletion, NodeRunnerError>> {
    match forward_cancel(
        context.runtime,
        context.reference,
        context.connection_loss,
        context.closing_signal,
    )
    .await
    {
        CancelOutcome::Forwarded => None,
        CancelOutcome::Closing => {
            *context.closing = true;
            None
        }
        CancelOutcome::ConnectionLost => Some(Err(NodeRunnerError::ConnectionLost)),
    }
}

struct RemoteCancelContext<'a> {
    runtime: &'a ProxyRuntime,
    reference: &'a ExecutionRef,
    connection_loss: &'a mut watch::Receiver<bool>,
    closing_signal: &'a mut watch::Receiver<bool>,
    closing: &'a mut bool,
}

async fn next_remote_input(context: RemoteInputContext<'_>) -> RemoteInput {
    if context.closing {
        tokio::select! {
            biased;
            () = wait_for_signal(context.connection_loss) => RemoteInput::Lost,
            event = context.stream.recv() => RemoteInput::Event(event),
            () = wait_for_signal(context.closed_signal) => RemoteInput::Closed,
        }
    } else {
        tokio::select! {
            biased;
            () = wait_for_signal(context.connection_loss) => RemoteInput::Lost,
            () = wait_for_signal(context.closing_signal) => RemoteInput::Closing,
            () = context.bridge.cancelled(), if !context.cancellation_handled => RemoteInput::Cancel,
            input = receive_remote_event_or_acceptance(context.stream, context.acceptance) => input,
        }
    }
}

async fn receive_remote_event_or_acceptance(
    stream: &mut CapsuleExecutionStream,
    acceptance: &mut Option<oneshot::Receiver<()>>,
) -> RemoteInput {
    if acceptance.is_some() {
        RemoteInput::Acceptance(receive_start_acceptance(acceptance).await)
    } else {
        RemoteInput::Event(stream.recv().await)
    }
}

struct RemoteInputContext<'a> {
    stream: &'a mut CapsuleExecutionStream,
    bridge: &'a mut RemoteNodeHandleBridge,
    connection_loss: &'a mut watch::Receiver<bool>,
    closing_signal: &'a mut watch::Receiver<bool>,
    closed_signal: &'a mut watch::Receiver<bool>,
    closing: bool,
    cancellation_handled: bool,
    acceptance: &'a mut Option<oneshot::Receiver<()>>,
}

async fn handle_remote_event(
    event: Option<CapsuleNodeEvent>,
    context: RemoteEventContext<'_>,
) -> Option<Result<NodeCompletion, NodeRunnerError>> {
    match event {
        None => {
            context.runtime.loss.promote();
            Some(Err(NodeRunnerError::ConnectionLost))
        }
        Some(CapsuleNodeEvent::Output { output, timestamp }) => {
            handle_remote_output(output, timestamp, context).await
        }
        Some(CapsuleNodeEvent::TokenUsage { usage }) => {
            let result = await_remote_bridge(
                context.bridge.record_token_usage(usage),
                context.connection_loss,
            )
            .await;
            handle_remote_bridge(result, context).await
        }
        Some(CapsuleNodeEvent::Completed { completion })
            if completion.reference == *context.reference =>
        {
            Some(Ok(completion))
        }
        Some(CapsuleNodeEvent::Completed { .. }) => Some(Err(NodeRunnerError::Driver)),
        Some(CapsuleNodeEvent::Failed { failure }) => Some(Err(failure.into_runner())),
    }
}

async fn handle_remote_output(
    output: CapsuleOutput,
    timestamp: openengine_cluster_protocol::UnixTimestampMillis,
    context: RemoteEventContext<'_>,
) -> Option<Result<NodeCompletion, NodeRunnerError>> {
    let output = match output.into_live() {
        Ok(output) => output,
        Err(error) => return Some(Err(error)),
    };
    let result = await_remote_bridge(
        context.bridge.emit_at(output, timestamp),
        context.connection_loss,
    )
    .await;
    handle_remote_bridge(result, context).await
}

async fn await_remote_bridge<F>(
    operation: F,
    connection_loss: &mut watch::Receiver<bool>,
) -> Result<(), NodeRunnerError>
where
    F: Future<Output = Result<(), NodeRunnerError>>,
{
    tokio::pin!(operation);
    tokio::select! {
        biased;
        () = wait_for_signal(connection_loss) => {
            Err(NodeRunnerError::ConnectionLost)
        }
        result = &mut operation => result,
    }
}

async fn handle_remote_bridge(
    result: Result<(), NodeRunnerError>,
    context: RemoteEventContext<'_>,
) -> Option<Result<NodeCompletion, NodeRunnerError>> {
    let Err(error) = result else {
        return None;
    };
    match error {
        NodeRunnerError::Cancelled => None,
        NodeRunnerError::ConnectionLost => Some(Err(NodeRunnerError::ConnectionLost)),
        error => match forward_cancel(
            context.runtime,
            context.reference,
            context.connection_loss,
            context.closing,
        )
        .await
        {
            CancelOutcome::Forwarded => Some(Err(error)),
            CancelOutcome::Closing => {
                if context.pending_bridge_failure.is_none() {
                    *context.pending_bridge_failure = Some(error);
                }
                None
            }
            CancelOutcome::ConnectionLost => Some(Err(NodeRunnerError::ConnectionLost)),
        },
    }
}

enum CancelOutcome {
    Forwarded,
    Closing,
    ConnectionLost,
}

async fn forward_cancel(
    runtime: &ProxyRuntime,
    reference: &ExecutionRef,
    connection_loss: &mut watch::Receiver<bool>,
    closing: &mut watch::Receiver<bool>,
) -> CancelOutcome {
    let cancel = runtime.channel.cancel(reference);
    tokio::pin!(cancel);
    let outcome = tokio::select! {
        biased;
        () = wait_for_signal(connection_loss) => CancelOutcome::ConnectionLost,
        () = wait_for_signal(closing) => CancelOutcome::Closing,
        result = &mut cancel => if result.is_ok() {
            CancelOutcome::Forwarded
        } else {
            CancelOutcome::ConnectionLost
        },
        () = tokio::time::sleep(runtime.control_timeout) => CancelOutcome::ConnectionLost,
    };
    if matches!(outcome, CancelOutcome::ConnectionLost) {
        runtime.loss.promote();
    }
    outcome
}

async fn control_rpc<F>(
    operation: F,
    connection_loss: &mut watch::Receiver<bool>,
    timeout: Duration,
) -> bool
where
    F: Future<Output = Result<(), CapsuleConnectionError>>,
{
    tokio::pin!(operation);
    tokio::select! {
        biased;
        () = wait_for_signal(connection_loss) => false,
        result = &mut operation => result.is_ok(),
        () = tokio::time::sleep(timeout) => false,
    }
}

fn connection_is_lost(receiver: &watch::Receiver<bool>) -> bool {
    *receiver.borrow() || receiver.has_changed().is_err()
}
