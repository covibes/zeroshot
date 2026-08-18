#![cfg(unix)]

use std::fs;
use std::time::Duration;

use openengine_cluster_testkit::assertions::{AssertAt, AssertValue, JsonAt};
use serde_json::{Value, json};
use tokio::time::sleep;

#[path = "native_v2_cli_local/fixture.rs"]
mod fixture;
use fixture::*;

const TITLE: &str = "Local no-delivery acceptance";

#[tokio::test(flavor = "multi_thread")]
async fn target_omitted_run_derives_source_and_preserves_workspace_mutation() {
    let fixture = LocalFixture::new();
    let output = fixture.run(TITLE, "finish", false).await;
    assert_success(&output, "foreground local run");
    let lines = json_lines(&output.stdout);
    let run_id = lines
        .as_slice()
        .assert_at(0)
        .assert_key("runId")
        .as_str()
        .assert_value_with("run receipt identity");
    assert_local_run_id(run_id);

    let status = fixture.json(&["status", run_id], "finish").await;
    assert_eq!(status.assert_key("title"), TITLE);
    assert_eq!(
        status.assert_key("source").assert_key("repository"),
        "acme/local-fixture"
    );
    assert_eq!(
        status.assert_key("source").assert_key("targetBranch"),
        "feature/local"
    );
    assert_eq!(
        status.assert_key("source").assert_key("baseRevision"),
        &fixture.head
    );
    assert_eq!(status.assert_key("size"), "small");
    assert_eq!(status.assert_key("status").assert_key("phase"), "finished");
    assert_eq!(
        status
            .assert_key("status")
            .assert_key("terminalResult")
            .assert_key("status"),
        "succeeded"
    );
    assert_eq!(
        status
            .assert_key("status")
            .assert_key("terminalResult")
            .assert_key("output"),
        &Value::Null
    );

    assert_eq!(
        fs::read_to_string(fixture.repository.join("local-mutation.txt"))
            .assert_value_with("workspace mutation"),
        "preserved\n"
    );
    assert_eq!(
        fs::read_to_string(fixture.repository.join("environment-proof.txt"))
            .assert_value_with("environment proof"),
        "declared-only\n"
    );
    assert!(fixture.config_blocker.is_file());
    assert!(!fixture.config_blocker.join("targets.json").exists());
    assert!(
        !fixture
            .run_storage(run_id)
            .join("controller.bootstrap.json")
            .exists(),
        "private bootstrap must be consumed"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn detached_local_run_reconnects_without_observer_ownership_and_force_stops() {
    let fixture = LocalFixture::new();
    let run_id = fixture.submit_detached("block").await;
    let running = fixture.wait_running(&run_id).await;
    let execution = running
        .assert_key("status")
        .assert_key("activeExecutions")
        .as_array()
        .assert_value_with("active executions")
        .as_slice()
        .assert_at(0)
        .assert_key("execution")
        .as_str()
        .assert_value_with("active execution")
        .to_owned();

    assert_eq!(
        fixture.listed_run(&run_id).await.assert_key("runId"),
        run_id.as_str()
    );

    let watch = fixture.interrupted(&["watch", &run_id], "block").await;
    assert_success(&watch, "interrupted local watch");
    assert!(String::from_utf8_lossy(&watch.stdout).contains(&run_id));
    assert_eq!(
        fixture
            .json(&["status", &run_id], "block")
            .await
            .assert_key("status")
            .assert_key("phase"),
        "running",
        "disconnecting an observer must not cancel the run"
    );

    let logs = fixture.interrupted(&["logs", &run_id], "block").await;
    assert_success(&logs, "interrupted local logs");
    assert!(String::from_utf8_lossy(&logs.stdout).contains("Codex turn started"));

    let attach = fixture
        .interrupted(&["attach", &run_id, &execution], "block")
        .await;
    assert_success(&attach, "interrupted read-only local attach");
    let attached = String::from_utf8_lossy(&attach.stdout);
    assert!(attached.contains("\"type\":\"working\""));
    assert!(attached.contains("Codex turn started"));
    assert_eq!(
        fixture
            .json(&["status", &run_id], "block")
            .await
            .assert_key("status")
            .assert_key("phase"),
        "running"
    );

    let forced = fixture.json(&["force-stop", &run_id], "block").await;
    assert_eq!(forced.assert_key("runId"), run_id.as_str());
    let terminal = fixture
        .wait_terminal(&run_id, "block", "force_stopped")
        .await;
    assert_eq!(
        terminal.assert_key("status").assert_key("phase"),
        "finished"
    );

    fixture
        .assert_replay("watch", &run_id, "force_stopped")
        .await;
    fixture
        .assert_replay("logs", &run_id, "Codex turn started")
        .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn dead_controller_reconciles_runtime_loss_and_keeps_durable_observation() {
    let fixture = LocalFixture::new();
    let run_id = fixture.submit_detached("block").await;
    fixture.wait_running(&run_id).await;
    sleep(Duration::from_millis(250)).await;

    let controller_pid = fixture.ready_pid(&run_id);
    signal(controller_pid, libc::SIGKILL).assert_value_with("kill detached controller");
    wait_for_exit(controller_pid).await;

    let terminal = fixture
        .wait_terminal(&run_id, "block", "runtime_lost")
        .await;
    assert_eq!(
        terminal.assert_key("status").assert_key("phase"),
        "finished"
    );
    assert_eq!(
        terminal.assert_key("status").assert_key("terminalResult"),
        &json!({"status":"failed", "reason":"runtime_lost"})
    );

    let listed = fixture.listed_run(&run_id).await;
    assert_eq!(
        listed
            .assert_key("status")
            .assert_key("terminalResult")
            .assert_key("reason"),
        "runtime_lost"
    );
    fixture
        .assert_replay("watch", &run_id, "runtime_lost")
        .await;
    fixture
        .assert_replay("logs", &run_id, "Codex turn started")
        .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn stable_submission_key_reuses_the_run_before_source_resolution() {
    let fixture = LocalFixture::new();
    let first = fixture
        .run_with_key("Idempotent local run", "block", "stable-local-key")
        .await;
    assert_success(&first, "first local submission");
    let first_run_id = receipt_run_id(&first);
    fixture.wait_running(&first_run_id).await;

    git(
        &fixture.repository,
        &[
            "remote",
            "set-url",
            "origin",
            "https://example.invalid/not-a-github-repository.git",
        ],
    );
    let retry = fixture
        .run_with_key("Idempotent local run", "block", "stable-local-key")
        .await;
    assert_success(&retry, "idempotent local retry");
    assert_eq!(receipt_run_id(&retry), first_run_id);

    let conflict = fixture
        .run_with_key("Different local intent", "block", "stable-local-key")
        .await;
    assert!(!conflict.status.success(), "conflicting intent succeeded");
    assert!(
        String::from_utf8_lossy(&conflict.stderr)
            .contains("submission key already identifies a different admitted run")
    );

    let forced = fixture.json(&["force-stop", &first_run_id], "block").await;
    assert_eq!(forced.assert_key("runId"), first_run_id.as_str());
}

#[tokio::test(flavor = "multi_thread")]
async fn concurrent_identical_submissions_create_one_local_run() {
    let fixture = LocalFixture::new();
    let first = fixture.run_with_key(
        "Concurrent idempotent local run",
        "block",
        "concurrent-local-key",
    );
    let second = fixture.run_with_key(
        "Concurrent idempotent local run",
        "block",
        "concurrent-local-key",
    );
    let (first, second) = tokio::join!(first, second);
    assert_success(&first, "first concurrent local submission");
    assert_success(&second, "second concurrent local submission");
    let run_id = receipt_run_id(&first);
    assert_eq!(receipt_run_id(&second), run_id);

    let listed = fixture.json(&["list"], "block").await;
    assert_eq!(
        listed
            .assert_key("runs")
            .as_array()
            .assert_value_with("run list")
            .len(),
        1
    );
    fixture.json(&["force-stop", &run_id], "block").await;
}
