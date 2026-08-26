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

    let (output, completion) = tokio::join!(durable.recv_output(), handle.completion());
    let output = output.assert_value();
    assert_eq!(output.stream, LiveOutputStream::Error);
    assert_eq!(
        output.text,
        "Claude provider failure: provider rejected [REDACTED] and [REDACTED]"
    );
    assert_eq!(completion, Err(NodeRunnerError::Driver));
    assert_eq!(durable.recv_output().await, Err(AttachReceiveError::Closed));
}

const RETRY_SCRIPT: &str = r#"
set -eu
if [ -e retry.state ]; then attempt=2; else attempt=1; : > retry.state; fi
prompt=
for argument in "$@"; do
  prompt=$argument
  printf '%s\n' "$argument" >> "attempt-$attempt.args"
done
printf '%s' "$prompt" > "attempt-$attempt.prompt"
if [ "$attempt" = 1 ]; then
  if [ "${NO_FIRST_SESSION-false}" != true ]; then
    printf '%s\n' '{"type":"system","subtype":"init","session_id":"retry-session"}'
  fi
  printf '%s%s\n' \
    '{"type":"system","subtype":"api_retry","attempt":1,"max_retries":3,' \
    '"error":"overloaded sentinel-secret"}'
  if [ "${FAIL_WITHOUT_RESULT-false}" = true ]; then exit 1; fi
  if [ "${NO_FIRST_SESSION-false}" = true ]; then
    printf '%s%s\n' \
      '{"type":"result","subtype":"error_during_execution","is_error":true,' \
      '"result":"provider lost sentinel-secret"}'
  else
    printf '%s%s%s\n' \
      '{"type":"result","subtype":"error_during_execution","is_error":true,' \
      '"result":"provider lost sentinel-secret",' \
      '"session_id":"retry-session"}'
  fi
  exit 1
fi
printf '%s\n' '{"type":"system","subtype":"init","session_id":"retry-session"}'
if [ "${FAIL_TWICE-false}" = true ]; then
  printf '%s%s\n' \
    '{"type":"system","subtype":"api_retry","attempt":2,"max_retries":3,' \
    '"error":"still overloaded"}'
  printf '%s%s%s\n' \
    '{"type":"result","subtype":"error_during_execution","is_error":true,' \
    '"result":"provider still unavailable",' \
    '"session_id":"retry-session"}'
  exit 1
fi
printf '%s%s\n' \
  '{"type":"result","subtype":"success","is_error":false,' \
  '"result":"{\"response\":\"done\"}","session_id":"retry-session"}'
"#;

async fn retry_runner(workspace: &TestDirectory) -> (NativeNodeRunner, NodeRuntimeBinding) {
    workspace.write("fake-claude.sh", RETRY_SCRIPT);
    let binding = agent_binding(
        "claude-sonnet-5",
        Some(ReasoningEffort::Max),
        SessionScope::Execution,
        &[
            ANTHROPIC_KEY,
            "FAIL_TWICE",
            "FAIL_WITHOUT_RESULT",
            "NO_FIRST_SESSION",
            "TEST_SECRET",
        ],
    );
    let runtime = runner(workspace, ClaudeProvider::Anthropic, binding.clone(), false).await;
    (runtime, binding)
}

fn retry_values(
    fail_twice: bool,
    fail_without_result: bool,
    no_first_session: bool,
) -> [(&'static str, &'static str); 5] {
    [
        (ANTHROPIC_KEY, "anthropic-fake"),
        ("FAIL_TWICE", if fail_twice { "true" } else { "false" }),
        (
            "FAIL_WITHOUT_RESULT",
            if fail_without_result { "true" } else { "false" },
        ),
        (
            "NO_FIRST_SESSION",
            if no_first_session { "true" } else { "false" },
        ),
        ("TEST_SECRET", "sentinel-secret"),
    ]
}

#[tokio::test]
async fn api_retry_signal_continues_once_in_the_same_claude_session() {
    let workspace = TestDirectory::new("claude-provider-retry");
    let (runner, binding) = retry_runner(&workspace).await;
    let mut handle = runner
        .start(request(binding, 1, &retry_values(false, false, false)))
        .await
        .assert_value();
    let mut durable = handle.take_initial_output().assert_value();
    let (logs, completion) = tokio::join!(
        async {
            let mut logs = Vec::new();
            while let Ok(entry) = durable.recv_output().await {
                logs.push(entry.text);
            }
            logs
        },
        handle.completion()
    );

    assert!(matches!(
        completion.assert_value().outcome,
        WorkerOutcome::Verified { output, .. } if output == json!("done")
    ));
    assert_eq!(workspace.read("attempt-2.prompt"), "Continue");
    let rendered = logs.join("\n");
    assert!(rendered.contains("Claude API retry 1/3: overloaded [REDACTED]"));
    assert!(rendered.contains("Claude provider failure: provider lost [REDACTED]"));
    assert!(rendered.contains("Claude provider failed; continuing once"));
    assert!(!rendered.contains("sentinel-secret"));
    let resumed = workspace.read("attempt-2.args");
    assert!(resumed.lines().any(|line| line == "--resume"));
    assert!(resumed.lines().any(|line| line == "retry-session"));
}

#[tokio::test]
async fn claude_without_a_session_retries_the_original_prompt_once() {
    let workspace = TestDirectory::new("claude-provider-retry-no-session");
    let (runner, binding) = retry_runner(&workspace).await;
    let completion = runner
        .start(request(binding, 1, &retry_values(false, false, true)))
        .await
        .assert_value()
        .completion()
        .await
        .assert_value();

    assert!(matches!(completion.outcome, WorkerOutcome::Verified { .. }));
    assert_eq!(
        workspace.read("attempt-1.prompt"),
        workspace.read("attempt-2.prompt")
    );
    assert!(!workspace.read("attempt-2.args").contains("--resume"));
}

#[tokio::test]
async fn retryable_claude_failure_is_retried_only_once() {
    let workspace = TestDirectory::new("claude-provider-retry-limit");
    let (runner, binding) = retry_runner(&workspace).await;
    let mut handle = runner
        .start(request(binding, 1, &retry_values(true, false, false)))
        .await
        .assert_value();

    assert_eq!(handle.completion().await, Err(NodeRunnerError::Driver));
    assert!(workspace.child("attempt-2.prompt").exists());
    assert!(!workspace.child("attempt-3.prompt").exists());
}

#[tokio::test]
async fn api_retry_signal_survives_a_missing_terminal_result() {
    let workspace = TestDirectory::new("claude-provider-retry-truncated");
    let (runner, binding) = retry_runner(&workspace).await;
    let mut handle = runner
        .start(request(binding, 1, &retry_values(false, true, false)))
        .await
        .assert_value();
    let completion = handle.completion().await.assert_value();

    assert!(matches!(completion.outcome, WorkerOutcome::Verified { .. }));
    assert_eq!(workspace.read("attempt-2.prompt"), "Continue");
}
