use std::{fs, path::Path};

use openengine_cluster_testkit::assertions::{AssertError, AssertValue};

#[cfg(unix)]
use super::session_io::PROCESS_OUTPUT_CHUNK_BYTES;
use super::{HostedProcessPool, HostedProcessScope, write_new_file};
#[cfg(unix)]
use super::{
    LocalProcessRunner, PROCESS_STDOUT_CAPACITY, ProcessCleanupEvidence, ProcessSession,
    ProcessRunnerError, ProcessSessionCommand, ProcessSessionOutput, prepare_local_private_home,
};
#[cfg(unix)]
use crate::execution::WorkspaceAccessMode;
#[cfg(unix)]
use crate::execution::driver::{DriverCancellation, WorkspaceCapability};
use crate::native_v2_candidate::test_support::TestDirectory;

#[test]
fn hosted_scopes_keep_loop_sessions_stable_and_executions_disjoint() {
    let pool = HostedProcessPool::new(10_002, 10_002, 20_000, 20_000).assert_value();
    let loop_scope = HostedProcessScope::VerifierNodeInstance(7);
    let repeated = pool.identity(loop_scope).assert_value();
    let first_execution = pool
        .identity(HostedProcessScope::VerifierExecution(7))
        .assert_value();
    let second_execution = pool
        .identity(HostedProcessScope::VerifierExecution(8))
        .assert_value();

    assert_eq!(
        pool.identity(loop_scope).assert_value().uid(),
        repeated.uid()
    );
    assert_ne!(repeated.uid(), first_execution.uid());
    assert_ne!(first_execution.uid(), second_execution.uid());
    assert_eq!(
        loop_scope.private_home(Path::new("/runtime")),
        Path::new("/runtime/verifier-node-instance-7")
    );
    assert_eq!(
        HostedProcessScope::VerifierExecution(7).private_home(Path::new("/runtime")),
        Path::new("/runtime/verifier-execution-7")
    );
    assert!(
        pool.identity(HostedProcessScope::VerifierExecution(0))
            .is_err()
    );
}

#[test]
fn active_run_slots_are_disjoint_from_source_and_each_other() {
    let host = HostedProcessPool::new(10_002, 10_002, 20_000, 20_000).assert_value();
    let first = host.active_run_slot(0, 65_536).assert_value();
    let second = host.active_run_slot(1, 65_536).assert_value();

    assert_eq!(writer_identity(host), (10_002, 10_002));
    assert_eq!(writer_identity(first), (20_000, 10_002));
    assert_eq!(writer_identity(second), (151_073, 10_002));
    assert_eq!(
        first
            .identity(HostedProcessScope::VerifierExecution(65_536))
            .assert_value()
            .uid(),
        151_072
    );
    assert!(host.active_run_slot(u32::MAX, 65_536).is_err());
    let sentinel = HostedProcessPool::new(1, 1, u32::MAX - 4, 2).assert_value();
    assert!(sentinel.active_run_slot(0, 2).is_err());
}

#[test]
fn new_file_writes_are_exclusive_and_complete() {
    let directory = TestDirectory::new("process-new-file");
    let path = directory.child("value");
    write_new_file(&path, b"complete", 0o600).assert_value();
    assert_eq!(fs::read(&path).assert_value(), b"complete");
    assert!(write_new_file(&path, b"replacement", 0o600).is_err());
    assert_eq!(fs::read(path).assert_value(), b"complete");
}

#[tokio::test]
#[cfg(unix)]
async fn natural_exit_preserves_stdout_after_the_old_drain_deadline() {
    let bytes = PROCESS_STDOUT_CAPACITY * PROCESS_OUTPUT_CHUNK_BYTES + 1;
    let (_cancel, mut process) = stdout_saturating_process(bytes).await;

    tokio::time::sleep(std::time::Duration::from_millis(1_500)).await;
    let mut received = 0;
    while let Some(chunk) = process.recv_stdout().await {
        received += chunk.as_slice().len();
    }
    let completion = tokio::time::timeout(std::time::Duration::from_secs(2), process.wait())
        .await
        .assert_value()
        .assert_value();

    assert_eq!(received, bytes);
    assert_eq!(completion.exit_code, Some(0));
    assert_eq!(completion.post_launch_error, None);
}

#[tokio::test]
#[cfg(unix)]
async fn unix_signal_exit_is_distinct_from_an_ordinary_missing_status() {
    let (_cancel, mut process) = shell_process(
        "kill -TERM $$".to_owned(),
        tokio::time::Instant::now() + std::time::Duration::from_secs(2),
    )
    .await;

    while process.recv_stdout().await.is_some() {}
    let completion = wait_for_process(&mut process).await;

    assert_eq!(completion.exit_code, None);
    assert_eq!(completion.termination_signal, Some(libc::SIGTERM));
    assert!(!completion.core_dumped);
    assert!(!completion.timed_out);
}

