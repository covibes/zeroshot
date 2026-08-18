use std::io::Write;
use std::time::Duration;

use openengine_cluster_protocol::{
    Cursor, RunAttachParams, RunForceParams, RunId, RunListParams, RunLogEventNotification,
    RunLogsParams, RunStatus, RunStatusParams, RunWatchEventNotification, RunWatchParams,
    SubscriptionCloseReason, TerminalResult,
};
use serde::Serialize;

use super::{
    CliOutcome, CliSubscription, CliSubscriptionItem, DetachSignal, NativeV2CliBackend,
    NativeV2CliCommand, NativeV2CliError, RunCommand, RunSelector, HELP,
};

#[path = "execution/submission.rs"]
mod submission;
use submission::prepare_submission;

pub async fn execute_native_v2_cli<B, S, W>(
    command: NativeV2CliCommand,
    backend: &B,
    signal: &mut S,
    output: &mut W,
) -> Result<CliOutcome, NativeV2CliError>
where
    B: NativeV2CliBackend,
    S: DetachSignal,
    W: Write,
{
    match command {
        NativeV2CliCommand::Help => {
            output.write_all(HELP.as_bytes())?;
            Ok(CliOutcome::Completed)
        }
        NativeV2CliCommand::Run(run) => execute_run(run, backend, signal, output).await,
        command @ (NativeV2CliCommand::TargetAdd(_)
        | NativeV2CliCommand::TargetLogin { .. }
        | NativeV2CliCommand::TargetSetup(_)) => execute_target(command, backend).await,
        command => execute_run_operation(command, backend, signal, output).await,
    }
}

async fn execute_target<B>(
    command: NativeV2CliCommand,
    backend: &B,
) -> Result<CliOutcome, NativeV2CliError>
where
    B: NativeV2CliBackend,
{
    match command {
        NativeV2CliCommand::TargetAdd(request) => backend.target_add(request).await?,
        NativeV2CliCommand::TargetLogin { name } => backend.target_login(&name).await?,
        NativeV2CliCommand::TargetSetup(request) => backend.target_setup(request).await?,
        _ => {
            return Err(NativeV2CliError::Usage(
                "expected a target operation".to_owned(),
            ));
        }
    }
    Ok(CliOutcome::Completed)
}

async fn execute_run_operation<B, S, W>(
    command: NativeV2CliCommand,
    backend: &B,
    signal: &mut S,
    output: &mut W,
) -> Result<CliOutcome, NativeV2CliError>
where
    B: NativeV2CliBackend,
    S: DetachSignal,
    W: Write,
{
    let command = match command {
        NativeV2CliCommand::ForceStop(run) => {
            return execute_force_stop(run, backend, output).await;
        }
        command => command,
    };
    if matches!(
        command,
        NativeV2CliCommand::List { .. } | NativeV2CliCommand::Status(_)
    ) {
        return execute_run_unary(command, backend, output).await;
    }
    execute_run_subscription(command, backend, signal, output).await
}

async fn execute_run_unary<B, W>(
    command: NativeV2CliCommand,
    backend: &B,
    output: &mut W,
) -> Result<CliOutcome, NativeV2CliError>
where
    B: NativeV2CliBackend,
    W: Write,
{
    match command {
        NativeV2CliCommand::List { target } => {
            let result = backend
                .run_list(target.as_deref(), RunListParams::default())
                .await?;
            write_json(output, &result)?;
            Ok(CliOutcome::Completed)
        }
        NativeV2CliCommand::Status(run) => {
            let result = backend
                .run_status(
                    run.target.as_deref(),
                    RunStatusParams { run_id: run.run_id },
                )
                .await?;
            write_json(output, &result)?;
            Ok(outcome_for_status(&result.status))
        }
        _ => Err(NativeV2CliError::Usage(
            "expected a unary run operation".to_owned(),
        )),
    }
}

async fn execute_force_stop<B, W>(
    run: RunSelector,
    backend: &B,
    output: &mut W,
) -> Result<CliOutcome, NativeV2CliError>
where
    B: NativeV2CliBackend,
    W: Write,
{
    let result = backend
        .run_force(run.target.as_deref(), RunForceParams { run_id: run.run_id })
        .await?;
    write_json(output, &result)?;
    Ok(outcome_for_status(&result.status))
}

