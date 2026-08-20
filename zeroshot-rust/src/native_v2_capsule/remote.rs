use super::*;

#[derive(Clone)]
pub struct RemoteCapsuleNodeRunner {
    channel: Arc<dyn CapsuleNodeChannel>,
    connection_loss: watch::Receiver<bool>,
    loss: RunnerLoss,
    activity: ProxyActivity,
    control_timeout: Duration,
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
                wait_for_connection_loss(&mut channel_loss).await;
                forward.promote();
            });
        }
        Self {
            channel,
            connection_loss,
            loss,
            activity: ProxyActivity::default(),
            control_timeout: CONTROL_RPC_TIMEOUT,
        }
    }

    #[cfg(test)]
    pub(super) fn with_control_timeout(mut self, timeout: Duration) -> Self {
        self.control_timeout = timeout;
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
        if connection_is_lost(&self.connection_loss) {
            return Err(NodeRunnerError::ConnectionLost);
        }
        let reference = request.invocation.reference.clone();
        let mut connection_loss = self.connection_loss.clone();
        let start = self.channel.start(request);
        tokio::pin!(start);
        let stream = tokio::select! {
            result = &mut start => match result {
                Ok(stream) => stream,
                Err(CapsuleConnectionError::Lost) => {
                    self.loss.promote();
                    return Err(NodeRunnerError::ConnectionLost);
                }
                Err(CapsuleConnectionError::Rejected(failure)) => {
                    return Err(failure.into_runner());
                }
            },
            () = wait_for_connection_loss(&mut connection_loss) => {
                return Err(NodeRunnerError::ConnectionLost);
            }
        };
        let (handle, bridge) = remote_node_handle(reference.clone());
        let registration = self.activity.register(reference.clone()).await;
        let runtime = ProxyRuntime {
            channel: self.channel.clone(),
            connection_loss: self.connection_loss.clone(),
            loss: self.loss.clone(),
            activity: self.activity.clone(),
            control_timeout: self.control_timeout,
        };
        tokio::spawn(drive_remote_execution(RemoteExecutionTask {
            runtime,
            reference,
            stream,
            bridge,
            registration,
        }));
        Ok(handle)
    }

    async fn close_run(&self, run_id: &RunId) {
        let mut connection_loss = self.connection_loss.clone();
        let closed = control_rpc(
            self.channel.close_run(run_id),
            &mut connection_loss,
            self.control_timeout,
        )
        .await;
        if !closed {
            self.loss.promote();
            self.activity.lose_run(run_id).await;
        }
        if tokio::time::timeout(self.control_timeout, self.activity.wait_run(run_id))
            .await
            .is_err()
        {
            self.loss.promote();
            self.activity.lose_run(run_id).await;
            let _ =
                tokio::time::timeout(self.control_timeout, self.activity.wait_run(run_id)).await;
        }
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
}

struct RemoteEventContext<'a> {
    runtime: &'a ProxyRuntime,
    reference: &'a ExecutionRef,
    bridge: &'a mut RemoteNodeHandleBridge,
    connection_loss: &'a mut watch::Receiver<bool>,
}

enum RemoteInput {
    Event(Option<CapsuleNodeEvent>),
    Cancel,
    Lost,
}

