use openengine_cluster_testkit::assertions::{AssertError, AssertValue};
use serde_json::json;

use super::*;

#[test]
fn version_reports_the_packaged_binary_version_without_a_backend() {
    let mut output = Vec::new();
    let outcome = try_execute_native_v2_static(&NativeV2CliCommand::Version, &mut output)
        .assert_value()
        .assert_value();
    assert_eq!(outcome, CliOutcome::Completed);
    assert_eq!(String::from_utf8(output).assert_value(), VERSION);
}

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
