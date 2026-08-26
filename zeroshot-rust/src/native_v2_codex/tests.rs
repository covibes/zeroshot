#![cfg(unix)]

#[path = "tests/correction.rs"]
mod correction;
#[path = "tests/environment.rs"]
mod environment;
#[path = "tests/local_identity.rs"]
mod local_identity;
#[path = "tests/retry.rs"]
mod retry;

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use openengine_cluster_protocol::{IdempotencyKey, NodeName, RunSize, RunTitle, WorkerOutcome};
use openengine_cluster_testkit::assertions::AssertValue;
use serde_json::{json, Value};

use super::*;
use crate::execution::SessionScope;
use crate::native_v2_candidate::test_support::{
    NodeRequestFixture, TestDirectory, admit, environment_name, full_graph, success_node,
};
use crate::native_v2_contract::{
    AdmittedRun, DeclaredEnvironment, EnvironmentVariableName, NodeRuntimeBinding, RunSubmission,
    RuntimePlan,
};
use crate::native_v2_runner::{
    AttachReceiveError, NativeNodeRunner, NodeHandle, NodeRunRequest, NodeRunner,
};
use crate::worker_catalog::{self, ReasoningEffort};

const SCRIPT: &str = r#"#!/bin/sh
set -eu
prompt=$(/usr/bin/cat)
{
  /usr/bin/printf '%s\n' '---'
  for argument in "$@"; do
    /usr/bin/printf 'arg=%s\n' "$argument"
  done
  /usr/bin/printf 'prompt=%s\n' "$prompt"
  /usr/bin/printf 'codex_home=%s\n' "$CODEX_HOME"
  /usr/bin/printf 'openrouter_key=%s\n' "${OPENROUTER_API_KEY-unset}"
  /usr/bin/printf 'codex_key=%s\n' "${CODEX_API_KEY-unset}"
  /usr/bin/printf 'path=%s\n' "${PATH-unset}"
  /usr/bin/printf 'home=%s\n' "${HOME-unset}"
  /usr/bin/printf 'ambient=%s\n' "${AMBIENT_SENTINEL-unset}"
} >> "$CAPTURE_PATH"

resumed=false
for argument in "$@"; do
  if [ "$argument" = "resume" ]; then
    resumed=true
  fi
done

/usr/bin/printf '%s\n' '{"type":"thread.started","thread_id":"thread-123"}'
/usr/bin/printf '%s\n' '{"type":"turn.started"}'
if [ "${OPENROUTER_API_KEY-unset}" != unset ]; then
  /usr/bin/printf '%s%s\n' \
    '{"type":"item.completed","item":{"type":"agent_message",' \
    '"text":"visible fake-openrouter-key"}}'
fi
if [ "${ALWAYS_MALFORMED-false}" = true ]; then
  /usr/bin/printf '%s\n' '{"type":"item.completed","item":{"type":"agent_message","text":"{\"answer\":\"wrong\"}"}}'
elif [ "${CORRECT_OUTPUT-false}" = true ] && [ "$resumed" = false ]; then
  /usr/bin/printf '%s\n' '{"type":"item.completed","item":{"type":"agent_message","text":"{\"answer\":\"wrong\"}"}}'
elif [ "$resumed" = true ]; then
  /usr/bin/printf '%s\n' '{"type":"item.completed","item":{"type":"agent_message","text":"{\"answer\":43}"}}'
else
  /usr/bin/printf '%s\n' '{"type":"item.completed","item":{"type":"agent_message","text":"{\"answer\":42}"}}'
fi

if [ "${SLOW_RUN-false}" = true ]; then
  /usr/bin/printf '%s\n' "$$" > "$PID_PATH"
  /usr/bin/sleep 30
fi
/usr/bin/printf '%s\n' '{"type":"turn.completed","usage":{"input_tokens":1,"cached_input_tokens":1,"output_tokens":2}}'
"#;

fn scripted_adapter(
    directory: &TestDirectory,
    provider: CodexProvider,
) -> Arc<NativeV2CodexAdapter> {
    scripted_adapter_with(directory, provider, "codex-script", SCRIPT)
}

fn scripted_adapter_with(
    directory: &TestDirectory,
    provider: CodexProvider,
    name: &str,
    script: &str,
) -> Arc<NativeV2CodexAdapter> {
    let executable = directory.write_executable(name, script);
    let runtime_home = directory.child("runtime-home");
    let workspace = directory.child("workspace");
    fs::create_dir_all(&runtime_home).assert_value();
    fs::create_dir_all(&workspace).assert_value();
    Arc::new(NativeV2CodexAdapter::new_for_test(NativeV2CodexConfig {
        provider,
        executable,
        workspace,
        runtime_home,
        local_user: None,
        search_path: "/usr/bin:/bin".to_owned(),
        process_pool: HostedProcessPool::new(10_002, 10_002, 20_000, 20_000).assert_value(),
    }))
}

fn environment_names(names: &[&str]) -> DeclaredEnvironment {
    DeclaredEnvironment::new(names.iter().map(|name| environment_name(name))).assert_value()
}

