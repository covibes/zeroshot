//! Lean native-v2 command contract.
//!
//! Parsing and local file validation happen before a named target is contacted. Runtime/provider
//! configuration remains target-owned; every run operation carries only the public [`RunId`].

use std::ffi::OsString;
use std::fmt;
use std::io::Write;
use std::path::{Path, PathBuf};

use async_trait::async_trait;
use openengine_cluster_protocol::{
    ExecutionRef, GraphProfile, GraphSpec, IdempotencyKey, RunAttachEventNotification,
    RunAttachParams, RunForceParams, RunListParams, RunLogEventNotification, RunLogsParams,
    RunStatus, RunStatusParams, RunStatusResult, RunSubmitParams, RunWatchEventNotification,
    RunWatchParams, SubscriptionCloseReason,
};
use serde::Serialize;
use thiserror::Error;

#[path = "native_v2_cli/oecp.rs"]
pub mod oecp;

#[cfg(test)]
#[path = "native_v2_cli/tests.rs"]
mod tests;

pub const HELP: &str = "\
zeroshot v2

  target add <name> --url <https-origin>
  target login <name>
  target setup <name> --repository <owner/name> --runtime-config <file> [--base <ref>] [--target-branch <branch>]
  run --target <name> --graph <file> --input <file> [--ship] [--submission-key <key>] [-d]
  list --target <name>
  status <run-id> --target <name>
  watch <run-id> --target <name>
  logs <run-id> --target <name>
  attach <run-id> <execution-ref> --target <name>
  force-stop <run-id> --target <name>
