use super::*;

#[derive(Clone)]
pub struct NativeCapsuleNodeEndpoint {
    runner: Arc<dyn NodeRunner>,
    loss: watch::Sender<bool>,
    active: Arc<Mutex<Vec<EndpointExecution>>>,
}

struct EndpointExecution {
    reference: ExecutionRef,
    cancel: mpsc::UnboundedSender<()>,
    done: watch::Receiver<bool>,
}

impl NativeCapsuleNodeEndpoint {
    #[must_use]
    pub fn new(runner: Arc<dyn NodeRunner>) -> Self {
        let (loss, _) = watch::channel(false);
        Self {
            runner,
            loss,
            active: Arc::new(Mutex::new(Vec::new())),
        }
    }

    /// Breaks the private connection and waits for all capsule-side provider cleanup.
    pub async fn disconnect(&self) {
        let _ = self.loss.send(true);
        let run_ids = {
            let entries = self.active.lock().await;
            entries
                .iter()
                .map(|entry| entry.reference.run_id.clone())
                .collect::<std::collections::BTreeSet<_>>()
        };
        for run_id in run_ids {
            self.close_local_run(&run_id).await;
        }
    }

    async fn close_local_run(&self, run_id: &RunId) {
        let mut completions = {
            let entries = self.active.lock().await;
            for entry in entries
                .iter()
                .filter(|entry| &entry.reference.run_id == run_id)
            {
                let _ = entry.cancel.send(());
            }
            entries
                .iter()
                .filter(|entry| &entry.reference.run_id == run_id)
                .map(|entry| entry.done.clone())
                .collect::<Vec<_>>()
        };
        self.runner.close_run(run_id).await;
        for completion in &mut completions {
            while !*completion.borrow_and_update() {
                if completion.changed().await.is_err() {
                    break;
                }
            }
        }
    }
}

#[async_trait]
impl CapsuleNodeChannel for NativeCapsuleNodeEndpoint {
    async fn start(
        &self,
        request: NodeRunRequest,
    ) -> Result<CapsuleExecutionStream, CapsuleConnectionError> {
        if *self.loss.borrow() {
            return Err(CapsuleConnectionError::Lost);
        }
        let mut handle = self.runner.start(request).await.map_err(|error| {
            CapsuleConnectionError::Rejected(CapsuleNodeFailure::from_runner(&error))
        })?;
        let reference = handle.reference().clone();
        let Some(durable) = handle.take_initial_output() else {
            handle.cancel();
            let _ = handle.completion().await;
            return Err(CapsuleConnectionError::Rejected(
                CapsuleNodeFailure::ExecutionFailed,
            ));
        };
        // Provider output is capped by the harness, so this lossless queue is bounded by that
        // cap while keeping cancellation and cleanup independent of a slow controller reader.
        let (events, receiver) = mpsc::unbounded_channel();
        let (cancel, commands) = mpsc::unbounded_channel();
        let (done_sender, done) = watch::channel(false);
        {
            let mut active = self.active.lock().await;
            if *self.loss.borrow() {
                handle.cancel();
                drop(active);
                let _ = handle.completion().await;
                return Err(CapsuleConnectionError::Lost);
            }
            active.push(EndpointExecution {
                reference: reference.clone(),
                cancel,
                done,
            });
        }
        let active = self.active.clone();
        tokio::spawn(serve_local_execution(LocalExecutionTask {
            handle,
            durable,
            commands,
            events,
            active,
            reference,
            done: done_sender,
        }));
        Ok(CapsuleExecutionStream::from_receiver(receiver))
    }

    async fn cancel(&self, reference: &ExecutionRef) -> Result<(), CapsuleConnectionError> {
        if *self.loss.borrow() {
            return Err(CapsuleConnectionError::Lost);
        }
        let entries = self.active.lock().await;
        if let Some(entry) = entries.iter().find(|entry| &entry.reference == reference) {
            let _ = entry.cancel.send(());
        }
        Ok(())
    }

    async fn close_run(&self, run_id: &RunId) -> Result<(), CapsuleConnectionError> {
        if *self.loss.borrow() {
            return Err(CapsuleConnectionError::Lost);
        }
        self.close_local_run(run_id).await;
        Ok(())
    }

