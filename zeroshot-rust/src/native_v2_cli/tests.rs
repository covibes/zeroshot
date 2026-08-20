use std::ffi::OsString;
use std::path::{Path, PathBuf};

use openengine_cluster_protocol::{RunStatusResult, RunTitle, RuntimePlan};
use serde_json::{json, Value};

use super::*;

#[path = "tests/attach.rs"]
mod attach_tests;
#[path = "tests/parser.rs"]
mod parser_tests;

#[path = "tests/support.rs"]
mod support;

use support::*;

fn args(values: &[&str]) -> Vec<OsString> {
    values.iter().map(OsString::from).collect()
}

fn assert_cursor_calls(calls: &[Call], kind: CursorCallKind, expected: &[Option<&str>]) {
    assert_eq!(calls.len(), expected.len());
    for (call, expected_cursor) in calls.iter().zip(expected) {
        let cursor_call = match (kind, call) {
            (
                CursorCallKind::Watch,
                Call::Watch {
                    target,
                    run_id,
                    from_cursor,
                },
            )
            | (
                CursorCallKind::Logs,
                Call::Logs {
                    target,
                    run_id,
                    from_cursor,
                },
            ) => Some((target, run_id, from_cursor)),
            _ => None,
        };
        let (target, run_id, from_cursor) =
            cursor_call.assert_value_with("expected one durable observation call kind");
        assert_eq!(target.as_deref(), Some("prod"));
        assert_eq!(run_id, "run-public");
        assert_eq!(from_cursor.as_deref(), *expected_cursor);
    }
}

async fn execute_durable_command(
    command_name: &str,
    backend: &FakeBackend,
) -> (CliOutcome, String) {
    let command = parse_native_v2_args(args(&[command_name, "run-public", "--target", "prod"]))
        .assert_value();
    let mut output = Vec::new();
    let outcome = execute_native_v2_cli(command, backend, &mut NeverDetach, &mut output)
        .await
        .assert_value();
    (outcome, String::from_utf8(output).assert_value())
}

fn assert_cursor_once(output: &str, cursor: &str) {
    assert_eq!(
        output.matches(&format!("\"cursor\":\"{cursor}\"")).count(),
        1
    );
}

fn run_args(graph: &Path, input: &Path, runtime: &Path, extra: &[&str]) -> Vec<OsString> {
    let mut values = vec![
        OsString::from("run"),
        OsString::from("--target"),
        OsString::from("prod"),
        OsString::from("--title"),
        OsString::from("Repair checkout"),
        OsString::from("--graph"),
        graph.as_os_str().to_owned(),
        OsString::from("--input"),
        input.as_os_str().to_owned(),
        OsString::from("--runtime-config"),
        runtime.as_os_str().to_owned(),
    ];
    values.extend(extra.iter().map(OsString::from));
    values
}

struct FixtureFiles {
    directory: PathBuf,
    graph: PathBuf,
    input: PathBuf,
    runtime: PathBuf,
}

impl FixtureFiles {
    fn new(graph: Value, input: Value) -> Self {
        Self::with_runtime(graph, input, runtime())
    }

    fn with_runtime(graph: Value, input: Value, runtime: RuntimePlan) -> Self {
        let mut random = [0_u8; 8];
        getrandom::fill(&mut random).assert_value();
        let suffix = random
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let directory = std::env::temp_dir().join(format!("zeroshot-v2-cli-{suffix}"));
        std::fs::create_dir(&directory).assert_value();
        let graph_path = directory.join("graph.json");
        let input_path = directory.join("input.json");
        let runtime_path = directory.join("runtime.json");
        std::fs::write(&graph_path, serde_json::to_vec(&graph).assert_value()).assert_value();
        std::fs::write(&input_path, serde_json::to_vec(&input).assert_value()).assert_value();
        std::fs::write(&runtime_path, serde_json::to_vec(&runtime).assert_value()).assert_value();
        Self {
            directory,
            graph: graph_path,
            input: input_path,
            runtime: runtime_path,
        }
    }
}