";

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TargetAdd {
    pub name: String,
    pub url: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TargetSetup {
    pub name: String,
    pub repository: String,
    pub runtime_config: PathBuf,
    pub base: Option<String>,
    pub target_branch: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RunCommand {
    pub target: String,
    pub graph: PathBuf,
    pub input: PathBuf,
    pub ship: bool,
    pub detach: bool,
    pub submission_key: Option<IdempotencyKey>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RunSelector {
    pub target: String,
    pub run_id: openengine_cluster_protocol::RunId,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum NativeV2CliCommand {
    Help,
    TargetAdd(TargetAdd),
    TargetLogin {
        name: String,
    },
    TargetSetup(TargetSetup),
    Run(RunCommand),
    List {
        target: String,
    },
    Status(RunSelector),
    Watch(RunSelector),
    Logs(RunSelector),
    Attach {
        run: RunSelector,
        execution: ExecutionRef,
    },
    ForceStop(RunSelector),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CliOutcome {
    Completed,
    Finished,
    Detached,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CliSubscriptionItem<E> {
    Event(E),
    Closed { reason: SubscriptionCloseReason },
}

#[derive(Debug, Error)]
pub enum NativeV2CliError {
    #[error("{0}")]
    Usage(String),
    #[error("could not read {kind} file {path}: {source}")]
    Read {
        kind: &'static str,
        path: PathBuf,
        source: std::io::Error,
    },
    #[error("{kind} file {path} is not valid JSON: {source}")]
    Json {
        kind: &'static str,
        path: PathBuf,
        source: serde_json::Error,
    },
    #[error("initial input does not match GraphSpec.initialInput: {0}")]
    InitialInput(String),
    #[error("submission identity randomness is unavailable")]
    Randomness,
    #[error("target operation failed: {0}")]
    Target(String),
    #[error("native-v2 OECP request failed: {0}")]
    Protocol(String),
    #[error("could not write CLI output: {0}")]
    Output(#[from] std::io::Error),
    #[error("could not encode CLI output: {0}")]
    OutputJson(#[from] serde_json::Error),
}

#[async_trait]
pub trait CliSubscription<E>: Send {
    async fn next(&mut self) -> Result<Option<CliSubscriptionItem<E>>, NativeV2CliError>;
}

#[async_trait]
pub trait DetachSignal: Send {
    async fn wait(&mut self);
}

pub struct CtrlCDetachSignal;

#[async_trait]
impl DetachSignal for CtrlCDetachSignal {
    async fn wait(&mut self) {
        let _ = tokio::signal::ctrl_c().await;
    }
}

pub struct NeverDetach;

#[async_trait]
impl DetachSignal for NeverDetach {
    async fn wait(&mut self) {
        std::future::pending::<()>().await;
    }
}

#[async_trait]
pub trait NativeV2CliBackend: Send + Sync {
    type Watch: CliSubscription<RunWatchEventNotification>;
    type Logs: CliSubscription<RunLogEventNotification>;
    type Attach: CliSubscription<RunAttachEventNotification>;

    async fn target_add(&self, request: TargetAdd) -> Result<(), NativeV2CliError>;
    async fn target_login(&self, name: &str) -> Result<(), NativeV2CliError>;
    async fn target_setup(&self, request: TargetSetup) -> Result<(), NativeV2CliError>;

    async fn run_submit(
        &self,
        target: &str,
        params: RunSubmitParams,
    ) -> Result<openengine_cluster_protocol::RunSubmitResult, NativeV2CliError>;
    async fn run_list(
        &self,
        target: &str,
        params: RunListParams,
    ) -> Result<openengine_cluster_protocol::RunListResult, NativeV2CliError>;
    async fn run_status(
        &self,
        target: &str,
        params: RunStatusParams,
    ) -> Result<RunStatusResult, NativeV2CliError>;
    async fn run_watch(
        &self,
        target: &str,
        params: RunWatchParams,
    ) -> Result<Self::Watch, NativeV2CliError>;
    async fn run_logs(
        &self,
        target: &str,
        params: RunLogsParams,
    ) -> Result<Self::Logs, NativeV2CliError>;
    async fn run_attach(
        &self,
        target: &str,
        params: RunAttachParams,
    ) -> Result<Self::Attach, NativeV2CliError>;
    async fn run_force(
        &self,
        target: &str,
        params: RunForceParams,
    ) -> Result<openengine_cluster_protocol::RunForceResult, NativeV2CliError>;
}

/// Parses only the native-v2 public command surface. Unknown options are rejected.
pub fn parse_native_v2_args<I>(args: I) -> Result<NativeV2CliCommand, NativeV2CliError>
where
    I: IntoIterator<Item = OsString>,
{
    let args = args
        .into_iter()
        .map(|value| {
            value
                .into_string()
                .map_err(|_| usage("arguments must be valid UTF-8"))
        })
        .collect::<Result<Vec<_>, _>>()?;
    let Some(command) = args.first().map(String::as_str) else {
        return Ok(NativeV2CliCommand::Help);
    };
    if matches!(
        command,
        "status" | "watch" | "logs" | "attach" | "force-stop"
    ) {
        return parse_observation_command(command, &args[1..]);
    }
    match command {
        "help" | "--help" | "-h" => exact_help(&args),
        "target" => parse_target(&args[1..]),
        "run" => parse_run(&args[1..]),
        "list" => parse_list(&args[1..]),
        _ => Err(usage(format!("unknown native-v2 command {command:?}"))),
    }
}

fn parse_observation_command(
    command: &str,
    args: &[String],
) -> Result<NativeV2CliCommand, NativeV2CliError> {
    match command {
        "status" => parse_run_selector(args).map(NativeV2CliCommand::Status),
        "watch" => parse_run_selector(args).map(NativeV2CliCommand::Watch),
        "logs" => parse_run_selector(args).map(NativeV2CliCommand::Logs),
        "attach" => parse_attach(args),
        "force-stop" => parse_run_selector(args).map(NativeV2CliCommand::ForceStop),
        _ => unreachable!("caller classifies observation commands"),
    }
}

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
        _ => unreachable!("caller classifies target operations"),
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
        _ => unreachable!("caller classifies unary run operations"),
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
        _ => unreachable!("caller classifies subscription run operations"),
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

async fn follow_watch<S, W, T>(
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
        write!(&mut key, "{byte:02x}").expect("writing to a String cannot fail");
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

fn exact_help(args: &[String]) -> Result<NativeV2CliCommand, NativeV2CliError> {
    if args.len() == 1 {
        Ok(NativeV2CliCommand::Help)
    } else {
        Err(usage("help accepts no arguments"))
    }
}

fn parse_target(args: &[String]) -> Result<NativeV2CliCommand, NativeV2CliError> {
    let Some(command) = args.first().map(String::as_str) else {
        return Err(usage("target requires add, login, or setup"));
    };
    match command {
        "add" => parse_target_add(args),
        "login" => parse_target_login(args),
        "setup" => parse_target_setup(args),
        _ => Err(usage(format!("unknown target command {command:?}"))),
    }
}

fn parse_target_add(args: &[String]) -> Result<NativeV2CliCommand, NativeV2CliError> {
    let name = required_name(args.get(1), "target name")?;
    let options = Options::parse(&args[2..], &["--url"], &[])?;
    Ok(NativeV2CliCommand::TargetAdd(TargetAdd {
        name,
        url: options.required("--url")?,
    }))
}

fn parse_target_login(args: &[String]) -> Result<NativeV2CliCommand, NativeV2CliError> {
    if args.len() != 2 {
        return Err(usage("target login requires exactly one target name"));
    }
    Ok(NativeV2CliCommand::TargetLogin {
        name: required_name(args.get(1), "target name")?,
    })
}

fn parse_target_setup(args: &[String]) -> Result<NativeV2CliCommand, NativeV2CliError> {
    let name = required_name(args.get(1), "target name")?;
    let options = Options::parse(
        &args[2..],
        &[
            "--repository",
            "--runtime-config",
            "--base",
            "--target-branch",
        ],
        &[],
    )?;
    Ok(NativeV2CliCommand::TargetSetup(TargetSetup {
        name,
        repository: options.required("--repository")?,
        runtime_config: PathBuf::from(options.required("--runtime-config")?),
        base: options.optional("--base"),
        target_branch: options.optional("--target-branch"),
    }))
}

fn parse_run(args: &[String]) -> Result<NativeV2CliCommand, NativeV2CliError> {
    let options = Options::parse(
        args,
        &["--target", "--graph", "--input", "--submission-key"],
        &["--ship", "--detach", "-d"],
    )?;
    let submission_key = options
        .optional("--submission-key")
        .map(IdempotencyKey::new)
        .transpose()
        .map_err(|error| usage(format!("invalid --submission-key: {error}")))?;
    Ok(NativeV2CliCommand::Run(RunCommand {
        target: required_target(&options)?,
        graph: PathBuf::from(options.required("--graph")?),
        input: PathBuf::from(options.required("--input")?),
        ship: options.flag("--ship"),
        detach: options.flag("--detach") || options.flag("-d"),
        submission_key,
    }))
}

fn parse_list(args: &[String]) -> Result<NativeV2CliCommand, NativeV2CliError> {
    let options = Options::parse(args, &["--target"], &[])?;
    Ok(NativeV2CliCommand::List {
        target: required_target(&options)?,
    })
}

fn parse_run_selector(args: &[String]) -> Result<RunSelector, NativeV2CliError> {
    let run_id = args.first().ok_or_else(|| usage("run ID is required"))?;
    validate_public_id(run_id, "run ID")?;
    let options = Options::parse(&args[1..], &["--target"], &[])?;
    Ok(RunSelector {
        target: required_target(&options)?,
        run_id: openengine_cluster_protocol::RunId::new(run_id),
    })
}

fn parse_attach(args: &[String]) -> Result<NativeV2CliCommand, NativeV2CliError> {
    let run_id = args
        .first()
        .ok_or_else(|| usage("attach requires a run ID"))?;
    validate_public_id(run_id, "run ID")?;
    let execution = args
        .get(1)
        .ok_or_else(|| usage("attach requires an execution reference"))?;
    let execution = ExecutionRef::new(execution.clone())
        .map_err(|error| usage(format!("invalid execution reference: {error}")))?;
    let options = Options::parse(&args[2..], &["--target"], &[])?;
    Ok(NativeV2CliCommand::Attach {
        run: RunSelector {
            target: required_target(&options)?,
            run_id: openengine_cluster_protocol::RunId::new(run_id),
        },
        execution,
    })
}

fn required_target(options: &Options) -> Result<String, NativeV2CliError> {
    let target = options.required("--target")?;
    validate_public_id(&target, "target name")?;
    Ok(target)
}

fn required_name(value: Option<&String>, kind: &str) -> Result<String, NativeV2CliError> {
    let value = value.ok_or_else(|| usage(format!("{kind} is required")))?;
    validate_public_id(value, kind)?;
    Ok(value.clone())
}

fn validate_public_id(value: &str, kind: &str) -> Result<(), NativeV2CliError> {
    if value.is_empty() || value.chars().count() > 256 || value.chars().any(char::is_control) {
        return Err(usage(format!(
            "{kind} must be 1..=256 non-control characters"
        )));
    }
    Ok(())
}

fn usage(message: impl Into<String>) -> NativeV2CliError {
    NativeV2CliError::Usage(message.into())
}

#[derive(Default)]
struct Options {
    values: std::collections::BTreeMap<String, String>,
    flags: std::collections::BTreeSet<String>,
}

impl Options {
    fn parse(
        args: &[String],
        value_names: &[&str],
        flag_names: &[&str],
    ) -> Result<Self, NativeV2CliError> {
        let mut parsed = Self::default();
        let mut index = 0;
        while index < args.len() {
            let name = args[index].as_str();
            if value_names.contains(&name) {
                let value = args
                    .get(index + 1)
                    .filter(|value| !value.is_empty() && !value.starts_with('-'))
                    .ok_or_else(|| usage(format!("{name} requires a value")))?;
                if parsed
                    .values
                    .insert(name.to_owned(), value.clone())
                    .is_some()
                {
                    return Err(usage(format!("{name} may be specified only once")));
                }
                index += 2;
            } else if flag_names.contains(&name) {
                if !parsed.flags.insert(name.to_owned()) {
                    return Err(usage(format!("{name} may be specified only once")));
                }
                index += 1;
            } else {
                return Err(usage(format!("unknown option or argument {name:?}")));
            }
        }
        Ok(parsed)
    }

    fn required(&self, name: &str) -> Result<String, NativeV2CliError> {
        self.values
            .get(name)
            .cloned()
            .ok_or_else(|| usage(format!("{name} is required")))
    }

    fn optional(&self, name: &str) -> Option<String> {
        self.values.get(name).cloned()
    }

    fn flag(&self, name: &str) -> bool {
        self.flags.contains(name)
    }
}