    fn connection_loss(&self) -> watch::Receiver<bool> {
        self.loss.subscribe()
    }
}

struct LocalExecutionTask {
    handle: NodeHandle,
    durable: crate::native_v2_runner::DurableOutput,
    commands: mpsc::UnboundedReceiver<()>,
    events: mpsc::UnboundedSender<CapsuleNodeEvent>,
    active: Arc<Mutex<Vec<EndpointExecution>>>,
    reference: ExecutionRef,
    done: watch::Sender<bool>,
}

enum LocalInput {
    Completion(Result<NodeCompletion, NodeRunnerError>),
    Output(Result<LiveOutput, crate::native_v2_runner::AttachReceiveError>),
    Cancel,
}

struct LocalAwait {
    completion: bool,
    output: bool,
    command: bool,
}

struct LocalOutputContext<'a> {
    events: &'a mpsc::UnboundedSender<CapsuleNodeEvent>,
    handle: &'a mut NodeHandle,
    output_closed: &'a mut bool,
    consumer_gone: &'a mut bool,
}

async fn serve_local_execution(task: LocalExecutionTask) {
    let LocalExecutionTask {
        mut handle,
        mut durable,
        mut commands,
        events,
        active,
        reference,
        done,
    } = task;
    let mut completion = None;
    let mut output_closed = false;
    let mut consumer_gone = false;
    while local_execution_pending(&completion, output_closed) {
        let next = next_local_input(
            &mut handle,
            &mut durable,
            &mut commands,
            LocalAwait {
                completion: completion.is_none(),
                output: !output_closed,
                command: !consumer_gone,
            },
        )
        .await;
        match next {
            LocalInput::Completion(result) => completion = Some(result),
            LocalInput::Output(output) => apply_local_output(
                output,
                LocalOutputContext {
                    events: &events,
                    handle: &mut handle,
                    output_closed: &mut output_closed,
                    consumer_gone: &mut consumer_gone,
                },
            ),
            LocalInput::Cancel => handle.cancel(),
        }
    }
    send_local_completion(&events, completion, consumer_gone);
    remove_endpoint_execution(&active, &reference).await;
    let _ = done.send(true);
}

fn local_execution_pending(
    completion: &Option<Result<NodeCompletion, NodeRunnerError>>,
    output_closed: bool,
) -> bool {
    completion.is_none() || !output_closed
}

async fn next_local_input(
    handle: &mut NodeHandle,
    durable: &mut crate::native_v2_runner::DurableOutput,
    commands: &mut mpsc::UnboundedReceiver<()>,
    awaiting: LocalAwait,
) -> LocalInput {
    tokio::select! {
        result = handle.completion(), if awaiting.completion => LocalInput::Completion(result),
        output = durable.recv(), if awaiting.output => LocalInput::Output(output),
        _ = commands.recv(), if awaiting.command => LocalInput::Cancel,
    }
}

fn apply_local_output(
    output: Result<LiveOutput, crate::native_v2_runner::AttachReceiveError>,
    context: LocalOutputContext<'_>,
) {
    let Ok(output) = output else {
        *context.output_closed = true;
        return;
    };
    if context
        .events
        .send(CapsuleNodeEvent::Output {
            output: output.into(),
        })
        .is_err()
    {
        *context.consumer_gone = true;
        context.handle.cancel();
    }
}

fn send_local_completion(
    events: &mpsc::UnboundedSender<CapsuleNodeEvent>,
    completion: Option<Result<NodeCompletion, NodeRunnerError>>,
    consumer_gone: bool,
) {
    if consumer_gone {
        return;
    }
    let Some(completion) = completion else {
        return;
    };
    let event = match completion {
        Ok(completion) => CapsuleNodeEvent::Completed { completion },
        Err(error) => CapsuleNodeEvent::Failed {
            failure: CapsuleNodeFailure::from_runner(&error),
        },
    };
    let _ = events.send(event);
}

async fn remove_endpoint_execution(
    active: &Mutex<Vec<EndpointExecution>>,
    reference: &ExecutionRef,
) {
    let mut entries = active.lock().await;
    if let Some(index) = entries
        .iter()
        .position(|entry| &entry.reference == reference)
    {
        entries.swap_remove(index);
    }
}
