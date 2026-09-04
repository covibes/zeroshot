use std::collections::BTreeMap;
use std::path::Path;

use openengine_cluster_testkit::assertions::AssertValue;

use super::super::ClaudeProcessEnvironment;

#[test]
fn base_environment_is_explicit_non_secret_and_allows_large_values() {
    assert!(ClaudeProcessEnvironment::new(BTreeMap::new()).is_ok());
    assert!(
        ClaudeProcessEnvironment::new(BTreeMap::from([(
            "OPENAI_API_KEY".to_owned(),
            "not-allowed".to_owned(),
        )]))
        .is_err()
    );
    let long_locale = "x".repeat(20 * 1024);
    let environment =
        ClaudeProcessEnvironment::new(BTreeMap::from([("LANG".to_owned(), long_locale.clone())]))
            .assert_value();
    assert_eq!(
        environment.clone_values().get("LANG").map(String::as_str),
        Some(long_locale.as_str())
    );
    assert!(
        ClaudeProcessEnvironment::new(BTreeMap::from([(
            "LANG".to_owned(),
            "invalid\0value".to_owned(),
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
