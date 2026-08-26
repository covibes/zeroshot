use super::*;

#[test]
fn supported_models_and_efforts_match_the_admission_catalog() {
    assert!(validate_model_effort("claude-haiku-4-5", None).is_ok());
    assert!(validate_model_effort("claude-haiku-4-5", Some(ReasoningEffort::Max)).is_err());
    for model in ["claude-sonnet-5", "claude-opus-5", "claude-fable-5"] {
        for effort in [
            ReasoningEffort::Low,
            ReasoningEffort::Medium,
            ReasoningEffort::High,
            ReasoningEffort::Xhigh,
            ReasoningEffort::Max,
        ] {
            assert!(validate_model_effort(model, Some(effort)).is_ok());
        }
        assert!(validate_model_effort(model, None).is_err());
    }
}

#[test]
fn base_environment_is_explicit_bounded_and_non_secret_by_name() {
    assert!(ClaudeProcessEnvironment::new(BTreeMap::new()).is_ok());
    assert!(
        ClaudeProcessEnvironment::new(BTreeMap::from([(
            "OPENAI_API_KEY".to_owned(),
            "not-allowed".to_owned(),
        )]))
        .is_err()
    );
}

#[test]
fn capsule_environment_roots_home_defaults_path_and_preserves_minimal_values() {
    let base = ClaudeProcessEnvironment::new(BTreeMap::from([
        ("HOME".to_owned(), "/host/home".to_owned()),
        ("LANG".to_owned(), "C.UTF-8".to_owned()),
    ]))
    .assert_value();
    let derived = base
        .for_capsule(Path::new("/capsule/runtime"), "/configured/bin")
        .assert_value();
    assert_eq!(
        derived.clone_values(),
        BTreeMap::from([
            ("HOME".to_owned(), "/capsule/runtime".to_owned()),
            ("LANG".to_owned(), "C.UTF-8".to_owned()),
            ("PATH".to_owned(), "/configured/bin".to_owned()),
        ])
    );

    let explicit_path = ClaudeProcessEnvironment::new(BTreeMap::from([(
        "PATH".to_owned(),
        "/explicit/bin".to_owned(),
    )]))
    .assert_value();
    assert_eq!(
        explicit_path
            .for_capsule(Path::new("/next/runtime"), "/configured/bin")
            .assert_value()
            .clone_values(),
        BTreeMap::from([
            ("HOME".to_owned(), "/next/runtime".to_owned()),
            ("PATH".to_owned(), "/explicit/bin".to_owned()),
        ])
    );
}
