use super::*;
use crate::native_v2_contract::TokenUsageDelta;
use crate::native_v2_runner::DurableNodeEvent;

#[path = "failure/duplex.rs"]
mod duplex;
#[path = "failure/retry.rs"]
mod retry;

type ClaudeHandle = crate::native_v2_runner::NodeHandle;
type CompletionResult = Result<crate::native_v2_contract::NodeCompletion, NodeRunnerError>;
type DurableOutput = crate::native_v2_runner::DurableOutput;

async fn scripted_failure(
    label: &str,
    script: &str,
) -> (TestDirectory, ClaudeHandle, DurableOutput) {
    let workspace = TestDirectory::new(label);
    workspace.write("fake-claude.sh", script);
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
    let durable = handle.take_initial_output().assert_value();
    (workspace, handle, durable)
}

async fn collect_logs(durable: &mut DurableOutput) -> Vec<String> {
    collect_durable(durable).await.logs
}

struct CapturedDurable {
    logs: Vec<String>,
    usages: Vec<Option<TokenUsageDelta>>,
}

async fn collect_durable(durable: &mut DurableOutput) -> CapturedDurable {
    let mut logs = Vec::new();
    let mut usages = Vec::new();
    while let Ok(event) = durable.recv().await {
        match event {
            DurableNodeEvent::Output { output, .. } => logs.push(output.text),
            DurableNodeEvent::TokenUsage(usage) => usages.push(usage),
        }
    }
    CapturedDurable { logs, usages }
}

async fn complete_with_durable(mut handle: ClaudeHandle) -> (CapturedDurable, CompletionResult) {
    let mut durable = handle.take_initial_output().assert_value();
    tokio::join!(collect_durable(&mut durable), handle.completion())
}

async fn start_anthropic_input(workspace: &TestDirectory, input: Value) -> ClaudeHandle {
    let (runtime, binding) = anthropic_runner(
        workspace,
        "claude-sonnet-5",
        Some(ReasoningEffort::Max),
        SessionScope::Execution,
    )
    .await;
    let mut invocation = request(binding, 1, &[(ANTHROPIC_KEY, "anthropic-fake")]);
    invocation.invocation.input = input;
    runtime.start(invocation).await.assert_value()
}

fn assert_verified_completion(completion: CompletionResult, expected: Value) {
    assert!(matches!(
        completion.assert_value().outcome,
        WorkerOutcome::Verified { output, .. } if output == expected
    ));
}

async fn run_failure(
    runner: &NativeNodeRunner,
    binding: NodeRuntimeBinding,
    input: Option<Value>,
) -> String {
    run_failure_capture(runner, binding, input).await.0
}

async fn run_failure_capture(
    runner: &NativeNodeRunner,
    binding: NodeRuntimeBinding,
    input: Option<Value>,
) -> (String, Vec<Option<TokenUsageDelta>>) {
    let mut invocation = request(binding, 1, &[(ANTHROPIC_KEY, "anthropic-fake")]);
    if let Some(input) = input {
        invocation.invocation.input = input;
    }
    let handle = runner.start(invocation).await.assert_value();
    let (captured, completion) = complete_with_durable(handle).await;
    let logs = driver_failure_logs(&captured, completion);
    (logs, captured.usages)
}

fn driver_failure_logs(captured: &CapturedDurable, completion: CompletionResult) -> String {
    assert_eq!(completion, Err(NodeRunnerError::Driver));
    captured.logs.join("\n")
}

async fn command_failure(label: &str, command: TestProviderCommand) -> String {
    let workspace = TestDirectory::new(label);
    let binding = agent_binding(
        "claude-sonnet-5",
        Some(ReasoningEffort::Max),
        SessionScope::Execution,
        &[ANTHROPIC_KEY],
    );
    let runtime = runner_with_command(
        &workspace,
        TestRunnerConfig {
            provider: ClaudeProvider::Anthropic,
            binding: binding.clone(),
            verifier: false,
            command,
        },
    )
    .await;
    run_failure(&runtime, binding, None).await
}

