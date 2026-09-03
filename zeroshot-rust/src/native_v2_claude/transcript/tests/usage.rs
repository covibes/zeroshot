use super::*;

fn usage(input: u64, output: u64, cache_read: u64, cache_creation: u64) -> Value {
    json!({
        "input_tokens":input,
        "output_tokens":output,
        "cache_read_input_tokens":cache_read,
        "cache_creation_input_tokens":cache_creation
    })
}

fn message_start(message_id: &str, usage: Value) -> Value {
    json!({
        "type":"stream_event",
        "session_id":"session-1",
        "event":{
            "type":"message_start",
            "message":{"id":message_id,"usage":usage}
        }
    })
}

fn assistant_usage(message_id: &str, usage: Value) -> Value {
    json!({
        "type":"assistant",
        "session_id":"session-1",
        "message":{"id":message_id,"content":[],"usage":usage}
    })
}

fn raw_message_usage(output_tokens: Value) -> Vec<u8> {
    let mut bytes = Vec::new();
    append_event(&mut bytes, message_start("message-1", usage(23, 0, 17, 5)));
    append_event(
        &mut bytes,
        json!({
            "type":"stream_event",
            "session_id":"session-1",
            "event":{
                "type":"message_delta",
                "delta":{"stop_reason":"end_turn"},
                "usage":{"output_tokens":output_tokens}
            }
        }),
    );
    bytes
}

fn usage_values(usage: Option<TokenUsageDelta>) -> [u64; 4] {
    let usage = usage.assert_value();
    [
        usage.input_tokens.get(),
        usage.output_tokens.get(),
        usage.cache_read_input_tokens.assert_value().get(),
        usage.cache_creation_input_tokens.assert_value().get(),
    ]
}

fn success_without_terminal_usage() -> Value {
    json!({
        "type":"result",
        "subtype":"success",
        "is_error":false,
        "session_id":"session-1",
        "structured_output":{"response":"done"},
        "usage":{},
        "modelUsage":null
    })
}

#[test]
fn assistant_usage_sums_unique_messages_and_replaces_repeated_snapshots() {
    let mut bytes = Vec::new();
    append_event(
        &mut bytes,
        json!({
            "type":"stream_event",
            "event":{
                "type":"content_block_delta",
                "delta":{"type":"text_delta","text":"visible once"}
            }
        }),
    );
    for (id, input, output, cache_read, cache_creation) in [
        ("message-1", 11, 2, 6, 2),
        ("message-1", 11, 4, 6, 2),
        ("message-2", 7, 3, 5, 1),
    ] {
        append_event(
            &mut bytes,
            assistant_usage(id, usage(input, output, cache_read, cache_creation)),
        );
    }

    let decoded = decode(&bytes, 19, Some("provider process exited with status 17"));
    assert_eq!(usage_values(decoded.usage), [18, 7, 11, 3]);
    assert_eq!(
        decoded
            .emissions
            .iter()
            .map(|emission| emission.text.as_str())
            .collect::<String>(),
        "visible once"
    );
    assert!(
        failed_attempt(decoded.attempt)
            .diagnostic
            .contains("without a terminal result")
    );
}

#[test]
fn raw_message_usage_survives_a_missing_terminal_result() {
    let bytes = raw_message_usage(json!(9));

    let decoded = decode(&bytes, 7, Some("provider process exited with status 17"));
    assert_eq!(usage_values(decoded.usage), [23, 9, 17, 5]);
    assert!(
        failed_attempt(decoded.attempt)
            .diagnostic
            .contains("without a terminal result")
    );
}

#[test]
fn malformed_raw_usage_is_not_reported_as_complete() {
    let bytes = raw_message_usage(json!("many"));

    assert!(decode(&bytes, 17, Some("provider exited")).usage.is_none());
}

#[test]
fn unidentifiable_message_start_usage_is_incomplete_but_turn_can_succeed() {
    for message in [
        json!({"usage":usage(23, 9, 17, 5)}),
        json!({"id":null,"usage":usage(23, 9, 17, 5)}),
        json!({"id":"","usage":usage(23, 9, 17, 5)}),
        json!({"id":17,"usage":usage(23, 9, 17, 5)}),
    ] {
        let mut bytes = Vec::new();
        append_event(
            &mut bytes,
            json!({
                "type":"stream_event",
                "session_id":"session-1",
                "event":{
                    "type":"message_start",
                    "message":message
                }
            }),
        );
        append_event(&mut bytes, success_without_terminal_usage());

        let decoded = decode(&bytes, 13, None);
        assert_eq!(completed_response(decoded.attempt), json!("done"));
        assert!(decoded.usage.is_none());
    }
}

#[test]
fn unassociated_message_delta_usage_is_incomplete_but_turn_can_succeed() {
    let mut bytes = Vec::new();
    append_event(
        &mut bytes,
        json!({
            "type":"stream_event",
            "session_id":"session-1",
            "event":{"type":"message_delta","usage":{"output_tokens":9}}
        }),
    );
    append_event(&mut bytes, success_without_terminal_usage());

    let decoded = decode(&bytes, 17, None);
    assert_eq!(completed_response(decoded.attempt), json!("done"));
    assert!(decoded.usage.is_none());
}

