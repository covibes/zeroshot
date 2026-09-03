use crate::execution::process::{
    LocalProcessRunner, ProcessRunnerError, ProcessSession, ProcessSessionCommand,
    ProcessSessionOutput, ProcessStdout,
};
use crate::native_v2_capsule::provider_process::{
    ProcessExchange, ProcessInputFailure, exchange_process_io, open_provider_process,
    process_failure_detail, safe_provider_text,
};
use crate::native_v2_contract::TokenUsageDelta;
use crate::native_v2_runner::{DriverControl, LiveOutput, LiveOutputStream, NodeRunnerError};

use super::output::{CodexOutput, CodexOutputDecoder};

pub(super) enum ProcessOpen {
    Ready(ProcessSession),
    ProviderFailure(String),
}

struct CollectedOutput {
    output: CodexOutput,
    delivery_error: Option<NodeRunnerError>,
    usage: Option<TokenUsageDelta>,
}

pub(super) async fn open_process(
    runner: LocalProcessRunner,
    command: ProcessSessionCommand,
    control: &DriverControl,
) -> Result<ProcessOpen, NodeRunnerError> {
    let process = match open_provider_process(runner, command, control).await? {
        Ok(process) => process,
        Err(error) => {
            return Ok(ProcessOpen::ProviderFailure(format!(
                "provider process could not start: {error}"
            )));
        }
    };
    Ok(ProcessOpen::Ready(process))
}

async fn collect_output(
    mut stdout: ProcessStdout,
    control: &DriverControl,
    redactions: &[String],
) -> CollectedOutput {
    let mut decoder = CodexOutputDecoder::new();
    let mut delivery_error = None;
    while let Some(chunk) = stdout.recv().await {
        for emission in decoder.push(chunk.as_slice()) {
            if delivery_error.is_some() {
                continue;
            }
            let (stream, message) = emission.log();
            if let Err(error) = emit_text(control, stream, message, redactions).await {
                delivery_error = Some(error);
            }
        }
    }
    finish_collection(decoder, delivery_error)
}

pub(super) async fn exchange_turn(
    process: &mut ProcessSession,
    prompt: &str,
    control: &DriverControl,
    redactions: &[String],
) -> Result<CodexOutput, NodeRunnerError> {
    let stdout = process.detach_stdout();
    let collected = collect_output(stdout, control, redactions);
    let exchange = exchange_process_io(process, prompt.as_bytes(), collected).await;
    let (resolved, usage) = match exchange {
        ProcessExchange::Complete(collected) => {
            let output_complete = collected.delivery_error.is_none();
            let output = retain_delivery_evidence(collected.output, collected.delivery_error);
            let completion = finish_process(process, output_complete).await;
            (
                resolve_process_completion(output, completion, control.is_cancelled()),
                collected.usage,
            )
        }
        ProcessExchange::InputFailure(ProcessInputFailure {
            output: collected,
            input_error,
            completion,
        }) => {
            let output = retain_delivery_evidence(collected.output, collected.delivery_error);
            (
                resolve_input_failure(output, input_error, completion, control.is_cancelled()),
                collected.usage,
            )
        }
    };
    let recorded = control.record_token_usage(usage).await;
    if matches!(&resolved, Err(NodeRunnerError::Cancelled)) {
        return Err(NodeRunnerError::Cancelled);
    }
    recorded?;
    resolved
}

fn finish_collection(
    decoder: CodexOutputDecoder,
    error: Option<NodeRunnerError>,
) -> CollectedOutput {
    let output = decoder.finish();
    let usage = output.token_usage();
    CollectedOutput {
        output,
        delivery_error: error,
        usage,
    }
}

fn retain_delivery_evidence(
    mut output: CodexOutput,
    error: Option<NodeRunnerError>,
) -> Result<CodexOutput, NodeRunnerError> {
    match error {
        Some(NodeRunnerError::Cancelled) => Err(NodeRunnerError::Cancelled),
        Some(error) => {
            output.merge_failure_detail(format!("provider output delivery failed: {error}"));
            Ok(output)
        }
        None => Ok(output),
    }
}