async fn anthropic_failure(
    workspace: &TestDirectory,
    scope: SessionScope,
    input: Option<Value>,
) -> String {
    let (runtime, binding) = anthropic_runner(
        workspace,
        "claude-sonnet-5",
        Some(ReasoningEffort::Max),
        scope,
    )
    .await;
    run_failure(&runtime, binding, input).await
}

async fn anthropic_failure_capture(
    workspace: &TestDirectory,
    scope: SessionScope,
    input: Option<Value>,
) -> (String, Vec<Option<TokenUsageDelta>>) {
    let (runtime, binding) = anthropic_runner(
        workspace,
        "claude-sonnet-5",
        Some(ReasoningEffort::Max),
        scope,
    )
    .await;
    run_failure_capture(&runtime, binding, input).await
}

async fn assert_missing_terminal_failure(
    label: &str,
    script: &str,
    expected_stderr: &str,
    expected_process_failure: Option<&str>,
) -> Option<TokenUsageDelta> {
    let (_workspace, mut handle, mut durable) = scripted_failure(label, script).await;
    let (mut captured, completion) =
        tokio::join!(collect_durable(&mut durable), handle.completion());

    let rendered = driver_failure_logs(&captured, completion);
    assert!(
        rendered.contains("Claude output ended without a terminal result"),
        "unexpected diagnostic: {rendered}"
    );
    assert!(rendered.contains(expected_stderr));
    if let Some(expected) = expected_process_failure {
        assert!(rendered.contains(expected));
    }
    assert!(!rendered.contains("execution failed without provider detail"));
    assert!(!rendered.contains("sentinel-secret"));
    assert!(!rendered.contains("anthropic-fake"));
    assert_eq!(captured.usages.len(), 1);
    captured.usages.pop().assert_value()
}

#[tokio::test]
async fn unsuccessful_result_emits_one_redacted_durable_error_and_fails() {
    let (_workspace, mut handle, mut durable) = scripted_failure(
        "claude-error-result",
        r#"
set -eu
cat >/dev/null
printf '%s\n' '{"type":"system","subtype":"init","session_id":"error-session"}'
printf '%s%s\n' \
  '{"type":"result","subtype":"success","is_error":true,' \
  '"result":"provider rejected sentinel-secret and anthropic-fake","session_id":"error-session"}'
exit 1
"#,
    )
    .await;

    let (output, completion) = tokio::join!(durable.recv_output(), handle.completion());
    let output = output.assert_value();
    assert_eq!(output.stream, LiveOutputStream::Error);
    assert_eq!(
        output.text,
        concat!(
            "Claude provider failure: provider rejected [REDACTED] and [REDACTED]; ",
            "provider process exited with status 1"
        )
    );
    assert_eq!(completion, Err(NodeRunnerError::Driver));
    assert_eq!(durable.recv_output().await, Err(AttachReceiveError::Closed));
}

#[tokio::test]
async fn missing_terminal_result_preserves_process_and_stderr_detail() {
    let usage = assert_missing_terminal_failure(
        "claude-missing-result-detail",
        r#"
set -eu
cat >/dev/null
printf '%s%s\n' \
  '{"type":"stream_event","event":{"type":"content_block_delta",' \
  '"delta":{"type":"thinking_delta","thinking":"finished work"}}}'
printf '%s%s%s\n' \
  '{"type":"assistant","session_id":"usage-session","message":{"content":[],' \
  '"usage":{"input_tokens":321,"output_tokens":45,' \
  '"cache_read_input_tokens":89,"cache_creation_input_tokens":13}}}'
printf '%s\n' 'upstream broke sentinel-secret anthropic-fake' >&2
exit 17
"#,
        "stderr: upstream broke [REDACTED] [REDACTED]",
        Some("provider process exited with status 17"),
    )
    .await;
    assert_token_usage(usage, [321, 45, 89, 13]);
}