impl Drop for FixtureFiles {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.graph);
        let _ = std::fs::remove_file(&self.input);
        let _ = std::fs::remove_file(&self.runtime);
        let _ = std::fs::remove_dir(&self.directory);
    }
}

fn graph() -> Value {
    json!({
        "profile":"openengine.graph.full/v1",
        "initialInput":{
            "kind":"record",
            "fields":{"task":{"type":{"kind":"string"},"required":true}}
        },
        "policy":{"policy":"policy.native-v2@1","default":"deny"},
        "root":{"kind":"succeed","name":"done","output":{"kind":"null"},"bindings":[]}
    })
}

fn runtime() -> RuntimePlan {
    serde_json::from_value(json!({
        "harness":"codex",
        "provider":"openai",
        "size":"standard",
        "nodes":{}
    }))
    .assert_value()
}

fn software_change_runtime() -> RuntimePlan {
    serde_json::from_value(json!({
        "harness":"codex",
        "provider":"openai",
        "size":"standard",
        "nodes":{
            "worker":{"kind":"agent","model":"gpt-5.6-sol","effort":"max"},
            "acceptance":{"kind":"agent","model":"gpt-5.6-sol","effort":"max"},
            "code":{"kind":"agent","model":"gpt-5.6-sol","effort":"max"},
            "review_repair":{"kind":"agent","model":"gpt-5.6-sol","effort":"max"},
            "delivery_repair":{"kind":"agent","model":"gpt-5.6-sol","effort":"max"}
        }
    }))
    .assert_value()
}

fn source() -> Value {
    json!({
        "repository":"open-engine/zeroshot",
        "targetBranch":"main",
        "baseRevision":"0123456789abcdef0123456789abcdef01234567"
    })
}

fn status(run_id: &str, phase: &str) -> RunStatusResult {
    serde_json::from_value(json!({
        "runId":run_id,
        "title":"Repair checkout",
        "source":source(),
        "size":"standard",
        "atCursor":"v2:1",
        "status":{"phase":phase}
    }))
    .assert_value()
}

#[test]
fn template_list_and_show_are_static_and_emit_ordinary_json() {
    let backend = FakeBackend::default();
    let mut list_output = Vec::new();
    let list = parse_native_v2_args(args(&["template", "list"])).assert_value();
    let outcome = try_execute_native_v2_static(&list, &mut list_output)
        .assert_value()
        .assert_value();
    assert_eq!(outcome, CliOutcome::Completed);
    assert_eq!(
        serde_json::from_slice::<Value>(&list_output).assert_value(),
        json!(["single-worker", "software-change"])
    );

    let mut show_output = Vec::new();
    let show =
        parse_native_v2_args(args(&["template", "show", "software-change", "--pr"])).assert_value();
    try_execute_native_v2_static(&show, &mut show_output)
        .assert_value()
        .assert_value();
    let shown = serde_json::from_slice::<Value>(&show_output).assert_value();
    assert_eq!(
        shown.pointer("/profile"),
        Some(&json!("openengine.graph.full/v1"))
    );
    assert_eq!(
        shown.pointer("/initialInput/fields/acceptanceFeedback/required"),
        Some(&json!(true))
    );
    assert_eq!(
        shown.pointer("/initialInput/fields/codeFeedback/required"),
        Some(&json!(true))
    );
    assert_eq!(
        shown.pointer("/initialInput/fields/deliveryFeedback/required"),
        Some(&json!(true))
    );
    assert!(shown.to_string().contains("builtin.git-delivery.pr@1"));
    assert!(backend.calls().is_empty());
}

