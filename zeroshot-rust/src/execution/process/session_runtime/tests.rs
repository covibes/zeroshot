use std::io;

use super::*;

#[test]
fn child_wait_failure_retains_the_io_cause() {
    let mut state = SessionState::default();

    state.record_wait(Err(io::Error::new(
        io::ErrorKind::PermissionDenied,
        "injected child wait cause",
    )));

    assert_eq!(state.errors.len(), 1);
    let detail = state.errors.first().map_or("", String::as_str);
    assert!(detail.starts_with("process child wait failed"));
    assert!(detail.contains("kind=PermissionDenied"));
    assert!(detail.contains("message=injected child wait cause"));
}

#[tokio::test]
async fn io_task_panic_is_classified_without_exposing_its_payload() {
    let mut task = Some(tokio::spawn(async {
        assert!(std::hint::black_box(false), "sensitive panic payload");
    }));
    let mut errors = Vec::new();

    let timed_out = drain_io_task(
        &mut task,
        Instant::now() + Duration::from_secs(1),
        "process stdout task failed",
        &mut errors,
    )
    .await;

    assert!(!timed_out);
    assert_eq!(errors, ["process stdout task failed: task panicked"]);
    assert!(!errors.join(" ").contains("sensitive"));
}

#[tokio::test]
async fn io_task_cancellation_is_preserved_as_the_join_cause() {
    let handle = tokio::spawn(std::future::pending::<()>());
    handle.abort();
    let mut task = Some(handle);
    let mut errors = Vec::new();

    let timed_out = drain_io_task(
        &mut task,
        Instant::now() + Duration::from_secs(1),
        "process stderr task failed",
        &mut errors,
    )
    .await;

    assert!(!timed_out);
    assert_eq!(errors, ["process stderr task failed: task was cancelled"]);
}
