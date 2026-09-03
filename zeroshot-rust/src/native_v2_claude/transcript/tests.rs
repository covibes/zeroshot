use openengine_cluster_testkit::assertions::AssertValue;
use serde_json::{Value, json};

use super::*;

#[path = "tests/limits.rs"]
mod limit_tests;
#[path = "tests/usage.rs"]
mod usage_tests;

struct Decoded {
    attempt: ClaudeAttempt,
    emissions: Vec<ClaudeEmission>,
    usage: Option<TokenUsageDelta>,
}

fn append_event(bytes: &mut Vec<u8>, event: Value) {
    bytes.extend(serde_json::to_vec(&event).assert_value());
    bytes.push(b'\n');
}

fn success(response: Value, session: &str) -> Value {
    json!({
        "type":"result",
        "subtype":"success",
        "is_error":false,
        "session_id":session,
        "structured_output":{"response":response},
        "usage":{
            "input_tokens":11,
            "output_tokens":4,
            "cache_read_input_tokens":6,
            "cache_creation_input_tokens":2
        }
    })
}

fn failure(diagnostic: &str, session: &str) -> Value {
    json!({
        "type":"result",
        "subtype":"error_during_execution",
        "is_error":true,
        "session_id":session,
        "result":diagnostic
    })
}

fn decode(bytes: &[u8], chunk_bytes: usize, process_failure: Option<&str>) -> Decoded {
    let mut transcript = ClaudeTranscript::new(Vec::new());
    let mut emissions = Vec::new();
    for chunk in bytes.chunks(chunk_bytes.max(1)) {
        emissions.extend(transcript.push(chunk));
    }
    emissions.extend(transcript.finish_stream());
    let usage = transcript.token_usage();
    let attempt = transcript.finish(process_failure).assert_value();
    Decoded {
        attempt,
        emissions,
        usage,
    }
}

fn completed_response(attempt: ClaudeAttempt) -> Value {
    let result = match attempt {
        ClaudeAttempt::Complete(result) => Some(result),
        ClaudeAttempt::Failed(_) => None,
    };
    let result = result.assert_value();
    serde_json::from_str::<Value>(&result.message)
        .assert_value()
        .get("response")
        .cloned()
        .assert_value()
}

fn failed_attempt(attempt: ClaudeAttempt) -> ClaudeFailure {
    match attempt {
        ClaudeAttempt::Complete(_) => None,
        ClaudeAttempt::Failed(failure) => Some(failure),
    }
    .assert_value()
}

fn session_change_prefix() -> Vec<u8> {
    let mut bytes = Vec::new();
    append_event(
        &mut bytes,
        json!({"type":"system","subtype":"init","session_id":"session-1"}),
    );
    append_event(
        &mut bytes,
        json!({"type":"system","subtype":"init","session_id":"session-2"}),
    );
    bytes
}

fn assert_failed_with_usage(
    decoded: Decoded,
    expected_diagnostic: &str,
    expected_usage: [u64; 2],
) -> ClaudeFailure {
    let failure = failed_attempt(decoded.attempt);
    assert_eq!(failure.diagnostic, expected_diagnostic);
    let usage = decoded.usage.assert_value();
    assert_eq!(
        [usage.input_tokens.get(), usage.output_tokens.get()],
        expected_usage
    );
    failure
}

#[test]
fn redactions_are_deduplicated_and_longest_first() {
    let mut transcript = ClaudeTranscript::new(vec![
        "secret".to_owned(),
        "secret-tail".to_owned(),
        "secret".to_owned(),
        String::new(),
    ]);
    assert_eq!(transcript.redactions, vec!["secret-tail", "secret"]);
    let mut bytes = Vec::new();
    append_event(
        &mut bytes,
        json!({
            "type":"stream_event",
            "event":{
                "type":"content_block_delta",
                "delta":{"type":"text_delta","text":"value=secret-tail\u{0}"}
            }
        }),
    );
    append_event(&mut bytes, success(json!("done"), "session-1"));

    let emissions = transcript.push(&bytes);
    assert_eq!(emissions.len(), 1);
    let emission = emissions.first().assert_value();
    assert_eq!(emission.text, "value=[REDACTED]\u{fffd}");
    assert!(!emission.text.contains('\0'));
}

