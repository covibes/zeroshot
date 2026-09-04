use super::*;

const LARGE_PROMPT_SCRIPT_PREFIX: &str = r#"#!/bin/sh
set -eu
/usr/bin/head -c 5242880 /dev/zero | /usr/bin/tr '\000' x
/usr/bin/printf '\n'
/usr/bin/wc -c <&0 > "$CAPTURE_PATH"
/usr/bin/printf '%s\n' '{"type":"thread.started","thread_id":"large-prompt-thread"}'
"#;

#[tokio::test]
async fn stdout_is_drained_while_a_multiframe_prompt_is_delivered_in_full() {
    let directory = TestDirectory::new("codex-large-prompt");
    let capture = directory.child("prompt-size");
    let script = script_with_success(LARGE_PROMPT_SCRIPT_PREFIX);
    let adapter = scripted_adapter_with(
        &directory,
        CodexProvider::OpenAi,
        "codex-large-prompt-script",
        &script,
    );
    let admitted = admitted(
        binding(SessionScope::Execution, &["CAPTURE_PATH", "OPENAI_API_KEY"]),
        CodexProvider::OpenAi,
    )
    .await;
    let runtime = runner(&admitted, adapter);
    let values = [
        ("CAPTURE_PATH", capture.display().to_string()),
        ("OPENAI_API_KEY", "fake-openai-key".to_owned()),
    ];
    let mut large_request = request(&admitted, 1, &values);
    large_request.invocation.input = json!({"task": "x".repeat(8 * 1024 * 1024)});
    let handle = runtime.start(large_request).await.assert_value();

    complete_verified_with_logs(handle).await;
    let delivered = fs::read_to_string(capture)
        .assert_value()
        .trim()
        .parse::<usize>()
        .assert_value();
    assert!(delivered > 8 * 1024 * 1024);
}
