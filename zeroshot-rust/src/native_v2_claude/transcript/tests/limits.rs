use super::*;

fn finish_success(bytes: &mut Vec<u8>) -> Option<TokenUsageDelta> {
    append_event(bytes, success(json!("done"), "session-1"));
    let decoded = decode(bytes, 64 * 1024, None);
    assert_eq!(completed_response(decoded.attempt), json!("done"));
    decoded.usage
}

#[test]
fn accepts_blank_crlf_and_unterminated_final_records_across_chunks() {
    let mut bytes = b"\n \t\r\n".to_vec();
    let mut init =
        serde_json::to_vec(&json!({"type":"system","subtype":"init","session_id":"session-1"}))
            .assert_value();
    init.extend_from_slice(b"\r\n\n");
    bytes.extend(init);
    bytes.extend(serde_json::to_vec(&success(json!("done \u{1f642}"), "session-1")).assert_value());
    bytes.extend_from_slice(b" \t\r");

    let decoded = decode(&bytes, 1, None);
    assert_eq!(completed_response(decoded.attempt), json!("done \u{1f642}"));
    assert!(decoded.emissions.is_empty());
}

#[test]
fn accepts_records_larger_than_the_old_per_record_limit() {
    let assistant_text = "a".repeat(80 * 1024);
    let tool_result = "t".repeat(96 * 1024);
    let response = "r".repeat(72 * 1024);
    let session = "s".repeat(1024);
    let mut bytes = Vec::new();
    append_event(
        &mut bytes,
        json!({
            "type":"assistant",
            "session_id":session,
            "message":{"content":[{"type":"text","text":assistant_text}]}
        }),
    );
    append_event(
        &mut bytes,
        json!({
            "type":"user",
            "session_id":session,
            "message":{"content":[{
                "type":"tool_result",
                "tool_use_id":"tool-1",
                "content":tool_result
            }]}
        }),
    );
    append_event(&mut bytes, success(json!(response.clone()), &session));

    let decoded = decode(&bytes, 31 * 1024, None);
    assert_eq!(completed_response(decoded.attempt), json!(response));
    assert!(
        decoded
            .emissions
            .iter()
            .all(|emission| emission.text.len() <= LIVE_CHUNK_BYTES)
    );
    assert_eq!(
        decoded
            .emissions
            .iter()
            .map(|emission| emission.text.as_str())
            .collect::<String>(),
        assistant_text
    );
}

#[test]
fn accepts_more_than_the_old_event_limit() {
    let mut bytes = Vec::new();
    for sequence in 0..=4096 {
        append_event(
            &mut bytes,
            json!({"type":"future_progress","sequence":sequence}),
        );
    }
    let _ = finish_success(&mut bytes);
}

#[test]
fn accepts_more_than_the_old_cumulative_transcript_limit() {
    const OLD_TRANSCRIPT_BYTES: usize = 8 * 1024 * 1024;
    let padding = "x".repeat(48 * 1024);
    let mut bytes = Vec::new();
    let mut records = 0;
    while bytes.len() <= OLD_TRANSCRIPT_BYTES {
        append_event(
            &mut bytes,
            json!({"type":"future_progress","padding":padding}),
        );
        records += 1;
    }
    assert!(records < 4096);
    let usage = finish_success(&mut bytes).assert_value();
    assert_eq!(
        [usage.input_tokens.get(), usage.output_tokens.get()],
        [11, 4]
    );
}
