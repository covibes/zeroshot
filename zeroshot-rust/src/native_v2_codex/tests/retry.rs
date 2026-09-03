use super::*;

const RETRY_SCRIPT_PREFIX: &str = r#"#!/bin/sh
set -eu
prompt=$(/usr/bin/cat)
if [ -e "$STATE_PATH" ]; then attempt=2; else attempt=1; : > "$STATE_PATH"; fi
/usr/bin/printf '%s' "$prompt" > "$STATE_PATH.prompt.$attempt"
{
  for argument in "$@"; do /usr/bin/printf 'arg=%s\n' "$argument"; done
} > "$STATE_PATH.args.$attempt"
if [ "$attempt" = 1 ]; then
  if [ "$NO_FIRST_SESSION" != true ]; then
    /usr/bin/printf '%s\n' '{"type":"thread.started","thread_id":"retry-thread"}'
  fi
  /usr/bin/printf '%s\n' '{"type":"turn.started"}'
  /usr/bin/printf '%s%s%s\n' \
    '{"type":"item.completed","item":{"type":"command_execution",' \
    '"command":"cargo test","aggregated_output":"hidden sentinel-secret",' \
    '"exit_code":1,"status":"failed"}}'
  /usr/bin/printf '%s%s\n' \
    '{"type":"turn.failed","usage":{"input_tokens":13,"output_tokens":5},' \
    '"error":{"message":"provider lost sentinel-secret"}}'
  exit 1
fi
/usr/bin/printf '%s\n' '{"type":"thread.started","thread_id":"retry-thread"}'
/usr/bin/printf '%s\n' '{"type":"turn.started"}'
if [ "$FAIL_TWICE" = true ]; then
  /usr/bin/printf '%s\n' '{"type":"turn.failed","error":{"message":"provider still unavailable"}}'
  exit 1
fi
/usr/bin/printf '%s%s\n' \
  '{"type":"item.completed","item":{"type":"file_change",' \
  '"changes":[{"path":"src/lib.rs","kind":"update"}],"status":"completed"}}'
"#;

const PROCESS_FAILURE_SCRIPT_PREFIX: &str = r#"#!/bin/sh
set -eu
/usr/bin/cat > /dev/null
if [ ! -e "$STATE_PATH" ]; then
  : > "$STATE_PATH"
  /usr/bin/printf '%s\n' '{"type":"thread.started","thread_id":"process-retry-thread"}'
  /usr/bin/printf '%s\n' 'provider stderr contains sentinel-secret' >&2
  exit 17
fi
/usr/bin/printf '%s\n' '{"type":"thread.started","thread_id":"process-retry-thread"}'
"#;

const CLEAN_EXIT_INCOMPLETE_SCRIPT_PREFIX: &str = r#"#!/bin/sh
set -eu
prompt=$(/usr/bin/cat)
if [ ! -e "$STATE_PATH" ]; then
  : > "$STATE_PATH"
  /usr/bin/printf '%s\n' '{"type":"thread.started","thread_id":"clean-exit-retry-thread"}'
  /usr/bin/printf '%s\n' 'clean-exit stderr contains sentinel-secret' >&2
  exit 0
fi
/usr/bin/printf '%s' "$prompt" > "$STATE_PATH.prompt.2"
/usr/bin/printf '%s\n' '{"type":"thread.started","thread_id":"clean-exit-retry-thread"}'
"#;

async fn codex_retry_runtime(
    directory: &TestDirectory,
    scope: SessionScope,
) -> (AdmittedRun, NativeNodeRunner, PathBuf) {
    let state = directory.child("retry-state");
    let script = script_with_success(RETRY_SCRIPT_PREFIX);
    let adapter = scripted_adapter_with(
        directory,
        CodexProvider::OpenAi,
        "codex-retry-script",
        &script,
    );
    let admitted = admitted(
        binding(
            scope,
            &[
                "FAIL_TWICE",
                "NO_FIRST_SESSION",
                "OPENAI_API_KEY",
                "STATE_PATH",
                "TEST_SECRET",
            ],
        ),
        CodexProvider::OpenAi,
    )
    .await;
    let runtime = runner(&admitted, adapter);
    (admitted, runtime, state)
}

fn retry_values(state: &Path, fail_twice: bool, no_first_session: bool) -> Vec<(&str, String)> {
    vec![
        ("FAIL_TWICE", fail_twice.to_string()),
        ("NO_FIRST_SESSION", no_first_session.to_string()),
        ("OPENAI_API_KEY", "fake-openai-key".to_owned()),
        ("STATE_PATH", state.display().to_string()),
        ("TEST_SECRET", "sentinel-secret".to_owned()),
    ]
}