async fn execute_run_subscription<B, S, W>(
    command: NativeV2CliCommand,
    backend: &B,
    signal: &mut S,
    output: &mut W,
) -> Result<CliOutcome, NativeV2CliError>
where
    B: NativeV2CliBackend,
    S: DetachSignal,
    W: Write,
{
    match command {
        NativeV2CliCommand::Watch(run) => {
            follow_durable(
                DurableFollow {
                    backend,
                    target: run.target.as_deref(),
                    run_id: run.run_id,
                    kind: DurableFollowKind::Watch,
                },
                signal,
                output,
            )
            .await
        }
        NativeV2CliCommand::Logs(run) => {
            follow_durable(
                DurableFollow {
                    backend,
                    target: run.target.as_deref(),
                    run_id: run.run_id,
                    kind: DurableFollowKind::Logs,
                },
                signal,
                output,
            )
            .await
        }
        NativeV2CliCommand::Attach { run, execution } => {
            let subscription = backend
                .run_attach(
                    run.target.as_deref(),
                    RunAttachParams {
                        run_id: run.run_id,
                        execution,
                    },
                )
                .await?;
            follow_stream(subscription, signal, output).await
        }
        _ => Err(NativeV2CliError::Usage(
            "expected a subscription run operation".to_owned(),
        )),
    }
}

async fn execute_run<B, S, W>(
    run: RunCommand,
    backend: &B,
    signal: &mut S,
    output: &mut W,
) -> Result<CliOutcome, NativeV2CliError>
where
    B: NativeV2CliBackend,
    S: DetachSignal,
    W: Write,
{
    let params = prepare_submission(&run)?;
    let receipt = backend.run_submit(run.target.as_deref(), params).await?;
    write_json(output, &receipt)?;
    if run.detach {
        return Ok(CliOutcome::Detached);
    }
    let outcome = follow_durable(
        DurableFollow {
            backend,
            target: run.target.as_deref(),
            run_id: receipt.run_id,
            kind: DurableFollowKind::Watch,
        },
        signal,
        output,
    )
    .await?;
    if outcome == CliOutcome::Failed {
        Err(NativeV2CliError::RunFailed)
    } else {
        Ok(outcome)
    }
}

#[derive(Clone, Copy)]
enum DurableFollowKind {
    Watch,
    Logs,
}

impl DurableFollowKind {
    const fn done_outcome(self) -> CliOutcome {
        match self {
            Self::Watch => CliOutcome::Detached,
            Self::Logs => CliOutcome::Completed,
        }
    }
}

struct DurableFollow<'a, B> {
    backend: &'a B,
    target: Option<&'a str>,
    run_id: RunId,
    kind: DurableFollowKind,
}

impl<B> DurableFollow<'_, B>
where
    B: NativeV2CliBackend,
{
    async fn open(
        &self,
        from_cursor: Option<Cursor>,
    ) -> Result<DurableSubscription<B::Watch, B::Logs>, NativeV2CliError> {
        match self.kind {
            DurableFollowKind::Watch => self
                .backend
                .run_watch(
                    self.target,
                    RunWatchParams {
                        run_id: self.run_id.clone(),
                        from_cursor,
                    },
                )
                .await
                .map(DurableSubscription::Watch),
            DurableFollowKind::Logs => self
                .backend
                .run_logs(
                    self.target,
                    RunLogsParams {
                        run_id: self.run_id.clone(),
                        from_cursor,
                        execution: None,
                    },
                )
                .await
                .map(DurableSubscription::Logs),
        }
    }
}

enum DurableSubscription<W, L> {
    Watch(W),
    Logs(L),
}

impl<W, L> DurableSubscription<W, L>
where
    W: CliSubscription<RunWatchEventNotification>,
    L: CliSubscription<RunLogEventNotification>,
{
    async fn next(&mut self) -> Result<Option<DurableItem>, NativeV2CliError> {
        match self {
            Self::Watch(subscription) => subscription.next().await.map(|item| {
                item.map(|item| match item {
                    CliSubscriptionItem::Event(event) => DurableItem::Watch(event),
                    CliSubscriptionItem::Closed { reason } => DurableItem::Closed(reason),
                })
            }),
            Self::Logs(subscription) => subscription.next().await.map(|item| {
                item.map(|item| match item {
                    CliSubscriptionItem::Event(event) => DurableItem::Log(event),
                    CliSubscriptionItem::Closed { reason } => DurableItem::Closed(reason),
                })
            }),
        }
    }
}