#[tokio::test]
async fn template_run_materializes_internal_input_and_owned_delivery_binding() {
    let files = FixtureFiles::with_runtime(
        graph(),
        json!({"task":"ship it"}),
        software_change_runtime(),
    );
    let command = parse_native_v2_args(args(&[
        "run",
        "--target",
        "prod",
        "--title",
        "Ship change",
        "--template",
        "software-change",
        "--ship",
        "--input",
        files.input.to_str().assert_value(),
        "--runtime-config",
        files.runtime.to_str().assert_value(),
        "--submission-key",
        "template-key",
        "-d",
    ]))
    .assert_value();
    let backend = FakeBackend::default();
    execute_native_v2_cli(command, &backend, &mut NeverDetach, &mut Vec::new())
        .await
        .assert_value();
    let calls = backend.calls();
    let submitted = match calls.as_slice() {
        [Call::Submit { runtime, input, .. }] => Some((runtime, input)),
        _ => None,
    }
    .assert_value();
    assert_eq!(submitted.1.pointer("/task"), Some(&json!("ship it")));
    assert_eq!(submitted.1.pointer("/acceptanceFeedback"), Some(&json!("")));
    assert_eq!(submitted.1.pointer("/codeFeedback"), Some(&json!("")));
    assert_eq!(submitted.1.pointer("/deliveryFeedback"), Some(&json!("")));
    let authored_input = std::fs::read(&files.input).assert_value();
    assert_eq!(
        serde_json::from_slice::<Value>(&authored_input).assert_value(),
        json!({"task":"ship it"})
    );

    let runtime = serde_json::to_value(submitted.0).assert_value();
    assert_eq!(
        runtime.pointer("/nodes/deliver/kind"),
        Some(&json!("git_delivery"))
    );
    assert_eq!(
        runtime.pointer("/nodes/deliver/env/0"),
        Some(&json!("GH_TOKEN"))
    );
}

#[tokio::test]
async fn run_follows_by_default_and_forwards_per_run_intent_unchanged() {
    let files = FixtureFiles::new(graph(), json!({"task":"ship it"}));
    let command = parse_native_v2_args(run_args(
        &files.graph,
        &files.input,
        &files.runtime,
        &["--submission-key", "stable-key"],
    ))
    .assert_value();
    let backend = FakeBackend::default();
    let mut output = Vec::new();
    let outcome = execute_native_v2_cli(command, &backend, &mut NeverDetach, &mut output)
        .await
        .assert_value();
    assert_eq!(outcome, CliOutcome::Finished);
    assert_eq!(
        backend.calls(),
        [
            Call::Submit {
                target: Some("prod".to_owned()),
                title: RunTitle::new("Repair checkout").assert_value(),
                runtime: runtime(),
                input: json!({"task":"ship it"}),
                submission_key: "stable-key".to_owned(),
            },
            Call::Watch {
                target: Some("prod".to_owned()),
                run_id: "run-public".to_owned(),
                from_cursor: None,
            },
        ]
    );
    let lines = String::from_utf8(output).assert_value();
    assert!(lines.contains("\"runId\":\"run-public\""));
    assert!(lines.contains("\"phase\":\"finished\""));
}

#[tokio::test]
async fn detach_flag_returns_after_submit_without_opening_watch() {
    let files = FixtureFiles::new(graph(), json!({"task":"detach"}));
    let command = parse_native_v2_args(run_args(
        &files.graph,
        &files.input,
        &files.runtime,
        &["-d"],
    ))
    .assert_value();
    let backend = FakeBackend::default();
    let outcome = execute_native_v2_cli(command, &backend, &mut NeverDetach, &mut Vec::new())
        .await
        .assert_value();
    assert_eq!(outcome, CliOutcome::Detached);
    assert!(matches!(backend.calls().as_slice(), [Call::Submit { .. }]));
}

#[tokio::test]
async fn ctrl_c_detaches_observation_without_force_stop() {
    let files = FixtureFiles::new(graph(), json!({"task":"interrupt"}));
    let command = parse_native_v2_args(run_args(&files.graph, &files.input, &files.runtime, &[]))
        .assert_value();
    let backend = FakeBackend::with_pending_watch();
    let outcome = execute_native_v2_cli(command, &backend, &mut ImmediateDetach, &mut Vec::new())
        .await
        .assert_value();
    assert_eq!(outcome, CliOutcome::Detached);
    assert!(matches!(
        backend.calls().as_slice(),
        [Call::Submit { .. }] | [Call::Submit { .. }, Call::Watch { .. }]
    ));
    assert!(
        !backend
            .calls()
            .iter()
            .any(|call| matches!(call, Call::Force { .. }))
    );
}

