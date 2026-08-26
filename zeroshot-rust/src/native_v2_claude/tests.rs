#![cfg(unix)]

#[path = "tests/correction.rs"]
mod correction;
#[path = "tests/environment.rs"]
mod environment;
#[path = "tests/local_identity.rs"]
mod local_identity;

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use openengine_cluster_protocol::{
    EnumLabel, FieldName, GraphSpec, IdempotencyKey, NodeName, RunSize, RunTitle, WorkerOutcome,
};
use openengine_cluster_testkit::assertions::AssertValue;
use serde_json::{json, Value};

use super::command::{ANTHROPIC_KEY, OPENROUTER_BASE_URL, OPENROUTER_KEY, validate_model_effort};
use super::{ClaudeAdapter, ClaudeAdapterConfig, ClaudeProcessEnvironment};
use crate::execution::{SessionScope, process::HostedProcessPool};
use crate::native_v2_candidate::test_support::{
    NodeRequestFixture, TestDirectory, admit, environment_name, full_graph, success_node,
};
use crate::native_v2_contract::{
    ClaudeProvider, DeclaredEnvironment, NodeRuntimeBinding, RunSubmission, RuntimePlan,
};
use crate::native_v2_runner::{
    AttachReceiveError, LiveOutputStream, NativeNodeRunner, NodeRunRequest, NodeRunner,
    NodeRunnerError,
};
use crate::worker_catalog::{self, ReasoningEffort};

fn agent_binding(
    model: &str,
    effort: Option<ReasoningEffort>,
    scope: SessionScope,
    environment: &[&str],
) -> NodeRuntimeBinding {
    NodeRuntimeBinding::Agent {
        model: worker_catalog::ModelId::new(model).assert_value(),
        effort,
        session_scope: scope,
        env: DeclaredEnvironment::new(environment.iter().map(|name| environment_name(name)))
            .assert_value(),
    }
}

fn graph(verifier: bool) -> GraphSpec {
    let executable = if verifier {
        json!({
            "kind":"verifier", "name":"agent", "worker":"agent.claude@1",
            "instructions":"Exercise the Claude adapter.",
            "input":{"kind":"null"}, "output":{"kind":"null"},
            "inputBindings":[], "writeBindings":[], "timeoutMs":60000, "attempts":1,
            "signals":{"verdict":["accepted","rejected"]}, "diagnostic":{"kind":"null"}
        })
    } else {
        json!({
            "kind":"step", "name":"agent", "worker":"agent.claude@1",
            "instructions":"Exercise the Claude adapter.",
            "input":{"kind":"null"}, "output":{"kind":"string"},
            "inputBindings":[], "writeBindings":[], "timeoutMs":60000, "attempts":1
        })
    };
    full_graph(vec![executable, success_node()])
}

async fn runner(
    workspace: &TestDirectory,
    provider: ClaudeProvider,
    binding: NodeRuntimeBinding,
    verifier: bool,
) -> NativeNodeRunner {
    let runtime = RuntimePlan::Claude {
        provider,
        size: RunSize::Standard,
        nodes: BTreeMap::from([(NodeName::new("agent").assert_value(), binding)]),
    };
    let admitted = admit(RunSubmission {
        title: RunTitle::new("Claude adapter test").assert_value(),
        graph: graph(verifier),
        initial_input: Value::Null,
        runtime,
        source: serde_json::from_value(json!({
            "repository": "open-engine/zeroshot",
            "branch": "main",
            "revision": "0123456789abcdef0123456789abcdef01234567"
        }))
        .assert_value(),
        submission_key: IdempotencyKey::new("claude-test").assert_value(),
    })
    .await;
    let base_environment = ClaudeProcessEnvironment::new(BTreeMap::from([
        (
            "HOME".to_owned(),
            workspace.path().to_string_lossy().into_owned(),
        ),
        ("PATH".to_owned(), "/usr/bin:/bin".to_owned()),
    ]))
    .assert_value();
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
            runtime_home: workspace.path().to_owned(),
            local_user_home: None,
            base_environment,
            turn_timeout: Duration::from_secs(10),
            process_pool: HostedProcessPool::new(10_002, 10_002, 20_000, 20_000).assert_value(),
        })
        .assert_value(),
    );
    NativeNodeRunner::new(&admitted, adapter.clone(), adapter).assert_value()
}

fn request(binding: NodeRuntimeBinding, execution: u64, values: &[(&str, &str)]) -> NodeRunRequest {
    let environment = values
        .iter()
        .map(|(name, value)| (environment_name(name), (*value).to_owned()))
        .collect::<BTreeMap<_, _>>();
    NodeRequestFixture {
        run_id: "claude-run",
        node: "agent",
        node_instance: 1,
        execution,
        worker: "agent.claude@1",
        instructions: "Exercise the Claude adapter.",
        input: Value::String("perform the node task".to_owned()),
        binding,
        environment,
    }
    .into_request()
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
            .assert_value()
            .completion()
            .await
            .assert_value();
    }
}