enum DurableItem {
    Watch(RunWatchEventNotification),
    Log(RunLogEventNotification),
    Closed(SubscriptionCloseReason),
}

impl DurableItem {
    fn cursor(&self) -> Option<&Cursor> {
        match self {
            Self::Watch(event) => Some(&event.cursor),
            Self::Log(event) => Some(&event.cursor),
            Self::Closed(_) => None,
        }
    }
}

async fn follow_durable<B, S, W>(
    follow: DurableFollow<'_, B>,
    signal: &mut S,
    output: &mut W,
) -> Result<CliOutcome, NativeV2CliError>
where
    B: NativeV2CliBackend,
    S: DetachSignal,
    W: Write,
{
    let mut from_cursor: Option<Cursor> = None;
    let mut opened = false;
    loop {
        let subscription = tokio::select! {
            () = signal.wait() => return Ok(CliOutcome::Detached),
            result = follow.open(from_cursor.clone()) => match result {
                Ok(subscription) => {
                    opened = true;
                    subscription
                }
                Err(error) if !opened => return Err(error),
                Err(_) => {
                    tokio::time::sleep(Duration::from_millis(100)).await;
                    continue;
                }
            },
        };
        let mut subscription = subscription;
        loop {
            let item = tokio::select! {
                () = signal.wait() => return Ok(CliOutcome::Detached),
                item = subscription.next() => item,
            };
            match item {
                Ok(Some(DurableItem::Closed(SubscriptionCloseReason::Done))) => {
                    return Ok(follow.kind.done_outcome());
                }
                Ok(Some(DurableItem::Closed(SubscriptionCloseReason::SlowConsumer)))
                | Ok(None)
                | Err(NativeV2CliError::Disconnected) => break,
                Ok(Some(event)) => {
                    if let Some(outcome) = write_durable_event(event, &mut from_cursor, output)? {
                        return Ok(outcome);
                    }
                }
                Err(error) => return Err(error),
            }
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

fn write_durable_event(
    event: DurableItem,
    from_cursor: &mut Option<Cursor>,
    output: &mut impl Write,
) -> Result<Option<CliOutcome>, NativeV2CliError> {
    if event.cursor() == from_cursor.as_ref() {
        return Ok(None);
    }
    let cursor = event.cursor().cloned();
    let outcome = match event {
        DurableItem::Watch(event) => {
            let outcome = match &event.status {
                RunStatus::Finished {
                    terminal_result: TerminalResult::Succeeded { .. },
                } => Some(CliOutcome::Finished),
                RunStatus::Finished {
                    terminal_result: TerminalResult::Failed { .. },
                } => Some(CliOutcome::Failed),
                _ => None,
            };
            write_json(output, &event)?;
            outcome
        }
        DurableItem::Log(event) => {
            write_json(output, &event)?;
            None
        }
        DurableItem::Closed(_) => None,
    };
    *from_cursor = cursor;
    Ok(outcome)
}

async fn follow_stream<E, S, W, T>(
    mut subscription: T,
    signal: &mut S,
    output: &mut W,
) -> Result<CliOutcome, NativeV2CliError>
where
    E: Serialize + Send,
    S: DetachSignal,
    W: Write,
    T: CliSubscription<E>,
{
    loop {
        tokio::select! {
            () = signal.wait() => return Ok(CliOutcome::Detached),
            item = subscription.next() => match item? {
                Some(CliSubscriptionItem::Event(event)) => write_json(output, &event)?,
                Some(CliSubscriptionItem::Closed { .. }) | None => {
                    return Ok(CliOutcome::Completed);
                }
            }
        }
    }
}

fn write_json(output: &mut impl Write, value: &impl Serialize) -> Result<(), NativeV2CliError> {
    serde_json::to_writer(&mut *output, value)?;
    output.write_all(b"\n")?;
    output.flush()?;
    Ok(())
}

fn outcome_for_status(status: &RunStatus) -> CliOutcome {
    match status {
        RunStatus::Finished {
            terminal_result: TerminalResult::Succeeded { .. },
        } => CliOutcome::Finished,
        RunStatus::Finished {
            terminal_result: TerminalResult::Failed { .. },
        } => CliOutcome::Failed,
        _ => CliOutcome::Completed,
    }
}
