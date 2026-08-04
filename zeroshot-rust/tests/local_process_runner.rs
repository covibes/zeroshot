use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;
#[cfg(target_os = "linux")]
use std::fs::OpenOptions;
#[cfg(target_os = "linux")]
use std::os::fd::AsRawFd;

use tokio::time::{Duration, Instant};
use zeroshot_engine::execution::driver::WorkspaceCapability;
use zeroshot_engine::execution::process::{
    LocalProcessRunner, ProcessCleanupEvidence, ProcessCommand, ProcessInput,
    ProcessLaunchEvidence, ProcessRunnerError, MAX_PROCESS_ARGV_BYTES, MAX_PROCESS_ARGV_ITEMS,
    MAX_PROCESS_DIAGNOSTIC_BYTES, MAX_PROCESS_ENV_BYTES, MAX_PROCESS_ENV_ITEMS,
    MAX_PROCESS_STDIN_BYTES,
};
use zeroshot_engine::execution::WorkspaceAccessMode;
#[path = "support/process_runner.rs"]
mod process_runner_support;
use process_runner_support::{
    cancellation_pair, process_exists, shell_quote, unique_temp_path, wait_for_child_pid,
    wait_for_process_exit,
};

fn command(program: &str, argv: Vec<&str>) -> ProcessCommand {
    ProcessCommand {
        program: program.to_owned(),
        argv: argv.into_iter().map(str::to_owned).collect(),
        environment: BTreeMap::new(),
        workspace: WorkspaceCapability {
            current_dir: PathBuf::from("/tmp"),
            mode: WorkspaceAccessMode::Exclusive,
        },
        stdin: ProcessInput::empty(),
        deadline: Instant::now() + Duration::from_secs(5),
    }
}

#[tokio::test]
async fn executes_with_typed_argv_without_a_shell() {
    let (_cancel_tx, cancellation) = cancellation_pair();
    let output = LocalProcessRunner::new()
        .run(
            command("/usr/bin/printf", vec!["%s", "literal;rm -rf never"]),
            cancellation,
        )
        .await
        .unwrap();
    assert_eq!(
        output.launch_evidence,
        ProcessLaunchEvidence::MayHaveStarted
    );
    assert_eq!(
        String::from_utf8(output.stdout).unwrap(),
        "literal;rm -rf never"
    );
    assert_eq!(output.cleanup, ProcessCleanupEvidence::NotRequired);
    assert_eq!(output.post_launch_error, None);
}

