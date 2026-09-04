use super::*;

struct RemoteInputAction<'a> {
    runtime: &'a ProxyRuntime,
    reference: &'a ExecutionRef,
    bridge: &'a mut RemoteNodeHandleBridge,
    connection_loss: &'a mut watch::Receiver<bool>,
    closing_signal: &'a mut watch::Receiver<bool>,
    closing: &'a mut bool,
    cancellation_handled: &'a mut bool,
    acceptance: &'a mut Option<oneshot::Receiver<()>>,
    pending_bridge_failure: &'a mut Option<NodeRunnerError>,
}

pub(super) async fn drive_remote_execution(task: RemoteExecutionTask) {
    let RemoteExecutionTask {
        runtime,
        reference,
        mut stream,
        mut bridge,
        registration,
        mut acceptance,
    } = task;
    let mut closing_signal = registration.closing;
    let mut closed_signal = registration.closed;
    let mut closing = false;
    let mut cancellation_handled = false;
    let mut pending_bridge_failure = None;
    let mut connection_loss = runtime.connection_loss.clone();
    let result = loop {
        let next = next_remote_input(RemoteInputContext {
            stream: &mut stream,
            bridge: &mut bridge,
            connection_loss: &mut connection_loss,
            closing_signal: &mut closing_signal,
            closed_signal: &mut closed_signal,
            closing,
            cancellation_handled,
            acceptance: &mut acceptance,
        })
        .await;
        let finished = apply_remote_input(
            next,
            RemoteInputAction {
                runtime: &runtime,
                reference: &reference,
                bridge: &mut bridge,
                connection_loss: &mut connection_loss,
                closing_signal: &mut closing_signal,
                closing: &mut closing,
                cancellation_handled: &mut cancellation_handled,
                acceptance: &mut acceptance,
                pending_bridge_failure: &mut pending_bridge_failure,
            },
        )
        .await;
        if let Some(result) = finished {
            break result;
        }
    };
    let result = prefer_pending_bridge_failure(result, pending_bridge_failure);
    settle_remote_acceptance(&mut acceptance, &mut connection_loss, &mut closing_signal).await;
    bridge.finish(result);
    runtime
        .activity
        .finish(&reference, &registration.done)
        .await;
}

async fn apply_remote_input(
    input: RemoteInput,
    mut context: RemoteInputAction<'_>,
) -> Option<Result<NodeCompletion, NodeRunnerError>> {
    match input {
        RemoteInput::Lost => Some(Err(NodeRunnerError::ConnectionLost)),
        RemoteInput::Closed => {
            context.acceptance.take();
            Some(Err(if connection_is_lost(context.connection_loss) {
                NodeRunnerError::ConnectionLost
            } else {
                NodeRunnerError::Cancelled
            }))
        }
        RemoteInput::Closing => {
            context.acceptance.take();
            *context.closing = true;
            *context.cancellation_handled = true;
            None
        }
        RemoteInput::Cancel => cancel_remote_input(&mut context).await,
        RemoteInput::Acceptance(result) => {
            context.acceptance.take();
            if result.is_err() {
                cancel_remote_input(&mut context).await
            } else {
                None
            }
        }
        RemoteInput::Event(event) => {
            handle_remote_event(
                event,
                RemoteEventContext {
                    runtime: context.runtime,
                    reference: context.reference,
                    bridge: context.bridge,
                    connection_loss: context.connection_loss,
                    closing: context.closing_signal,
                    pending_bridge_failure: context.pending_bridge_failure,
                },
            )
            .await
        }
    }
}

fn prefer_pending_bridge_failure(
    result: Result<NodeCompletion, NodeRunnerError>,
    pending: Option<NodeRunnerError>,
) -> Result<NodeCompletion, NodeRunnerError> {
    match result {
        Err(NodeRunnerError::ConnectionLost) => Err(NodeRunnerError::ConnectionLost),
        result => pending.map_or(result, Err),
    }
}

async fn cancel_remote_input(
    context: &mut RemoteInputAction<'_>,
) -> Option<Result<NodeCompletion, NodeRunnerError>> {
    context.acceptance.take();
    *context.cancellation_handled = true;
    handle_remote_cancel(RemoteCancelContext {
        runtime: context.runtime,
        reference: context.reference,
        connection_loss: context.connection_loss,
        closing_signal: context.closing_signal,
        closing: context.closing,
    })
    .await
}
