use std::path::{Path, PathBuf};
use std::time::Duration;

use super::*;

#[tokio::test]
async fn cancellation_waits_for_contained_child_cleanup() {
    let directory = TestDirectory::new("codex-cancel");
    let capture = directory.child("capture");
    let pid_path = directory.child("pid");
    let (admitted, runtime) = openai_runtime(
        &directory,
        SessionScope::Execution,
        &["CAPTURE_PATH", "CODEX_API_KEY", "PID_PATH", "SLOW_RUN"],
    )
    .await;
    let mut handle = start(
        &runtime,
        &admitted,
        1,
        &[
            ("CAPTURE_PATH", capture.display().to_string()),
            ("CODEX_API_KEY", "fake-openai-key".to_owned()),
            ("PID_PATH", pid_path.display().to_string()),
            ("SLOW_RUN", "true".to_owned()),
        ],
    )
    .await;
    let mut attach = handle.take_initial_output().assert_value();
    assert_eq!(
        attach.recv_output().await.assert_value().text,
        "Codex turn started"
    );
    assert_eq!(
        attach.recv_output().await.assert_value().text,
        r#"{"response":{"answer":42}}"#
    );
    let pid = wait_for_pid(&pid_path).await;
    handle.cancel();
    assert_eq!(handle.completion().await, Err(NodeRunnerError::Cancelled));
    assert!(
        !process_is_live(pid),
        "provider child remained alive after completion"
    );
}

async fn wait_for_pid(path: &Path) -> u32 {
    for _ in 0..100 {
        if let Ok(value) = fs::read_to_string(path) {
            if let Ok(pid) = value.trim().parse() {
                return pid;
            }
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    None::<u32>.assert_value_with("script did not publish its pid")
}

fn process_is_live(pid: u32) -> bool {
    PathBuf::from(format!("/proc/{pid}")).exists()
}