#[test]
fn malformed_ancillary_records_do_not_hide_a_valid_result() {
    let mut bytes = b"not-json\n[]\n{}\n{\"type\":1}\n".to_vec();
    append_event(&mut bytes, success(json!("done"), "session-1"));

    let decoded = decode(&bytes, 13, None);
    assert_eq!(completed_response(decoded.attempt), json!("done"));
}

#[test]
fn unknown_event_types_are_ignored_before_session_validation() {
    let mut bytes = Vec::new();
    append_event(
        &mut bytes,
        json!({"type":"future_progress","session_id":{"future":"shape"}}),
    );
    append_event(
        &mut bytes,
        json!({"type":"system","subtype":"init","session_id":"session-1"}),
    );
    append_event(
        &mut bytes,
        json!({"type":"future_progress","session_id":"conflicting-session"}),
    );
    append_event(&mut bytes, success(json!("done"), "session-1"));

    assert_eq!(
        completed_response(decode(&bytes, 11, None).attempt),
        json!("done")
    );
}

#[test]
fn oversized_ancillary_record_does_not_hide_a_valid_result() {
    let mut transcript = ClaudeTranscript::new(Vec::new());
    let result = serde_json::to_vec(&success(json!("done"), "session-1")).assert_value();
    let emissions = transcript.accept_records([
        ProviderJsonLine::Oversized,
        ProviderJsonLine::Record(result),
    ]);
    assert!(emissions.is_empty());

    assert_eq!(
        completed_response(transcript.finish(None).assert_value()),
        json!("done")
    );
}

#[test]
fn missing_terminal_result_reports_discarded_record_counts() {
    let mut transcript = ClaudeTranscript::new(Vec::new());
    let emissions = transcript.accept_records([
        ProviderJsonLine::Record(b"not-json".to_vec()),
        ProviderJsonLine::Record(b"[]".to_vec()),
        ProviderJsonLine::Oversized,
    ]);
    assert!(emissions.is_empty());

    let failure = failed_attempt(transcript.finish(None).assert_value());
    assert!(!failure.retryable);
    assert_eq!(
        failure.diagnostic,
        concat!(
            "Claude output ended without a terminal result; discarded ",
            "2 malformed JSONL records and 1 oversized JSONL record"
        )
    );
}

