use super::*;

const LARGE_INPUT_BYTES: usize = 9 * 1024 * 1024;

const INPUT_FAILURE_FIRST: &str = r#"
set -eu
printf '%s\n' '{"type":"system","subtype":"init","session_id":"duplex-session"}'
printf '%s%s%s%s\n' \
  '{"type":"result","subtype":"success","is_error":false,' \
  '"session_id":"duplex-session","structured_output":{"response":"ignored"},' \
  '"usage":{"input_tokens":23,"output_tokens":9,' \
  '"cache_read_input_tokens":17,"cache_creation_input_tokens":5}}'
exec 0<&-
/usr/bin/sleep 30
"#;

const OUTPUT_FAILURE_FIRST: &str = r#"
set -eu
if [ ! -e duplex.state ]; then
  : > duplex.state
  printf '%s\n' '{"type":"system","subtype":"init","session_id":"duplex-session"}'
  printf '%s\n' '{"type":"system","subtype":"api_retry","attempt":1,"max_retries":3,"error":"overloaded"}'
  printf '%s%s%s%s\n' \
    '{"type":"result","subtype":"success","is_error":false,' \
    '"session_id":"duplex-session","structured_output":{"response":"ignored"},' \
    '"usage":{"input_tokens":23,"output_tokens":9,' \
    '"cache_read_input_tokens":17,"cache_creation_input_tokens":5}}'
  exec 1>&-
  /usr/bin/sleep 1
  exec 0<&-
  /usr/bin/sleep 30
fi
cat > retry.prompt
for argument in "$@"; do printf '%s\n' "$argument" >> retry.args; done
printf '%s\n' '{"type":"system","subtype":"init","session_id":"duplex-session"}'
printf '%s%s\n' \
  '{"type":"result","subtype":"success","is_error":false,"session_id":"duplex-session",' \
  '"structured_output":{"response":"done"},"usage":{},"modelUsage":null}'
"#;

#[tokio::test]
async fn input_failure_wins_while_the_unfinished_transcript_is_drained() {
    let workspace = TestDirectory::new("claude-duplex-input-first");
    workspace.write("fake-claude.sh", INPUT_FAILURE_FIRST);
    let (logs, usages) = anthropic_failure_capture(
        &workspace,
        SessionScope::Execution,
        Some(json!("x".repeat(LARGE_INPUT_BYTES))),
    )
    .await;

    assert!(logs.contains("provider process input failed"));
    assert_eq!(usages.len(), 1);
    assert_token_usage(usages.first().copied().flatten(), [23, 9, 17, 5]);
}

#[tokio::test]
async fn completed_output_cannot_mask_input_failure_and_retry_metadata() {
    let workspace = TestDirectory::new("claude-duplex-output-first");
    workspace.write("fake-claude.sh", OUTPUT_FAILURE_FIRST);
    let handle = start_anthropic_input(&workspace, json!("x".repeat(LARGE_INPUT_BYTES))).await;
    let (captured, completion) = complete_with_durable(handle).await;

    assert_verified_completion(completion, json!("done"));
    assert!(
        captured
            .logs
            .join("\n")
            .contains("provider process input failed")
    );
    assert_eq!(captured.usages.len(), 2);
    assert_token_usage(captured.usages.first().copied().flatten(), [23, 9, 17, 5]);
    assert_eq!(captured.usages.get(1).copied().flatten(), None);
    assert_eq!(workspace.read("retry.prompt"), "Continue");
    let arguments = workspace.read("retry.args");
    assert!(arguments.lines().any(|argument| argument == "--resume"));
    assert!(
        arguments
            .lines()
            .any(|argument| argument == "duplex-session")
    );
}
