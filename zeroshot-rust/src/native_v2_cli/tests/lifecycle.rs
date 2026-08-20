use openengine_cluster_testkit::assertions::AssertValue;

use super::*;

#[tokio::test]
async fn foreground_watch_reports_queued_before_oecp_admission() {
    let backend = FakeBackend::with_queued_lifecycle();
    let (outcome, output) = execute_durable_command("watch", &backend).await;

    assert_eq!(outcome, CliOutcome::Finished);
    assert!(output.contains("\"phase\":\"queued\""));
    assert!(output.contains("\"phase\":\"admitted\""));
    assert!(output.contains("\"phase\":\"finished\""));
}

#[tokio::test]
async fn queued_is_visible_in_unary_status_and_list() {
    let backend = FakeBackend::with_queued_lifecycle();

    for argv in [
        args(&["status", "run-public", "--target", "prod"]),
        args(&["list", "--target", "prod"]),
    ] {
        let command = parse_native_v2_args(argv).assert_value();
        let mut output = Vec::new();
        execute_native_v2_cli(command, &backend, &mut NeverDetach, &mut output)
            .await
            .assert_value();
        assert_eq!(
            String::from_utf8(output)
                .assert_value()
                .matches("\"phase\":\"queued\"")
                .count(),
            1
        );
    }
}

#[tokio::test]
async fn watch_reconnects_from_queued_cursor_into_admitted_history() {
    let backend = FakeBackend::with_queued_lifecycle();
    let (outcome, output) = execute_durable_command("watch", &backend).await;

    assert_eq!(outcome, CliOutcome::Finished);
    assert_cursor_calls(
        &backend.calls(),
        CursorCallKind::Watch,
        &[None, Some("cloud:1")],
    );
    for cursor in ["cloud:1", "cloud:2", "cloud:3"] {
        assert_cursor_once(&output, cursor);
    }
}

#[tokio::test]
async fn force_can_project_a_preadmission_run_as_stopping() {
    let backend = FakeBackend::with_queued_lifecycle();
    let command = parse_native_v2_args(args(&["force-stop", "run-public", "--target", "prod"]))
        .assert_value();
    let mut output = Vec::new();

    let outcome = execute_native_v2_cli(command, &backend, &mut NeverDetach, &mut output)
        .await
        .assert_value();

    assert_eq!(outcome, CliOutcome::Completed);
    let value = serde_json::from_slice::<Value>(&output).assert_value();
    assert_eq!(value.pointer("/status/phase"), Some(&json!("stopping")));
    assert_eq!(value.pointer("/status/activeExecutions"), Some(&json!([])));
}