async fn process_retry_logs(label: &str, script_prefix: &str) -> String {
    let directory = TestDirectory::new(label);
    let state = directory.child("retry-state");
    let script = script_with_success(script_prefix);
    let adapter = scripted_adapter_with(&directory, CodexProvider::OpenAi, label, &script);
    let admitted = admitted(
        binding(
            SessionScope::Execution,
            &["OPENAI_API_KEY", "STATE_PATH", "TEST_SECRET"],
        ),
        CodexProvider::OpenAi,
    )
    .await;
    let runtime = runner(&admitted, adapter);
    let handle = start(
        &runtime,
        &admitted,
        1,
        &[
            ("OPENAI_API_KEY", "fake-openai-key".to_owned()),
            ("STATE_PATH", state.display().to_string()),
            ("TEST_SECRET", "sentinel-secret".to_owned()),
        ],
    )
    .await;
    complete_verified_with_logs(handle).await
}

#[tokio::test]
async fn terminal_error_continues_once_in_the_same_session() {
    let directory = TestDirectory::new("codex-provider-retry");
    let (admitted, runtime, state) = codex_retry_runtime(&directory, SessionScope::Execution).await;
    let handle = start(&runtime, &admitted, 1, &retry_values(&state, false, false)).await;
    let rendered = complete_verified_with_logs(handle).await;
    assert_eq!(
        fs::read_to_string(state.with_extension("prompt.2")).assert_value(),
        "Continue"
    );
    assert!(rendered.contains("Codex command completed: cargo test [failed] exit=1"));
    assert!(rendered.contains("hidden [REDACTED]"));
    assert!(rendered.contains("Codex provider failure: provider lost [REDACTED]"));
    assert!(rendered.contains("Codex provider failed; continuing once"));
    assert!(rendered.contains("Codex file change completed: update src/lib.rs"));
    assert!(!rendered.contains("sentinel-secret"));
}

#[tokio::test]
async fn terminal_failure_usage_is_recorded_before_the_retry() {
    let directory = TestDirectory::new("codex-provider-retry-usage");
    let (admitted, runtime, state) = codex_retry_runtime(&directory, SessionScope::Execution).await;
    let mut handle = start(&runtime, &admitted, 1, &retry_values(&state, false, false)).await;
    let mut output = handle.take_initial_output().assert_value();

    let failed_usage = output.recv_usage().await.assert_value().assert_value();
    assert_eq!(failed_usage.input_tokens.get(), 13);
    assert_eq!(failed_usage.output_tokens.get(), 5);
    assert_eq!(output.recv_usage().await.assert_value(), None);
    assert!(matches!(
        handle.completion().await.assert_value().outcome,
        WorkerOutcome::Verified { .. }
    ));
}

#[tokio::test]
async fn no_session_retries_the_original_prompt_once() {
    let directory = TestDirectory::new("codex-provider-retry-no-session");
    let (admitted, runtime, state) =
        codex_retry_runtime(&directory, SessionScope::NodeInstance).await;
    let mut handle = start(&runtime, &admitted, 1, &retry_values(&state, false, true)).await;

    assert!(matches!(
        handle.completion().await.assert_value().outcome,
        WorkerOutcome::Verified { .. }
    ));
    assert_eq!(
        fs::read_to_string(state.with_extension("prompt.1")).assert_value(),
        fs::read_to_string(state.with_extension("prompt.2")).assert_value()
    );
    assert!(
        !fs::read_to_string(state.with_extension("args.2"))
            .assert_value()
            .contains("arg=resume")
    );
}

#[tokio::test]
async fn terminal_error_is_retried_only_once() {
    let directory = TestDirectory::new("codex-provider-retry-limit");
    let (admitted, runtime, state) = codex_retry_runtime(&directory, SessionScope::Execution).await;
    let mut handle = start(&runtime, &admitted, 1, &retry_values(&state, true, false)).await;

    assert_eq!(handle.completion().await, Err(NodeRunnerError::Driver));
    assert!(state.with_extension("prompt.2").exists());
    assert!(!state.with_extension("prompt.3").exists());
}

#[tokio::test]
async fn process_failure_detail_and_stderr_are_preserved_before_retry() {
    let rendered = process_retry_logs(
        "codex-process-failure-script",
        PROCESS_FAILURE_SCRIPT_PREFIX,
    )
    .await;
    assert!(rendered.contains("provider process exited with status 17"));
    assert!(rendered.contains("stderr: provider stderr contains [REDACTED]"));
    assert!(!rendered.contains("execution failed without provider detail"));
    assert!(!rendered.contains("sentinel-secret"));
}

#[tokio::test]
async fn clean_exit_incomplete_stream_preserves_stderr_and_retries() {
    let rendered = process_retry_logs(
        "codex-clean-exit-incomplete-script",
        CLEAN_EXIT_INCOMPLETE_SCRIPT_PREFIX,
    )
    .await;
    assert!(rendered.contains("Codex output ended without a terminal turn event"));
    assert!(rendered.contains("stderr: clean-exit stderr contains [REDACTED]"));
    assert!(rendered.contains("Codex provider failed; continuing once"));
    assert!(!rendered.contains("execution failed without provider detail"));
    assert!(!rendered.contains("sentinel-secret"));
}
