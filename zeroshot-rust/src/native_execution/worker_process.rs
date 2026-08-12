use std::path::PathBuf;

use openengine_cluster_protocol::{canonical_value_bytes, WorkerErrorCode, WorkerOutcome};
use serde::de::DeserializeOwned;
use tokio::sync::watch;

use crate::execution::driver::{DriverCompletion, DriverStartOutcome};
use crate::execution::process::{
    LocalProcessRunner, ProcessCommand, ProcessLaunchEvidence, ProcessRunOutput,
    ProcessRunnerError, ProcessSecretEnvironment,
};
use crate::execution::{CompletionEvidence, ExecutionCandidate, ExecutionInput, ExecutionResult};
use crate::native_credentials::CredentialRequirementName;
use crate::worker_catalog::{worker_catalog, DriverFamily, ProbeStrategy};

pub(super) struct CliConfiguration {
    pub(super) executable: Option<PathBuf>,
    pub(super) arguments: Vec<String>,
    pub(super) requirement: CredentialRequirementName,
}

pub(super) enum WorkerRunFailure {
    Closed(WorkerErrorCode),
    Uncertain,
}

pub(super) fn cleaned_process(
    result: Result<ProcessRunOutput, ProcessRunnerError>,
) -> Result<ProcessRunOutput, WorkerRunFailure> {
    let output = match result {
        Err(error) if error.launch_evidence() == ProcessLaunchEvidence::DefinitelyNotStarted => {
            return Err(WorkerRunFailure::Closed(WorkerErrorCode::Crash));
        }
        Err(_) => return Err(WorkerRunFailure::Uncertain),
        Ok(output) => output,
    };
    if !output.cleanup.proves_tree_empty() || output.post_launch_error.is_some() {
        return Err(WorkerRunFailure::Uncertain);
    }
    if output.timed_out || output.cancelled {
        return Err(WorkerRunFailure::Closed(WorkerErrorCode::Timeout));
    }
    Ok(output)
}

pub(super) fn successful_stdout(
    result: Result<ProcessRunOutput, ProcessRunnerError>,
) -> Result<Vec<u8>, WorkerRunFailure> {
    let output = cleaned_process(result)?;
    if output.exit_code != Some(0) || !output.stderr.is_empty() {
        return Err(WorkerRunFailure::Closed(WorkerErrorCode::Crash));
    }
    Ok(output.stdout)
}

pub(super) async fn probe_output(
    runner: &LocalProcessRunner,
    command: ProcessCommand,
    secret: Option<ProcessSecretEnvironment>,
) -> Result<Vec<u8>, ()> {
    let (_cancel_tx, cancel_rx) = watch::channel(false);
    let cancellation = crate::execution::driver::DriverCancellation::new(cancel_rx);
    let result = match secret {
        Some(secret) => runner.run_with_secrets(command, secret, cancellation).await,
        None => runner.run(command, cancellation).await,
    };
    let output = cleaned_process(result).map_err(|_| ())?;
    if output.exit_code != Some(0) {
        return Err(());
    }
    let mut bytes = output.stdout;
    bytes.extend_from_slice(&output.stderr);
    Ok(bytes)
}

pub(super) fn finish_worker_run(
    result: Result<WorkerOutcome, WorkerRunFailure>,
) -> DriverStartOutcome {
    match result {
        Ok(outcome) => completed_outcome(outcome),
        Err(WorkerRunFailure::Closed(code)) => {
            completed_outcome(WorkerOutcome::declared_failure(code))
        }
        Err(WorkerRunFailure::Uncertain) => DriverStartOutcome::Indeterminate { fault: None },
    }
}

fn completed_outcome(outcome: WorkerOutcome) -> DriverStartOutcome {
    let value = serde_json::to_value(outcome).expect("closed worker outcome must serialize");
    let bytes = canonical_value_bytes(&value).expect("closed worker outcome must canonicalize");
    let candidate = ExecutionCandidate::new(
        String::from_utf8(bytes).expect("canonical worker outcome must be UTF-8"),
    )
    .expect("closed worker outcome fits execution candidate bounds");
    let result = ExecutionResult::new(candidate, CompletionEvidence::Success, None)
        .expect("closed worker completion is valid");
    DriverStartOutcome::Completed {
        completion: DriverCompletion::success(result),
    }
}

pub(super) fn cli_configuration(
    provider: &str,
    path: Option<&std::ffi::OsStr>,
) -> Result<CliConfiguration, ()> {
    let descriptor = worker_catalog().resolve(provider).ok_or(())?;
    if descriptor.driver_family() != DriverFamily::CliProcess
        || descriptor.credential_requirements().len() != 1
    {
        return Err(());
    }
    let metadata = descriptor.executable().ok_or(())?;
    if metadata.probe() != ProbeStrategy::Version {
        return Err(());
    }
    Ok(CliConfiguration {
        executable: resolve_executable(metadata.name().as_str(), path),
        arguments: metadata
            .arguments()
            .iter()
            .map(|argument| argument.as_str().to_owned())
            .collect(),
        requirement: descriptor.credential_requirements()[0].clone(),
    })
}

fn resolve_executable(name: &str, path: Option<&std::ffi::OsStr>) -> Option<PathBuf> {
    std::env::split_paths(path?)
        .map(|directory| directory.join(name))
        .find(|candidate| candidate.is_file())
        .and_then(|candidate| std::fs::canonicalize(candidate).ok())
}

pub(super) fn decode_inline<T: DeserializeOwned>(input: ExecutionInput) -> Result<T, ()> {
    let ExecutionInput::Inline(input) = input else {
        return Err(());
    };
    serde_json::from_str(input.as_str()).map_err(|_| ())
}

pub(super) fn validate_bounded_text(value: &str, maximum: usize) -> Result<(), ()> {
    if value.is_empty() || value.len() > maximum || value.contains('\0') {
        Err(())
    } else {
        Ok(())
    }
}
