#![cfg(unix)]

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use openengine_cluster_protocol::{
    EnumLabel, FieldName, GraphSpec, IdempotencyKey, NodeName, RunId, WorkerOutcome, WorkerRef,
};
use serde_json::{json, Value};

use super::*;
use crate::native_v2_admission::NativeV2Admission;
use crate::native_v2_contract::{
    EnvironmentVariableName, ExecutionId, ExecutionRef, NodeInstanceId, RunSubmission, RuntimePlan,
};
use crate::native_v2_runner::{NativeNodeRunner, NodeRunRequest, NodeRunner};
use crate::worker_catalog::ModelId;

static NEXT_WORKSPACE: AtomicU64 = AtomicU64::new(1);

struct TestWorkspace(PathBuf);

impl TestWorkspace {
    fn new() -> Self {
        let serial = NEXT_WORKSPACE.fetch_add(1, Ordering::SeqCst);
        let path = std::env::temp_dir().join(format!(
            "zeroshot-native-v2-claude-{}-{serial}",
            std::process::id()
        ));
        fs::create_dir(&path).unwrap();
        Self(path)
    }

    fn path(&self) -> &Path {
        &self.0
    }

    fn write_script(&self, contents: &str) -> PathBuf {
        let path = self.0.join("fake-claude.sh");
        fs::write(&path, contents).unwrap();
        path
    }

    fn read(&self, name: &str) -> String {
        fs::read_to_string(self.0.join(name)).unwrap()
    }
}

