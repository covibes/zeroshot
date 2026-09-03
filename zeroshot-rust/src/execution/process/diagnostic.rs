use std::io;

use tokio::task::JoinError;

pub(crate) fn io_error_detail(operation: &'static str, error: &io::Error) -> String {
    let raw_os_error = error
        .raw_os_error()
        .map_or_else(|| "none".to_owned(), |code| code.to_string());
    let message = sanitize_message(&error.to_string());
    format!(
        "{operation}: kind={:?}, raw_os_error={raw_os_error}, message={message}",
        error.kind()
    )
}

pub(super) fn task_join_detail(operation: &'static str, error: &JoinError) -> String {
    let cause = if error.is_panic() {
        "task panicked"
    } else if error.is_cancelled() {
        "task was cancelled"
    } else {
        "task failed"
    };
    format!("{operation}: {cause}")
}

fn sanitize_message(message: &str) -> String {
    message
        .chars()
        .map(|character| {
            if character.is_control() {
                ' '
            } else {
                character
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use openengine_cluster_testkit::assertions::AssertError;

    use super::*;

    #[test]
    fn io_detail_preserves_structured_cause_and_sanitizes_controls() {
        let error = io::Error::new(io::ErrorKind::PermissionDenied, "denied\nsecret-path");

        let detail = io_error_detail("stdout read failed", &error);

        assert_eq!(
            detail,
            "stdout read failed: kind=PermissionDenied, raw_os_error=none, message=denied secret-path"
        );
    }

    #[tokio::test]
    async fn join_detail_classifies_panics_without_exposing_the_payload() {
        let joined = tokio::spawn(async {
            assert!(std::hint::black_box(false), "sensitive panic payload");
        })
        .await
        .assert_error();

        let detail = task_join_detail("stderr task failed", &joined);

        assert_eq!(detail, "stderr task failed: task panicked");
        assert!(!detail.contains("sensitive"));
    }
}