async fn drive_remote_execution(task: RemoteExecutionTask) {
    let RemoteExecutionTask {
        runtime,
        reference,
        mut stream,
        mut bridge,
        registration,
    } = task;
    let mut local_loss = registration.loss;
    let mut cancellation_forwarded = false;
    let mut connection_loss = runtime.connection_loss.clone();
    let result = loop {
        let next = tokio::select! {
            biased;
            () = wait_for_connection_loss(&mut connection_loss) => RemoteInput::Lost,
            () = wait_for_connection_loss(&mut local_loss) => RemoteInput::Lost,
            () = bridge.cancelled(), if !cancellation_forwarded => RemoteInput::Cancel,
            event = stream.recv() => RemoteInput::Event(event),
        };
        let finished = match next {
            RemoteInput::Lost => Some(Err(NodeRunnerError::ConnectionLost)),
            RemoteInput::Cancel => {
                cancellation_forwarded = true;
                forward_cancel(&runtime, &reference, &mut connection_loss)
                    .await
                    .err()
                    .map(Err)
            }
            RemoteInput::Event(event) => {
                handle_remote_event(
                    event,
                    RemoteEventContext {
                        runtime: &runtime,
                        reference: &reference,
                        bridge: &mut bridge,
                        connection_loss: &mut connection_loss,
                    },
                )
                .await
            }
        };
        if let Some(result) = finished {
            break result;
        }
    };
    bridge.finish(result);
    let _ = registration.done.send(true);
    runtime.activity.finish(&reference).await;
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
        Some(CapsuleNodeEvent::Output { output }) => handle_remote_output(output, context).await,
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
    context: RemoteEventContext<'_>,
) -> Option<Result<NodeCompletion, NodeRunnerError>> {
    let output = match output.into_live() {
        Ok(output) => output,
        Err(error) => return Some(Err(error)),
    };
    let Err(error) = context.bridge.emit(output) else {
        return None;
    };
    Some(
        match forward_cancel(context.runtime, context.reference, context.connection_loss).await {
            Ok(()) => Err(error),
            Err(connection_lost) => Err(connection_lost),
        },
    )
}

async fn forward_cancel(
    runtime: &ProxyRuntime,
    reference: &ExecutionRef,
    connection_loss: &mut watch::Receiver<bool>,
) -> Result<(), NodeRunnerError> {
    if control_rpc(
        runtime.channel.cancel(reference),
        connection_loss,
        runtime.control_timeout,
    )
    .await
    {
        Ok(())
    } else {
        runtime.loss.promote();
        Err(NodeRunnerError::ConnectionLost)
    }
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
        () = wait_for_connection_loss(connection_loss) => false,
        result = &mut operation => result.is_ok(),
        () = tokio::time::sleep(timeout) => false,
    }
}

fn connection_is_lost(receiver: &watch::Receiver<bool>) -> bool {
    *receiver.borrow() || receiver.has_changed().is_err()
}

async fn wait_for_connection_loss(receiver: &mut watch::Receiver<bool>) {
    while !*receiver.borrow_and_update() {
        if receiver.changed().await.is_err() {
            return;
        }
    }
}

#[derive(Clone, Default)]
struct ProxyActivity {
    entries: Arc<Mutex<Vec<ProxyExecution>>>,
}

struct ProxyExecution {
    reference: ExecutionRef,
    loss: watch::Sender<bool>,
    done: watch::Receiver<bool>,
}

impl ProxyActivity {
    async fn register(&self, reference: ExecutionRef) -> ProxyRegistration {
        let (loss, loss_receiver) = watch::channel(false);
        let (done_sender, done) = watch::channel(false);
        self.entries.lock().await.push(ProxyExecution {
            reference,
            loss,
            done,
        });
        ProxyRegistration {
            loss: loss_receiver,
            done: done_sender,
        }
    }

    async fn finish(&self, reference: &ExecutionRef) {
        let mut entries = self.entries.lock().await;
        if let Some(index) = entries
            .iter()
            .position(|entry| &entry.reference == reference)
        {
            entries.swap_remove(index);
        }
    }

    async fn lose_run(&self, run_id: &RunId) {
        let entries = self.entries.lock().await;
        for entry in entries
            .iter()
            .filter(|entry| &entry.reference.run_id == run_id)
        {
            let _ = entry.loss.send(true);
        }
    }

    async fn wait_run(&self, run_id: &RunId) {
        let mut completions = {
            let entries = self.entries.lock().await;
            entries
                .iter()
                .filter(|entry| &entry.reference.run_id == run_id)
                .map(|entry| entry.done.clone())
                .collect::<Vec<_>>()
        };
        for completion in &mut completions {
            while !*completion.borrow_and_update() {
                if completion.changed().await.is_err() {
                    break;
                }
            }
        }
    }
}

struct ProxyRegistration {
    loss: watch::Receiver<bool>,
    done: watch::Sender<bool>,
}
