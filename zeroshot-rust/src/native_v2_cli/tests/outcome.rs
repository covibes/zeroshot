use openengine_cluster_testkit::assertions::{AssertError, AssertValue};
use serde_json::json;

use super::*;

#[tokio::test]
async fn foreground_run_reports_a_terminal_failure_after_printing_it() {
    let files = FixtureFiles::new(graph(), json!({"task":"fail"}));
    let command = parse_native_v2_args(run_args(&files.graph, &files.input, &files.runtime, &[]))
        .assert_value();
    let backend = FakeBackend::with_failed_watch();
    let mut output = Vec::new();
    let error = execute_native_v2_cli(command, &backend, &mut NeverDetach, &mut output)
        .await
        .assert_error();
    assert!(matches!(error, NativeV2CliError::RunFailed));
    assert!(
        String::from_utf8(output)
            .assert_value()
            .contains("\"reason\":\"worker_failed\"")
    );
}
