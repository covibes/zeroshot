//! Shipped native-v2 CLI entrypoint.

mod native_v2_target;

use std::io::Write;
use std::path::PathBuf;

use thiserror::Error;
#[cfg(unix)]
use zeroshot_engine::native_v2_cli::local::{LOCAL_CONTROLLER_MODE, LocalCliBackend};
use zeroshot_engine::native_v2_cli::oecp::NamedTargetCliBackend;
use zeroshot_engine::native_v2_cli::{
    execute_native_v2_cli, parse_native_v2_args, try_execute_native_v2_static, CtrlCDetachSignal,
    NativeV2CliCommand, NativeV2CliError,
};
#[cfg(unix)]
use zeroshot_engine::native_v2_portable_controller::{PortableControllerError, run_controller_process};

use native_v2_target::{
    default_target_registry_path, parse_target_serve, serve_direct_target, FileTargetRegistry,
    NativeV2TargetConnector, TargetConnectorError, TargetHttpControlAuthority,
    TargetOecpWebSocketDialer, TargetServeError, GitHubTargetSourceResolver,
};

#[derive(Debug, Error)]
enum ProcessError {
    #[error(transparent)]
    Target(#[from] TargetConnectorError),
    #[error(transparent)]
    Cli(#[from] NativeV2CliError),
    #[cfg(unix)]
    #[error(transparent)]
    Portable(#[from] PortableControllerError),
    #[error(transparent)]
    Serve(#[from] TargetServeError),
    #[error("could not write CLI output: {0}")]
    Output(#[from] std::io::Error),
}

async fn run() -> Result<(), ProcessError> {
    let arguments = std::env::args_os().skip(1).collect::<Vec<_>>();
    #[cfg(unix)]
    if run_private_controller(&arguments).await? {
        return Ok(());
    }
    if let Some(config) = parse_target_serve(&arguments)? {
        serve_direct_target(config).await?;
        return Ok(());
    }
    run_public_command(arguments).await
}

#[cfg(unix)]
async fn run_private_controller(arguments: &[std::ffi::OsString]) -> Result<bool, ProcessError> {
    let Some(bootstrap) = private_controller_bootstrap(arguments)? else {
        return Ok(false);
    };
    run_controller_process(&bootstrap).await?;
    Ok(true)
}

async fn run_public_command(arguments: Vec<std::ffi::OsString>) -> Result<(), ProcessError> {
    let command = parse_native_v2_args(arguments)?;
    let stdout = std::io::stdout();
    let mut output = stdout.lock();
    if try_execute_native_v2_static(&command, &mut output)?.is_some() {
        return Ok(());
    }

    let mut detach = CtrlCDetachSignal;
    if is_local_command(&command) {
        return run_local_command(command, &mut detach, &mut output).await;
    }
    run_named_target_command(command, &mut detach, &mut output).await
}

async fn run_named_target_command(
    command: NativeV2CliCommand,
    detach: &mut CtrlCDetachSignal,
    output: &mut impl Write,
) -> Result<(), ProcessError> {
    let registry = FileTargetRegistry::new(default_target_registry_path()?);
    let connector = NativeV2TargetConnector::new(
        registry,
        TargetHttpControlAuthority::production().map_err(TargetConnectorError::Authority)?,
        TargetOecpWebSocketDialer,
        GitHubTargetSourceResolver::production(),
    );
    let backend = NamedTargetCliBackend::new(connector);
    execute_native_v2_cli(command, &backend, detach, output).await?;
    Ok(())
}

#[cfg(unix)]
async fn run_local_command(
    command: NativeV2CliCommand,
    detach: &mut CtrlCDetachSignal,
    output: &mut impl Write,
) -> Result<(), ProcessError> {
    let backend = LocalCliBackend::production()?;
    execute_native_v2_cli(command, &backend, detach, output).await?;
    Ok(())
}

#[cfg(not(unix))]
async fn run_local_command(
    _command: NativeV2CliCommand,
    _detach: &mut CtrlCDetachSignal,
    _output: &mut impl Write,
) -> Result<(), ProcessError> {
    Err(
        NativeV2CliError::Local("local controllers are unavailable on this platform".to_owned())
            .into(),
    )
}

fn is_local_command(command: &NativeV2CliCommand) -> bool {
    match command {
        NativeV2CliCommand::Run(run) => run.target.is_none(),
        NativeV2CliCommand::List { target } => target.is_none(),
        NativeV2CliCommand::Status(run)
        | NativeV2CliCommand::Watch(run)
        | NativeV2CliCommand::Logs(run)
        | NativeV2CliCommand::ForceStop(run) => run.target.is_none(),
        NativeV2CliCommand::Attach { run, .. } => run.target.is_none(),
        NativeV2CliCommand::Help
        | NativeV2CliCommand::Version
        | NativeV2CliCommand::TemplateList
        | NativeV2CliCommand::TemplateShow { .. }
        | NativeV2CliCommand::TargetAdd(_)
        | NativeV2CliCommand::TargetLogin { .. }
        | NativeV2CliCommand::TargetSetup(_) => false,
    }
}

#[cfg(unix)]
fn private_controller_bootstrap(
    arguments: &[std::ffi::OsString],
) -> Result<Option<PathBuf>, NativeV2CliError> {
    if arguments
        .first()
        .is_none_or(|value| value != LOCAL_CONTROLLER_MODE)
    {
        return Ok(None);
    }
    if arguments.len() != 3 || arguments.get(1).is_none_or(|value| value != "--bootstrap") {
        return Err(NativeV2CliError::Usage(
            "private controller bootstrap arguments are malformed".to_owned(),
        ));
    }
    Ok(arguments.get(2).cloned().map(PathBuf::from))
}

#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("zeroshot-rust: {error}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use std::ffi::OsString;

    use openengine_cluster_testkit::assertions::AssertValue;

    use super::*;

    #[test]
    fn target_serve_is_intercepted_as_a_process_command() {
        let arguments = [
            "target",
            "serve",
            "--listen",
            "127.0.0.1:8080",
            "--public-origin",
            "http://127.0.0.1:8080",
            "--storage",
            "/tmp/zeroshot-target",
        ]
        .into_iter()
        .map(OsString::from)
        .collect::<Vec<_>>();
        assert!(parse_target_serve(&arguments).assert_value().is_some());
        assert!(parse_native_v2_args(arguments).is_err());
    }
}