fn binding(scope: SessionScope, environment: &[&str]) -> NodeRuntimeBinding {
    NodeRuntimeBinding::Agent {
        model: worker_catalog::ModelId::new("gpt-5.6-sol").assert_value(),
        effort: Some(ReasoningEffort::Max),
        session_scope: scope,
        env: environment_names(environment),
    }
}

async fn admitted(binding: NodeRuntimeBinding, provider: CodexProvider) -> AdmittedRun {
    let graph = full_graph(vec![
        json!({
            "kind":"step","name":"work","worker":"agent.work@1",
            "instructions":"Exercise the Codex adapter.",
            "input":{"kind":"null"},
            "output":{"kind":"record","fields":{
                "answer":{"type":{"kind":"integer"},"required":true}
            }},
            "inputBindings":[],"writeBindings":[],"timeoutMs":1000,"attempts":1
        }),
        success_node(),
    ]);
    admit(RunSubmission {
        title: RunTitle::new("Codex adapter test").assert_value(),
        graph,
        initial_input: Value::Null,
        runtime: RuntimePlan::Codex {
            provider,
            size: RunSize::Standard,
            nodes: BTreeMap::from([(NodeName::new("work").assert_value(), binding)]),
        },
        source: serde_json::from_value(json!({
            "repository": "open-engine/zeroshot",
            "branch": "main",
            "revision": "0123456789abcdef0123456789abcdef01234567"
        }))
        .assert_value(),
        submission_key: IdempotencyKey::new("codex-adapter-test").assert_value(),
    })
    .await
}

fn request(admitted: &AdmittedRun, execution: u64, values: &[(&str, String)]) -> NodeRunRequest {
    let binding = admitted
        .runtime
        .nodes()
        .get(&NodeName::new("work").assert_value())
        .assert_value()
        .clone();
    let values = values
        .iter()
        .map(|(name, value)| (environment_name(name), value.clone()))
        .collect();
    NodeRequestFixture {
        run_id: "run-codex",
        node: "work",
        node_instance: 1,
        execution,
        worker: "agent.work@1",
        instructions: "Exercise the Codex adapter.",
        input: json!({"task":"change the workspace"}),
        binding,
        environment: values,
    }
    .into_request()
}

fn runner(admitted: &AdmittedRun, adapter: Arc<NativeV2CodexAdapter>) -> NativeNodeRunner {
    NativeNodeRunner::new(admitted, adapter.clone(), adapter).assert_value()
}

async fn openai_runtime(
    directory: &TestDirectory,
    scope: SessionScope,
    environment: &[&str],
) -> (AdmittedRun, NativeNodeRunner) {
    let adapter = scripted_adapter(directory, CodexProvider::OpenAi);
    let admitted = admitted(binding(scope, environment), CodexProvider::OpenAi).await;
    let runtime = runner(&admitted, adapter);
    (admitted, runtime)
}

async fn start(
    runtime: &NativeNodeRunner,
    admitted: &AdmittedRun,
    execution: u64,
    values: &[(&str, String)],
) -> NodeHandle {
    runtime
        .start(request(admitted, execution, values))
        .await
        .assert_value()
}

fn assert_openrouter_capture(capture: &str) {
    for expected in [
        "arg=model_provider=\"openrouter\"",
        "arg=model_providers.openrouter.base_url=\"https://openrouter.ai/api/v1\"",
        "arg=model_providers.openrouter.env_key=\"OPENROUTER_API_KEY\"",
        "arg=model_providers.openrouter.wire_api=\"responses\"",
        "arg=--model\narg=openai/gpt-5.6-sol",
        "arg=model_reasoning_effort=\"max\"",
        "arg=--sandbox\narg=workspace-write",
        "arg=approval_policy=\"never\"",
        "arg=web_search=\"disabled\"",
        "Authored instructions:\nExercise the Codex adapter.",
        "Input JSON:\n{\"task\":\"change the workspace\"}",
        "Runtime-owned response contract:\n{\"kind\":\"worker\",\"output\":{\"kind\":\"record\"",
        "openrouter_key=fake-openrouter-key",
        "codex_key=unset",
        "path=/usr/bin:/bin",
        "ambient=unset",
    ] {
        assert!(
            capture.contains(expected),
            "missing capture evidence: {expected}"
        );
    }
    for suppressed in ["--ignore-user-config", "--ignore-rules", "--strict-config"] {
        assert!(!capture.contains(suppressed));
    }
}

