use super::*;
use crate::native_v2_contract::TokenUsageDelta;
use crate::native_v2_runner::DurableNodeEvent;

#[path = "process_start/duplex.rs"]
mod duplex;

const EARLY_EXIT_SCRIPT: &str = r#"#!/bin/sh
set -eu
exec 0<&-
/usr/bin/printf '%s\n' 'early provider exit contains sentinel-secret' >&2
exit 23
"#;

type CompletionResult = Result<crate::native_v2_contract::NodeCompletion, NodeRunnerError>;

fn adapter_with_paths(
    directory: &TestDirectory,
    executable: PathBuf,
    runtime_home: PathBuf,
) -> Arc<NativeV2CodexAdapter> {
    let workspace = directory.child("workspace");
    fs::create_dir_all(&workspace).assert_value();
    Arc::new(NativeV2CodexAdapter::new_for_test(NativeV2CodexConfig {
        provider: CodexProvider::OpenAi,
        executable,
        workspace,
        runtime_home,
        local_user: None,
        search_path: "/usr/bin:/bin".to_owned(),
        process_pool: HostedProcessPool::new(10_002, 10_002, 20_000, 20_000).assert_value(),
    }))
}

async fn failed_with_logs(
    adapter: Arc<NativeV2CodexAdapter>,
    environment: &[&str],
    values: &[(&str, String)],
) -> (NodeRunnerError, String) {
    let (error, logs, _) = failed_with_events(adapter, environment, values).await;
    (error, logs)
}

async fn failed_with_events(
    adapter: Arc<NativeV2CodexAdapter>,
    environment: &[&str],
    values: &[(&str, String)],
) -> (NodeRunnerError, String, Vec<Option<TokenUsageDelta>>) {
    let (admitted, runtime) = failure_runtime(adapter, environment).await;
    let handle = start(&runtime, &admitted, 1, values).await;
    let (completion, logs, usages) = complete_with_events(handle).await;
    (completion.err().assert_value(), logs, usages)
}

async fn complete_with_events(
    mut handle: NodeHandle,
) -> (CompletionResult, String, Vec<Option<TokenUsageDelta>>) {
    let mut durable = handle.take_initial_output().assert_value();
    let (events, completion) = tokio::join!(
        async {
            let mut events = Vec::new();
            while let Ok(event) = durable.recv().await {
                events.push(event);
            }
            events
        },
        handle.completion()
    );
    let mut logs = Vec::new();
    let mut usages = Vec::new();
    for event in events {
        match event {
            DurableNodeEvent::Output { output, .. } => logs.push(output.text),
            DurableNodeEvent::TokenUsage(usage) => usages.push(usage),
        }
    }
    (completion, logs.join("\n"), usages)
}

async fn failure_runtime(
    adapter: Arc<NativeV2CodexAdapter>,
    environment: &[&str],
) -> (AdmittedRun, NativeNodeRunner) {
    let admitted = admitted(
        binding(SessionScope::Execution, environment),
        CodexProvider::OpenAi,
    )
    .await;
    let runtime = runner(&admitted, adapter);
    (admitted, runtime)
}

async fn failed_with_openai_key(adapter: Arc<NativeV2CodexAdapter>) -> (NodeRunnerError, String) {
    failed_with_logs(
        adapter,
        &["OPENAI_API_KEY"],
        &[("OPENAI_API_KEY", "fake-openai-key".to_owned())],
    )
    .await
}

fn assert_actionable_retry(error: &NodeRunnerError, logs: &str) {
    assert_eq!(*error, NodeRunnerError::Driver);
    assert_eq!(
        logs.matches("Codex provider failed; continuing once")
            .count(),
        1
    );
    assert!(!logs.contains("execution failed without provider detail"));
}

#[tokio::test]
async fn nonexistent_executable_reports_launch_detail_and_retries_once() {
    let directory = TestDirectory::new("codex-missing-executable");
    let runtime_home = directory.child("runtime-home");
    fs::create_dir_all(&runtime_home).assert_value();
    let adapter = adapter_with_paths(&directory, directory.child("missing-codex"), runtime_home);
    let (error, logs) = failed_with_openai_key(adapter).await;

    assert_actionable_retry(&error, &logs);
    assert!(logs.contains("provider process could not start: process launch failed before start"));
}

#[tokio::test]
async fn early_exit_preserves_stdin_or_exit_detail_and_redacted_stderr() {
    let directory = TestDirectory::new("codex-early-exit");
    let executable = directory.write_executable("early-exit", EARLY_EXIT_SCRIPT);
    let runtime_home = directory.child("runtime-home");
    fs::create_dir_all(&runtime_home).assert_value();
    let adapter = adapter_with_paths(&directory, executable, runtime_home);
    let (error, logs, usages) = failed_with_events(
        adapter,
        &["OPENAI_API_KEY", "TEST_SECRET"],
        &[
            ("OPENAI_API_KEY", "fake-openai-key".to_owned()),
            ("TEST_SECRET", "sentinel-secret".to_owned()),
        ],
    )
    .await;

    assert_actionable_retry(&error, &logs);
    assert!(logs.contains("provider process exited with status 23"));
    assert!(logs.contains("stderr: early provider exit contains [REDACTED]"));
    assert!(!logs.contains("sentinel-secret"));
    assert_eq!(usages, [None, None]);
}

#[tokio::test]
async fn preterminal_thread_conflict_records_authoritative_turn_usage() {
    let directory = TestDirectory::new("codex-preterminal-thread-conflict-usage");
    let adapter = scripted_adapter_with(
        &directory,
        CodexProvider::OpenAi,
        "thread-conflict",
        r#"#!/bin/sh
set -eu
cat >/dev/null
printf '%s\n' '{"type":"thread.started","thread_id":"thread-one"}'
printf '%s\n' '{"type":"thread.started","thread_id":"thread-two"}'
printf '%s%s\n' \
  '{"type":"item.completed","item":{"type":"agent_message",' \
  '"text":"{\"response\":{\"answer\":42}}"}}'
printf '%s%s\n' \
  '{"type":"turn.completed","usage":{"input_tokens":43,"output_tokens":19,' \
  '"cached_input_tokens":13,"cache_write_input_tokens":5}}'
"#,
    );
    let (error, logs, usages) = failed_with_events(
        adapter,
        &["OPENAI_API_KEY"],
        &[("OPENAI_API_KEY", "fake-openai-key".to_owned())],
    )
    .await;

    assert_actionable_retry(&error, &logs);
    assert!(logs.contains("Codex output contained conflicting thread IDs"));
    assert_eq!(usages.len(), 2);
    for usage in usages {
        let usage = usage.assert_value();
        assert_eq!(usage.input_tokens.get(), 43);
        assert_eq!(usage.output_tokens.get(), 19);
        assert_eq!(usage.cache_read_input_tokens.assert_value().get(), 13);
        assert_eq!(usage.cache_creation_input_tokens.assert_value().get(), 5);
    }
}

#[tokio::test]
async fn private_home_setup_failure_is_actionable_and_retried_once() {
    let directory = TestDirectory::new("codex-private-home-failure");
    let runtime_home = directory.write("runtime-home", "not a directory");
    let adapter = adapter_with_paths(&directory, PathBuf::from("/bin/true"), runtime_home);
    let (error, logs) = failed_with_openai_key(adapter).await;

    assert_actionable_retry(&error, &logs);
    assert!(logs.contains("provider process setup failed: process launch failed before start"));
    assert!(logs.contains("provider private home create failed"));
}