#[tokio::test]
#[cfg(unix)]
async fn natural_root_exit_cannot_leave_inherited_stdout_open_past_command_deadline() {
    let started = tokio::time::Instant::now();
    let (cancel, mut process) =
        inherited_stdout_process(started + std::time::Duration::from_millis(500)).await;

    let (stdout, completion) = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        let mut stdout = Vec::new();
        while let Some(chunk) = process.recv_stdout().await {
            stdout.extend_from_slice(chunk.as_slice());
        }
        (stdout, process.wait().await.assert_value())
    })
    .await
    .assert_value();
    drop(cancel);

    assert_eq!(stdout, b"root-exited\n");
    assert_eq!(completion.exit_code, Some(0));
    assert!(completion.timed_out);
    assert_eq!(completion.cleanup, ProcessCleanupEvidence::Reaped);
    assert!(
        completion
            .post_launch_error
            .as_deref()
            .is_some_and(|detail| detail.contains("process I/O drain timed out"))
    );
}

#[tokio::test]
#[cfg(unix)]
async fn cancellation_interrupts_natural_drain_after_root_exit() {
    let (cancel, mut process) = natural_drain_process().await;
    cancel.send_replace(true);

    let completion = wait_for_process(&mut process).await;

    assert!(completion.cancelled);
    assert!(completion.cleanup.proves_tree_empty());
}

#[tokio::test]
#[cfg(unix)]
async fn release_interrupts_natural_drain_after_root_exit() {
    let (_cancel, mut process) = natural_drain_process().await;

    let completion = tokio::time::timeout(std::time::Duration::from_secs(3), process.release())
        .await
        .assert_value()
        .assert_value();

    assert!(!completion.timed_out);
    assert!(completion.cleanup.proves_tree_empty());
}

#[tokio::test]
#[cfg(unix)]
async fn release_interrupts_a_saturated_stdout_drain() {
    let bytes = PROCESS_STDOUT_CAPACITY * PROCESS_OUTPUT_CHUNK_BYTES + 1;
    let (_cancel, mut process) = stdout_saturating_process(bytes).await;
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;

    tokio::time::timeout(std::time::Duration::from_secs(2), process.release())
        .await
        .assert_value()
        .assert_value();
}

#[tokio::test]
#[cfg(unix)]
async fn cancellation_interrupts_a_saturated_stdout_drain() {
    let bytes = PROCESS_STDOUT_CAPACITY * PROCESS_OUTPUT_CHUNK_BYTES + 1;
    let (cancel, mut process) = stdout_saturating_process(bytes).await;
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    cancel.send_replace(true);

    let completion = wait_for_process(&mut process).await;
    assert!(completion.cancelled);
}

#[test]
#[cfg(target_os = "linux")]
fn private_home_create_failure_retains_enoent_without_exposing_the_path() {
    let directory = TestDirectory::new("private-home-cause");
    let missing_root = directory.child("missing-parent/runtime-root");
    let error =
        prepare_local_private_home(&missing_root, HostedProcessScope::Writer).assert_error();
    let detail = launch_detail(error).assert_value();

    assert_os_detail(&detail, "provider private home create failed", libc::ENOENT);
    assert!(!detail.contains(&missing_root.to_string_lossy().into_owned()));
}

#[test]
#[cfg(target_os = "linux")]
fn private_home_followup_failures_retain_their_operation_and_os_cause() {
    let directory = TestDirectory::new("private-home-followup-causes");
    let missing = directory.child("missing-sensitive-home");
    let failures = [
        (
            "provider private home inspection failed",
            super::validate_private_directory(&missing),
        ),
        (
            "provider private home chmod failed",
            super::set_private_directory_mode(&missing),
        ),
        (
            "provider private home chown failed",
            super::set_private_directory_owner(&missing, Some((10_002, 10_002))),
        ),
    ];

    for (operation, failure) in failures {
        let detail = launch_detail(failure.assert_error()).assert_value();
        assert_os_detail(&detail, operation, libc::ENOENT);
        assert!(!detail.contains(&missing.to_string_lossy().into_owned()));
    }
}

