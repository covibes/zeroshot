use std::path::{Path, PathBuf};
use std::time::Duration;

use super::*;
use crate::native_v2_runner::DurableNodeEvent;

const TERMINAL_THEN_SLOW_SCRIPT: &str = r#"#!/bin/sh
set -eu
/usr/bin/cat > /dev/null
/usr/bin/printf '%s\n' '{"type":"thread.started","thread_id":"usage-before-cancel"}'
/usr/bin/printf '%s%s\n' \
  '{"type":"item.completed","item":{"type":"agent_message",' \
  '"text":"{\"response\":{\"answer\":42}}"}}'
/usr/bin/printf '%s\n' \
  '{"type":"turn.completed","usage":{"input_tokens":17,"output_tokens":9}}'
/usr/bin/printf '%s\n' "$$" > "$PID_PATH"
/usr/bin/sleep 30
"#;

const INPUT_FAILURE_THEN_SLOW_SCRIPT: &str = r#"#!/bin/sh
set -eu
exec 0<&-
/usr/bin/printf '%s\n' "$$" > "$PID_PATH"
/usr/bin/sleep 30
"#;

#[tokio::test]
async fn cancellation_waits_for_contained_child_cleanup() {
    let directory = TestDirectory::new("codex-cancel");
    let capture = directory.child("capture");
    let pid_path = directory.child("pid");
    let (admitted, runtime) = openai_runtime(
        &directory,
        SessionScope::Execution,
        &["CAPTURE_PATH", "CODEX_API_KEY", "PID_PATH", "SLOW_RUN"],
    )
    .await;
    let mut handle = start(
        &runtime,
        &admitted,
        1,
        &[
            ("CAPTURE_PATH", capture.display().to_string()),
            ("CODEX_API_KEY", "fake-openai-key".to_owned()),
            ("PID_PATH", pid_path.display().to_string()),
            ("SLOW_RUN", "true".to_owned()),
        ],
    )
    .await;
    let mut attach = handle.take_initial_output().assert_value();
    assert_eq!(
        attach.recv_output().await.assert_value().text,
        "Codex turn started"
    );
    assert_eq!(
        attach.recv_output().await.assert_value().text,
        r#"{"response":{"answer":42}}"#
    );
    let pid = wait_for_pid(&pid_path).await;
    handle.cancel();
    assert_eq!(handle.completion().await, Err(NodeRunnerError::Cancelled));
    assert!(
        !process_is_live(pid),
        "provider child remained alive after completion"
    );
}

#[tokio::test]
async fn cancellation_after_terminal_output_preserves_parsed_usage_once() {
    let directory = TestDirectory::new("codex-cancel-after-usage");
    let pid_path = directory.child("pid");
    let (admitted, runtime) = openai_scripted_runtime(
        &directory,
        OpenAiScript {
            scope: SessionScope::Execution,
            environment: &["OPENAI_API_KEY", "PID_PATH"],
            name: "terminal-then-slow",
            body: TERMINAL_THEN_SLOW_SCRIPT,
        },
    )
    .await;
    let mut handle = start(
        &runtime,
        &admitted,
        1,
        &[
            ("OPENAI_API_KEY", "fake-openai-key".to_owned()),
            ("PID_PATH", pid_path.display().to_string()),
        ],
    )
    .await;
    let mut output = handle.take_initial_output().assert_value();
    assert_eq!(
        output.recv_output().await.assert_value().text,
        r#"{"response":{"answer":42}}"#
    );
    assert_eq!(
        output.recv_output().await.assert_value().text,
        "Codex turn completed"
    );
    let pid = wait_for_pid(&pid_path).await;

    handle.cancel();
    let (usage, completion) = tokio::join!(output.recv_usage(), handle.completion());
    let usage = usage.assert_value().assert_value();
    assert_eq!(usage.input_tokens.get(), 17);
    assert_eq!(usage.output_tokens.get(), 9);
    assert_eq!(completion, Err(NodeRunnerError::Cancelled));
    assert!(!process_is_live(pid));
    while let Ok(event) = output.recv().await {
        assert!(!matches!(event, DurableNodeEvent::TokenUsage(_)));
    }
}

#[tokio::test]
async fn cancelled_input_failure_records_one_incomplete_usage_event() {
    let directory = TestDirectory::new("codex-cancel-input-failure");
    let pid_path = directory.child("pid");
    let (admitted, runtime) = openai_scripted_runtime(
        &directory,
        OpenAiScript {
            scope: SessionScope::Execution,
            environment: &["OPENAI_API_KEY", "PID_PATH"],
            name: "input-failure-then-slow",
            body: INPUT_FAILURE_THEN_SLOW_SCRIPT,
        },
    )
    .await;
    let values = [
        ("OPENAI_API_KEY", "fake-openai-key".to_owned()),
        ("PID_PATH", pid_path.display().to_string()),
    ];
    let mut large_request = request(&admitted, 1, &values);
    large_request.invocation.input = json!({"task":"x".repeat(8 * 1024 * 1024)});
    let mut handle = runtime.start(large_request).await.assert_value();
    let mut output = handle.take_initial_output().assert_value();
    let pid = wait_for_pid(&pid_path).await;

    handle.cancel();
    let (usages, completion) = tokio::join!(
        async {
            let mut usages = Vec::new();
            while let Ok(event) = output.recv().await {
                if let DurableNodeEvent::TokenUsage(usage) = event {
                    usages.push(usage);
                }
            }
            usages
        },
        handle.completion()
    );
    assert_eq!(completion, Err(NodeRunnerError::Cancelled));
    assert_eq!(usages, [None]);
    assert!(!process_is_live(pid));
}

async fn wait_for_pid(path: &Path) -> u32 {
    for _ in 0..100 {
        if let Ok(value) = fs::read_to_string(path) {
            if let Ok(pid) = value.trim().parse() {
                return pid;
            }
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    None::<u32>.assert_value_with("script did not publish its pid")
}

fn process_is_live(pid: u32) -> bool {
    PathBuf::from(format!("/proc/{pid}")).exists()
}
