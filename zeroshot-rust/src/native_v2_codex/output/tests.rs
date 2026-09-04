use openengine_cluster_testkit::assertions::AssertValue;
use serde_json::json;

use super::*;

fn output_with_provisional_usage(event_type: &str, usage: Option<Value>) -> CodexOutput {
    let mut terminal = json!({"type":event_type});
    if event_type == "turn.failed" {
        terminal
            .as_object_mut()
            .assert_value()
            .insert("error".to_owned(), json!({"message":"terminal failure"}));
    }
    if let Some(usage) = usage {
        terminal
            .as_object_mut()
            .assert_value()
            .insert("usage".to_owned(), usage);
    }
    let mut bytes = Vec::new();
    for event in [
        json!({
            "type":"error",
            "message":"temporary",
            "usage":{
                "input_tokens":11,
                "output_tokens":7,
                "cached_input_tokens":5,
                "cache_write_input_tokens":3
            }
        }),
        json!({"type":"item.completed","item":{"type":"agent_message","text":"done"}}),
        terminal,
    ] {
        serde_json::to_writer(&mut bytes, &event).assert_value();
        bytes.push(b'\n');
    }
    CodexOutput::parse(&bytes)
}

fn assert_usage(output: &CodexOutput, expected: [u64; 4]) {
    let usage = output.token_usage().assert_value();
    assert_eq!(
        [
            usage.input_tokens.get(),
            usage.output_tokens.get(),
            usage.cache_read_input_tokens.assert_value().get(),
            usage.cache_creation_input_tokens.assert_value().get(),
        ],
        expected
    );
}

