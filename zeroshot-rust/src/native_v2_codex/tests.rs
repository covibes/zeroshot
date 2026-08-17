#![cfg(unix)]

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use openengine_cluster_protocol::{
    GraphSpec, IdempotencyKey, NodeName, RunId, WorkerOutcome, WorkerRef,
};
use serde_json::{json, Value};

use super::*;
use crate::execution::SessionScope;
use crate::native_v2_admission::NativeV2Admission;
use crate::native_v2_contract::{
    AdmittedRun, ExecutionId, ExecutionRef, EnvironmentVariableName, NodeInstanceId,
    NodeRuntimeBinding, RunSubmission, RuntimePlan,
};
use crate::native_v2_runner::{NativeNodeRunner, NodeHandle, NodeRunRequest, NodeRunner};
use crate::worker_catalog::{ModelId, ReasoningEffort};

static NEXT_TEMP: AtomicU64 = AtomicU64::new(1);

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
if [ "$resumed" = true ]; then
  /usr/bin/printf '%s\n' '{"type":"item.completed","item":{"type":"agent_message","text":"{\"answer\":43}"}}'
else
  /usr/bin/printf '%s\n' '{"type":"item.completed","item":{"type":"agent_message","text":"{\"answer\":42}"}}'
fi

if [ "${SLOW_RUN-false}" = true ]; then
  /usr/bin/printf '%s\n' "$$" > "$PID_PATH"
  /usr/bin/sleep 30
fi
/usr/bin/printf '%s\n' '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":2}}'
"#;

struct TempDir(PathBuf);

