use std::fmt;
use std::io::Write;
use std::path::Path;

use openengine_cluster_protocol::{
    GraphProfile, GraphSpec, IdempotencyKey, RunAttachParams, RunForceParams, RunListParams,
    RunLogsParams, RunStatus, RunStatusParams, RunSubmitParams, RunWatchEventNotification,
    RunWatchParams,
};
use serde::Serialize;

use super::{
    CliOutcome, CliSubscription, CliSubscriptionItem, DetachSignal, NativeV2CliBackend,
    NativeV2CliCommand, NativeV2CliError, RunCommand, RunSelector, HELP,
};

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
            let result = backend.run_list(&target, RunListParams::default()).await?;
            write_json(output, &result)?;
            Ok(CliOutcome::Completed)
        }
        NativeV2CliCommand::Status(run) => {
            let result = backend
                .run_status(&run.target, RunStatusParams { run_id: run.run_id })
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
        .run_force(&run.target, RunForceParams { run_id: run.run_id })
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
            let subscription = backend
                .run_watch(
                    &run.target,
                    RunWatchParams {
                        run_id: run.run_id,
                        from_cursor: None,
                    },
                )
                .await?;
            follow_watch(subscription, signal, output).await
        }
        NativeV2CliCommand::Logs(run) => {
            let subscription = backend
                .run_logs(
                    &run.target,
                    RunLogsParams {
                        run_id: run.run_id,
                        from_cursor: None,
                        execution: None,
                    },
                )
                .await?;
            follow_stream(subscription, signal, output).await
        }
        NativeV2CliCommand::Attach { run, execution } => {
            let subscription = backend
                .run_attach(
                    &run.target,
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
    let receipt = backend.run_submit(&run.target, params).await?;
    write_json(output, &receipt)?;
    if run.detach {
        return Ok(CliOutcome::Detached);
    }
    let subscription = backend
        .run_watch(
            &run.target,
            RunWatchParams {
                run_id: receipt.run_id,
                from_cursor: None,
            },
        )
        .await?;
    follow_watch(subscription, signal, output).await
}

fn prepare_submission(run: &RunCommand) -> Result<RunSubmitParams, NativeV2CliError> {
    let graph = read_json::<GraphSpec>("graph", &run.graph)?;
    validate_graph_profile(&graph)?;
    let initial_input = read_json::<serde_json::Value>("input", &run.input)?;
    graph
        .initial_input
        .validate_value(&initial_input)
        .map_err(|error| NativeV2CliError::InitialInput(error.to_string()))?;
    let submission_key = run
        .submission_key
        .clone()
        .map_or_else(fresh_submission_key, Ok)?;
    Ok(RunSubmitParams {
        graph,
        initial_input,
        ship: run.ship,
        submission_key,
    })
}

fn validate_graph_profile(graph: &GraphSpec) -> Result<(), NativeV2CliError> {
    if graph.profile == GraphProfile::Full {
        return Ok(());
    }
    Err(NativeV2CliError::Usage(
        "native-v2 requires graph profile openengine.graph.full/v1".to_owned(),
    ))
}

pub(crate) async fn follow_watch<S, W, T>(
    mut subscription: T,
    signal: &mut S,
    output: &mut W,
) -> Result<CliOutcome, NativeV2CliError>
where
    S: DetachSignal,
    W: Write,
    T: CliSubscription<RunWatchEventNotification>,
{
    loop {
        tokio::select! {
            () = signal.wait() => return Ok(CliOutcome::Detached),
            item = subscription.next() => match item? {
                Some(CliSubscriptionItem::Event(event)) => {
                    let finished = matches!(event.status, RunStatus::Finished { .. });
                    write_json(output, &event)?;
                    if finished {
                        return Ok(CliOutcome::Finished);
                    }
                }
                Some(CliSubscriptionItem::Closed { .. }) | None => {
                    return Ok(CliOutcome::Detached);
                }
            }
        }
    }
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

fn read_json<T>(kind: &'static str, path: &Path) -> Result<T, NativeV2CliError>
where
    T: serde::de::DeserializeOwned,
{
    let bytes = std::fs::read(path).map_err(|source| NativeV2CliError::Read {
        kind,
        path: path.to_owned(),
        source,
    })?;
    serde_json::from_slice(&bytes).map_err(|source| NativeV2CliError::Json {
        kind,
        path: path.to_owned(),
        source,
    })
}

fn fresh_submission_key() -> Result<IdempotencyKey, NativeV2CliError> {
    let mut random = [0_u8; 16];
    getrandom::fill(&mut random).map_err(|_| NativeV2CliError::Randomness)?;
    let mut key = String::from("cli-");
    for byte in random {
        use fmt::Write as _;
        let _ = write!(&mut key, "{byte:02x}");
    }
    IdempotencyKey::new(key).map_err(|error| NativeV2CliError::Usage(error.to_owned()))
}

fn write_json(output: &mut impl Write, value: &impl Serialize) -> Result<(), NativeV2CliError> {
    serde_json::to_writer(&mut *output, value)?;
    output.write_all(b"\n")?;
    output.flush()?;
    Ok(())
}

fn outcome_for_status(status: &RunStatus) -> CliOutcome {
    match status {
        RunStatus::Finished { .. } => CliOutcome::Finished,
        _ => CliOutcome::Completed,
    }
}
