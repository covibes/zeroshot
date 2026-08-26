use std::ffi::OsString;

use openengine_cluster_protocol::RuntimePlan;
use openengine_cluster_testkit::assertions::{AssertError, AssertValue};
use serde_json::json;

use super::*;
use crate::native_v2_cli::execution::{CliExecutionContext, execute_native_v2_cli_with_context};

fn runtime_with_environment() -> RuntimePlan {
    serde_json::from_value(json!({
        "harness":"codex",
        "provider":"openai",
        "size":"standard",
        "nodes":{
            "worker":{"kind":"agent","model":"gpt-5.6-sol","env":["DECLARED","SHARED"]}
        }
    }))
    .assert_value()
}

fn environment_graph() -> serde_json::Value {
    serde_json::to_value(
        BuiltinGraphTemplate::SingleWorker
            .materialize(TemplateDelivery::None)
            .assert_value(),
    )
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

fn environment_command(extra: &[&str]) -> (FixtureFiles, NativeV2CliCommand) {
    let files = FixtureFiles::with_runtime(
        environment_graph(),
        json!({"task":"ship it"}),
        runtime_with_environment(),
    );
    let command = parse_native_v2_args(run_args(&files.graph, &files.input, &files.runtime, extra))
        .assert_value();
    (files, command)
}

async fn execute_with_environment(
    command: NativeV2CliCommand,
    backend: &FakeBackend,
    environment: &dyn Fn(&str) -> Option<OsString>,
) -> Result<CliOutcome, NativeV2CliError> {
    let context = CliExecutionContext::new(backend, environment);
    execute_native_v2_cli_with_context(command, &context, &mut NeverDetach, &mut Vec::new()).await
}

async fn assert_declared_environment_rejected(
    command: NativeV2CliCommand,
    backend: &FakeBackend,
    environment: &dyn Fn(&str) -> Option<OsString>,
) {
    let error = execute_with_environment(command, backend, environment)
        .await
        .assert_error();
    assert!(error.to_string().contains("DECLARED"));
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
    let available = |name: &str| (name == "GH_TOKEN").then(|| OsString::from("template-secret"));
    execute_with_environment(command, &backend, &available)
        .await
        .assert_value();
    let calls = backend.calls();
    let submitted = match calls.as_slice() {
        [
            Call::Submit {
                runtime,
                input,
                environment,
                ..
            },
        ] => Some((runtime, input, environment)),
        _ => None,
    }
    .assert_value();
    assert_eq!(submitted.1.pointer("/task"), Some(&json!("ship it")));
    assert_eq!(submitted.1.pointer("/acceptanceFeedback"), Some(&json!("")));
    assert_eq!(submitted.1.pointer("/codeFeedback"), Some(&json!("")));
    assert_eq!(submitted.1.pointer("/deliveryFeedback"), Some(&json!("")));
    let authored_input = std::fs::read(&files.input).assert_value();
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&authored_input).assert_value(),
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
    assert_eq!(
        submitted
            .2
            .iter()
            .next()
            .map(|(name, value)| (name.as_str(), value.as_str())),
        Some(("GH_TOKEN", "template-secret"))
    );
}

#[tokio::test]
async fn run_collects_only_the_distinct_declared_environment_before_submission() {
    let (_files, command) = environment_command(&["--submission-key", "environment-key", "-d"]);
    let requested = std::cell::RefCell::new(Vec::new());
    let backend = FakeBackend::default();
    let available = |name: &str| {
        requested.borrow_mut().push(name.to_owned());
        Some(OsString::from(format!("value-for-{name}")))
    };
    execute_with_environment(command, &backend, &available)
        .await
        .assert_value();

    assert_eq!(requested.into_inner(), ["DECLARED", "SHARED", "GH_TOKEN"]);
    let calls = backend.calls();
    let (environment, github_token) = match calls.as_slice() {
        [
            Call::Submit {
                environment,
                github_token,
                ..
            },
        ] => Some((environment, github_token)),
        _ => None,
    }
    .assert_value();
    assert_eq!(github_token.as_deref(), Some("value-for-GH_TOKEN"));
    assert_eq!(
        environment
            .iter()
            .map(|(name, value)| (name.as_str(), value.as_str()))
            .collect::<Vec<_>>(),
        [
            ("DECLARED", "value-for-DECLARED"),
            ("SHARED", "value-for-SHARED")
        ]
    );
}

#[tokio::test]
async fn missing_declared_environment_fails_before_backend_contact() {
    let (_files, command) = environment_command(&["--submission-key", "missing-environment", "-d"]);
    let backend = FakeBackend::default();
    let available = |_: &str| None;
    assert_declared_environment_rejected(command, &backend, &available).await;
}

#[cfg(unix)]
#[tokio::test]
async fn non_utf8_declared_environment_fails_before_backend_contact() {
    use std::os::unix::ffi::OsStringExt as _;

    let (_files, command) =
        environment_command(&["--submission-key", "non-utf8-environment", "-d"]);
    let backend = FakeBackend::default();
    let available = |_: &str| Some(OsString::from_vec(vec![0xff]));
    assert_declared_environment_rejected(command, &backend, &available).await;
}

#[tokio::test]
async fn uniform_runtime_is_materialized_by_rust_against_the_selected_graph() {
    let files = FixtureFiles::new(graph(), json!({"task":"inspect it"}));
    std::fs::write(
        &files.runtime,
        serde_json::to_vec(&json!({
            "provider":"openrouter",
            "model":"gpt-5.6-luna",
            "effort":"max"
        }))
        .assert_value(),
    )
    .assert_value();
    let command = parse_native_v2_args(args(&[
        "run",
        "--target",
        "prod",
        "--title",
        "Uniform runtime",
        "--template",
        "single-worker",
        "--input",
        files.input.to_str().assert_value(),
        "--uniform-runtime-config",
        files.runtime.to_str().assert_value(),
        "-d",
    ]))
    .assert_value();
    let backend = FakeBackend::default();
    let available =
        |name: &str| (name == "OPENROUTER_API_KEY").then(|| OsString::from("provider-secret"));
    execute_with_environment(command, &backend, &available)
        .await
        .assert_value();

    let calls = backend.calls();
    let runtime = match calls.as_slice() {
        [Call::Submit { runtime, .. }] => Some(runtime),
        _ => None,
    }
    .assert_value();
    assert_eq!(
        serde_json::to_value(runtime)
            .assert_value()
            .pointer("/nodes/worker/model"),
        Some(&json!("gpt-5.6-luna"))
    );
    assert_eq!(
        serde_json::to_value(runtime)
            .assert_value()
            .pointer("/nodes/worker/env/0"),
        Some(&json!("OPENROUTER_API_KEY"))
    );
}

#[tokio::test]
async fn validation_only_rejects_runtime_graph_mismatch_without_backend_contact() {
    let files = FixtureFiles::new(environment_graph(), json!({"task":"inspect it"}));
    let command = parse_native_v2_args(run_args(
        &files.graph,
        &files.input,
        &files.runtime,
        &["--validate-only"],
    ))
    .assert_value();
    let backend = FakeBackend::default();
    let error = rejected_without_backend_contact(command, &backend).await;
    assert!(error.to_string().contains("worker"));
}
