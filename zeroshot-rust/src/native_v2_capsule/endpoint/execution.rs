use super::*;

pub(super) struct LocalExecutionTask {
    pub(super) handle: NodeHandle,
    pub(super) durable: crate::native_v2_runner::DurableOutput,
    pub(super) commands: watch::Receiver<bool>,
    pub(super) events: mpsc::Sender<CapsuleNodeEvent>,
    pub(super) terminal: oneshot::Sender<Vec<CapsuleNodeEvent>>,
    pub(super) state: Arc<Mutex<EndpointState>>,
    pub(super) reference: ExecutionRef,
    pub(super) done: watch::Sender<bool>,
    pub(super) acceptance: Option<oneshot::Receiver<()>>,
}

enum LocalInput {
    Completion(Result<NodeCompletion, NodeRunnerError>),
    Output(Result<DurableNodeEvent, crate::native_v2_runner::AttachReceiveError>),
    Cancel,
    Acceptance(Result<(), oneshot::error::RecvError>),
}

struct LocalAwait {
    completion: bool,
    output: bool,
    command: bool,
    acceptance: bool,
}

struct LocalInputContext<'a> {
    handle: &'a mut NodeHandle,
    durable: &'a mut crate::native_v2_runner::DurableOutput,
    commands: &'a mut watch::Receiver<bool>,
    acceptance: &'a mut Option<oneshot::Receiver<()>>,
    awaiting: LocalAwait,
}

struct LocalOutputContext<'a> {
    events: &'a mpsc::Sender<CapsuleNodeEvent>,
    commands: &'a mut watch::Receiver<bool>,
    handle: &'a mut NodeHandle,
    output_closed: &'a mut bool,
    consumer_gone: &'a mut bool,
    cancelled: &'a mut bool,
    terminal_metadata: &'a mut TerminalMetadata,
    acceptance: &'a mut Option<oneshot::Receiver<()>>,
}

#[derive(Default)]
struct TerminalMetadata {
    known_usage: Option<TokenUsageDelta>,
    incomplete: bool,
    overflowed: bool,
}

impl TerminalMetadata {
    fn retain(&mut self, event: CapsuleNodeEvent) {
        let CapsuleNodeEvent::TokenUsage { usage } = event else {
            return;
        };
        let Some(usage) = usage else {
            self.incomplete = true;
            return;
        };
        if self.overflowed {
            return;
        }
        self.known_usage = match self.known_usage {
            None => Some(usage),
            Some(total) => match add_usage(total, usage) {
                Some(total) => Some(total),
                None => {
                    self.incomplete = true;
                    self.overflowed = true;
                    Some(total)
                }
            },
        };
    }

    fn into_events(
        self,
        completion: Result<NodeCompletion, NodeRunnerError>,
    ) -> Vec<CapsuleNodeEvent> {
        let mut events = Vec::with_capacity(3);
        if let Some(usage) = self.known_usage {
            events.push(CapsuleNodeEvent::TokenUsage { usage: Some(usage) });
        }
        if self.incomplete {
            events.push(CapsuleNodeEvent::TokenUsage { usage: None });
        }
        let terminal = if self.overflowed {
            CapsuleNodeEvent::Failed {
                failure: CapsuleNodeFailure::ExecutionFailed,
            }
        } else {
            match completion {
                Ok(completion) => CapsuleNodeEvent::Completed { completion },
                Err(error) => CapsuleNodeEvent::Failed {
                    failure: CapsuleNodeFailure::from_runner(&error),
                },
            }
        };
        events.push(terminal);
        events
    }
}

fn add_usage(left: TokenUsageDelta, right: TokenUsageDelta) -> Option<TokenUsageDelta> {
    let input_tokens = left.input_tokens.checked_add(right.input_tokens)?;
    let output_tokens = left.output_tokens.checked_add(right.output_tokens)?;
    let cache_read_input_tokens =
        add_optional_usage(left.cache_read_input_tokens, right.cache_read_input_tokens)?;
    let cache_creation_input_tokens = add_optional_usage(
        left.cache_creation_input_tokens,
        right.cache_creation_input_tokens,
    )?;
    Some(TokenUsageDelta {
        input_tokens,
        output_tokens,
        cache_read_input_tokens,
        cache_creation_input_tokens,
    })
}

fn add_optional_usage(
    left: Option<openengine_cluster_protocol::TokenCount>,
    right: Option<openengine_cluster_protocol::TokenCount>,
) -> Option<Option<openengine_cluster_protocol::TokenCount>> {
    match (left, right) {
        (Some(left), Some(right)) => left.checked_add(right).map(Some),
        _ => Some(None),
    }
}

