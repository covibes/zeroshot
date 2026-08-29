use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::time::Duration;

use openengine_cluster_protocol::{
    ConnectionDeleteRequest, ConnectionListRequest, ConnectionSetRequest, EnvironmentVariableName,
    Cursor, RunAttachParams, RunForceParams, RunId, RunListParams, RunLogEventNotification,
    RunLogsParams, RunStatus, RunStatusParams, RunWatchParams, StaticConnectionValues,
    SubscriptionCloseReason, TerminalResult,
};
use serde::Serialize;

use super::{
    CliOutcome, CliRunStatus, CliRunWatchEventNotification, CliSubscription, CliSubscriptionItem,
    ConnectionInput, ConnectionSetCommand, DetachSignal, NativeV2CliBackend, NativeV2CliCommand,
    NativeV2CliError, RunCommand, RunLogsCommand, RunSelector, RunWatchCommand,
};
#[path = "execution/attach.rs"]
mod attach;
#[path = "execution/context.rs"]
mod context;
#[path = "execution/status.rs"]
mod status;
#[path = "execution/submission.rs"]
mod submission;
use attach::{RoutedAttach, follow_attach};
pub(crate) use context::CliExecutionContext;
pub use submission::{try_execute_native_v2_preflight, try_execute_native_v2_static};
use submission::submit_run;
use status::outcome_for_status;

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
    let environment = |name: &str| std::env::var_os(name);
    let context = CliExecutionContext::new(backend, &environment);
    execute_native_v2_cli_with_context(command, &context, signal, output).await
}

pub(crate) async fn execute_native_v2_cli_with_context<B, S, W>(
    command: NativeV2CliCommand,
    context: &CliExecutionContext<'_, B>,
    signal: &mut S,
    output: &mut W,
) -> Result<CliOutcome, NativeV2CliError>
where
    B: NativeV2CliBackend,
    S: DetachSignal,
    W: Write,
{
    if let Some(outcome) = try_execute_native_v2_static(&command, output)? {
        return Ok(outcome);
    }
    if command.is_connection_operation() {
        return execute_connection(command, context.backend, output).await;
    }
    if command.is_target_operation() {
        return execute_target(command, context.backend).await;
    }
    match command {
        NativeV2CliCommand::Run(run) => execute_run(run, context, signal, output).await,
        NativeV2CliCommand::TargetServe(_) => Err(NativeV2CliError::ProcessCommand),
        command => execute_run_operation(command, context.backend, signal, output).await,
    }
}

async fn execute_connection<B, W>(
    command: NativeV2CliCommand,
    backend: &B,
    output: &mut W,
) -> Result<CliOutcome, NativeV2CliError>
where
    B: NativeV2CliBackend,
    W: Write,
{
    match command {
        NativeV2CliCommand::ConnectionList(route) => {
            let result = backend
                .connection_list(
                    route.target.as_deref(),
                    ConnectionListRequest { scope: route.scope },
                )
                .await?;
            write_json(output, &result)?;
            Ok(CliOutcome::Completed)
        }
        NativeV2CliCommand::ConnectionSet(command) => {
            execute_connection_set(command, backend, output).await
        }
        NativeV2CliCommand::ConnectionDelete { route, key } => {
            let result = backend
                .connection_delete(
                    route.target.as_deref(),
                    ConnectionDeleteRequest {
                        key,
                        scope: route.scope,
                    },
                )
                .await?;
            write_json(output, &result)?;
            Ok(CliOutcome::Completed)
        }
        _ => Err(NativeV2CliError::Usage(
            "expected a connection operation".to_owned(),
        )),
    }
}

async fn execute_connection_set<B, W>(
    command: ConnectionSetCommand,
    backend: &B,
    output: &mut W,
) -> Result<CliOutcome, NativeV2CliError>
where
    B: NativeV2CliBackend,
    W: Write,
{
    let values = read_connection_values(command.input)?;
    let result = backend
        .connection_set(
            command.route.target.as_deref(),
            ConnectionSetRequest {
                key: command.key,
                scope: command.route.scope,
                values,
            },
        )
        .await?;
    write_json(output, &result)?;
    Ok(CliOutcome::Completed)
}

