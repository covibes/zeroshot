//! Shipped native-v2 CLI entrypoint.

mod native_v2_target;

use std::io::Write;

use thiserror::Error;
use zeroshot_engine::native_v2_cli::oecp::OecpCliBackend;
use zeroshot_engine::native_v2_cli::{
    execute_native_v2_cli, parse_native_v2_args, CtrlCDetachSignal, NativeV2CliCommand,
    NativeV2CliError, HELP,
};

use native_v2_target::{
    default_target_registry_path, AuthenticatedOecpWebSocketDialer, FileTargetRegistry,
    HostedTargetControlAuthority, NativeV2TargetConnector, TargetConnectorError,
};

#[derive(Debug, Error)]
enum ProcessError {
    #[error(transparent)]
    Target(#[from] TargetConnectorError),
    #[error(transparent)]
    Cli(#[from] NativeV2CliError),
    #[error("could not write CLI output: {0}")]
    Output(#[from] std::io::Error),
}

async fn run() -> Result<(), ProcessError> {
    let command = parse_native_v2_args(std::env::args_os().skip(1))?;
    let stdout = std::io::stdout();
    let mut output = stdout.lock();
    if command == NativeV2CliCommand::Help {
        output.write_all(HELP.as_bytes())?;
        output.flush()?;
        return Ok(());
    }

    let registry = FileTargetRegistry::new(default_target_registry_path()?);
    let connector = NativeV2TargetConnector::new(
        registry,
        HostedTargetControlAuthority::production().map_err(TargetConnectorError::Authority)?,
        AuthenticatedOecpWebSocketDialer,
    );
    let backend = OecpCliBackend::new(connector);
    let mut detach = CtrlCDetachSignal;
    execute_native_v2_cli(command, &backend, &mut detach, &mut output).await?;
    Ok(())
}

#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("zeroshot-rust: {error}");
        std::process::exit(1);
    }
}