pub(super) async fn serve_local_execution(task: LocalExecutionTask) {
    let LocalExecutionTask {
        mut handle,
        mut durable,
        mut commands,
        events,
        terminal,
        state,
        reference,
        done,
        mut acceptance,
    } = task;
    let mut completion = None;
    let mut output_closed = false;
    let mut consumer_gone = false;
    let mut cancelled = false;
    let mut terminal_metadata = TerminalMetadata::default();
    while local_execution_pending(&completion, output_closed, acceptance.is_some()) {
        let awaiting_acceptance = acceptance.is_some();
        let next = next_local_input(LocalInputContext {
            handle: &mut handle,
            durable: &mut durable,
            commands: &mut commands,
            acceptance: &mut acceptance,
            awaiting: LocalAwait {
                completion: completion.is_none(),
                output: !output_closed,
                command: !consumer_gone && !cancelled,
                acceptance: awaiting_acceptance,
            },
        })
        .await;
        match next {
            LocalInput::Completion(result) => completion = Some(result),
            LocalInput::Output(output) => {
                apply_local_output(
                    output,
                    LocalOutputContext {
                        events: &events,
                        commands: &mut commands,
                        handle: &mut handle,
                        output_closed: &mut output_closed,
                        consumer_gone: &mut consumer_gone,
                        cancelled: &mut cancelled,
                        terminal_metadata: &mut terminal_metadata,
                        acceptance: &mut acceptance,
                    },
                )
                .await;
            }
            LocalInput::Cancel => {
                cancelled = true;
                handle.cancel();
                acceptance.take();
            }
            LocalInput::Acceptance(result) => {
                acceptance.take();
                if result.is_err() {
                    consumer_gone = true;
                    cancelled = true;
                    handle.cancel();
                }
            }
        }
    }
    drop(events);
    send_local_completion(terminal, completion, consumer_gone, terminal_metadata);
    remove_endpoint_execution(&state, &reference, &done).await;
    let _ = done.send(true);
}

fn local_execution_pending(
    completion: &Option<Result<NodeCompletion, NodeRunnerError>>,
    output_closed: bool,
    awaiting_acceptance: bool,
) -> bool {
    completion.is_none() || !output_closed || awaiting_acceptance
}

async fn next_local_input(context: LocalInputContext<'_>) -> LocalInput {
    tokio::select! {
        result = context.handle.completion(), if context.awaiting.completion => LocalInput::Completion(result),
        output = context.durable.recv(), if context.awaiting.output => LocalInput::Output(output),
        () = wait_for_signal(context.commands), if context.awaiting.command => LocalInput::Cancel,
        result = receive_start_acceptance(context.acceptance),
            if context.awaiting.acceptance => LocalInput::Acceptance(result),
    }
}

async fn apply_local_output(
    output: Result<DurableNodeEvent, crate::native_v2_runner::AttachReceiveError>,
    context: LocalOutputContext<'_>,
) {
    let Ok(output) = output else {
        *context.output_closed = true;
        return;
    };
    let event = match output {
        DurableNodeEvent::Output { output, timestamp } => CapsuleNodeEvent::Output {
            output: output.into(),
            timestamp,
        },
        DurableNodeEvent::TokenUsage(usage) => CapsuleNodeEvent::TokenUsage { usage },
    };
    if *context.consumer_gone {
        return;
    }
    if *context.cancelled {
        context.terminal_metadata.retain(event);
        return;
    }
    tokio::select! {
        biased;
        () = wait_for_signal(context.commands) => {
            *context.cancelled = true;
            context.handle.cancel();
            context.acceptance.take();
            context.terminal_metadata.retain(event);
        }
        permit = context.events.reserve() => match permit {
            Ok(permit) => permit.send(event),
            Err(_) => {
                *context.consumer_gone = true;
                context.handle.cancel();
            }
        }
    }
}

fn send_local_completion(
    terminal: oneshot::Sender<Vec<CapsuleNodeEvent>>,
    completion: Option<Result<NodeCompletion, NodeRunnerError>>,
    consumer_gone: bool,
    metadata: TerminalMetadata,
) {
    if consumer_gone {
        return;
    }
    let Some(completion) = completion else {
        return;
    };
    let _ = terminal.send(metadata.into_events(completion));
}

pub(super) async fn remove_endpoint_execution(
    state: &Mutex<EndpointState>,
    reference: &ExecutionRef,
    done: &watch::Sender<bool>,
) {
    let expected = done.subscribe();
    let mut state = state.lock().await;
    if let Some(index) = state
        .active
        .iter()
        .position(|entry| &entry.reference == reference && entry.done.same_channel(&expected))
    {
        state.active.swap_remove(index);
    }
}

#[cfg(test)]
mod tests {
    use openengine_cluster_protocol::{MAX_SAFE_GENERATION, TokenCount};

    use super::*;
    use openengine_cluster_testkit::assertions::AssertValue;

    fn usage(tokens: u64) -> TokenUsageDelta {
        TokenUsageDelta {
            input_tokens: TokenCount::new(tokens).assert_value(),
            output_tokens: TokenCount::new(tokens).assert_value(),
            cache_read_input_tokens: None,
            cache_creation_input_tokens: None,
        }
    }

    #[test]
    fn usage_overflow_is_incomplete_and_overrides_cancellation() {
        let mut metadata = TerminalMetadata::default();
        metadata.retain(CapsuleNodeEvent::TokenUsage {
            usage: Some(usage(MAX_SAFE_GENERATION)),
        });
        metadata.retain(CapsuleNodeEvent::TokenUsage {
            usage: Some(usage(1)),
        });

        let events = metadata.into_events(Err(NodeRunnerError::Cancelled));
        assert!(matches!(
            events.as_slice(),
            [
                CapsuleNodeEvent::TokenUsage { usage: Some(known) },
                CapsuleNodeEvent::TokenUsage { usage: None },
                CapsuleNodeEvent::Failed {
                    failure: CapsuleNodeFailure::ExecutionFailed
                }
            ] if known.input_tokens.get() == MAX_SAFE_GENERATION
        ));
    }
}
