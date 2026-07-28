use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use tokio::sync::watch;
use tokio::time::{Duration, Instant};
use zeroshot_engine::execution::driver::{DriverCancellation, WorkspaceCapability};
use zeroshot_engine::execution::process::{
    LocalProcessRunner, ProcessCleanupEvidence, ProcessCommand, ProcessInput,
    ProcessLaunchEvidence, ProcessRunnerError, MAX_PROCESS_ARGV_BYTES, MAX_PROCESS_ARGV_ITEMS,
    MAX_PROCESS_DIAGNOSTIC_BYTES, MAX_PROCESS_ENV_BYTES, MAX_PROCESS_ENV_ITEMS,
    MAX_PROCESS_STDIN_BYTES,
};
use zeroshot_engine::execution::WorkspaceAccessMode;

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

fn cancellation_pair() -> (watch::Sender<bool>, DriverCancellation) {
    let (sender, receiver) = watch::channel(false);
    (sender, DriverCancellation::new(receiver))
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

fn unique_temp_path(name: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    std::env::temp_dir().join(format!("{name}-{nanos}"))
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

async fn wait_for_child_pid(path: &PathBuf) -> i32 {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if let Ok(contents) = fs::read_to_string(path) {
            if let Ok(pid) = contents.trim().parse::<i32>() {
                return pid;
            }
        }
        assert!(Instant::now() < deadline, "child pid file was not written");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

async fn wait_for_process_exit(pid: i32) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while process_exists(pid) {
        assert!(Instant::now() < deadline, "process {pid} did not exit");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

#[cfg(unix)]
fn process_exists(pid: i32) -> bool {
    unsafe {
        if libc::kill(pid, 0) == 0 {
            true
        } else {
            std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
        }
    }
}
