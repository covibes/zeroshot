use super::*;

const LARGE_OUTPUT_SCRIPT: &str = r#"#!/bin/sh
set -eu
/usr/bin/cat > /dev/null
/usr/bin/printf '%s\n' '{"type":"thread.started","thread_id":"large-output-thread"}'
index=0
while [ "$index" -lt 9 ]; do
  /usr/bin/printf '%s' '{"type":"item.completed","item":{"type":"padding","payload":"'
  /usr/bin/head -c 1048576 /dev/zero | /usr/bin/tr '\000' x
  /usr/bin/printf '%s\n' '"}}'
  index=$((index + 1))
done
/usr/bin/printf '%s\n' '{"type":"error","message":"temporary transport retry"}'
/usr/bin/printf '%s%s\n' \
  '{"type":"item.completed","item":{"type":"command_execution","command":"scan",' \
  '"aggregated_output":"before\u0000after","exit_code":0,"status":"completed"}}'
/usr/bin/printf '%s%s\n' \
  '{"type":"item.completed","item":{"type":"agent_message",' \
  '"text":"{\"response\":{\"answer\":42}}"}}'
/usr/bin/printf '%s\n' '{"type":"turn.completed","usage":{"input_tokens":5,"output_tokens":7}}'
/usr/bin/printf '%s\n' 'trailing output is not JSON'
/usr/bin/printf '%s%s\n' \
  '{"type":"item.completed","item":{"type":"agent_message",' \
  '"text":"{\"response\":{\"answer\":999}}"}}'
/usr/bin/printf '%s\n' '{"type":"turn.failed","error":{"message":"trailing failure"}}'
"#;

#[tokio::test]
async fn large_output_provisional_error_and_nul_log_complete_successfully() {
    let directory = TestDirectory::new("codex-large-output");
    let adapter = scripted_adapter_with(
        &directory,
        CodexProvider::OpenAi,
        "codex-large-output-script",
        LARGE_OUTPUT_SCRIPT,
    );
    let admitted = admitted(
        binding(SessionScope::Execution, &["OPENAI_API_KEY"]),
        CodexProvider::OpenAi,
    )
    .await;
    let runtime = runner(&admitted, adapter);
    let handle = start(
        &runtime,
        &admitted,
        1,
        &[("OPENAI_API_KEY", "fake-openai-key".to_owned())],
    )
    .await;
    let rendered = complete_verified_with_logs(handle).await;
    assert_eq!(
        rendered
            .matches("Codex activity completed: padding")
            .count(),
        9
    );
    assert!(rendered.contains("Codex stream error"));
    assert!(rendered.contains("Codex command completed: scan [completed] exit=0\nbefore�after"));
    assert!(!rendered.contains('\0'));
    assert!(!rendered.contains("999"));
    assert!(!rendered.contains("trailing failure"));
}