#[tokio::test]
async fn missing_terminal_result_with_successful_exit_preserves_stderr_detail() {
    let usage = assert_missing_terminal_failure(
        "claude-missing-result-successful-exit-detail",
        r#"
set -eu
cat >/dev/null
printf '%s%s\n' \
  '{"type":"stream_event","event":{"type":"content_block_delta",' \
  '"delta":{"type":"thinking_delta","thinking":"finished work"}}}'
printf '%s\n' 'provider warning sentinel-secret anthropic-fake' >&2
exit 0
"#,
        "stderr: provider warning [REDACTED] [REDACTED]",
        None,
    )
    .await;
    assert!(usage.is_none());
}

#[tokio::test]
async fn preterminal_session_conflict_records_authoritative_result_usage() {
    let workspace = TestDirectory::new("claude-preterminal-session-conflict-usage");
    workspace.write(
        "fake-claude.sh",
        r#"
set -eu
cat >/dev/null
printf '%s\n' '{"type":"system","subtype":"init","session_id":"session-one"}'
printf '%s\n' '{"type":"system","subtype":"init","session_id":"session-two"}'
printf '%s%s%s\n' \
  '{"type":"result","subtype":"success","is_error":false,"session_id":"session-one",' \
  '"structured_output":{"response":"done"},"usage":{"input_tokens":41,"output_tokens":17,' \
  '"cache_read_input_tokens":11,"cache_creation_input_tokens":7}}'
"#,
    );

    let (rendered, usages) =
        anthropic_failure_capture(&workspace, SessionScope::Execution, None).await;
    assert!(rendered.contains("Claude output changed session identifier during one turn"));
    assert!(!rendered.contains("without a terminal result"));
    assert_eq!(usages.len(), 1);
    assert_token_usage(usages.first().copied().flatten(), [41, 17, 11, 7]);
}

#[tokio::test]
async fn nonexistent_executable_emits_a_specific_nonretryable_launch_failure() {
    let rendered = command_failure(
        "claude-missing-executable",
        TestProviderCommand {
            executable: "/missing-zeroshot-claude-executable".to_owned(),
            prefix_arguments: Vec::new(),
            base_environment: BTreeMap::new(),
        },
    )
    .await;
    assert!(rendered.contains("process launch failed before start"));
    assert!(rendered.contains("process spawn failed"));
    assert!(!rendered.contains("execution failed without provider detail"));
    assert!(!rendered.contains("continuing once"));
}

#[tokio::test]
async fn environment_above_the_old_process_bound_reaches_the_provider() {
    let rendered = command_failure(
        "claude-process-environment-bound",
        TestProviderCommand {
            executable: "/bin/true".to_owned(),
            prefix_arguments: Vec::new(),
            base_environment: BTreeMap::from([("LANG".to_owned(), "x".repeat(70 * 1024))]),
        },
    )
    .await;
    assert!(
        rendered.contains("process I/O failed after launch")
            || rendered.contains("Claude output ended without a terminal result"),
        "unexpected diagnostic: {rendered}"
    );
    assert!(!rendered.contains("invalid process command"));
    assert!(!rendered.contains("execution failed without provider detail"));
    assert!(!rendered.contains("continuing once"));
}

#[tokio::test]
async fn early_exit_while_sending_stdin_emits_detail_without_retrying() {
    let workspace = TestDirectory::new("claude-early-stdin-exit");
    workspace.write(
        "fake-claude.sh",
        "set -eu\nprintf x >> invocations.txt\nexit 23\n",
    );
    let (rendered, usages) = anthropic_failure_capture(
        &workspace,
        SessionScope::Execution,
        Some(json!("x".repeat(1024 * 1024))),
    )
    .await;
    assert!(rendered.contains("process I/O failed after launch"));
    assert!(!rendered.contains("execution failed without provider detail"));
    assert!(!rendered.contains("continuing once"));
    assert_eq!(workspace.read("invocations.txt"), "x");
    assert_eq!(usages, [None]);
}