impl Drop for TestWorkspace {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn environment_name(value: &str) -> EnvironmentVariableName {
    EnvironmentVariableName::new(value).unwrap()
}

fn agent_binding(
    model: &str,
    effort: Option<ReasoningEffort>,
    scope: SessionScope,
    environment: &[&str],
) -> NodeRuntimeBinding {
    NodeRuntimeBinding::Agent {
        model: ModelId::new(model).unwrap(),
        effort,
        session_scope: scope,
        env: environment
            .iter()
            .map(|name| environment_name(name))
            .collect::<BTreeSet<_>>(),
    }
}

fn graph(verifier: bool) -> GraphSpec {
    let executable = if verifier {
        json!({
            "kind":"verifier", "name":"agent", "worker":"agent.claude@1",
            "input":{"kind":"null"}, "output":{"kind":"null"},
            "inputBindings":[], "writeBindings":[], "timeoutMs":60000, "attempts":1,
            "signals":{"verdict":["accepted","rejected"]}, "diagnostic":{"kind":"null"}
        })
    } else {
        json!({
            "kind":"step", "name":"agent", "worker":"agent.claude@1",
            "input":{"kind":"null"}, "output":{"kind":"string"},
            "inputBindings":[], "writeBindings":[], "timeoutMs":60000, "attempts":1
        })
    };
    serde_json::from_value(json!({
        "profile":"openengine.graph.full/v1",
        "initialInput":{"kind":"null"},
        "policy":{"policy":"policy.native-v2@1","default":"deny"},
        "root":{
            "kind":"seq", "name":"root", "state":{"kind":"null"},
            "children":[executable, {
                "kind":"succeed", "name":"done", "output":{"kind":"null"}, "bindings":[]
            }],
            "promotedStatePaths":[]
        }
    }))
    .unwrap()
}

async fn runner(
    workspace: &TestWorkspace,
    provider: ClaudeProvider,
    binding: NodeRuntimeBinding,
    verifier: bool,
) -> NativeNodeRunner {
    let runtime = RuntimePlan::Claude {
        provider,
        nodes: BTreeMap::from([(NodeName::new("agent").unwrap(), binding)]),
    };
    let admitted = NativeV2Admission
        .admit(RunSubmission {
            graph: graph(verifier),
            initial_input: Value::Null,
            runtime,
            ship: false,
            submission_key: IdempotencyKey::new("claude-test").unwrap(),
        })
        .await
        .unwrap();
    let base_environment = ClaudeProcessEnvironment::new(BTreeMap::from([
        (
            "HOME".to_owned(),
            workspace.path().to_string_lossy().into_owned(),
        ),
        ("PATH".to_owned(), "/usr/bin:/bin".to_owned()),
    ]))
    .unwrap();
    let adapter = Arc::new(
        ClaudeAdapter::new_for_test(ClaudeAdapterConfig {
            provider,
            executable: "/bin/sh".to_owned(),
            prefix_arguments: vec![
                workspace
                    .path()
                    .join("fake-claude.sh")
                    .to_string_lossy()
                    .into_owned(),
            ],
            workspace: workspace.path().to_owned(),
            base_environment,
            turn_timeout: Duration::from_secs(10),
            process_pool: HostedProcessPool::new(10_002, 10_002, 20_000, 20_000).unwrap(),
        })
        .unwrap(),
    );
    NativeNodeRunner::new(&admitted, adapter.clone(), adapter).unwrap()
}

fn request(binding: NodeRuntimeBinding, execution: u64, values: &[(&str, &str)]) -> NodeRunRequest {
    let environment = values
        .iter()
        .map(|(name, value)| (environment_name(name), (*value).to_owned()))
        .collect::<BTreeMap<_, _>>();
    NodeRunRequest {
        invocation: NodeInvocation {
            reference: ExecutionRef {
                run_id: RunId::new("claude-run"),
                node: NodeName::new("agent").unwrap(),
                node_instance: NodeInstanceId::new(1).unwrap(),
                execution: ExecutionId::new(execution).unwrap(),
            },
            worker: WorkerRef::new("agent.claude@1").unwrap(),
            input: Value::String("perform the node task".to_owned()),
            binding: binding.clone(),
        },
        environment: ResolvedEnvironment::exact(&binding, environment).unwrap(),
    }
}

async fn complete_two_turns(runner: &NativeNodeRunner, binding: &NodeRuntimeBinding) {
    for execution in [1, 2] {
        runner
            .start(request(
                binding.clone(),
                execution,
                &[(ANTHROPIC_KEY, "anthropic-fake")],
            ))
            .await
            .unwrap()
            .completion()
            .await
            .unwrap();
    }
}

const SUCCESS_SCRIPT: &str = r#"
set -eu
target=initial.args
previous=
for argument in "$@"; do
  if [ "$previous" = "--resume" ]; then target=resumed.args; fi
  previous=$argument
done
: > "$target"
for argument in "$@"; do printf '%s\n' "$argument" >> "$target"; done
printf '%s\n' "${ANTHROPIC_API_KEY-unset}" > anthropic-key.txt
printf '%s\n' "${ANTHROPIC_AUTH_TOKEN-unset}" > anthropic-token.txt
printf '%s\n' "${ANTHROPIC_BASE_URL-unset}" > anthropic-base-url.txt
printf '%s\n' "${OPENROUTER_API_KEY-unset}" > openrouter-key.txt
printf '%s\n' "${UNDECLARED_AMBIENT_SENTINEL-unset}" > ambient.txt
printf '%s\n' "$HOME" >> homes.txt
printf '%s\n' '{"type":"system","subtype":"init","session_id":"session-1"}'
printf '%s%s\n' \
  '{"type":"stream_event","event":{"type":"content_block_delta",' \
  '"delta":{"type":"text_delta","text":"visible sentinel-secret"}}}'
printf '%s\n' '{"type":"result","subtype":"success","is_error":false,"result":"done","session_id":"session-1"}'
"#;

#[tokio::test]
async fn scripted_anthropic_and_openrouter_commands_are_exact_and_ambient_free() {
    for provider in [ClaudeProvider::Anthropic, ClaudeProvider::OpenRouter] {
        let workspace = TestWorkspace::new();
        workspace.write_script(SUCCESS_SCRIPT);
        let (provider_name, provider_value) = match provider {
            ClaudeProvider::Anthropic => (ANTHROPIC_KEY, "anthropic-fake"),
            ClaudeProvider::OpenRouter => (OPENROUTER_KEY, "openrouter-fake"),
        };
        let binding = agent_binding(
            "claude-sonnet-5",
            Some(ReasoningEffort::Max),
            SessionScope::Execution,
            &[provider_name, "TEST_SECRET"],
        );
        let runner = runner(&workspace, provider, binding.clone(), false).await;
        let mut handle = runner
            .start(request(
                binding,
                1,
                &[
                    (provider_name, provider_value),
                    ("TEST_SECRET", "sentinel-secret"),
                ],
            ))
            .await
            .unwrap();
        let mut attach = handle.take_initial_output().unwrap();
        let (live, completion) = tokio::join!(attach.recv(), handle.completion());
        assert_eq!(live.unwrap().text, "visible [REDACTED]");
        assert_eq!(
            completion.unwrap().outcome,
            WorkerOutcome::Verified {
                output: json!("done"),
                artifacts: Vec::new(),
            }
        );
        let arguments = workspace.read("initial.args");
        assert!(arguments.starts_with(concat!(
            "--print\n--input-format\ntext\n--output-format\nstream-json\n",
            "--verbose\n--include-partial-messages\n--model\nclaude-sonnet-5\n",
            "--effort\nmax\n--setting-sources\n\n--dangerously-skip-permissions\n",
        )));
        assert!(arguments.contains("Input JSON:\n\"perform the node task\""));
        assert!(arguments.contains("Response contract:\n{\"kind\":\"worker\""));
        assert_eq!(workspace.read("ambient.txt").trim(), "unset");
        match provider {
            ClaudeProvider::Anthropic => {
                assert_eq!(workspace.read("anthropic-key.txt").trim(), provider_value);
                assert_eq!(workspace.read("anthropic-token.txt").trim(), "unset");
                assert_eq!(workspace.read("anthropic-base-url.txt").trim(), "unset");
                assert_eq!(workspace.read("openrouter-key.txt").trim(), "unset");
            }
            ClaudeProvider::OpenRouter => {
                assert_eq!(workspace.read("anthropic-key.txt"), "\n");
                assert_eq!(workspace.read("anthropic-token.txt").trim(), provider_value);
                assert_eq!(
                    workspace.read("anthropic-base-url.txt").trim(),
                    OPENROUTER_BASE_URL
                );
                assert_eq!(workspace.read("openrouter-key.txt").trim(), provider_value);
            }
        }
    }
}

#[tokio::test]
async fn node_instance_scope_resumes_the_exact_claude_session() {
    let workspace = TestWorkspace::new();
    workspace.write_script(SUCCESS_SCRIPT);
    let binding = agent_binding(
        "claude-opus-5",
        Some(ReasoningEffort::High),
        SessionScope::NodeInstance,
        &[ANTHROPIC_KEY],
    );
    let runner = runner(
        &workspace,
        ClaudeProvider::Anthropic,
        binding.clone(),
        false,
    )
    .await;
    complete_two_turns(&runner, &binding).await;
    assert!(workspace.0.join("initial.args").exists());
    let resumed = workspace.read("resumed.args");
    assert!(resumed.lines().any(|line| line == "--resume"));
    assert!(resumed.lines().any(|line| line == "session-1"));
    assert!(resumed.lines().any(|line| line == "high"));
    let homes = workspace
        .read("homes.txt")
        .lines()
        .map(str::to_owned)
        .collect::<BTreeSet<_>>();
    assert_eq!(homes.len(), 1);
    assert!(
        homes
            .iter()
            .all(|home| home.ends_with("writer-node-instance-1"))
    );
}

#[tokio::test]
async fn execution_scope_never_resumes_a_prior_turn() {
    let workspace = TestWorkspace::new();
    workspace.write_script(SUCCESS_SCRIPT);
    let binding = agent_binding(
        "claude-sonnet-5",
        Some(ReasoningEffort::Max),
        SessionScope::Execution,
        &[ANTHROPIC_KEY],
    );
    let runner = runner(
        &workspace,
        ClaudeProvider::Anthropic,
        binding.clone(),
        false,
    )
    .await;
    complete_two_turns(&runner, &binding).await;
    assert!(workspace.0.join("initial.args").exists());
    assert!(!workspace.0.join("resumed.args").exists());
    let homes = workspace
        .read("homes.txt")
        .lines()
        .map(str::to_owned)
        .collect::<BTreeSet<_>>();
    assert_eq!(homes.len(), 2);
    assert!(
        homes
            .iter()
            .any(|home| home.ends_with("writer-execution-1"))
    );
    assert!(
        homes
            .iter()
            .any(|home| home.ends_with("writer-execution-2"))
    );
}

#[tokio::test]
async fn verifier_result_is_normalized_to_the_closed_worker_outcome() {
    let workspace = TestWorkspace::new();
    workspace.write_script(
        r#"
set -eu
printf '%s\n' "$@" > verifier.args
printf '%s\n' '{"type":"system","subtype":"init","session_id":"verifier-session"}'
printf '%s%s%s%s\n' \
  '{"type":"result","subtype":"success","is_error":false,' \
  '"result":"{\"output\":null,' \
  '\"signals\":{\"verdict\":\"accepted\"},' \
  '\"diagnostic\":null}"}'
"#,
    );
    let binding = agent_binding(
        "claude-fable-5",
        Some(ReasoningEffort::Xhigh),
        SessionScope::Execution,
        &[ANTHROPIC_KEY],
    );
    let runner = runner(&workspace, ClaudeProvider::Anthropic, binding.clone(), true).await;
    let completion = runner
        .start(request(binding, 1, &[(ANTHROPIC_KEY, "anthropic-fake")]))
        .await
        .unwrap()
        .completion()
        .await
        .unwrap();
    assert_eq!(
        completion.outcome,
        WorkerOutcome::Verifier {
            output: Value::Null,
            signals: BTreeMap::from([(
                FieldName::new("verdict").unwrap(),
                EnumLabel::new("accepted").unwrap(),
            )]),
            diagnostic: Value::Null,
            artifacts: Vec::new(),
        }
    );
    let arguments = workspace.read("verifier.args");
    assert!(arguments.contains("--permission-mode\nplan"));
    assert!(arguments.contains("--tools\nRead,Glob,Grep"));
    assert!(!arguments.contains("--dangerously-skip-permissions"));
    assert!(arguments.contains("\"signals\":{\"verdict\":[\"accepted\",\"rejected\"]}"));
}

#[tokio::test]
async fn cancellation_reaps_the_script_and_its_child_before_completion() {
    let workspace = TestWorkspace::new();
    workspace.write_script(
        r#"
set -eu
(sleep 30; printf survived > survivor.txt) &
printf '%s' "$!" > child.pid
printf '%s%s\n' \
  '{"type":"stream_event","event":{"type":"content_block_delta",' \
  '"delta":{"type":"text_delta","text":"started"}}}'
wait
"#,
    );
    let binding = agent_binding(
        "claude-haiku-4-5",
        None,
        SessionScope::Execution,
        &[ANTHROPIC_KEY],
    );
    let runner = runner(
        &workspace,
        ClaudeProvider::Anthropic,
        binding.clone(),
        false,
    )
    .await;
    let mut handle = runner
        .start(request(binding, 1, &[(ANTHROPIC_KEY, "anthropic-fake")]))
        .await
        .unwrap();
    let mut attach = handle.take_initial_output().unwrap();
    assert_eq!(attach.recv().await.unwrap().text, "started");
    let child_pid: u32 = workspace.read("child.pid").parse().unwrap();
    handle.cancel();
    assert_eq!(handle.completion().await, Err(NodeRunnerError::Cancelled));
    assert!(!Path::new(&format!("/proc/{child_pid}")).exists());
    assert!(!workspace.0.join("survivor.txt").exists());
}

#[test]
fn supported_models_and_efforts_match_the_admission_catalog() {
    assert!(validate_model_effort("claude-haiku-4-5", None).is_ok());
    assert!(validate_model_effort("claude-haiku-4-5", Some(ReasoningEffort::Max)).is_err());
    for model in ["claude-sonnet-5", "claude-opus-5", "claude-fable-5"] {
        for effort in [
            ReasoningEffort::Low,
            ReasoningEffort::Medium,
            ReasoningEffort::High,
            ReasoningEffort::Xhigh,
            ReasoningEffort::Max,
        ] {
            assert!(validate_model_effort(model, Some(effort)).is_ok());
        }
        assert!(validate_model_effort(model, None).is_err());
    }
}

#[test]
fn base_environment_is_explicit_bounded_and_non_secret_by_name() {
    assert!(ClaudeProcessEnvironment::new(BTreeMap::new()).is_ok());
    assert!(
        ClaudeProcessEnvironment::new(BTreeMap::from([(
            "OPENAI_API_KEY".to_owned(),
            "not-allowed".to_owned(),
        )]))
        .is_err()
    );
}
