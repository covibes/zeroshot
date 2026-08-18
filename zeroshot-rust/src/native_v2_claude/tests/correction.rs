use super::*;

#[tokio::test]
async fn invalid_output_is_corrected_in_the_same_claude_session() {
    let workspace = TestDirectory::new("claude-correction");
    workspace.write("fake-claude.sh", SUCCESS_SCRIPT);
    let binding = agent_binding(
        "claude-sonnet-5",
        Some(ReasoningEffort::Max),
        SessionScope::Execution,
        &[ANTHROPIC_KEY, "CORRECT_OUTPUT"],
    );
    let runner = runner(
        &workspace,
        ClaudeProvider::Anthropic,
        binding.clone(),
        false,
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
