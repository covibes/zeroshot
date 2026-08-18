use super::*;

#[tokio::test]
async fn unsuccessful_result_emits_one_redacted_durable_error_and_fails() {
    let workspace = TestDirectory::new("claude-error-result");
    workspace.write(
        "fake-claude.sh",
        r#"
set -eu
printf '%s\n' '{"type":"system","subtype":"init","session_id":"error-session"}'
printf '%s%s\n' \
  '{"type":"result","subtype":"success","is_error":true,' \
  '"result":"provider rejected sentinel-secret and anthropic-fake","session_id":"error-session"}'
exit 1
"#,
    );
    let binding = agent_binding(
        "claude-sonnet-5",
        Some(ReasoningEffort::Max),
        SessionScope::Execution,
        &[ANTHROPIC_KEY, "TEST_SECRET"],
    );
    let runner = runner(
        &workspace,
        ClaudeProvider::Anthropic,
        binding.clone(),
        false,
    )
    .await;
    let mut handle = runner
        .start(request(
            binding,
            1,
            &[
                (ANTHROPIC_KEY, "anthropic-fake"),
                ("TEST_SECRET", "sentinel-secret"),
            ],
        ))
        .await
        .assert_value();
    let mut durable = handle.take_initial_output().assert_value();

    let (output, completion) = tokio::join!(durable.recv(), handle.completion());
    let output = output.assert_value();
    assert_eq!(output.stream, LiveOutputStream::Error);
    assert_eq!(output.text, "provider rejected [REDACTED] and [REDACTED]");
    assert_eq!(completion, Err(NodeRunnerError::Driver));
    assert_eq!(durable.recv().await, Err(AttachReceiveError::Closed));
}
