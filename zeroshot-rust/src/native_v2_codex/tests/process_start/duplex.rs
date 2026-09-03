use super::*;

const LARGE_INPUT_BYTES: usize = 9 * 1024 * 1024;

const INPUT_FAILURE_FIRST: &str = r#"#!/bin/sh
set -eu
if [ -e "$STATE_PATH" ]; then
  /usr/bin/cat > "$STATE_PATH.prompt.2"
  for argument in "$@"; do /usr/bin/printf '%s\n' "$argument" >> "$STATE_PATH.args.2"; done
  /usr/bin/printf '%s\n' '{"type":"thread.started","thread_id":"duplex-thread"}'
  /usr/bin/printf '%s%s\n' \
    '{"type":"item.completed","item":{"type":"agent_message",' \
    '"text":"{\"response\":{\"answer\":42}}"}}'
  /usr/bin/printf '%s\n' '{"type":"turn.completed"}'
  exit 0
fi
: > "$STATE_PATH"
/usr/bin/printf '%s\n' '{"type":"thread.started","thread_id":"duplex-thread"}'
/usr/bin/printf '%s%s\n' \
  '{"type":"item.completed","item":{"type":"agent_message",' \
  '"text":"{\"response\":{\"answer\":41}}"}}'
/usr/bin/printf '%s%s\n' \
  '{"type":"turn.completed","usage":{"input_tokens":23,"output_tokens":9,' \
  '"cached_input_tokens":17,"cache_write_input_tokens":5}}'
exec 0<&-
/usr/bin/sleep 30
"#;

const OUTPUT_FAILURE_FIRST: &str = r#"#!/bin/sh
set -eu
if [ -e "$STATE_PATH" ]; then
  /usr/bin/cat > "$STATE_PATH.prompt.2"
  for argument in "$@"; do /usr/bin/printf '%s\n' "$argument" >> "$STATE_PATH.args.2"; done
  /usr/bin/printf '%s\n' '{"type":"thread.started","thread_id":"duplex-thread"}'
  /usr/bin/printf '%s%s\n' \
    '{"type":"item.completed","item":{"type":"agent_message",' \
    '"text":"{\"response\":{\"answer\":42}}"}}'
  /usr/bin/printf '%s\n' '{"type":"turn.completed"}'
  exit 0
fi
: > "$STATE_PATH"
/usr/bin/printf '%s\n' '{"type":"thread.started","thread_id":"duplex-thread"}'
/usr/bin/printf '%s%s\n' \
  '{"type":"item.completed","item":{"type":"agent_message",' \
  '"text":"{\"response\":{\"answer\":41}}"}}'
/usr/bin/printf '%s\n' '{"type":"turn.completed"}'
exec 1>&-
/usr/bin/sleep 1
exec 0<&-
/usr/bin/sleep 30
"#;

struct DuplexRun {
    directory: TestDirectory,
    logs: String,
    usages: Vec<Option<TokenUsageDelta>>,
    completion: Result<WorkerOutcome, NodeRunnerError>,
}

async fn run_duplex(label: &str, script: &str) -> DuplexRun {
    let directory = TestDirectory::new(label);
    let state = directory.child("duplex-state");
    let adapter = scripted_adapter_with(&directory, CodexProvider::OpenAi, label, script);
    let admitted = admitted(
        binding(SessionScope::Execution, &["OPENAI_API_KEY", "STATE_PATH"]),
        CodexProvider::OpenAi,
    )
    .await;
    let runtime = runner(&admitted, adapter);
    let values = [
        ("OPENAI_API_KEY", "fake-openai-key".to_owned()),
        ("STATE_PATH", state.display().to_string()),
    ];
    let mut invocation = request(&admitted, 1, &values);
    invocation.invocation.input = json!({"task":"x".repeat(LARGE_INPUT_BYTES)});
    let handle = runtime.start(invocation).await.assert_value();
    let (completion, logs, usages) = complete_with_events(handle).await;
    DuplexRun {
        directory,
        logs,
        usages,
        completion: completion.map(|completion| completion.outcome),
    }
}

fn assert_resumed(run: &DuplexRun) {
    assert!(matches!(
        run.completion.as_ref().assert_value(),
        WorkerOutcome::Verified { output, .. } if output == &json!({"answer":42})
    ));
    assert!(run.logs.contains("provider process input failed"));
    assert!(run.logs.contains("Codex provider failed; continuing once"));
    assert_eq!(run.directory.read("duplex-state.prompt.2"), "Continue");
    let arguments = run.directory.read("duplex-state.args.2");
    assert!(arguments.lines().any(|argument| argument == "resume"));
    assert!(
        arguments
            .lines()
            .any(|argument| argument == "duplex-thread")
    );
}

#[tokio::test]
async fn input_failure_wins_while_the_unfinished_output_is_drained() {
    let run = run_duplex("codex-duplex-input-first", INPUT_FAILURE_FIRST).await;

    assert_resumed(&run);
    assert_eq!(run.usages.len(), 2);
    let usage = run.usages.first().copied().flatten().assert_value();
    assert_eq!(usage.input_tokens.get(), 23);
    assert_eq!(usage.output_tokens.get(), 9);
    assert_eq!(usage.cache_read_input_tokens.assert_value().get(), 17);
    assert_eq!(usage.cache_creation_input_tokens.assert_value().get(), 5);
    assert_eq!(run.usages.get(1).copied().flatten(), None);
}

#[tokio::test]
async fn completed_output_cannot_mask_input_failure_or_session_evidence() {
    let run = run_duplex("codex-duplex-output-first", OUTPUT_FAILURE_FIRST).await;

    assert_resumed(&run);
    assert_eq!(run.usages, [None, None]);
}