#[tokio::test]
async fn watch_reconnects_after_transport_failure_from_the_last_emitted_cursor() {
    let backend = FakeBackend::with_reconnecting_watch();
    let (outcome, output) = execute_durable_command("watch", &backend).await;
    assert_eq!(outcome, CliOutcome::Finished);
    assert_cursor_calls(
        &backend.calls(),
        CursorCallKind::Watch,
        &[None, Some("v2:1")],
    );
    assert_cursor_once(&output, "v2:1");
    assert_cursor_once(&output, "v2:2");
}

#[tokio::test]
async fn logs_reconnect_after_transport_close_without_replaying_the_boundary() {
    let backend = FakeBackend::with_reconnecting_logs();
    let (outcome, output) = execute_durable_command("logs", &backend).await;
    assert_eq!(outcome, CliOutcome::Completed);
    assert_cursor_calls(
        &backend.calls(),
        CursorCallKind::Logs,
        &[None, Some("v2:4")],
    );
    assert_cursor_once(&output, "v2:4");
    assert_cursor_once(&output, "v2:5");
}

#[tokio::test]
async fn restarted_client_reconnects_with_public_run_id_only() {
    let backend = FakeBackend::default();
    for _client_process in 0..2 {
        let command =
            parse_native_v2_args(args(&["watch", "run-public", "--target", "prod"])).assert_value();
        let outcome = execute_native_v2_cli(command, &backend, &mut NeverDetach, &mut Vec::new())
            .await
            .assert_value();
        assert_eq!(outcome, CliOutcome::Finished);
    }
    assert_eq!(
        backend.calls(),
        [
            Call::Watch {
                target: Some("prod".to_owned()),
                run_id: "run-public".to_owned(),
                from_cursor: None,
            },
            Call::Watch {
                target: Some("prod".to_owned()),
                run_id: "run-public".to_owned(),
                from_cursor: None,
            },
        ]
    );
}

use openengine_cluster_testkit::assertions::AssertValue;

#[tokio::test]
async fn list_and_status_are_run_centric() {
    let backend = FakeBackend::default();
    for argv in [
        args(&["list"]),
        args(&["status", "run-8", "--target", "prod"]),
    ] {
        let command = parse_native_v2_args(argv).assert_value();
        execute_native_v2_cli(command, &backend, &mut NeverDetach, &mut Vec::new())
            .await
            .assert_value();
    }
    assert_eq!(
        backend.calls(),
        [
            Call::List { target: None },
            Call::Status {
                target: Some("prod".to_owned()),
                run_id: "run-8".to_owned(),
            },
        ]
    );
}

#[tokio::test]
async fn logs_attach_and_force_use_the_run_scoped_methods() {
    let backend = FakeBackend::default();
    for argv in [
        args(&["logs", "run-1", "--target", "prod"]),
        args(&["attach", "run-1", "exec-9", "--target", "prod"]),
        args(&["force-stop", "run-1", "--target", "prod"]),
    ] {
        let command = parse_native_v2_args(argv).assert_value();
        execute_native_v2_cli(command, &backend, &mut NeverDetach, &mut Vec::new())
            .await
            .assert_value();
    }
    assert_eq!(
        backend.calls(),
        [
            Call::Logs {
                target: Some("prod".to_owned()),
                run_id: "run-1".to_owned(),
                from_cursor: None,
            },
            Call::Attach {
                target: Some("prod".to_owned()),
                run_id: "run-1".to_owned(),
                execution: "exec-9".to_owned(),
            },
            Call::Force {
                target: Some("prod".to_owned()),
                run_id: "run-1".to_owned(),
            },
        ]
    );
}
