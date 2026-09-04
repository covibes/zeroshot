use super::*;

const CHANGED_THREAD_SCRIPT_PREFIX: &str = r#"#!/bin/sh
set -eu
/usr/bin/cat > /dev/null
if [ ! -e "$STATE_PATH" ]; then
  : > "$STATE_PATH"
  /usr/bin/printf '%s\n' '{"type":"thread.started","thread_id":"thread-one"}'
  /usr/bin/printf '%s\n' '{"type":"turn.failed","error":{"message":"retry me"}}'
  exit 1
fi
/usr/bin/printf '%s\n' '{"type":"thread.started","thread_id":"thread-two"}'
"#;

const NO_THREAD_SCRIPT_PREFIX: &str = r#"#!/bin/sh
set -eu
/usr/bin/cat > /dev/null
"#;

const NO_THREAD_CORRECTION_SCRIPT: &str = r#"#!/bin/sh
set -eu
/usr/bin/cat > /dev/null
/usr/bin/printf '%s%s\n' \
  '{"type":"item.completed","item":{"type":"agent_message",' \
  '"text":"{\"response\":{\"answer\":\"wrong\"}}"}}'
/usr/bin/printf '%s\n' '{"type":"turn.completed"}'
"#;

const RETAINED_THREAD_SCRIPT: &str = r#"#!/bin/sh
set -eu
/usr/bin/cat > /dev/null
{
  for argument in "$@"; do /usr/bin/printf 'arg=%s\n' "$argument"; done
  /usr/bin/printf '%s\n' '---'
} >> "$CAPTURE_PATH"
if [ ! -e "$STATE_PATH" ]; then
  : > "$STATE_PATH"
  /usr/bin/printf '%s\n' '{"type":"thread.started","thread_id":"retained-thread"}'
  /usr/bin/printf '%s%s\n' \
    '{"type":"item.completed","item":{"type":"agent_message",' \
    '"text":"{\"response\":{\"answer\":42}}"}}'
else
  /usr/bin/printf '%s%s\n' \
    '{"type":"item.completed","item":{"type":"agent_message",' \
    '"text":"{\"response\":{\"answer\":43}}"}}'
fi
/usr/bin/printf '%s\n' '{"type":"turn.completed"}'
"#;

async fn assert_two_turn_outputs(
    runtime: &NativeNodeRunner,
    admitted: &AdmittedRun,
    values: &[(&str, String)],
) {
    for (execution, expected) in [(1, 42), (2, 43)] {
        let mut handle = start(runtime, admitted, execution, values).await;
        assert!(matches!(
            handle.completion().await.assert_value().outcome,
            WorkerOutcome::Verified { output, .. } if output == json!({"answer":expected})
        ));
    }
}

async fn missing_thread_failure(
    directory: &TestDirectory,
    scope: SessionScope,
    name: &str,
    body: &str,
) -> String {
    let (admitted, runtime) = openai_scripted_runtime(
        directory,
        OpenAiScript {
            scope,
            environment: &["OPENAI_API_KEY"],
            name,
            body,
        },
    )
    .await;
    let handle = start(
        &runtime,
        &admitted,
        1,
        &[("OPENAI_API_KEY", "fake-openai-key".to_owned())],
    )
    .await;
    let (logs, completion) = complete_with_logs(handle).await;
    assert_eq!(completion, Err(NodeRunnerError::Driver));
    logs
}

#[tokio::test]
async fn long_provider_thread_id_survives_and_resumes_exactly() {
    let directory = TestDirectory::new("codex-long-thread-id");
    let capture = directory.child("capture");
    let thread_id = format!("thread-{}", "x".repeat(1024));
    let (admitted, runtime) = openai_runtime(
        &directory,
        SessionScope::NodeInstance,
        &["CAPTURE_PATH", "OPENAI_API_KEY", "THREAD_ID"],
    )
    .await;
    let values = [
        ("CAPTURE_PATH", capture.display().to_string()),
        ("OPENAI_API_KEY", "fake-openai-key".to_owned()),
        ("THREAD_ID", thread_id.clone()),
    ];

    assert_two_turn_outputs(&runtime, &admitted, &values).await;

    let capture = fs::read_to_string(capture).assert_value();
    assert_eq!(capture.matches("arg=resume").count(), 1);
    assert_eq!(capture.matches(&format!("arg={thread_id}\n")).count(), 1);
}