fn read_connection_values(
    input: ConnectionInput,
) -> Result<StaticConnectionValues, NativeV2CliError> {
    let values = match input {
        ConnectionInput::Prompt(fields) => fields
            .into_iter()
            .map(|field| {
                let value = rpassword::prompt_password(format!("{}: ", field.as_str()))?;
                Ok((field, value))
            })
            .collect::<Result<BTreeMap<_, _>, std::io::Error>>()?,
        ConnectionInput::JsonStdin => {
            let mut encoded = String::new();
            std::io::stdin().lock().read_to_string(&mut encoded)?;
            serde_json::from_str::<BTreeMap<EnvironmentVariableName, String>>(&encoded).map_err(
                |error| NativeV2CliError::Usage(format!("connection JSON is invalid: {error}")),
            )?
        }
    };
    StaticConnectionValues::new(values).map_err(|error| NativeV2CliError::Usage(error.to_string()))
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
        NativeV2CliCommand::Watch(RunWatchCommand { run, after }) => {
            follow_durable(
                DurableFollow {
                    backend,
                    target: run.target.as_deref(),
                    run_id: run.run_id,
                    kind: DurableFollowKind::Watch,
                    initial_cursor: after,
                    execution: None,
                },
                signal,
                output,
            )
            .await
        }
        NativeV2CliCommand::Logs(RunLogsCommand {
            run,
            after,
            execution,
        }) => {
            follow_durable(
                DurableFollow {
                    backend,
                    target: run.target.as_deref(),
                    run_id: run.run_id,
                    kind: DurableFollowKind::Logs,
                    initial_cursor: after,
                    execution,
                },
                signal,
                output,
            )
            .await
        }
        NativeV2CliCommand::Attach { run, execution } => {
            follow_attach(
                backend,
                RoutedAttach {
                    target: run.target.as_deref(),
                    params: RunAttachParams {
                        run_id: run.run_id,
                        execution,
                    },
                },
                signal,
                output,
            )
            .await
        }
        _ => Err(NativeV2CliError::Usage(
            "expected a subscription run operation".to_owned(),
        )),
    }
}

async fn execute_run<B, S, W>(
    run: RunCommand,
    context: &CliExecutionContext<'_, B>,
    signal: &mut S,
    output: &mut W,
) -> Result<CliOutcome, NativeV2CliError>
where
    B: NativeV2CliBackend,
    S: DetachSignal,
    W: Write,
{
    let Some(receipt) = submit_run(&run, context).await? else {
        write_json(output, &serde_json::json!({ "valid": true }))?;
        return Ok(CliOutcome::Completed);
    };
    write_json(output, &receipt)?;
    if run.detach {
        return Ok(CliOutcome::Detached);
    }
    let outcome = follow_durable(
        DurableFollow {
            backend: context.backend,
            target: run.target.as_deref(),
            run_id: receipt.run_id,
            kind: DurableFollowKind::Watch,
            initial_cursor: None,
            execution: None,
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
    initial_cursor: Option<Cursor>,
    execution: Option<openengine_cluster_protocol::ExecutionRef>,
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
                        execution: self.execution.clone(),
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
    W: CliSubscription<CliRunWatchEventNotification>,
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
    Watch(CliRunWatchEventNotification),
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
    let mut from_cursor = follow.initial_cursor.clone();
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
                Err(NativeV2CliError::Disconnected) => {
                    tokio::time::sleep(Duration::from_millis(100)).await;
                    continue;
                }
                Err(error) => return Err(error),
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
                CliRunStatus::Target(RunStatus::Finished {
                    terminal_result: TerminalResult::Succeeded { .. },
                    ..
                }) => Some(CliOutcome::Finished),
                CliRunStatus::Target(RunStatus::Finished {
                    terminal_result: TerminalResult::Failed { .. },
                    ..
                }) => Some(CliOutcome::Failed),
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

fn write_json(output: &mut impl Write, value: &impl Serialize) -> Result<(), NativeV2CliError> {
    serde_json::to_writer(&mut *output, value)?;
    output.write_all(b"\n")?;
    output.flush()?;
    Ok(())
}
