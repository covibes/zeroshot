use std::collections::BTreeMap;
use std::fs;
#[cfg(windows)]
use std::path::PathBuf;

#[cfg(unix)]
use tokio::sync::watch;
use tokio::time::{Duration, Instant, timeout};
use zeroshot_engine::execution::WorkspaceAccessMode;
use zeroshot_engine::execution::driver::WorkspaceCapability;
use zeroshot_engine::execution::process::{
    LocalProcessRunner, ProcessCleanupEvidence, ProcessSessionCommand,
};
#[cfg(unix)]
use zeroshot_engine::execution::process::{
    MAX_PROCESS_DIAGNOSTIC_BYTES, MAX_PROCESS_FRAME_BYTES, MAX_PROCESS_FRAMING_OVERHEAD_BYTES,
    MAX_PROCESS_MESSAGE_BYTES, PROCESS_STDIN_CAPACITY, PROCESS_STDOUT_CAPACITY, ProcessFrame,
    ProcessLaunchEvidence, ProcessRunnerError, ProcessSession,
};
#[path = "support/process_runner.rs"]
mod process_runner_support;
use process_runner_support::{
    cancellation_pair, process_exists, unique_temp_path, wait_for_child_pid, wait_for_process_exit,
};
#[cfg(unix)]
use process_runner_support::shell_quote;

fn command(program: &str, argv: Vec<&str>) -> ProcessSessionCommand {
    ProcessSessionCommand {
        program: program.to_owned(),
        argv: argv.into_iter().map(str::to_owned).collect(),
        environment: BTreeMap::new(),
        workspace: WorkspaceCapability {
            current_dir: std::env::temp_dir(),
            mode: WorkspaceAccessMode::Exclusive,
        },
        deadline: Instant::now() + Duration::from_secs(10),
    }
}

#[test]
fn process_command_debug_exposes_environment_names_but_not_values() {
    let mut command = command("provider", vec![]);
    command.environment.insert(
        "OPENAI_API_KEY".to_owned(),
        "sensitive-provider-secret".to_owned(),
    );

    let debug = format!("{command:?}");
    assert!(debug.contains("OPENAI_API_KEY"));
    assert!(!debug.contains("sensitive-provider-secret"));
}

#[cfg(unix)]
async fn open(program: &str, argv: Vec<&str>) -> (watch::Sender<bool>, ProcessSession) {
    let (cancel, cancellation) = cancellation_pair();
    let session = LocalProcessRunner::new()
        .open(command(program, argv), cancellation)
        .await
        .assert_value();
    (cancel, session)
}

#[cfg(unix)]
async fn collect_stdout(session: &mut ProcessSession) -> Vec<u8> {
    let mut output = Vec::new();
    while let Some(chunk) = session.recv_stdout().await {
        output.extend_from_slice(chunk.as_slice());
    }
    output
}

#[cfg(unix)]
#[tokio::test]
async fn stdout_queue_applies_capacity_sixty_four_backpressure() {
    assert_eq!(PROCESS_STDOUT_CAPACITY, 64);
    assert_eq!(PROCESS_STDIN_CAPACITY, 64);
    let marker = unique_temp_path("zeroshot-stream-backpressure");
    let script = format!(
        "/usr/bin/head -c 7000000 /dev/zero; printf ready > {}; sleep 30",
        shell_quote(marker.to_string_lossy().as_ref())
    );
    let (_cancel, mut session) = open("/bin/sh", vec!["-c", &script]).await;
    assert_eq!(session.stdout_queue_capacity(), 64);
    assert_eq!(session.stdin_queue_capacity(), 64);

    tokio::time::sleep(Duration::from_millis(250)).await;
    assert!(
        !marker.exists(),
        "child passed the bounded stdout queue without a receiver"
    );
    let released = timeout(Duration::from_secs(4), session.release())
        .await
        .assert_value_with("release must not depend on stdout capacity")
        .assert_value();
    assert_eq!(released.cleanup, ProcessCleanupEvidence::Reaped);
    assert!(
        released
            .post_launch_error
            .as_deref()
            .is_some_and(|error| error.contains("drain timed out"))
    );
    let _ = fs::remove_file(marker);
}