#[tokio::test]
async fn cancelled_input_failure_records_one_incomplete_usage_event() {
    let workspace = TestDirectory::new("claude-cancel-input-failure");
    workspace.write(
        "fake-claude.sh",
        "set -eu\nexec 0<&-\nprintf '%s\\n' \"$$\" > input-failure.pid\nsleep 30\n",
    );
    let mut handle =
        start_anthropic_input(&workspace, json!({"task":"x".repeat(8 * 1024 * 1024)})).await;
    let mut durable = handle.take_initial_output().assert_value();
    let marker = workspace.child("input-failure.pid");
    for _ in 0..100 {
        if marker.exists() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(marker.exists());

    handle.cancel();
    let (captured, completion) = tokio::join!(collect_durable(&mut durable), handle.completion());
    assert_eq!(completion, Err(NodeRunnerError::Cancelled));
    assert_eq!(captured.usages, [None]);
}

#[tokio::test]
async fn changed_session_across_retry_attempts_emits_a_specific_failure() {
    let workspace = TestDirectory::new("claude-changed-retry-session");
    workspace.write(
        "fake-claude.sh",
        r#"
set -eu
cat >/dev/null
if [ -e first-attempt ]; then
  : > second-attempt
  printf '%s\n' '{"type":"system","subtype":"init","session_id":"session-two"}'
  printf '%s%s\n' \
    '{"type":"result","subtype":"success","is_error":false,' \
    '"result":"{\"response\":\"done\"}","session_id":"session-two"}'
  exit 0
fi
: > first-attempt
printf '%s\n' '{"type":"system","subtype":"init","session_id":"session-one"}'
printf '%s\n' '{"type":"system","subtype":"api_retry","attempt":1,"max_retries":3,"error":"overloaded"}'
printf '%s%s\n' \
  '{"type":"result","subtype":"error_during_execution","is_error":true,' \
  '"result":"retry","session_id":"session-one"}'
exit 1
"#,
    );
    let rendered = anthropic_failure(&workspace, SessionScope::Execution, None).await;
    assert!(rendered.contains("Claude output changed session identifier across turns"));
    assert!(!rendered.contains("execution failed without provider detail"));
    assert!(workspace.child("second-attempt").exists());
}

#[tokio::test]
async fn correction_requires_a_provider_session_identifier() {
    let workspace = TestDirectory::new("claude-missing-correction-session");
    workspace.write(
        "fake-claude.sh",
        concat!(
            "set -eu\ncat >/dev/null\n",
            "printf '%s%s\\n' \\\n",
            "  '{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,' \\\n",
            "  '\"result\":\"done\"}'\n",
        ),
    );
    let rendered = anthropic_failure(&workspace, SessionScope::Execution, None).await;
    assert!(
        rendered
            .contains("Claude output did not provide a session identifier required for correction")
    );
    assert!(!rendered.contains("execution failed without provider detail"));
}

#[tokio::test]
async fn reusable_session_requires_a_provider_session_identifier() {
    let workspace = TestDirectory::new("claude-missing-reusable-session");
    workspace.write(
        "fake-claude.sh",
        concat!(
            "set -eu\ncat >/dev/null\n",
            "printf '%s%s\\n' \\\n",
            "  '{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,' \\\n",
            "  '\"result\":\"{\\\"response\\\":\\\"done\\\"}\"}'\n",
        ),
    );
    let rendered = anthropic_failure(&workspace, SessionScope::NodeInstance, None).await;
    assert!(
        rendered
            .contains("Claude output did not provide a session identifier for reusable session")
    );
    assert!(!rendered.contains("execution failed without provider detail"));
}
