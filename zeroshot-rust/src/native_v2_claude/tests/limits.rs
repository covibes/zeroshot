use super::*;

const LARGE_DUPLEX_SCRIPT: &str = r#"#!/bin/sh
set -eu
: > initial.args
for argument in "$@"; do /usr/bin/printf '%s\n' "$argument" >> initial.args; done
/usr/bin/head -c 5242880 /dev/zero | /usr/bin/tr '\000' x
/usr/bin/printf '\n'
/usr/bin/cat > initial.prompt
/usr/bin/printf '%s\n' '{"type":"system","subtype":"init","session_id":"session-1"}'
/usr/bin/printf '%s%s\n' \
  '{"type":"result","subtype":"success","is_error":false,' \
  '"result":"{\"response\":\"done\"}","session_id":"session-1"}'
"#;

#[tokio::test]
async fn long_transcript_crossing_all_legacy_parser_caps_completes() {
    const OLD_TRANSCRIPT_BYTES: usize = 8 * 1024 * 1024;
    let workspace = TestDirectory::new("claude-long-transcript");
    workspace.write(
        "fake-claude.sh",
        "set -eu\ncat >/dev/null\nexec /bin/cat provider-output.ndjson\n",
    );
    let mut provider_output = String::new();
    provider_output.push('\n');
    provider_output.push_str(
        &serde_json::to_string(&json!({
            "type":"assistant",
            "session_id":"long-session",
            "message":{"content":[{
                "type":"tool_use",
                "id":"tool-1",
                "name":"large_tool",
                "input":{"payload":"x".repeat(80 * 1024)}
            }]}
        }))
        .assert_value(),
    );
    provider_output.push('\n');
    let padding = "p".repeat(2048);
    for sequence in 0..=4096 {
        provider_output.push_str(
            &serde_json::to_string(
                &json!({"type":"future_progress","sequence":sequence,"padding":padding}),
            )
            .assert_value(),
        );
        provider_output.push('\n');
    }
    assert!(provider_output.len() > OLD_TRANSCRIPT_BYTES);
    provider_output.push_str(
        &serde_json::to_string(&json!({
            "type":"result",
            "subtype":"success",
            "is_error":false,
            "session_id":"long-session",
            "structured_output":{"response":"done"}
        }))
        .assert_value(),
    );
    workspace.write("provider-output.ndjson", &provider_output);

    let (runner, binding) = anthropic_runner(
        &workspace,
        "claude-sonnet-5",
        Some(ReasoningEffort::Max),
        SessionScope::Execution,
    )
    .await;
    let outcome = complete_turn(&runner, &binding, 1).await;

    assert!(matches!(
        outcome,
        WorkerOutcome::Verified { output, .. } if output == json!("done")
    ));
}

#[tokio::test]
async fn stdout_is_drained_while_a_multiframe_prompt_is_delivered_in_full() {
    let workspace = TestDirectory::new("claude-large-prompt");
    workspace.write("fake-claude.sh", LARGE_DUPLEX_SCRIPT);
    let (runner, binding) = anthropic_runner(
        &workspace,
        "claude-sonnet-5",
        Some(ReasoningEffort::Max),
        SessionScope::Execution,
    )
    .await;
    let payload = "p".repeat(8 * 1024 * 1024);
    let mut invocation = request(binding, 1, &[(ANTHROPIC_KEY, "anthropic-fake")]);
    invocation.invocation.input = json!({"payload":payload});
    let completion = runner
        .start(invocation)
        .await
        .assert_value()
        .completion()
        .await
        .assert_value();

    assert!(matches!(completion.outcome, WorkerOutcome::Verified { .. }));
    let prompt = workspace.read("initial.prompt");
    assert!(prompt.len() > 8 * 1024 * 1024);
    assert!(prompt.contains(&payload));
    assert!(!workspace.read("initial.args").contains(&payload));
}
