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
            "one":{"kind":"agent","model":"gpt-5.6-sol","env":["DECLARED","SHARED"]},
            "two":{"kind":"agent","model":"gpt-5.6-sol","env":["SHARED"]}
        }
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
    let context = CliExecutionContext::new(&backend, &available);
    execute_native_v2_cli_with_context(command, &context, &mut NeverDetach, &mut Vec::new())
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
    let files = FixtureFiles::with_runtime(
        graph(),
        json!({"task":"ship it"}),
        runtime_with_environment(),
    );
    let command = parse_native_v2_args(run_args(
        &files.graph,
        &files.input,
        &files.runtime,
        &["--submission-key", "environment-key", "-d"],
    ))
    .assert_value();
    let requested = std::cell::RefCell::new(Vec::new());
    let backend = FakeBackend::default();
    let available = |name: &str| {
        requested.borrow_mut().push(name.to_owned());
        Some(OsString::from(format!("value-for-{name}")))
    };
    let context = CliExecutionContext::new(&backend, &available);
    execute_native_v2_cli_with_context(command, &context, &mut NeverDetach, &mut Vec::new())
        .await
        .assert_value();

    assert_eq!(requested.into_inner(), ["DECLARED", "SHARED"]);
    let calls = backend.calls();
    let environment = match calls.as_slice() {
        [Call::Submit { environment, .. }] => Some(environment),
        _ => None,
    }
    .assert_value();
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
    let files = FixtureFiles::with_runtime(
        graph(),
        json!({"task":"ship it"}),
        runtime_with_environment(),
    );
    let command = parse_native_v2_args(run_args(
        &files.graph,
        &files.input,
        &files.runtime,
        &["--submission-key", "missing-environment", "-d"],
    ))
    .assert_value();
    let backend = FakeBackend::default();
    let available = |_: &str| None;
    let context = CliExecutionContext::new(&backend, &available);
    let error =
        execute_native_v2_cli_with_context(command, &context, &mut NeverDetach, &mut Vec::new())
            .await
            .assert_error();
    assert!(error.to_string().contains("DECLARED"));
    assert!(backend.calls().is_empty());
}

#[cfg(unix)]
#[tokio::test]
async fn non_utf8_declared_environment_fails_before_backend_contact() {
    use std::os::unix::ffi::OsStringExt as _;

    let files = FixtureFiles::with_runtime(
        graph(),
        json!({"task":"ship it"}),
        runtime_with_environment(),
    );
    let command = parse_native_v2_args(run_args(
        &files.graph,
        &files.input,
        &files.runtime,
        &["--submission-key", "non-utf8-environment", "-d"],
    ))
    .assert_value();
    let backend = FakeBackend::default();
    let available = |_: &str| Some(OsString::from_vec(vec![0xff]));
    let context = CliExecutionContext::new(&backend, &available);
    let error =
        execute_native_v2_cli_with_context(command, &context, &mut NeverDetach, &mut Vec::new())
            .await
            .assert_error();
    assert!(error.to_string().contains("DECLARED"));
    assert!(backend.calls().is_empty());
}