#[tokio::test]
async fn rejects_argv_and_environment_bounds_and_prestart_failures() {
    let mut too_many_args = command("/usr/bin/printf", vec!["ok"]);
    too_many_args.argv = (0..=MAX_PROCESS_ARGV_ITEMS)
        .map(|index| format!("arg-{index}"))
        .collect();
    let (_cancel_tx, cancellation) = cancellation_pair();
    assert!(matches!(
        LocalProcessRunner::new()
            .run(too_many_args, cancellation)
            .await,
        Err(ProcessRunnerError::InvalidCommand(_))
    ));

    let mut too_many_env = command("/usr/bin/printf", vec!["ok"]);
    too_many_env.environment = (0..=MAX_PROCESS_ENV_ITEMS)
        .map(|index| (format!("KEY_{index}"), "value".to_owned()))
        .collect();
    let (_cancel_tx, cancellation) = cancellation_pair();
    assert!(matches!(
        LocalProcessRunner::new()
            .run(too_many_env, cancellation)
            .await,
        Err(ProcessRunnerError::InvalidCommand(_))
    ));

    let mut oversized_argv = command("p", vec![]);
    oversized_argv.argv = vec!["a".repeat(255); MAX_PROCESS_ARGV_ITEMS];
    let (_cancel_tx, cancellation) = cancellation_pair();
    let error = LocalProcessRunner::new()
        .run(oversized_argv, cancellation)
        .await
        .unwrap_err();
    assert!(matches!(
        error,
        ProcessRunnerError::InvalidCommand(message)
            if message.contains(&MAX_PROCESS_ARGV_BYTES.to_string())
    ));

    let mut oversized_env = command("/usr/bin/printf", vec!["ok"]);
    oversized_env.environment = (0..MAX_PROCESS_ENV_ITEMS)
        .map(|index| (format!("K{index:03}"), "v".repeat(251)))
        .collect();
    let (_cancel_tx, cancellation) = cancellation_pair();
    let error = LocalProcessRunner::new()
        .run(oversized_env, cancellation)
        .await
        .unwrap_err();
    assert!(matches!(
        error,
        ProcessRunnerError::InvalidCommand(message)
            if message.contains(&MAX_PROCESS_ENV_BYTES.to_string())
    ));

    let (_cancel_tx, cancellation) = cancellation_pair();
    assert!(matches!(
        ProcessInput::new(vec![b'x'; MAX_PROCESS_STDIN_BYTES + 1]),
        Err(ProcessRunnerError::InvalidCommand(_))
    ));
    let output = LocalProcessRunner::new()
        .run(command("/usr/bin/printf", vec!["ok"]), cancellation)
        .await
        .unwrap();
    assert_eq!(String::from_utf8(output.stdout).unwrap(), "ok");

    let (_cancel_tx, cancellation) = cancellation_pair();
    assert!(matches!(
        LocalProcessRunner::new()
            .run(command("/definitely/missing", vec!["x"]), cancellation)
            .await,
        Err(ProcessRunnerError::Launch(_))
    ));
}

#[tokio::test]
async fn cancellation_and_deadline_return_cleanup_evidence_and_reap_descendants() {
    let pid_file = unique_temp_path("zeroshot-local-process-runner-child.pid");
    let script = format!(
        "sleep 30 & child=$!; printf %s \"$child\" > {}; wait",
        shell_quote(pid_file.to_string_lossy().as_ref())
    );
    let (cancel_tx, cancellation) = cancellation_pair();
    let runner = LocalProcessRunner::new();
    let handle = tokio::spawn(async move {
        runner
            .run(command("/bin/sh", vec!["-c", &script]), cancellation)
            .await
            .unwrap()
    });
    let child_pid = wait_for_child_pid(&pid_file).await;
    assert!(process_exists(child_pid));
    cancel_tx.send(true).unwrap();
    let output = handle.await.unwrap();
    assert!(output.cancelled);
    assert_eq!(output.cleanup, ProcessCleanupEvidence::Reaped);
    assert_eq!(
        output.launch_evidence,
        ProcessLaunchEvidence::MayHaveStarted
    );
    wait_for_process_exit(child_pid).await;
    assert!(
        !process_exists(child_pid),
        "descendant pid {child_pid} survived cancellation"
    );
    let _ = fs::remove_file(pid_file);

    let (_cancel_tx, cancellation) = cancellation_pair();
    let mut timed = command("/bin/sleep", vec!["10"]);
    timed.deadline = Instant::now() + Duration::from_millis(50);
    let output = LocalProcessRunner::new()
        .run(timed, cancellation)
        .await
        .unwrap();
    assert!(output.timed_out);
    assert_eq!(output.cleanup, ProcessCleanupEvidence::Reaped);
}

