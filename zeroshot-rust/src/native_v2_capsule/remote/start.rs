use super::*;

pub(super) async fn remote_start(
    runner: &RemoteCapsuleNodeRunner,
    request: NodeRunRequest,
) -> Result<NodeHandle, NodeRunnerError> {
    if connection_is_lost(&runner.connection_loss) {
        return Err(NodeRunnerError::ConnectionLost);
    }
    let reference = request.invocation.reference.clone();
    let (handle, bridge) = remote_node_handle(reference.clone());
    let registration = runner
        .activity
        .register(reference.clone(), bridge.cancellation_signal())
        .await?;
    let registration_identity = registration.done.clone();
    let (ready, readiness) = oneshot::channel();
    let pending_reference = reference.clone();
    tokio::spawn(establish_remote_execution(
        PendingRemoteStart {
            runner: runner.clone(),
            request,
            reference: pending_reference,
            bridge,
            registration,
        },
        ready,
    ));
    #[cfg(test)]
    pause_before_start_readiness(runner.start_readiness_pause.as_ref()).await;
    let acceptance = readiness.await.unwrap_or(Err(NodeRunnerError::Driver))?;
    if let Err(error) = runner
        .activity
        .accept_start(&reference, &registration_identity, acceptance)
        .await
    {
        if connection_is_lost(&runner.connection_loss) {
            return Err(NodeRunnerError::ConnectionLost);
        }
        return Err(error);
    }
    Ok(handle)
}

struct PendingRemoteStart {
    runner: RemoteCapsuleNodeRunner,
    request: NodeRunRequest,
    reference: ExecutionRef,
    bridge: RemoteNodeHandleBridge,
    registration: ProxyRegistration,
}

async fn establish_remote_execution(
    pending: PendingRemoteStart,
    ready: oneshot::Sender<Result<oneshot::Sender<()>, NodeRunnerError>>,
) {
    let stream = match await_remote_start(&pending).await {
        Ok(stream) => stream,
        Err(error) => {
            pending
                .runner
                .activity
                .finish(&pending.reference, &pending.registration.done)
                .await;
            let _ = ready.send(Err(error));
            #[cfg(test)]
            mark_start_readiness_sent(pending.runner.start_readiness_pause.as_ref());
            return;
        }
    };
    let runtime = ProxyRuntime {
        channel: pending.runner.channel.clone(),
        connection_loss: pending.runner.connection_loss.clone(),
        loss: pending.runner.loss.clone(),
        activity: pending.runner.activity.clone(),
        control_timeout: pending.runner.control_timeout,
    };
    let (accept, acceptance) = oneshot::channel();
    let task = RemoteExecutionTask {
        runtime,
        reference: pending.reference,
        stream,
        bridge: pending.bridge,
        registration: pending.registration,
        acceptance: Some(acceptance),
    };
    let _ = ready.send(Ok(accept));
    #[cfg(test)]
    mark_start_readiness_sent(pending.runner.start_readiness_pause.as_ref());
    drive_remote_execution(task).await;
}

async fn await_remote_start(
    pending: &PendingRemoteStart,
) -> Result<CapsuleExecutionStream, NodeRunnerError> {
    let mut connection_loss = pending.runner.connection_loss.clone();
    let mut closed = pending.registration.closed.clone();
    let start = pending.runner.channel.start(pending.request.clone());
    tokio::pin!(start);
    tokio::select! {
        biased;
        result = &mut start => match result {
            Ok(stream) => Ok(stream),
            Err(CapsuleConnectionError::Lost) => {
                pending.runner.loss.promote();
                Err(NodeRunnerError::ConnectionLost)
            }
            Err(CapsuleConnectionError::Rejected(failure)) => Err(failure.into_runner()),
        },
        () = wait_for_signal(&mut connection_loss) => Err(NodeRunnerError::ConnectionLost),
        () = wait_for_signal(&mut closed) => Err(NodeRunnerError::RunClosed),
    }
}