#[tokio::test]
async fn openrouter_script_observes_exact_configuration_environment_output_and_attach() {
    let directory = TestDirectory::new("codex-openrouter");
    let capture = directory.child("capture");
    let adapter = scripted_adapter(&directory, CodexProvider::OpenRouter);
    let admitted = admitted(
        binding(
            SessionScope::Execution,
            &["CAPTURE_PATH", "OPENROUTER_API_KEY"],
        ),
        CodexProvider::OpenRouter,
    )
    .await;
    let runtime = runner(&admitted, adapter);
    let mut handle = start(
        &runtime,
        &admitted,
        1,
        &[
            ("CAPTURE_PATH", capture.display().to_string()),
            ("OPENROUTER_API_KEY", "fake-openrouter-key".to_owned()),
        ],
    )
    .await;
    let mut attach = handle.take_initial_output().assert_value();
    let progress = attach.recv_output().await.assert_value();
    assert_eq!(progress.stream, LiveOutputStream::System);
    assert_eq!(progress.text, "Codex turn started");
    let attached = attach.recv_output().await.assert_value();
    assert_eq!(attached.stream, LiveOutputStream::Output);
    assert_eq!(attached.text, "visible [REDACTED]");
    assert_eq!(
        attach.recv_output().await.assert_value().text,
        r#"{"answer":42}"#
    );
    let completion = handle.completion().await.assert_value();
    assert_eq!(
        completion.outcome,
        WorkerOutcome::Verified {
            output: json!({"answer":42}),
            artifacts: Vec::new(),
        }
    );
    let usage = attach.recv_usage().await.assert_value().assert_value();
    assert_eq!(
        serde_json::to_value(usage).assert_value(),
        json!({
            "inputTokens": 1,
            "outputTokens": 2,
            "cacheReadInputTokens": 1,
            "cacheCreationInputTokens": null
        })
    );
    assert_eq!(attach.recv().await, Err(AttachReceiveError::Closed));

    let capture = fs::read_to_string(capture).assert_value();
    assert_openrouter_capture(&capture);
}

#[test]
fn hosted_codex_uses_the_capsule_as_its_sandbox_boundary() {
    let directory = TestDirectory::new("codex-hosted-policy");
    let local = scripted_adapter(&directory, CodexProvider::OpenAi);
    let hosted = NativeV2CodexAdapter::new(local.config.clone());
    let mut arguments = Vec::new();
    hosted.add_execution_policy(&mut arguments, "read-only");
    assert_eq!(arguments, ["--dangerously-bypass-approvals-and-sandbox"]);
}

#[tokio::test]
async fn openai_node_instance_session_resumes_the_exact_thread() {
    let directory = TestDirectory::new("codex-resume");
    let capture = directory.child("capture");
    let (admitted, runtime) = openai_runtime(
        &directory,
        SessionScope::NodeInstance,
        &["CAPTURE_PATH", "OPENAI_API_KEY"],
    )
    .await;
    let values = [
        ("CAPTURE_PATH", capture.display().to_string()),
        ("OPENAI_API_KEY", "fake-openai-key".to_owned()),
    ];
    let mut first_handle = start(&runtime, &admitted, 1, &values).await;
    let first = first_handle.completion().await.assert_value();
    let mut second_handle = start(&runtime, &admitted, 2, &values).await;
    let second = second_handle.completion().await.assert_value();
    assert!(matches!(
        first.outcome,
        WorkerOutcome::Verified { output, .. } if output == json!({"answer":42})
    ));
    assert!(matches!(
        second.outcome,
        WorkerOutcome::Verified { output, .. } if output == json!({"answer":43})
    ));
    let capture = fs::read_to_string(capture).assert_value();
    assert!(capture.contains("arg=model_provider=\"openai\""));
    assert!(capture.contains("arg=--model\narg=gpt-5.6-sol"));
    assert_eq!(capture.matches("arg=resume").count(), 1);
    assert_eq!(capture.matches("arg=thread-123").count(), 1);
    assert!(capture.contains("codex_key=fake-openai-key"));
    assert!(capture.contains("openrouter_key=unset"));
    let homes = capture
        .lines()
        .filter_map(|line| line.strip_prefix("codex_home="))
        .collect::<BTreeSet<_>>();
    assert_eq!(homes.len(), 1);
    assert!(
        homes
            .iter()
            .all(|home| home.ends_with("writer-node-instance-1"))
    );
}

#[tokio::test]
async fn malformed_output_stops_after_two_correction_turns() {
    let directory = TestDirectory::new("codex-malformed-limit");
    let capture = directory.child("capture");
    let (admitted, runtime) = openai_runtime(
        &directory,
        SessionScope::Execution,
        &["ALWAYS_MALFORMED", "CAPTURE_PATH", "OPENAI_API_KEY"],
    )
    .await;
    let mut handle = start(
        &runtime,
        &admitted,
        1,
        &[
            ("ALWAYS_MALFORMED", "true".to_owned()),
            ("CAPTURE_PATH", capture.display().to_string()),
            ("OPENAI_API_KEY", "fake-openai-key".to_owned()),
        ],
    )
    .await;

    assert_eq!(
        handle.completion().await.assert_value().outcome,
        WorkerOutcome::malformed()
    );
    let capture = fs::read_to_string(capture).assert_value();
    assert_eq!(capture.matches("prompt=").count(), 3);
    assert_eq!(capture.matches("arg=resume").count(), 2);
}

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
        r#"{"answer":42}"#
    );
    let pid = wait_for_pid(&pid_path).await;
    handle.cancel();
    assert_eq!(handle.completion().await, Err(NodeRunnerError::Cancelled));
    assert!(
        !process_is_live(pid),
        "provider child remained alive after completion"
    );
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