#[tokio::test]
async fn closed_stdio_does_not_release_a_live_child_before_deadline() {
    let pid_file = unique_temp_path("zeroshot-local-process-closed-stdio.pid");
    let script = format!(
        "printf %s $$ > {}; exec 0<&- 1>&- 2>&-; exec /bin/sleep 30",
        shell_quote(pid_file.to_string_lossy().as_ref())
    );
    let (_cancel_tx, cancellation) = cancellation_pair();
    let mut timed = command("/bin/sh", vec!["-c", &script]);
    timed.deadline = Instant::now() + Duration::from_millis(150);
    let handle = tokio::spawn(async move {
        LocalProcessRunner::new()
            .run(timed, cancellation)
            .await
            .unwrap()
    });
    let child_pid = wait_for_child_pid(&pid_file).await;
    let output = tokio::time::timeout(Duration::from_secs(2), handle)
        .await
        .expect("closed stdio must not bypass the deadline")
        .unwrap();
    assert!(output.timed_out);
    assert_eq!(output.cleanup, ProcessCleanupEvidence::Reaped);
    wait_for_process_exit(child_pid).await;
    let _ = fs::remove_file(pid_file);
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn hosted_uid_boundary_reaps_setsid_double_fork_and_closes_control_descriptors() {
    if unsafe { libc::geteuid() } != 0 {
        return;
    }

    let pid_file = unique_temp_path("zeroshot-hosted-detached.pid");
    let control_file_path = unique_temp_path("zeroshot-hosted-control");
    let control_file = OpenOptions::new()
        .create_new(true)
        .read(true)
        .write(true)
        .open(&control_file_path)
        .expect("open inherited control descriptor fixture");
    let control_fd = control_file.as_raw_fd();
    assert_eq!(unsafe { libc::fcntl(control_fd, libc::F_SETFD, 0) }, 0);

    let detached = format!(
        "/bin/sleep 30 & daemon=$!; /usr/bin/printf %s \"$daemon\" > {}; exit 0",
        shell_quote(pid_file.to_string_lossy().as_ref())
    );
    let script = format!(
        "/usr/bin/setsid /bin/sh -c {} </dev/null >/dev/null 2>&1 & \
         while [ ! -s {} ]; do /bin/sleep 0.01; done; \
         uid=$(/usr/bin/id -u); gid=$(/usr/bin/id -g); \
         if /bin/kill -0 {} 2>/dev/null; then signal=allowed; else signal=blocked; fi; \
         if [ -e /proc/self/fd/{control_fd} ]; then control=open; else control=closed; fi; \
         /usr/bin/printf '%s:%s:%s:%s' \"$uid\" \"$gid\" \"$signal\" \"$control\"",
        shell_quote(&detached),
        shell_quote(pid_file.to_string_lossy().as_ref()),
        std::process::id(),
    );
    let (_cancel_tx, cancellation) = cancellation_pair();
    let output = LocalProcessRunner::hosted_worker()
        .expect("Linux hosted containment is available")
        .run(command("/bin/sh", vec!["-c", &script]), cancellation)
        .await
        .expect("run isolated daemon fixture");

    let daemon_pid = fs::read_to_string(&pid_file)
        .expect("detached daemon recorded its pid")
        .trim()
        .parse::<i32>()
        .expect("detached daemon pid is decimal");
    assert_eq!(output.cleanup, ProcessCleanupEvidence::Reaped);
    assert!(output.cleanup.proves_tree_empty());
    assert_eq!(
        String::from_utf8(output.stdout).expect("fixture output is utf-8"),
        "10002:10002:blocked:closed"
    );
    assert!(
        !process_exists(daemon_pid),
        "setsid double-fork daemon {daemon_pid} survived successful cleanup"
    );

    drop(control_file);
    let _ = fs::remove_file(pid_file);
    let _ = fs::remove_file(control_file_path);
}

#[tokio::test]
async fn diagnostics_are_bounded() {
    let (_cancel_tx, cancellation) = cancellation_pair();
    let output = LocalProcessRunner::new()
        .run(
            command(
                "/bin/sh",
                vec![
                    "-c",
                    "i=0; while [ \"$i\" -lt 66000 ]; do printf x 1>&2; i=$((i+1)); done",
                ],
            ),
            cancellation,
        )
        .await;
    let output = output.unwrap();
    assert_eq!(
        output.launch_evidence,
        ProcessLaunchEvidence::MayHaveStarted
    );
    assert_eq!(output.cleanup, ProcessCleanupEvidence::Reaped);
    let error = output.post_launch_error.unwrap();
    assert!(error.contains(&MAX_PROCESS_DIAGNOSTIC_BYTES.to_string()));
}
