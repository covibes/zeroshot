use super::*;

const RETRY_SCRIPT: &str = r#"#!/bin/sh
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
  /usr/bin/printf '%s\n' '{"type":"turn.failed","error":{"message":"provider lost sentinel-secret"}}'
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
/usr/bin/printf '%s%s\n' \
  '{"type":"item.completed","item":{"type":"agent_message",' \
  '"text":"{\"response\":{\"answer\":42}}"}}'
/usr/bin/printf '%s\n' '{"type":"turn.completed"}'
"#;

async fn codex_retry_runtime(
    directory: &TestDirectory,
) -> (AdmittedRun, NativeNodeRunner, PathBuf) {
    let state = directory.child("retry-state");
    let adapter = scripted_adapter_with(
        directory,
        CodexProvider::OpenAi,
        "codex-retry-script",
        RETRY_SCRIPT,
    );
    let admitted = admitted(
        binding(
            SessionScope::Execution,
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

#[tokio::test]
async fn terminal_error_continues_once_in_the_same_session() {
    let directory = TestDirectory::new("codex-provider-retry");
    let (admitted, runtime, state) = codex_retry_runtime(&directory).await;
    let mut handle = start(&runtime, &admitted, 1, &retry_values(&state, false, false)).await;
    let mut output = handle.take_initial_output().assert_value();
    let (logs, completion) = tokio::join!(
        async {
            let mut logs = Vec::new();
            while let Ok(entry) = output.recv_output().await {
                logs.push(entry);
            }
            logs
        },
        handle.completion()
    );

    assert!(matches!(
        completion.assert_value().outcome,
        WorkerOutcome::Verified { output, .. } if output == json!({"answer": 42})
    ));
    assert_eq!(
        fs::read_to_string(state.with_extension("prompt.2")).assert_value(),
        "Continue"
    );
    let rendered = logs
        .iter()
        .map(|entry| entry.text.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    assert!(rendered.contains("Codex command completed: cargo test [failed] exit=1"));
    assert!(rendered.contains("hidden [REDACTED]"));
    assert!(rendered.contains("Codex provider failure: provider lost [REDACTED]"));
    assert!(rendered.contains("Codex provider failed; continuing once"));
    assert!(rendered.contains("Codex file change completed: update src/lib.rs"));
    assert!(!rendered.contains("sentinel-secret"));
}

#[tokio::test]
async fn no_session_retries_the_original_prompt_once() {
    let directory = TestDirectory::new("codex-provider-retry-no-session");
    let (admitted, runtime, state) = codex_retry_runtime(&directory).await;
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
    let (admitted, runtime, state) = codex_retry_runtime(&directory).await;
    let mut handle = start(&runtime, &admitted, 1, &retry_values(&state, true, false)).await;

    assert_eq!(handle.completion().await, Err(NodeRunnerError::Driver));
    assert!(state.with_extension("prompt.2").exists());
    assert!(!state.with_extension("prompt.3").exists());
}
