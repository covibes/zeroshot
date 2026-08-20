use super::*;

async fn correction_runner(
    workspace: &TestDirectory,
    script: &str,
    environment: &[&str],
) -> (NativeNodeRunner, NodeRuntimeBinding) {
    workspace.write("fake-claude.sh", script);
    let binding = agent_binding(
        "claude-sonnet-5",
        Some(ReasoningEffort::Max),
        SessionScope::Execution,
        environment,
    );
    let runtime = runner(workspace, ClaudeProvider::Anthropic, binding.clone(), false).await;
    (runtime, binding)
}

#[tokio::test]
async fn invalid_output_is_corrected_in_the_same_claude_session() {
    let workspace = TestDirectory::new("claude-correction");
    let (runner, binding) = correction_runner(
        &workspace,
        SUCCESS_SCRIPT,
        &[ANTHROPIC_KEY, "CORRECT_OUTPUT"],
    )
    .await;
    let completion = runner
        .start(request(
            binding,
            1,
            &[
                (ANTHROPIC_KEY, "anthropic-fake"),
                ("CORRECT_OUTPUT", "true"),
            ],
        ))
        .await
        .assert_value()
        .completion()
        .await
        .assert_value();

    assert!(matches!(
        completion.outcome,
        WorkerOutcome::Verified { output, .. } if output == json!("done")
    ));
    let resumed = workspace.read("resumed.args");
    assert_resumed_session(&resumed);
    assert!(resumed.contains("Your previous final response was rejected mechanically"));
    assert!(resumed.contains("final response is not valid JSON"));
}

#[tokio::test]
async fn malformed_output_stops_after_two_claude_correction_turns() {
    let workspace = TestDirectory::new("claude-malformed-limit");
    let (runner, binding) = correction_runner(
        &workspace,
        r#"
set -eu
printf '%s\n' "$@" >> attempts.args
printf '%s\n' '---' >> attempts.args
printf '%s\n' '{"type":"system","subtype":"init","session_id":"malformed-session"}'
printf '%s%s\n' \
  '{"type":"result","subtype":"success","is_error":false,' \
  '"result":"not-json","session_id":"malformed-session"}'
"#,
        &[ANTHROPIC_KEY],
    )
    .await;
    let mut handle = runner
        .start(request(binding, 1, &[(ANTHROPIC_KEY, "anthropic-fake")]))
        .await
        .assert_value();
    let completion = handle.completion().await.assert_value();

    assert_eq!(completion.outcome, WorkerOutcome::malformed());
    assert_eq!(workspace.read("attempts.args").matches("---").count(), 3);
}