#[tokio::test]
async fn changed_thread_id_reports_actionable_failure_after_retry() {
    let directory = TestDirectory::new("codex-changed-thread-id");
    let state = directory.child("state");
    let script = script_with_success(CHANGED_THREAD_SCRIPT_PREFIX);
    let (admitted, runtime) = openai_scripted_runtime(
        &directory,
        OpenAiScript {
            scope: SessionScope::Execution,
            environment: &["OPENAI_API_KEY", "STATE_PATH"],
            name: "changed-thread",
            body: &script,
        },
    )
    .await;
    let handle = start(
        &runtime,
        &admitted,
        1,
        &[
            ("OPENAI_API_KEY", "fake-openai-key".to_owned()),
            ("STATE_PATH", state.display().to_string()),
        ],
    )
    .await;
    let (logs, completion) = complete_with_logs(handle).await;

    assert_eq!(completion, Err(NodeRunnerError::Driver));
    assert!(logs.contains("Codex output thread ID did not match the resumed session"));
    assert!(!logs.contains("execution failed without provider detail"));
}

#[tokio::test]
async fn execution_scoped_success_does_not_require_a_thread_id() {
    let directory = TestDirectory::new("codex-execution-no-thread");
    let script = script_with_success(NO_THREAD_SCRIPT_PREFIX);
    let (admitted, runtime) = openai_scripted_runtime(
        &directory,
        OpenAiScript {
            scope: SessionScope::Execution,
            environment: &["OPENAI_API_KEY"],
            name: "execution-no-thread",
            body: &script,
        },
    )
    .await;
    let mut handle = start(
        &runtime,
        &admitted,
        1,
        &[("OPENAI_API_KEY", "fake-openai-key".to_owned())],
    )
    .await;

    assert!(matches!(
        handle.completion().await.assert_value().outcome,
        WorkerOutcome::Verified { output, .. } if output == json!({"answer":42})
    ));
}

#[tokio::test]
async fn node_instance_success_requires_a_thread_id() {
    let directory = TestDirectory::new("codex-node-instance-no-thread");
    let script = script_with_success(NO_THREAD_SCRIPT_PREFIX);
    let logs = missing_thread_failure(
        &directory,
        SessionScope::NodeInstance,
        "node-instance-no-thread",
        &script,
    )
    .await;

    assert!(
        logs.contains("Codex output did not provide a thread ID required for reusable session")
    );
}

#[tokio::test]
async fn correction_requires_a_thread_id() {
    let directory = TestDirectory::new("codex-correction-no-thread");
    let logs = missing_thread_failure(
        &directory,
        SessionScope::Execution,
        "correction-no-thread",
        NO_THREAD_CORRECTION_SCRIPT,
    )
    .await;

    assert!(logs.contains("Codex output did not provide a thread ID required for correction"));
    assert!(!logs.contains("requesting correction"));
}

#[tokio::test]
async fn retained_resume_allows_a_turn_without_an_observed_thread_id() {
    let directory = TestDirectory::new("codex-retained-thread");
    let capture = directory.child("capture");
    let state = directory.child("state");
    let (admitted, runtime) = openai_scripted_runtime(
        &directory,
        OpenAiScript {
            scope: SessionScope::NodeInstance,
            environment: &["CAPTURE_PATH", "OPENAI_API_KEY", "STATE_PATH"],
            name: "retained-thread",
            body: RETAINED_THREAD_SCRIPT,
        },
    )
    .await;
    let values = [
        ("CAPTURE_PATH", capture.display().to_string()),
        ("OPENAI_API_KEY", "fake-openai-key".to_owned()),
        ("STATE_PATH", state.display().to_string()),
    ];
    assert_two_turn_outputs(&runtime, &admitted, &values).await;

    let capture = fs::read_to_string(capture).assert_value();
    assert_eq!(capture.matches("arg=resume\n").count(), 1);
    assert_eq!(capture.matches("arg=retained-thread\n").count(), 1);
}
