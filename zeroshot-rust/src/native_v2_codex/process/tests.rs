use crate::execution::process::{ProcessCleanupEvidence, ProcessLaunchEvidence, ProcessSessionOutput};
use openengine_cluster_testkit::assertions::AssertValue;

use super::*;

fn completion(cleanup: ProcessCleanupEvidence, cancelled: bool) -> ProcessSessionOutput {
    ProcessSessionOutput {
        launch_evidence: ProcessLaunchEvidence::MayHaveStarted,
        exit_code: Some(0),
        termination_signal: None,
        core_dumped: false,
        stderr_tail: Vec::new(),
        stderr_tail_truncated: false,
        cancelled,
        timed_out: false,
        cleanup,
        post_launch_error: None,
    }
}

#[test]
fn process_cancellation_wins_over_output_collection_failure() {
    let resolved = resolve_process_completion(
        Err(NodeRunnerError::DurableOutputClosed),
        Ok(completion(ProcessCleanupEvidence::Reaped, true)),
        false,
    );

    assert!(matches!(resolved, Err(NodeRunnerError::Cancelled)));
}

#[test]
fn external_cancellation_wins_over_process_completion_failure() {
    let resolved = resolve_process_completion(
        Err(NodeRunnerError::DurableOutputClosed),
        Err(ProcessRunnerError::Io("supervisor stopped".to_owned())),
        true,
    );

    assert!(matches!(resolved, Err(NodeRunnerError::Cancelled)));
}

#[test]
fn cleanup_evidence_is_retained_with_output_collection_failure() {
    let output = resolve_process_completion(
        Err(NodeRunnerError::DurableOutputClosed),
        Ok(completion(ProcessCleanupEvidence::TimedOut, false)),
        false,
    )
    .assert_value();
    let detail = output.failure_message().assert_value();

    assert!(detail.contains("provider output collection failed"));
    assert!(detail.contains("cleanup did not prove the process tree empty"));
}

#[test]
fn clean_completion_does_not_replace_output_collection_failure() {
    let resolved = resolve_process_completion(
        Err(NodeRunnerError::DurableOutputClosed),
        Ok(completion(ProcessCleanupEvidence::Reaped, false)),
        false,
    );

    assert!(matches!(
        resolved,
        Err(NodeRunnerError::DurableOutputClosed)
    ));
}

#[test]
fn parsing_after_an_emission_failure_retains_later_terminal_usage() {
    let mut decoder = CodexOutputDecoder::new();
    let emissions = decoder.push(
        concat!(
            "{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",",
            "\"text\":\"done\"}}\n",
        )
        .as_bytes(),
    );
    assert_eq!(emissions.len(), 1);

    let suppressed = decoder.push(
        concat!(
            "{\"type\":\"turn.completed\",\"usage\":{",
            "\"input_tokens\":17,\"cached_input_tokens\":4,",
            "\"cache_write_input_tokens\":3,\"output_tokens\":9}}\n",
        )
        .as_bytes(),
    );
    assert_eq!(suppressed.len(), 1);

    let collected = finish_collection(decoder, Some(NodeRunnerError::DurableOutputClosed));
    assert!(matches!(
        collected.delivery_error,
        Some(NodeRunnerError::DurableOutputClosed)
    ));
    assert_eq!(collected.output.final_message().assert_value(), "done");
    let usage = collected.usage.assert_value();
    assert_eq!(usage.input_tokens.get(), 17);
    assert_eq!(usage.output_tokens.get(), 9);
    assert_eq!(usage.cache_read_input_tokens.assert_value().get(), 4);
    assert_eq!(usage.cache_creation_input_tokens.assert_value().get(), 3);
}