#[test]
fn normalizes_worker_and_verifier_messages() {
    let worker = CodexOutput::parse(
        concat!(
            "{\"type\":\"thread.started\",\"thread_id\":\"thread-1\"}\n",
            "{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",",
            "\"text\":\"{\\\"answer\\\":42}\"}}\n",
            "{\"type\":\"turn.completed\",\"usage\":{\"input_tokens\":1,",
            "\"cached_input_tokens\":1,\"cache_write_input_tokens\":3,",
            "\"output_tokens\":2}}\n",
        )
        .as_bytes(),
    );
    assert_eq!(worker.final_message().assert_value(), r#"{"answer":42}"#);
    let usage = worker.token_usage().assert_value();
    assert_eq!(usage.input_tokens.get(), 1);
    assert_eq!(usage.output_tokens.get(), 2);
    assert_eq!(usage.cache_read_input_tokens.assert_value().get(), 1);
    assert_eq!(usage.cache_creation_input_tokens.assert_value().get(), 3);

    let verifier_events = concat!(
        "{\"type\":\"thread.started\",\"thread_id\":\"thread-2\"}\n",
        "{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",",
        "\"text\":\"{\\\"output\\\":{\\\"ok\\\":true},",
        "\\\"signals\\\":{\\\"decision\\\":\\\"pass\\\"},",
        "\\\"diagnostic\\\":null}\"}}\n",
        "{\"type\":\"turn.completed\"}\n",
    );
    let verifier = CodexOutput::parse(verifier_events.as_bytes());
    assert_eq!(
        serde_json::from_str::<Value>(verifier.final_message().assert_value()).assert_value(),
        json!({
            "output": { "ok": true },
            "signals": { "decision": "pass" },
            "diagnostic": null
        })
    );
}

#[test]
fn malformed_terminal_usage_is_unavailable_without_rejecting_the_turn() {
    let output = CodexOutput::parse(
        br#"{"type":"error","message":"temporary","usage":{"input_tokens":11,"output_tokens":7}}
{"type":"item.completed","item":{"type":"agent_message","text":"done"}}
{"type":"turn.completed","usage":{"input_tokens":"many","output_tokens":2}}
"#,
    );
    assert!(output.token_usage().is_none());
}

#[test]
fn empty_terminal_usage_preserves_provisional_usage_for_every_terminal_outcome() {
    for event_type in ["turn.completed", "turn.failed"] {
        for usage in [None, Some(Value::Null), Some(json!({}))] {
            assert_usage(
                &output_with_provisional_usage(event_type, usage),
                [11, 7, 5, 3],
            );
        }
    }
}

#[test]
fn valid_terminal_usage_replaces_provisional_usage_for_every_terminal_outcome() {
    for event_type in ["turn.completed", "turn.failed"] {
        let output = output_with_provisional_usage(
            event_type,
            Some(json!({
                "input_tokens":19,
                "output_tokens":13,
                "cached_input_tokens":8,
                "cache_write_input_tokens":2
            })),
        );
        assert_usage(&output, [19, 13, 8, 2]);
    }
}

#[test]
fn malformed_terminal_usage_invalidates_provisional_usage_for_every_terminal_outcome() {
    for event_type in ["turn.completed", "turn.failed"] {
        for usage in [
            json!("invalid"),
            json!({"input_tokens":"many","output_tokens":2}),
            json!({"input_tokens":1}),
        ] {
            assert!(
                output_with_provisional_usage(event_type, Some(usage))
                    .token_usage()
                    .is_none()
            );
        }
    }
}

#[test]
fn reports_missing_terminal_or_final_message_with_actionable_detail() {
    assert_eq!(
        CodexOutput::parse(br#"{"type":"thread.started","thread_id":"thread-1"}"#)
            .failure_message(),
        Some("Codex output ended without a terminal turn event")
    );
    assert_eq!(
        CodexOutput::parse(br#"{"type":"turn.completed"}"#).failure_message(),
        Some("Codex turn completed without a final agent message")
    );
}

#[test]
fn retains_terminal_failure_detail_for_the_retry_policy() {
    let failed = CodexOutput::parse(
        concat!(
            "{\"type\":\"thread.started\",\"thread_id\":\"thread-1\"}\n",
            "{\"type\":\"error\",\"message\":\"temporary\",\"usage\":{",
            "\"input_tokens\":21,\"output_tokens\":13}}\n",
            "{\"type\":\"turn.failed\",\"usage\":{\"input_tokens\":8,",
            "\"cached_input_tokens\":5,\"cache_write_input_tokens\":2,",
            "\"output_tokens\":3},\"error\":{\"message\":\"service unavailable\"}}\n",
        )
        .as_bytes(),
    );

    assert_eq!(failed.thread_id.as_deref(), Some("thread-1"));
    assert_eq!(failed.failure_message(), Some("service unavailable"));
    let usage = failed.token_usage().assert_value();
    assert_eq!(usage.cache_read_input_tokens.assert_value().get(), 5);
    assert_eq!(usage.cache_creation_input_tokens.assert_value().get(), 2);
}

#[test]
fn retains_error_usage_provisionally_at_eof() {
    let output = CodexOutput::parse(
        concat!(
            "{\"type\":\"error\",\"message\":\"connection ended\",\"usage\":{",
            "\"input_tokens\":19,\"cached_input_tokens\":7,",
            "\"cache_write_input_tokens\":3,\"output_tokens\":5}}",
        )
        .as_bytes(),
    );

    assert_eq!(output.failure_message(), Some("connection ended"));
    let usage = output.token_usage().assert_value();
    assert_eq!(usage.input_tokens.get(), 19);
    assert_eq!(usage.output_tokens.get(), 5);
    assert_eq!(usage.cache_read_input_tokens.assert_value().get(), 7);
    assert_eq!(usage.cache_creation_input_tokens.assert_value().get(), 3);
}

#[test]
fn provisional_error_is_cleared_by_completion_and_latest_message_wins() {
    let output = CodexOutput::parse(
        br#"{"type":"error","message":"temporary transport retry","usage":{"input_tokens":31,"output_tokens":17}}
{"type":"item.completed","item":{"type":"agent_message","text":"old"}}
{"type":"item.completed","item":{"type":"agent_message","text":"final"}}
{"type":"turn.completed","usage":{"input_tokens":3,"output_tokens":4}}
{"type":"item.completed","item":{"type":"agent_message","text":"trailing"}}
{"type":"turn.failed","error":{"message":"trailing failure"}}
"#,
    );

    assert_eq!(output.final_message().assert_value(), "final");
    assert_eq!(output.failure_message(), None);
    let usage = output.token_usage().assert_value();
    assert_eq!(usage.input_tokens.get(), 3);
    assert_eq!(usage.output_tokens.get(), 4);
}

#[test]
fn provisional_error_survives_eof_and_terminal_failure_prefers_its_detail() {
    let ended = CodexOutput::parse(br#"{"type":"error","message":"temporary transport retry"}"#);
    assert_eq!(ended.failure_message(), Some("temporary transport retry"));

    let failed = CodexOutput::parse(
        br#"{"type":"error","message":"temporary transport retry"}
{"type":"turn.failed","error":"terminal service failure"}
{"type":"turn.completed"}
"#,
    );
    assert_eq!(failed.failure_message(), Some("terminal service failure"));
}

#[test]
fn malformed_ancillary_records_do_not_discard_a_valid_result() {
    let mut bytes = b"not json\n".to_vec();
    bytes.extend_from_slice(&[0xff, b'\n']);
    bytes.extend_from_slice(
        br#"{}
{"type":"thread.started"}
{"type":"item.completed"}
{"type":"future.event","payload":true}
{"type":"item.completed","item":{"type":"agent_message","text":"done"}}
{"type":"turn.completed"}"#,
    );
    let output = CodexOutput::parse(&bytes);

    assert_eq!(output.final_message().assert_value(), "done");
    assert_eq!(output.failure_message(), None);
    assert_eq!(output.malformed_records, 5);
    assert_eq!(output.oversized_records, 0);
}

#[test]
fn malformed_records_are_reported_when_required_output_is_missing() {
    let output = CodexOutput::parse(b"not json\n{\"type\":\"turn.completed\"}\n");
    assert_eq!(
        output.failure_message(),
        Some(
            "Codex turn completed without a final agent message; ignored 1 malformed and 0 oversized output records"
        )
    );
}

#[test]
fn conflicting_thread_ids_wait_for_completion_and_preserve_terminal_evidence() {
    let output = CodexOutput::parse(
        br#"{"type":"thread.started","thread_id":"thread-1"}
{"type":"thread.started","thread_id":"thread-2"}
{"type":"item.completed","item":{"type":"agent_message","text":"done"}}
{"type":"turn.completed","usage":{"input_tokens":8,"output_tokens":3}}
{"type":"item.completed","item":{"type":"agent_message","text":"trailing"}}
{"type":"turn.failed","usage":{"input_tokens":999,"output_tokens":999},"error":{"message":"trailing failure"}}
"#,
    );

    assert_eq!(output.thread_id.as_deref(), Some("thread-1"));
    assert_eq!(
        output.failure_message(),
        Some("Codex output contained conflicting thread IDs")
    );
    assert_eq!(output.final_message().assert_value(), "done");
    let usage = output.token_usage().assert_value();
    assert_eq!(usage.input_tokens.get(), 8);
    assert_eq!(usage.output_tokens.get(), 3);
}

#[test]
fn conflicting_thread_ids_preserve_failed_turn_usage_but_win_the_outcome() {
    let output = CodexOutput::parse(
        br#"{"type":"thread.started","thread_id":"thread-1"}
{"type":"thread.started","thread_id":"thread-2"}
{"type":"turn.failed","usage":{"input_tokens":13,"output_tokens":5},"error":{"message":"provider terminal detail"}}
"#,
    );

    assert_eq!(output.thread_id.as_deref(), Some("thread-1"));
    assert_eq!(
        output.failure_message(),
        Some("Codex output contained conflicting thread IDs; provider terminal detail")
    );
    let usage = output.token_usage().assert_value();
    assert_eq!(usage.input_tokens.get(), 13);
    assert_eq!(usage.output_tokens.get(), 5);
}

#[test]
fn decoder_handles_split_crlf_and_an_unterminated_terminal_record() {
    let mut decoder = CodexOutputDecoder::new();
    assert!(
        decoder
            .push(b"{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_")
            .is_empty()
    );
    let emissions = decoder.push(b"message\",\"text\":\"done\"}}\r\n{\"type\":\"turn.completed\"}");
    assert_eq!(emissions.len(), 1);
    let output = decoder.finish();
    assert_eq!(output.final_message().assert_value(), "done");
    assert_eq!(output.failure_message(), None);
}

#[test]
fn projects_provider_items_to_semantic_attach_messages() {
    let mut decoder = CodexOutputDecoder::new();
    let emissions = decoder.push(
        concat!(
            "{\"type\":\"item.updated\",\"item\":{\"type\":\"reasoning\",\"text\":\"checking tests\"}}\n",
            "{\"type\":\"item.completed\",\"item\":{\"type\":\"command_execution\",",
            "\"command\":\"cargo test\",\"aggregated_output\":\"ok\",",
            "\"exit_code\":0,\"status\":\"completed\"}}\n",
            "{\"type\":\"item.completed\",\"item\":{\"type\":\"file_change\",",
            "\"changes\":[{\"path\":\"src/lib.rs\",\"kind\":\"update\"}],",
            "\"status\":\"completed\"}}\n",
            "{\"type\":\"item.completed\",\"item\":{\"type\":\"mcp_tool_call\",",
            "\"server\":\"github\",\"tool\":\"get_pr\",",
            "\"result\":{\"number\":7},\"status\":\"completed\"}}\n",
        )
        .as_bytes(),
    );
    let messages = emissions
        .iter()
        .map(|emission| emission.log().1)
        .collect::<Vec<_>>();

    assert_eq!(
        messages,
        [
            "Codex reasoning updated: checking tests",
            "Codex command completed: cargo test [completed] exit=0\nok",
            "Codex file change completed: update src/lib.rs",
            "Codex tool completed: github.get_pr result={\"number\":7}",
        ]
    );
}