pub(super) async fn finish_process(
    process: &mut ProcessSession,
    output_complete: bool,
) -> Result<ProcessSessionOutput, ProcessRunnerError> {
    if output_complete {
        process.wait().await
    } else {
        process.release().await
    }
}

pub(super) fn resolve_process_completion(
    output: Result<CodexOutput, NodeRunnerError>,
    completion: Result<ProcessSessionOutput, ProcessRunnerError>,
    cancelled: bool,
) -> Result<CodexOutput, NodeRunnerError> {
    if process_was_cancelled(&output, &completion, cancelled) {
        return Err(NodeRunnerError::Cancelled);
    }
    let provider_output_failed = output
        .as_ref()
        .map_or(true, |output| output.failure_message().is_some());
    let process_detail = completion_detail(&completion, provider_output_failed)?;
    merge_completion_detail(output, process_detail)
}

pub(super) fn resolve_input_failure(
    output: Result<CodexOutput, NodeRunnerError>,
    input_error: ProcessRunnerError,
    completion: Result<ProcessSessionOutput, ProcessRunnerError>,
    cancelled: bool,
) -> Result<CodexOutput, NodeRunnerError> {
    if process_was_cancelled(&output, &completion, cancelled) {
        return Err(NodeRunnerError::Cancelled);
    }
    let mut output = output.unwrap_or_else(|error| {
        CodexOutput::provider_failure(format!("provider output collection failed: {error}"))
    });
    output.merge_failure_detail(format!("provider process input failed: {input_error}"));
    if let Some(detail) = completion_detail(&completion, true)? {
        output.merge_failure_detail(detail);
    }
    Ok(output)
}

fn process_was_cancelled(
    output: &Result<CodexOutput, NodeRunnerError>,
    completion: &Result<ProcessSessionOutput, ProcessRunnerError>,
    externally_cancelled: bool,
) -> bool {
    externally_cancelled
        || matches!(output, Err(NodeRunnerError::Cancelled))
        || matches!(completion, Ok(output) if output.cancelled)
}

fn completion_detail(
    completion: &Result<ProcessSessionOutput, ProcessRunnerError>,
    provider_output_failed: bool,
) -> Result<Option<String>, NodeRunnerError> {
    match completion {
        Err(error) => Ok(Some(format!("provider process completion failed: {error}"))),
        Ok(completion) => process_failure_detail(completion, false, provider_output_failed),
    }
}

fn merge_completion_detail(
    output: Result<CodexOutput, NodeRunnerError>,
    process_detail: Option<String>,
) -> Result<CodexOutput, NodeRunnerError> {
    match (output, process_detail) {
        (Ok(mut output), Some(detail)) => {
            output.merge_failure_detail(detail);
            Ok(output)
        }
        (Ok(output), None) => Ok(output),
        (Err(error), Some(detail)) => {
            let mut output = CodexOutput::provider_failure(format!(
                "provider output collection failed: {error}"
            ));
            output.merge_failure_detail(detail);
            Ok(output)
        }
        (Err(error), None) => Err(error),
    }
}

async fn emit_text(
    control: &DriverControl,
    stream: LiveOutputStream,
    text: &str,
    redactions: &[String],
) -> Result<(), NodeRunnerError> {
    let safe = safe_provider_text(text, redactions);
    let mut rest = safe.as_str();
    while !rest.is_empty() {
        let split = if rest.len() <= 8 * 1024 {
            rest.len()
        } else {
            rest.char_indices()
                .map(|(index, _)| index)
                .take_while(|index| *index <= 8 * 1024)
                .last()
                .filter(|index| *index > 0)
                .ok_or(NodeRunnerError::UnsafeOutput)?
        };
        let (part, tail) = rest.split_at(split);
        control.emit(LiveOutput::new(stream, part)?).await?;
        rest = tail;
    }
    if text.is_empty() {
        control.emit(LiveOutput::new(stream, "")?).await?;
    }
    Ok(())
}

#[cfg(test)]
#[path = "process/tests.rs"]
mod tests;