#[tokio::test]
#[cfg(target_os = "linux")]
async fn spawn_failures_distinguish_enoent_eacces_and_e2big_without_command_values() {
    let missing_program = "/definitely/missing/zeroshot-sensitive-program";
    let missing = spawn_failure(missing_program, Vec::new()).await;
    assert_os_detail(&missing, "process spawn failed", libc::ENOENT);
    assert!(!missing.contains(missing_program));

    let directory = TestDirectory::new("process-spawn-causes");
    let denied_program = directory.child("not-executable-sensitive");
    write_new_file(&denied_program, b"#!/bin/sh\nexit 0\n", 0o600).assert_value();
    let denied = spawn_failure(&denied_program.to_string_lossy(), Vec::new()).await;
    assert_os_detail(&denied, "process spawn failed", libc::EACCES);
    assert!(!denied.contains(&denied_program.to_string_lossy().into_owned()));

    let oversized_marker = "SENSITIVE_ARG_VALUE";
    let oversized = format!("{oversized_marker}{}", "x".repeat(256 * 1024));
    let too_big = spawn_failure("/bin/true", vec![oversized]).await;
    assert_os_detail(&too_big, "process spawn failed", libc::E2BIG);
    assert!(!too_big.contains(oversized_marker));
}

#[cfg(target_os = "linux")]
async fn spawn_failure(program: &str, argv: Vec<String>) -> String {
    let (cancel, cancellation) = tokio::sync::watch::channel(false);
    let result = LocalProcessRunner::new()
        .open(
            process_command(program, argv),
            DriverCancellation::new(cancellation),
        )
        .await;
    drop(cancel);
    launch_detail(result.assert_error()).assert_value()
}

#[cfg(target_os = "linux")]
fn process_command(program: &str, argv: Vec<String>) -> ProcessSessionCommand {
    process_command_with_deadline(
        program,
        argv,
        tokio::time::Instant::now() + std::time::Duration::from_secs(2),
    )
}

#[cfg(target_os = "linux")]
fn launch_detail(error: ProcessRunnerError) -> Option<String> {
    match error {
        ProcessRunnerError::Launch(detail) => Some(detail),
        ProcessRunnerError::InvalidCommand(_) | ProcessRunnerError::Io(_) => None,
    }
}

#[cfg(target_os = "linux")]
fn assert_os_detail(detail: &str, operation: &str, raw_os_error: i32) {
    assert!(detail.starts_with(operation));
    assert!(detail.contains("kind="));
    assert!(detail.contains(&format!("raw_os_error={raw_os_error}")));
    assert!(detail.contains("message="));
}

#[cfg(unix)]
async fn stdout_saturating_process(
    bytes: usize,
) -> (tokio::sync::watch::Sender<bool>, ProcessSession) {
    shell_process(
        format!("/usr/bin/head -c {bytes} /dev/zero"),
        tokio::time::Instant::now() + std::time::Duration::from_secs(15),
    )
    .await
}

#[cfg(unix)]
async fn shell_process(
    script: String,
    deadline: tokio::time::Instant,
) -> (tokio::sync::watch::Sender<bool>, ProcessSession) {
    let (cancel, cancellation) = tokio::sync::watch::channel(false);
    let process = LocalProcessRunner::new()
        .open(
            process_command_with_deadline("/bin/sh", vec!["-c".to_owned(), script], deadline),
            DriverCancellation::new(cancellation),
        )
        .await
        .assert_value();
    (cancel, process)
}

#[cfg(unix)]
async fn inherited_stdout_process(
    deadline: tokio::time::Instant,
) -> (tokio::sync::watch::Sender<bool>, ProcessSession) {
    shell_process(
        "trap '' HUP; sleep 30 & printf 'root-exited\\n'".to_owned(),
        deadline,
    )
    .await
}

#[cfg(unix)]
async fn natural_drain_process() -> (tokio::sync::watch::Sender<bool>, ProcessSession) {
    let (cancel, mut process) =
        inherited_stdout_process(tokio::time::Instant::now() + std::time::Duration::from_secs(30))
            .await;
    assert_eq!(receive_root_output(&mut process).await, b"root-exited\n");
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    (cancel, process)
}

#[cfg(unix)]
async fn receive_root_output(process: &mut ProcessSession) -> Vec<u8> {
    tokio::time::timeout(std::time::Duration::from_secs(2), process.recv_stdout())
        .await
        .assert_value()
        .assert_value()
        .into_inner()
}

#[cfg(unix)]
async fn wait_for_process(process: &mut ProcessSession) -> ProcessSessionOutput {
    tokio::time::timeout(std::time::Duration::from_secs(3), process.wait())
        .await
        .assert_value()
        .assert_value()
}

#[cfg(unix)]
fn process_command_with_deadline(
    program: &str,
    argv: Vec<String>,
    deadline: tokio::time::Instant,
) -> ProcessSessionCommand {
    ProcessSessionCommand {
        program: program.to_owned(),
        argv,
        environment: std::collections::BTreeMap::new(),
        workspace: WorkspaceCapability {
            current_dir: std::env::current_dir().assert_value(),
            mode: WorkspaceAccessMode::ReadOnly,
        },
        deadline,
    }
}

fn writer_identity(pool: HostedProcessPool) -> (u32, u32) {
    let identity = pool.identity(HostedProcessScope::Writer).assert_value();
    (identity.uid(), identity.gid())
}