#[test]
fn assistant_wrapper_replaces_the_same_raw_message_usage() {
    let mut bytes = Vec::new();
    append_event(&mut bytes, message_start("message-1", usage(23, 0, 17, 5)));
    append_event(
        &mut bytes,
        assistant_usage("message-1", usage(23, 9, 17, 5)),
    );

    let decoded = decode(&bytes, 29, Some("provider exited"));
    assert_eq!(usage_values(decoded.usage), [23, 9, 17, 5]);
}

#[test]
fn valid_result_usage_replaces_provisional_assistant_usage() {
    let mut bytes = Vec::new();
    append_event(
        &mut bytes,
        json!({
            "type":"assistant",
            "session_id":"session-1",
            "message":{
                "content":[],
                "usage":{
                    "input_tokens":97,
                    "output_tokens":53,
                    "cache_read_input_tokens":41,
                    "cache_creation_input_tokens":29
                }
            }
        }),
    );
    append_event(&mut bytes, success(json!("done"), "session-1"));

    let decoded = decode(&bytes, 64, None);
    assert_eq!(completed_response(decoded.attempt), json!("done"));
    assert_eq!(usage_values(decoded.usage), [11, 4, 6, 2]);
}

#[test]
fn model_usage_sums_all_models_and_overrides_other_usage() {
    for (model_key, fields) in [
        (
            "modelUsage",
            [
                ("inputTokens", 13),
                ("outputTokens", 7),
                ("cacheReadInputTokens", 11),
                ("cacheCreationInputTokens", 5),
            ],
        ),
        (
            "model_usage",
            [
                ("input_tokens", 13),
                ("output_tokens", 7),
                ("cache_read_input_tokens", 11),
                ("cache_creation_input_tokens", 5),
            ],
        ),
    ] {
        let first = fields
            .into_iter()
            .map(|(key, value)| (key.to_owned(), json!(value)))
            .collect::<serde_json::Map<_, _>>();
        let second = fields
            .into_iter()
            .map(|(key, value)| (key.to_owned(), json!(value + 1)))
            .collect::<serde_json::Map<_, _>>();
        let mut event = json!({
            "type":"result",
            "subtype":"success",
            "is_error":false,
            "session_id":"session-1",
            "result":"done",
            "usage":{
                "input_tokens":999,
                "output_tokens":999,
                "cache_read_input_tokens":999,
                "cache_creation_input_tokens":999
            }
        });
        event.as_object_mut().assert_value().insert(
            model_key.to_owned(),
            json!({"model-a":first,"model-b":second}),
        );
        let mut bytes = Vec::new();
        append_event(&mut bytes, event);

        let decoded = decode(&bytes, 31, None);
        assert_eq!(usage_values(decoded.usage), [27, 15, 23, 11]);
    }
}

#[test]
fn malformed_model_usage_fails_closed_even_with_valid_result_usage() {
    let mut event = success(json!("done"), "session-1");
    event.as_object_mut().assert_value().insert(
        "modelUsage".to_owned(),
        json!({
            "model-a":{
                "inputTokens":"many",
                "outputTokens":7,
                "cacheReadInputTokens":11,
                "cacheCreationInputTokens":5
            }
        }),
    );
    let mut bytes = Vec::new();
    append_event(&mut bytes, event);

    assert!(decode(&bytes, 19, None).usage.is_none());
}

#[test]
fn empty_terminal_usage_preserves_provisional_usage_on_success_and_failure() {
    for (subtype, is_error, result) in [
        ("success", false, "done"),
        ("error_during_execution", true, "provider failed"),
    ] {
        let mut bytes = Vec::new();
        append_event(
            &mut bytes,
            assistant_usage("message-1", usage(23, 9, 17, 5)),
        );
        let mut terminal = json!({
            "type":"result",
            "subtype":subtype,
            "is_error":is_error,
            "session_id":"session-1",
            "result":result,
            "usage":{},
            "modelUsage":null
        });
        if !is_error {
            terminal
                .as_object_mut()
                .assert_value()
                .insert("structured_output".to_owned(), json!({"response":result}));
        }
        append_event(&mut bytes, terminal);

        let decoded = decode(&bytes, 29, None);
        assert_eq!(usage_values(decoded.usage), [23, 9, 17, 5]);
        if is_error {
            assert_eq!(failed_attempt(decoded.attempt).diagnostic, result);
        } else {
            assert_eq!(completed_response(decoded.attempt), json!(result));
        }
    }
}

#[test]
fn malformed_terminal_usage_does_not_reuse_provisional_usage() {
    let mut bytes = Vec::new();
    append_event(
        &mut bytes,
        assistant_usage("message-1", usage(23, 9, 17, 5)),
    );
    append_event(
        &mut bytes,
        json!({
            "type":"result",
            "subtype":"success",
            "is_error":false,
            "session_id":"session-1",
            "result":"done",
            "modelUsage":{"model-a":{"inputTokens":"many"}},
            "usage":{"input_tokens":"many","output_tokens":7}
        }),
    );

    assert!(decode(&bytes, 23, None).usage.is_none());
}