impl TempDir {
    fn new(label: &str) -> Self {
        let serial = NEXT_TEMP.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "zeroshot-v2-codex-{label}-{}-{serial}",
            std::process::id()
        ));
        fs::create_dir_all(&path).unwrap();
        Self(path)
    }

    fn join(&self, path: impl AsRef<Path>) -> PathBuf {
        self.0.join(path)
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn scripted_adapter(directory: &TempDir, provider: CodexProvider) -> Arc<NativeV2CodexAdapter> {
    let executable = directory.join("codex-script");
    fs::write(&executable, SCRIPT).unwrap();
    let mut permissions = fs::metadata(&executable).unwrap().permissions();
    permissions.set_mode(0o700);
    fs::set_permissions(&executable, permissions).unwrap();
    let runtime_home = directory.join("runtime-home");
    let workspace = directory.join("workspace");
    fs::create_dir_all(&runtime_home).unwrap();
    fs::create_dir_all(&workspace).unwrap();
    Arc::new(NativeV2CodexAdapter::new_for_test(NativeV2CodexConfig {
        provider,
        executable,
        workspace,
        runtime_home,
        search_path: "/usr/bin:/bin".to_owned(),
        process_pool: HostedProcessPool::new(10_002, 10_002, 20_000, 20_000).unwrap(),
    }))
}

fn environment_names(names: &[&str]) -> BTreeSet<EnvironmentVariableName> {
    names
        .iter()
        .map(|name| EnvironmentVariableName::new(*name).unwrap())
        .collect()
}

fn binding(scope: SessionScope, environment: &[&str]) -> NodeRuntimeBinding {
    NodeRuntimeBinding::Agent {
        model: ModelId::new("gpt-5.6-sol").unwrap(),
        effort: Some(ReasoningEffort::Max),
        session_scope: scope,
        env: environment_names(environment),
    }
}

async fn admitted(binding: NodeRuntimeBinding, provider: CodexProvider) -> AdmittedRun {
    let graph: GraphSpec = serde_json::from_value(json!({
        "profile":"openengine.graph.full/v1",
        "initialInput":{"kind":"null"},
        "policy":{"policy":"policy.native-v2@1","default":"deny"},
        "root":{
            "kind":"seq","name":"root","state":{"kind":"null"},
            "children":[
                {
                    "kind":"step","name":"work","worker":"agent.work@1",
                    "input":{"kind":"null"},
                    "output":{"kind":"record","fields":{
                        "answer":{"type":{"kind":"integer"},"required":true}
                    }},
                    "inputBindings":[],"writeBindings":[],"timeoutMs":1000,"attempts":1
                },
                {"kind":"succeed","name":"done","output":{"kind":"null"},"bindings":[]}
            ],
            "promotedStatePaths":[]
        }
    }))
    .unwrap();
    NativeV2Admission
        .admit(RunSubmission {
            graph,
            initial_input: Value::Null,
            runtime: RuntimePlan::Codex {
                provider,
                nodes: BTreeMap::from([(NodeName::new("work").unwrap(), binding)]),
            },
            ship: false,
            submission_key: IdempotencyKey::new("codex-adapter-test").unwrap(),
        })
        .await
        .unwrap()
}

fn request(admitted: &AdmittedRun, execution: u64, values: &[(&str, String)]) -> NodeRunRequest {
    let binding = admitted
        .runtime
        .nodes()
        .get(&NodeName::new("work").unwrap())
        .unwrap()
        .clone();
    let values = values
        .iter()
        .map(|(name, value)| (EnvironmentVariableName::new(*name).unwrap(), value.clone()))
        .collect();
    NodeRunRequest {
        invocation: NodeInvocation {
            reference: ExecutionRef {
                run_id: RunId::new("run-codex"),
                node: NodeName::new("work").unwrap(),
                node_instance: NodeInstanceId::new(1).unwrap(),
                execution: ExecutionId::new(execution).unwrap(),
            },
            worker: WorkerRef::new("agent.work@1").unwrap(),
            input: json!({"task":"change the workspace"}),
            binding: binding.clone(),
        },
        environment: ResolvedEnvironment::exact(&binding, values).unwrap(),
    }
}

fn runner(admitted: &AdmittedRun, adapter: Arc<NativeV2CodexAdapter>) -> NativeNodeRunner {
    NativeNodeRunner::new(admitted, adapter.clone(), adapter).unwrap()
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
        .unwrap()
}

#[tokio::test]
async fn openrouter_script_observes_exact_configuration_environment_output_and_attach() {
    let directory = TempDir::new("openrouter");
    let capture = directory.join("capture");
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
    let mut attach = handle.take_initial_output().unwrap();
    let progress = attach.recv().await.unwrap();
    assert_eq!(progress.stream, LiveOutputStream::System);
    assert_eq!(progress.text, "Codex turn started");
    let attached = attach.recv().await.unwrap();
    assert_eq!(attached.stream, LiveOutputStream::Output);
    assert_eq!(attached.text, "visible [REDACTED]");
    assert_eq!(attach.recv().await.unwrap().text, r#"{"answer":42}"#);
    let completion = handle.completion().await.unwrap();
    assert_eq!(
        completion.outcome,
        WorkerOutcome::Verified {
            output: json!({"answer":42}),
            artifacts: Vec::new(),
        }
    );

    let capture = fs::read_to_string(capture).unwrap();
    for expected in [
        "arg=model_provider=\"openrouter\"",
        "arg=model_providers.openrouter.base_url=\"https://openrouter.ai/api/v1\"",
        "arg=model_providers.openrouter.env_key=\"OPENROUTER_API_KEY\"",
        "arg=model_providers.openrouter.wire_api=\"responses\"",
        "arg=--model\narg=gpt-5.6-sol",
        "arg=model_reasoning_effort=\"max\"",
        "arg=--sandbox\narg=workspace-write",
        "arg=approval_policy=\"never\"",
        "arg=--ignore-user-config",
        "arg=--ignore-rules",
        "arg=--strict-config",
        "arg=web_search=\"disabled\"",
        "Input JSON:\n{\"task\":\"change the workspace\"}",
        "Response contract:\n{\"kind\":\"worker\",\"output\":{\"kind\":\"record\"",
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
}

#[tokio::test]
async fn openai_node_instance_session_resumes_the_exact_thread() {
    let directory = TempDir::new("resume");
    let capture = directory.join("capture");
    let adapter = scripted_adapter(&directory, CodexProvider::OpenAi);
    let admitted = admitted(
        binding(
            SessionScope::NodeInstance,
            &["CAPTURE_PATH", "OPENAI_API_KEY"],
        ),
        CodexProvider::OpenAi,
    )
    .await;
    let runtime = runner(&admitted, adapter);
    let values = [
        ("CAPTURE_PATH", capture.display().to_string()),
        ("OPENAI_API_KEY", "fake-openai-key".to_owned()),
    ];
    let mut first_handle = start(&runtime, &admitted, 1, &values).await;
    let first = first_handle.completion().await.unwrap();
    let mut second_handle = start(&runtime, &admitted, 2, &values).await;
    let second = second_handle.completion().await.unwrap();
    assert!(matches!(
        first.outcome,
        WorkerOutcome::Verified { output, .. } if output == json!({"answer":42})
    ));
    assert!(matches!(
        second.outcome,
        WorkerOutcome::Verified { output, .. } if output == json!({"answer":43})
    ));
    let capture = fs::read_to_string(capture).unwrap();
    assert!(capture.contains("arg=model_provider=\"openai\""));
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
async fn cancellation_waits_for_contained_child_cleanup() {
    let directory = TempDir::new("cancel");
    let capture = directory.join("capture");
    let pid_path = directory.join("pid");
    let adapter = scripted_adapter(&directory, CodexProvider::OpenAi);
    let admitted = admitted(
        binding(
            SessionScope::Execution,
            &["CAPTURE_PATH", "CODEX_API_KEY", "PID_PATH", "SLOW_RUN"],
        ),
        CodexProvider::OpenAi,
    )
    .await;
    let runtime = runner(&admitted, adapter);
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
    let mut attach = handle.take_initial_output().unwrap();
    assert_eq!(attach.recv().await.unwrap().text, "Codex turn started");
    assert_eq!(attach.recv().await.unwrap().text, r#"{"answer":42}"#);
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
    panic!("script did not publish its pid");
}

fn process_is_live(pid: u32) -> bool {
    PathBuf::from(format!("/proc/{pid}")).exists()
}

#[test]
fn command_environment_is_exact_and_rejects_adapter_owned_collisions() {
    let declared = binding(SessionScope::Execution, &["DECLARED"]);
    let resolved = ResolvedEnvironment::exact(
        &declared,
        BTreeMap::from([(
            EnvironmentVariableName::new("DECLARED").unwrap(),
            "resolved-value".to_owned(),
        )]),
    )
    .unwrap();
    let environment = process_environment(
        &resolved,
        "/private/runtime".to_owned(),
        "/usr/bin:/bin".to_owned(),
    )
    .unwrap();
    assert_eq!(
        environment,
        BTreeMap::from([
            ("CODEX_HOME".to_owned(), "/private/runtime".to_owned()),
            ("DECLARED".to_owned(), "resolved-value".to_owned()),
            ("HOME".to_owned(), "/private/runtime".to_owned()),
            ("PATH".to_owned(), "/usr/bin:/bin".to_owned()),
        ])
    );

    let binding = binding(SessionScope::Execution, &["CODEX_HOME"]);
    let environment = ResolvedEnvironment::exact(
        &binding,
        BTreeMap::from([(
            EnvironmentVariableName::new("CODEX_HOME").unwrap(),
            "node-owned".to_owned(),
        )]),
    )
    .unwrap();
    assert_eq!(
        process_environment(
            &environment,
            "adapter-owned".to_owned(),
            "/usr/bin:/bin".to_owned()
        ),
        Err(NodeRunnerError::Driver)
    );
}

#[test]
fn log_redactions_are_longest_first_and_do_not_leave_overlapping_suffixes() {
    let binding = binding(SessionScope::Execution, &["LONG_SECRET", "SHORT_SECRET"]);
    let environment = ResolvedEnvironment::exact(
        &binding,
        BTreeMap::from([
            (
                EnvironmentVariableName::new("LONG_SECRET").unwrap(),
                "secret-tail".to_owned(),
            ),
            (
                EnvironmentVariableName::new("SHORT_SECRET").unwrap(),
                "secret".to_owned(),
            ),
        ]),
    )
    .unwrap();
    let redactions = redaction_values(&environment);
    assert_eq!(redactions, vec!["secret-tail", "secret"]);
    assert_eq!(
        redact_text("value=secret-tail", &redactions),
        "value=[REDACTED]"
    );
}
