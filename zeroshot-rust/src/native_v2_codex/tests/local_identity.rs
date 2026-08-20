use super::*;

#[test]
fn local_codex_user_reuses_native_homes_without_an_openai_api_key() {
    let directory = TestDirectory::new("codex-local-user");
    let runtime_home = directory.child("runtime");
    let home = directory.child("home");
    let codex_home = directory.child("codex-home");
    let adapter = NativeV2CodexAdapter::new_for_test(NativeV2CodexConfig {
        provider: CodexProvider::OpenAi,
        executable: PathBuf::from("codex"),
        workspace: directory.path().to_owned(),
        runtime_home: runtime_home.clone(),
        local_user: Some(NativeV2CodexUser {
            home: home.clone(),
            codex_home: codex_home.clone(),
        }),
        search_path: "/usr/bin:/bin".to_owned(),
        process_pool: HostedProcessPool::new(10_002, 10_002, 20_000, 20_000).assert_value(),
    });
    let binding = binding(SessionScope::Execution, &[]);
    let environment = ResolvedEnvironment::exact(&binding, BTreeMap::new()).assert_value();
    let values = adapter
        .provider_environment(&environment, &runtime_home)
        .assert_value();

    assert_eq!(values.get("HOME").map(String::as_str), home.to_str());
    assert_eq!(
        values.get("CODEX_HOME").map(String::as_str),
        codex_home.to_str()
    );
    assert!(!values.contains_key("CODEX_API_KEY"));

    let isolated = NativeV2CodexAdapter::new(adapter.config.clone());
    assert_eq!(
        isolated.provider_environment(&environment, &runtime_home),
        Err(NodeRunnerError::Driver)
    );
}