#[cfg(unix)]
#[tokio::test]
async fn duplex_preserves_split_frames_and_eof_with_pending_output() {
    let (_cancel, mut session) = open("/bin/cat", vec![]).await;
    let prefix = vec![b'a'; 63 * 1024];
    let boundary = vec![b'b'; 3 * 1024];
    let suffix = vec![b'c'; 512 * 1024];
    session
        .send(ProcessFrame::new(prefix.clone()).assert_value())
        .await
        .assert_value();
    session
        .send(ProcessFrame::new(boundary.clone()).assert_value())
        .await
        .assert_value();
    session
        .send(ProcessFrame::new(suffix.clone()).assert_value())
        .await
        .assert_value();
    session.close_stdin().await.assert_value();

    tokio::time::sleep(Duration::from_millis(50)).await;
    let output = collect_stdout(&mut session).await;
    let mut expected = prefix;
    expected.extend_from_slice(&boundary);
    expected.extend_from_slice(&suffix);
    assert_eq!(output, expected);
    let completion = session.wait().await.assert_value();
    assert_eq!(completion.exit_code, Some(0));
    assert_eq!(completion.post_launch_error, None);
}

#[cfg(unix)]
#[tokio::test]
async fn cancellation_and_child_exit_races_settle_once() {
    for _ in 0..8 {
        let (cancel, mut session) =
            open("/bin/sh", vec!["-c", "printf ready; /bin/sleep 0.01"]).await;
        assert_eq!(
            session.recv_stdout().await.assert_value().as_slice(),
            b"ready"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
        let _ = cancel.send(true);
        let completion = timeout(Duration::from_secs(2), session.wait())
            .await
            .assert_value_with("child-exit race must settle")
            .assert_value();
        if completion.cancelled {
            assert_eq!(completion.cleanup, ProcessCleanupEvidence::Reaped);
        } else {
            assert_eq!(completion.exit_code, Some(0));
        }
        assert_eq!(completion, session.release().await.assert_value());
    }

    let (cancel, mut session) = open("/bin/sleep", vec!["30"]).await;
    cancel.send(true).assert_value();
    let completion = timeout(Duration::from_secs(2), session.wait())
        .await
        .assert_value_with("cancellation must settle")
        .assert_value();
    assert!(completion.cancelled);
    assert_eq!(completion.cleanup, ProcessCleanupEvidence::Reaped);
}

#[cfg(unix)]
#[tokio::test]
async fn deadline_force_kills_and_reaps_the_session() {
    let (_cancel, cancellation) = cancellation_pair();
    let mut timed = command("/bin/sleep", vec!["30"]);
    timed.deadline = Instant::now() + Duration::from_millis(50);
    let mut session = LocalProcessRunner::new()
        .open(timed, cancellation)
        .await
        .assert_value();
    let completion = timeout(Duration::from_secs(2), session.wait())
        .await
        .assert_value_with("deadline must settle")
        .assert_value();
    assert!(completion.timed_out);
    assert_eq!(completion.cleanup, ProcessCleanupEvidence::Reaped);
}

#[cfg(unix)]
#[tokio::test]
async fn child_death_closes_stream_and_reports_may_have_started() {
    let (_cancel, mut session) = open("/bin/sh", vec!["-c", "kill -9 $$"]).await;
    assert_eq!(session.recv_stdout().await, None);
    let completion = timeout(Duration::from_secs(2), session.wait())
        .await
        .assert_value()
        .assert_value();
    assert_eq!(
        completion.launch_evidence,
        ProcessLaunchEvidence::MayHaveStarted
    );
    assert_eq!(completion.exit_code, None);

    let (cancel, cancellation) = cancellation_pair();
    let _keep_sender_alive = cancel;
    let error = LocalProcessRunner::new()
        .open(command("/definitely/missing", vec![]), cancellation)
        .await
        .assert_error_with("missing process unexpectedly started");
    assert!(matches!(error, ProcessRunnerError::Launch(_)));
    assert_eq!(
        error.launch_evidence(),
        ProcessLaunchEvidence::DefinitelyNotStarted
    );
}

#[cfg(unix)]
#[tokio::test]
async fn release_drain_timeout_force_kills_and_reaps_descendants() {
    let pid_file = unique_temp_path("zeroshot-stream-descendant-pid");
    let script = format!(
        "sleep 30 & child=$!; printf %s \"$child\" > {}; wait",
        shell_quote(pid_file.to_string_lossy().as_ref())
    );
    let (_cancel, mut session) = open("/bin/sh", vec!["-c", &script]).await;
    let child_pid = wait_for_child_pid(&pid_file).await;
    assert!(process_exists(child_pid));

    let first = timeout(Duration::from_secs(4), session.release())
        .await
        .assert_value_with("release must force a non-draining child")
        .assert_value();
    let second = session.release().await.assert_value();
    assert_eq!(first, second);
    assert_eq!(first.cleanup, ProcessCleanupEvidence::Reaped);
    wait_for_process_exit(child_pid).await;
    let _ = fs::remove_file(pid_file);
}

use openengine_cluster_testkit::assertions::{AssertValue, AssertError};

#[cfg(unix)]
#[tokio::test]
async fn root_exit_and_cancel_race_still_reap_surviving_descendants() {
    let pid_file = unique_temp_path("zeroshot-stream-orphan-pid");
    let ready_file = unique_temp_path("zeroshot-stream-orphan-ready");
    let ready_path = shell_quote(ready_file.to_string_lossy().as_ref());
    let script = format!(
        "(printf ready > {ready_path}; exec /bin/sleep 30) </dev/null >/dev/null 2>&1 & child=$!; while [ ! -f {ready_path} ]; do :; done; printf %s \"$child\" > {}; exit 0",
        shell_quote(pid_file.to_string_lossy().as_ref())
    );
    let (_cancel, mut session) = open("/bin/sh", vec!["-c", &script]).await;
    let child_pid = wait_for_child_pid(&pid_file).await;
    assert_eq!(fs::read(&ready_file).assert_value(), b"ready");
    let completion = timeout(Duration::from_secs(4), session.wait())
        .await
        .assert_value_with("root exit must retain descendant cleanup ownership")
        .assert_value();
    assert_eq!(completion.exit_code, Some(0));
    assert_eq!(completion.cleanup, ProcessCleanupEvidence::Reaped);
    assert_eq!(completion.post_launch_error, None);
    wait_for_process_exit(child_pid).await;
    let _ = fs::remove_file(&pid_file);
    let _ = fs::remove_file(&ready_file);

    let (cancel, mut session) = open("/bin/sh", vec!["-c", &script]).await;
    let child_pid = wait_for_child_pid(&pid_file).await;
    assert_eq!(fs::read(&ready_file).assert_value(), b"ready");
    let _ = cancel.send(true);
    let completion = timeout(Duration::from_secs(4), session.wait())
        .await
        .assert_value_with("root-exit cancellation race must retain cleanup ownership")
        .assert_value();
    assert_eq!(completion.cleanup, ProcessCleanupEvidence::Reaped);
    assert_eq!(completion.post_launch_error, None);
    wait_for_process_exit(child_pid).await;
    let _ = fs::remove_file(pid_file);
    let _ = fs::remove_file(ready_file);
}

#[cfg(unix)]
#[tokio::test]
async fn rejects_oversized_messages_and_classifies_post_launch_io() {
    assert_eq!(
        MAX_PROCESS_FRAME_BYTES,
        MAX_PROCESS_MESSAGE_BYTES + MAX_PROCESS_FRAMING_OVERHEAD_BYTES
    );
    assert!(
        ProcessFrame::with_framing(vec![0; MAX_PROCESS_FRAME_BYTES], MAX_PROCESS_MESSAGE_BYTES)
            .is_ok()
    );
    let error = ProcessFrame::new(vec![0; MAX_PROCESS_MESSAGE_BYTES + 1]).assert_error();
    assert!(matches!(error, ProcessRunnerError::InvalidCommand(_)));
    let overhead_error = ProcessFrame::with_framing(
        vec![0; MAX_PROCESS_FRAME_BYTES + 1],
        MAX_PROCESS_MESSAGE_BYTES,
    )
    .assert_error();
    assert!(matches!(
        overhead_error,
        ProcessRunnerError::InvalidCommand(_)
    ));
    assert_eq!(
        error.launch_evidence(),
        ProcessLaunchEvidence::DefinitelyNotStarted
    );

    let (_cancel, mut session) = open("/bin/true", vec![]).await;
    session.wait().await.assert_value();
    let error = session
        .send(ProcessFrame::new(b"late".to_vec()).assert_value())
        .await
        .assert_error();
    assert!(matches!(error, ProcessRunnerError::Io(_)));
    assert_eq!(
        error.launch_evidence(),
        ProcessLaunchEvidence::MayHaveStarted
    );
}

#[cfg(unix)]
#[tokio::test]
async fn stderr_keeps_only_the_bounded_diagnostic_tail() {
    let script =
        "i=0; while [ \"$i\" -lt 70000 ]; do printf a 1>&2; i=$((i+1)); done; printf TAIL 1>&2";
    let (_cancel, mut session) = open("/bin/sh", vec!["-c", script]).await;
    let completion = timeout(Duration::from_secs(5), session.wait())
        .await
        .assert_value()
        .assert_value();
    assert_eq!(completion.stderr_tail.len(), MAX_PROCESS_DIAGNOSTIC_BYTES);
    assert!(completion.stderr_tail.ends_with(b"TAIL"));
    assert_eq!(completion.post_launch_error, None);
}

#[cfg(unix)]
#[tokio::test]
async fn close_and_release_are_idempotent_for_one_shot_sessions() {
    let (_cancel, mut session) = open("/bin/cat", vec![]).await;
    session
        .send(ProcessFrame::new(b"one-shot\n".to_vec()).assert_value())
        .await
        .assert_value();
    session.close_stdin().await.assert_value();
    session.close_stdin().await.assert_value();
    assert_eq!(collect_stdout(&mut session).await, b"one-shot\n");

    let waited = session.wait().await.assert_value();
    let first_release = session.release().await.assert_value();
    let second_release = session.release().await.assert_value();
    assert_eq!(waited, first_release);
    assert_eq!(first_release, second_release);
    assert_eq!(first_release.cleanup, ProcessCleanupEvidence::NotRequired);
}

#[cfg(windows)]
#[tokio::test]
async fn windows_job_release_reaps_a_descendant() {
    let system_root = std::env::var("SystemRoot").assert_value_with("Windows has SystemRoot");
    let powershell = PathBuf::from(&system_root)
        .join("System32")
        .join("WindowsPowerShell")
        .join("v1.0")
        .join("powershell.exe");
    let pid_file = unique_temp_path("zeroshot-stream-windows-descendant-pid");
    let powershell_literal = powershell.to_string_lossy().replace('\'', "''");
    let pid_literal = pid_file.to_string_lossy().replace('\'', "''");
    let script = format!(
        "$child = Start-Process -FilePath '{powershell_literal}' -ArgumentList @('-NoProfile','-Command','Start-Sleep -Seconds 30') -PassThru; Set-Content -NoNewline -Path '{pid_literal}' -Value $child.Id; Wait-Process -Id $child.Id"
    );
    let mut launch = command(
        powershell.to_string_lossy().as_ref(),
        vec!["-NoProfile", "-Command", &script],
    );
    launch
        .environment
        .insert("SystemRoot".to_owned(), system_root);
    let (cancel, cancellation) = cancellation_pair();
    let mut session = LocalProcessRunner::new()
        .open(launch, cancellation)
        .await
        .assert_value();
    let child_pid = wait_for_child_pid(&pid_file).await;
    assert!(process_exists(child_pid));
    cancel.send(true).assert_value();
    let completion = timeout(Duration::from_secs(5), session.wait())
        .await
        .assert_value()
        .assert_value();
    assert_eq!(completion.cleanup, ProcessCleanupEvidence::Reaped);
    wait_for_process_exit(child_pid).await;
    let _ = fs::remove_file(pid_file);
}
