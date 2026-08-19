use super::*;

#[test]
fn command_is_exact_and_rejects_adapter_owned_collisions() {
    let declared = binding(SessionScope::Execution, &["DECLARED"]);
    let resolved = ResolvedEnvironment::exact(
        &declared,
        BTreeMap::from([(
            EnvironmentVariableName::new("DECLARED").assert_value(),
            "resolved-value".to_owned(),
        )]),
    )
    .assert_value();
    let environment = process_environment(
        &resolved,
        "/private/runtime".to_owned(),
        "/private/runtime".to_owned(),
        "/usr/bin:/bin".to_owned(),
    )
    .assert_value();
    assert_eq!(
        environment,
        BTreeMap::from([
            ("CODEX_HOME".to_owned(), "/private/runtime".to_owned()),
            ("DECLARED".to_owned(), "resolved-value".to_owned()),
            ("HOME".to_owned(), "/private/runtime".to_owned()),
            ("PATH".to_owned(), "/usr/bin:/bin".to_owned()),
        ])
    );

    let binding = binding(SessionScope::Execution, &["CODEX_HOME"]);
    let environment = ResolvedEnvironment::exact(
        &binding,
        BTreeMap::from([(
            EnvironmentVariableName::new("CODEX_HOME").assert_value(),
            "node-owned".to_owned(),
        )]),
    )
    .assert_value();
    assert_eq!(
        process_environment(
            &environment,
            "adapter-owned".to_owned(),
            "adapter-owned".to_owned(),
            "/usr/bin:/bin".to_owned()
        ),
        Err(NodeRunnerError::Driver)
    );
}

#[test]
fn log_redactions_are_longest_first_and_do_not_leave_overlapping_suffixes() {
    let binding = binding(SessionScope::Execution, &["LONG_SECRET", "SHORT_SECRET"]);
    let environment = ResolvedEnvironment::exact(
        &binding,
        BTreeMap::from([
            (
                EnvironmentVariableName::new("LONG_SECRET").assert_value(),
                "secret-tail".to_owned(),
            ),
            (
                EnvironmentVariableName::new("SHORT_SECRET").assert_value(),
                "secret".to_owned(),
            ),
        ]),
    )
    .assert_value();
    let redactions = redaction_values(environment.iter().map(|(_, value)| value));
    assert_eq!(redactions, vec!["secret-tail", "secret"]);
    assert_eq!(
        redact_text("value=secret-tail", &redactions),
        "value=[REDACTED]"
    );
}
