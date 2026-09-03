use super::*;

#[tokio::test]
async fn cancellation_wins_after_durable_output_closes_and_reaps_the_process() {
    let workspace = TestDirectory::new("claude-closed-durable-cancellation");
    workspace.write(
        "fake-claude.sh",
        r#"
set -eu
cat >/dev/null
(sleep 30; printf survived > survivor.txt) &
printf '%s' "$!" > child.pid
while [ ! -e emit-output ]; do sleep 0.01; done
printf '%s%s\n' \
  '{"type":"stream_event","event":{"type":"content_block_delta",' \
  '"delta":{"type":"text_delta","text":"started"}}}'
: > output-emitted
wait
"#,
    );
    let mut handle = start_anthropic(&workspace, "claude-haiku-4-5", None).await;
    drop(handle.take_initial_output().assert_value());
    let child_pid = wait_for_child_pid(&workspace).await;
    workspace.write("emit-output", "go");
    let _ = wait_for_file(&workspace, "output-emitted").await;
    cancel_and_assert_reaped(handle, &workspace, child_pid).await;
}

async fn wait_for_child_pid(workspace: &TestDirectory) -> u32 {
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            if workspace.child("child.pid").exists() {
                if let Ok(pid) = workspace.read("child.pid").trim().parse() {
                    return pid;
                }
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .assert_value()
}

async fn wait_for_file(workspace: &TestDirectory, name: &str) -> String {
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            if workspace.child(name).exists() {
                return workspace.read(name);
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .assert_value()
}