#[test]
fn truncated_preterminal_record_has_an_actionable_failure() {
    let mut bytes = Vec::new();
    append_event(
        &mut bytes,
        json!({"type":"system","subtype":"init","session_id":"session-1"}),
    );
    bytes.extend_from_slice(br#"{"type":"result","subtype":"success"#);

    let failure = failed_attempt(decode(&bytes, 17, None).attempt);
    assert_eq!(
        failure.diagnostic,
        concat!(
            "Claude output ended without a terminal result; discarded ",
            "1 malformed JSONL record"
        )
    );
}

#[test]
fn first_terminal_result_seals_and_ignores_all_trailing_output() {
    let mut bytes = Vec::new();
    append_event(&mut bytes, success(json!("first"), "session-1"));
    append_event(
        &mut bytes,
        json!({
            "type":"system",
            "subtype":"api_retry",
            "attempt":1,
            "max_retries":3,
            "error":"late"
        }),
    );
    append_event(&mut bytes, failure("late failure", "different-session"));
    bytes.extend_from_slice(b"not-json\nunterminated");

    let decoded = decode(&bytes, bytes.len(), None);
    assert_eq!(completed_response(decoded.attempt), json!("first"));
    assert!(decoded.emissions.is_empty());
    let usage = decoded.usage.assert_value();
    assert_eq!(
        [usage.input_tokens.get(), usage.output_tokens.get()],
        [11, 4]
    );

    let mut failure_first = Vec::new();
    append_event(
        &mut failure_first,
        failure("authoritative failure", "session-1"),
    );
    append_event(&mut failure_first, success(json!("ignored"), "session-1"));
    let failure = failed_attempt(decode(&failure_first, failure_first.len(), None).attempt);
    assert_eq!(failure.diagnostic, "authoritative failure");
}

#[test]
fn preterminal_session_change_waits_for_result_and_preserves_terminal_usage() {
    let mut bytes = session_change_prefix();
    append_event(&mut bytes, success(json!("ignored"), "session-1"));
    append_event(
        &mut bytes,
        json!({
            "type":"result",
            "subtype":"success",
            "is_error":false,
            "session_id":"session-1",
            "result":"trailing",
            "usage":{"input_tokens":999,"output_tokens":999}
        }),
    );

    let decoded = decode(&bytes, 64 * 1024, None);
    let failure = assert_failed_with_usage(
        decoded,
        "Claude output changed session identifier during one turn",
        [11, 4],
    );
    assert!(!failure.retryable);
    assert_eq!(failure.session_id.as_deref(), Some("session-1"));
}

#[test]
fn session_change_on_the_result_still_records_its_usage() {
    let mut bytes = Vec::new();
    append_event(
        &mut bytes,
        json!({"type":"system","subtype":"init","session_id":"session-1"}),
    );
    append_event(&mut bytes, success(json!("ignored"), "session-2"));

    let decoded = decode(&bytes, 7, None);
    let failure = assert_failed_with_usage(
        decoded,
        "Claude output changed session identifier during one turn",
        [11, 4],
    );
    assert_eq!(failure.session_id.as_deref(), Some("session-1"));
}

#[test]
fn session_change_preserves_later_terminal_failure_detail_and_usage() {
    let mut bytes = session_change_prefix();
    let mut terminal = failure("provider terminal detail", "session-1");
    terminal.as_object_mut().assert_value().insert(
        "usage".to_owned(),
        json!({"input_tokens":29,"output_tokens":13}),
    );
    append_event(&mut bytes, terminal);

    let decoded = decode(&bytes, 9, None);
    assert_failed_with_usage(
        decoded,
        concat!(
            "Claude output changed session identifier during one turn; ",
            "provider terminal detail"
        ),
        [29, 13],
    );
}

#[test]
fn session_identifiers_preserve_opaque_whitespace_and_reject_nul() {
    let session = "  opaque session\nwith tab\t ";
    let mut bytes = Vec::new();
    append_event(&mut bytes, success(json!("done"), session));
    let attempt = decode(&bytes, 23, None).attempt;
    let result = match attempt {
        ClaudeAttempt::Complete(result) => Some(result),
        ClaudeAttempt::Failed(_) => None,
    }
    .assert_value();
    assert_eq!(result.session_id.as_deref(), Some(session));

    let mut invalid = Vec::new();
    append_event(&mut invalid, success(json!("ignored"), "nul\0session"));
    let decoded = decode(&invalid, 23, None);
    assert_failed_with_usage(
        decoded,
        "Claude output contained an invalid session identifier",
        [11, 4],
    );
}

#[test]
fn only_an_api_retry_signal_makes_a_missing_result_retryable() {
    let ordinary = failed_attempt(decode(b"not-json\n", 64, None).attempt);
    assert!(!ordinary.retryable);

    let mut retry = Vec::new();
    append_event(
        &mut retry,
        json!({
            "type":"system",
            "subtype":"api_retry",
            "attempt":1,
            "max_retries":3,
            "error":"overloaded"
        }),
    );
    let retry = failed_attempt(decode(&retry, 64, None).attempt);
    assert!(retry.retryable);
    assert!(retry.diagnostic.contains("retryable API error"));
}

#[test]
fn process_failures_are_merged_into_terminal_attempts() {
    let process = "provider process exited with status 17; stderr: useful detail";
    let mut complete = Vec::new();
    append_event(&mut complete, success(json!("ignored"), "session-1"));
    let complete = failed_attempt(decode(&complete, 64 * 1024, Some(process)).attempt);
    assert_eq!(complete.diagnostic, process);
    assert!(!complete.retryable);

    let mut failed = Vec::new();
    append_event(
        &mut failed,
        failure("provider rejected request", "session-1"),
    );
    let failed = failed_attempt(decode(&failed, 64 * 1024, Some(process)).attempt);
    assert_eq!(
        failed.diagnostic,
        "provider rejected request; provider process exited with status 17; stderr: useful detail"
    );
}