async fn two_turn_workspace(
    label: &str,
    model: &str,
    effort: ReasoningEffort,
    scope: SessionScope,
) -> TestDirectory {
    let workspace = TestDirectory::new(label);
    workspace.write("fake-claude.sh", SUCCESS_SCRIPT);
    let binding = agent_binding(model, Some(effort), scope, &[ANTHROPIC_KEY]);
    let runner = runner(
        &workspace,
        ClaudeProvider::Anthropic,
        binding.clone(),
        false,
    )
    .await;
    complete_two_turns(&runner, &binding).await;
    workspace
}

fn assert_resumed_session(arguments: &str) {
    assert!(arguments.lines().any(|line| line == "--resume"));
    assert!(arguments.lines().any(|line| line == "session-1"));
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
if [ "${CORRECT_OUTPUT-false}" = true ] && [ "$target" = initial.args ]; then
  result=done
else
  result='\"done\"'
fi
printf '%s%s%s%s\n' \
  '{"type":"result","subtype":"success","is_error":false,"result":"' \
  "$result" \
  '","session_id":"session-1","usage":{"input_tokens":11,"output_tokens":4,' \
  '"cache_read_input_tokens":6,"cache_creation_input_tokens":2}}'
"#;

#[tokio::test]
async fn scripted_anthropic_and_openrouter_commands_are_exact_and_ambient_free() {
    for provider in [ClaudeProvider::Anthropic, ClaudeProvider::OpenRouter] {
        let workspace = TestDirectory::new("claude-command");
        workspace.write("fake-claude.sh", SUCCESS_SCRIPT);
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
            .assert_value();
        let mut attach = handle.take_initial_output().assert_value();
        let (live, completion) = tokio::join!(attach.recv_output(), handle.completion());
        assert_eq!(live.assert_value().text, "visible [REDACTED]");
        assert_eq!(
            completion.assert_value().outcome,
            WorkerOutcome::Verified {
                output: json!("done"),
                artifacts: Vec::new(),
            }
        );
        let usage = attach.recv_usage().await.assert_value().assert_value();
        assert_eq!(
            [
                usage.input_tokens.get(),
                usage.output_tokens.get(),
                usage.cache_read_input_tokens.assert_value().get(),
                usage.cache_creation_input_tokens.assert_value().get(),
            ],
            [11, 4, 6, 2]
        );
        assert_eq!(attach.recv().await, Err(AttachReceiveError::Closed));
        let arguments = workspace.read("initial.args");
        assert!(arguments.starts_with(concat!(
            "--print\n--input-format\ntext\n--output-format\nstream-json\n",
            "--verbose\n--include-partial-messages\n--model\nclaude-sonnet-5\n",
            "--effort\nmax\n--dangerously-skip-permissions\n",
        )));
        assert!(!arguments.contains("--setting-sources"));
        assert!(arguments.contains("Authored instructions:\nExercise the Claude adapter."));
        assert!(arguments.contains("Input JSON:\n\"perform the node task\""));
        assert!(arguments.contains("Runtime-owned response contract:\n{\"kind\":\"worker\""));
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
    let workspace = two_turn_workspace(
        "claude-resume",
        "claude-opus-5",
        ReasoningEffort::High,
        SessionScope::NodeInstance,
    )
    .await;
    assert!(workspace.child("initial.args").exists());
    let resumed = workspace.read("resumed.args");
    assert_resumed_session(&resumed);
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
    let workspace = two_turn_workspace(
        "claude-execution",
        "claude-sonnet-5",
        ReasoningEffort::Max,
        SessionScope::Execution,
    )
    .await;
    assert!(workspace.child("initial.args").exists());
    assert!(!workspace.child("resumed.args").exists());
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
    let workspace = TestDirectory::new("claude-verifier");
    workspace.write(
        "fake-claude.sh",
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
        .assert_value()
        .completion()
        .await
        .assert_value();
    assert_eq!(
        completion.outcome,
        WorkerOutcome::Verifier {
            output: Value::Null,
            signals: BTreeMap::from([(
                FieldName::new("verdict").assert_value(),
                EnumLabel::new("accepted").assert_value(),
            )]),
            diagnostic: Value::Null,
            artifacts: Vec::new(),
        }
    );
    let arguments = workspace.read("verifier.args");
    assert!(arguments.contains("--permission-mode\nplan"));
    assert!(!arguments.contains("--tools"));
    assert!(!arguments.contains("--setting-sources"));
    assert!(!arguments.contains("--dangerously-skip-permissions"));
    assert!(arguments.contains("\"signals\":{\"verdict\":[\"accepted\",\"rejected\"]}"));
}

#[tokio::test]
async fn cancellation_reaps_the_script_and_its_child_before_completion() {
    let workspace = TestDirectory::new("claude-cancel");
    workspace.write(
        "fake-claude.sh",
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
        .assert_value();
    let mut attach = handle.take_initial_output().assert_value();
    assert_eq!(attach.recv_output().await.assert_value().text, "started");
    let child_pid: u32 = workspace.read("child.pid").parse().assert_value();
    handle.cancel();
    assert_eq!(handle.completion().await, Err(NodeRunnerError::Cancelled));
    assert!(!Path::new(&format!("/proc/{child_pid}")).exists());
    assert!(!workspace.child("survivor.txt").exists());
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

#[path = "tests/failure.rs"]
mod failure;
