use super::*;
use crate::native_v2_runner::ResolvedEnvironment;

#[test]
fn local_claude_user_reuses_home_without_moving_session_state() {
    let directory = TestDirectory::new("claude-local-user");
    let runtime_home = directory.child("runtime");
    let local_home = directory.child("home");
    let adapter = ClaudeAdapter::new_for_test(ClaudeAdapterConfig {
        provider: ClaudeProvider::Anthropic,
        executable: "claude".to_owned(),
        prefix_arguments: Vec::new(),
        workspace: directory.path().to_owned(),
        runtime_home,
        local_user_home: Some(local_home.clone()),
        base_environment: ClaudeProcessEnvironment::new(BTreeMap::from([(
            "PATH".to_owned(),
            "/usr/bin:/bin".to_owned(),
        )]))
        .assert_value(),
        turn_timeout: Duration::from_secs(1),
        process_pool: HostedProcessPool::new(10_002, 10_002, 20_000, 20_000).assert_value(),
    })
    .assert_value();
    let binding = agent_binding(
        "claude-sonnet-5",
        Some(ReasoningEffort::Max),
        SessionScope::Execution,
        &[],
    );
    let environment = ResolvedEnvironment::exact(&binding, BTreeMap::new()).assert_value();
    let values = adapter
        .process_environment(&environment, Path::new("/private/session"))
        .assert_value();

    assert_eq!(values.get("HOME").map(String::as_str), local_home.to_str());
}
