//! Precedence, default, and malformed-value coverage for native settings resolution.

use std::collections::BTreeMap;

use zeroshot_engine::native_settings::profile::{Profile, ProfileRegistry};
use zeroshot_engine::native_settings::resolve::{parse_env_settings, resolve, CliOverride};
use zeroshot_engine::native_settings::{
    NativeSettingsSchema, NativeSettingsSchemaSpec, ProfileId, ProviderSettingsId,
    ProviderSettingsRef,
};

fn provider_ref(id: &str, version: u32) -> ProviderSettingsRef {
    ProviderSettingsRef::new(ProviderSettingsId::new(id).unwrap(), version).unwrap()
}

fn schema_with_provider(id: &str, version: u32) -> NativeSettingsSchema {
    NativeSettingsSchema::new(NativeSettingsSchemaSpec {
        provider: Some(provider_ref(id, version)),
        ..NativeSettingsSchemaSpec::default()
    })
    .unwrap()
}

fn empty_cli() -> CliOverride {
    CliOverride::new(None, NativeSettingsSchema::default())
}

fn empty_env() -> BTreeMap<String, String> {
    BTreeMap::new()
}

fn empty_profiles() -> ProfileRegistry {
    ProfileRegistry::new(Vec::new()).unwrap()
}

#[test]
fn default_only_resolution_returns_the_product_default_unchanged() {
    let product_default = schema_with_provider("claude", 1);
    let resolved = resolve(
        &empty_cli(),
        &empty_env(),
        &empty_profiles(),
        &product_default,
    )
    .expect("resolution with no overrides must succeed");
    assert_eq!(resolved, product_default);
}

#[test]
fn profile_overrides_the_product_default() {
    let product_default = schema_with_provider("claude", 1);
    let profile_settings = schema_with_provider("codex", 2);
    let profile_id = ProfileId::new("work").unwrap();
    let profiles = ProfileRegistry::new(vec![
        Profile::new(profile_id.clone(), None, profile_settings.clone()).unwrap(),
    ])
    .unwrap();

    let cli = CliOverride::new(Some(profile_id), NativeSettingsSchema::default());
    let resolved = resolve(&cli, &empty_env(), &profiles, &product_default).unwrap();
    assert_eq!(resolved.provider(), profile_settings.provider());
}

#[test]
fn environment_overrides_the_selected_profile() {
    let product_default = schema_with_provider("claude", 1);
    let profile_settings = schema_with_provider("codex", 2);
    let profile_id = ProfileId::new("work").unwrap();
    let profiles = ProfileRegistry::new(vec![
        Profile::new(profile_id.clone(), None, profile_settings).unwrap(),
    ])
    .unwrap();

    let cli = CliOverride::new(Some(profile_id), NativeSettingsSchema::default());
    let mut env = empty_env();
    env.insert("ZEROSHOT_RUST_PROVIDER".to_owned(), "gemini@3".to_owned());

    let resolved = resolve(&cli, &env, &profiles, &product_default).unwrap();
    assert_eq!(resolved.provider(), Some(&provider_ref("gemini", 3)));
}

#[test]
fn cli_overrides_the_environment() {
    let product_default = schema_with_provider("claude", 1);
    let mut env = empty_env();
    env.insert("ZEROSHOT_RUST_PROVIDER".to_owned(), "gemini@3".to_owned());

    let cli = CliOverride::new(None, schema_with_provider("opencode", 4));
    let resolved = resolve(&cli, &env, &empty_profiles(), &product_default).unwrap();
    assert_eq!(resolved.provider(), Some(&provider_ref("opencode", 4)));
}

#[test]
fn cli_profile_selection_wins_over_environment_profile_selection() {
    let product_default = NativeSettingsSchema::default();
    let cli_profile = ProfileId::new("cli-selected").unwrap();
    let env_profile = ProfileId::new("env-selected").unwrap();
    let profiles = ProfileRegistry::new(vec![
        Profile::new(cli_profile.clone(), None, schema_with_provider("claude", 1)).unwrap(),
        Profile::new(env_profile.clone(), None, schema_with_provider("codex", 2)).unwrap(),
    ])
    .unwrap();

    let cli = CliOverride::new(Some(cli_profile), NativeSettingsSchema::default());
    let mut env = empty_env();
    env.insert(
        "ZEROSHOT_RUST_PROFILE".to_owned(),
        env_profile.as_str().to_owned(),
    );

    let resolved = resolve(&cli, &env, &profiles, &product_default).unwrap();
    assert_eq!(resolved.provider(), Some(&provider_ref("claude", 1)));
}

#[test]
fn precedence_holds_independently_for_every_settings_field() {
    use zeroshot_engine::native_settings::{
        DaemonSettingsId, DaemonSettingsRef, GatewaySettingsId, GatewaySettingsRef,
        IssueSettingsId, IssueSettingsRef, PolicySettingsId, PolicySettingsRef, SourceSettingsId,
        SourceSettingsRef, WorkspaceSettingsId, WorkspaceSettingsRef,
    };

    let product_default = NativeSettingsSchema::new(NativeSettingsSchemaSpec {
        provider: Some(provider_ref("claude", 1)),
        source: Some(SourceSettingsRef::new(SourceSettingsId::new("github").unwrap(), 1).unwrap()),
        issue: Some(IssueSettingsRef::new(IssueSettingsId::new("github").unwrap(), 1).unwrap()),
        workspace: Some(
            WorkspaceSettingsRef::new(WorkspaceSettingsId::new("worktree").unwrap(), 1).unwrap(),
        ),
        gateway: Some(
            GatewaySettingsRef::new(GatewaySettingsId::new("default-gateway").unwrap(), 1).unwrap(),
        ),
        daemon: Some(DaemonSettingsRef::new(DaemonSettingsId::new("local").unwrap(), 1).unwrap()),
        policy: Some(
            PolicySettingsRef::new(PolicySettingsId::new("standard").unwrap(), 1).unwrap(),
        ),
        credential_requirements: std::collections::BTreeSet::new(),
    })
    .unwrap();

    // Only the environment overrides the `source` field; every other field must still surface
    // the product default, proving fields resolve independently rather than in lock-step.
    let mut env = empty_env();
    env.insert("ZEROSHOT_RUST_SOURCE".to_owned(), "gitlab@9".to_owned());

    let resolved = resolve(&empty_cli(), &env, &empty_profiles(), &product_default).unwrap();
    assert_eq!(
        resolved.source(),
        Some(&SourceSettingsRef::new(SourceSettingsId::new("gitlab").unwrap(), 9).unwrap())
    );
    assert_eq!(resolved.provider(), product_default.provider());
    assert_eq!(resolved.issue(), product_default.issue());
    assert_eq!(resolved.workspace(), product_default.workspace());
    assert_eq!(resolved.gateway(), product_default.gateway());
    assert_eq!(resolved.daemon(), product_default.daemon());
    assert_eq!(resolved.policy(), product_default.policy());
}

#[test]
fn unknown_selected_profile_is_rejected() {
    let cli = CliOverride::new(
        Some(ProfileId::new("missing").unwrap()),
        NativeSettingsSchema::default(),
    );
    let error = resolve(
        &cli,
        &empty_env(),
        &empty_profiles(),
        &NativeSettingsSchema::default(),
    )
    .unwrap_err();
    assert_eq!(error.reason(), "unknown profile");
}

#[test]
fn malformed_env_reference_missing_at_separator_is_rejected() {
    let mut env = empty_env();
    env.insert(
        "ZEROSHOT_RUST_PROVIDER".to_owned(),
        "claude-without-version".to_owned(),
    );
    assert!(parse_env_settings(&env).is_err());
}

#[test]
fn malformed_env_reference_non_numeric_version_is_rejected() {
    let mut env = empty_env();
    env.insert(
        "ZEROSHOT_RUST_PROVIDER".to_owned(),
        "claude@not-a-number".to_owned(),
    );
    assert!(parse_env_settings(&env).is_err());
}

#[test]
fn malformed_env_reference_zero_version_is_rejected() {
    let mut env = empty_env();
    env.insert("ZEROSHOT_RUST_PROVIDER".to_owned(), "claude@0".to_owned());
    assert!(parse_env_settings(&env).is_err());
}

#[test]
fn malformed_env_reference_empty_value_is_rejected() {
    let mut env = empty_env();
    env.insert("ZEROSHOT_RUST_PROVIDER".to_owned(), String::new());
    assert!(parse_env_settings(&env).is_err());
}

#[test]
fn malformed_env_profile_selection_empty_value_is_rejected() {
    let mut env = empty_env();
    env.insert("ZEROSHOT_RUST_PROFILE".to_owned(), String::new());
    assert!(parse_env_settings(&env).is_err());
}

#[test]
fn environment_parsing_never_sets_credential_requirements() {
    let mut env = empty_env();
    env.insert("ZEROSHOT_RUST_PROVIDER".to_owned(), "claude@1".to_owned());
    env.insert("ZEROSHOT_RUST_SOURCE".to_owned(), "github@1".to_owned());
    env.insert("ZEROSHOT_RUST_ISSUE".to_owned(), "github@1".to_owned());
    env.insert(
        "ZEROSHOT_RUST_WORKSPACE".to_owned(),
        "worktree@1".to_owned(),
    );
    env.insert(
        "ZEROSHOT_RUST_GATEWAY".to_owned(),
        "default-gateway@1".to_owned(),
    );
    env.insert("ZEROSHOT_RUST_DAEMON".to_owned(), "local@1".to_owned());
    env.insert("ZEROSHOT_RUST_POLICY".to_owned(), "standard@1".to_owned());

    let (_, settings) = parse_env_settings(&env).unwrap();
    assert!(settings.credential_requirements().is_empty());
}

#[test]
fn cli_credential_requirements_are_layered_in_only_when_non_empty() {
    use zeroshot_engine::native_settings::CredentialRequirementName;

    let product_default = NativeSettingsSchema::new(NativeSettingsSchemaSpec {
        credential_requirements: std::collections::BTreeSet::from([
            CredentialRequirementName::new("claude-auth").unwrap(),
        ]),
        ..NativeSettingsSchemaSpec::default()
    })
    .unwrap();

    // No layer sets credential_requirements, so the product default's set carries through.
    let resolved = resolve(
        &empty_cli(),
        &empty_env(),
        &empty_profiles(),
        &product_default,
    )
    .unwrap();
    assert_eq!(
        resolved.credential_requirements(),
        product_default.credential_requirements()
    );

    // A non-empty CLI override replaces the set wholesale rather than unioning it.
    let cli = CliOverride::new(
        None,
        NativeSettingsSchema::new(NativeSettingsSchemaSpec {
            credential_requirements: std::collections::BTreeSet::from([
                CredentialRequirementName::new("gateway-auth").unwrap(),
            ]),
            ..NativeSettingsSchemaSpec::default()
        })
        .unwrap(),
    );
    let resolved = resolve(&cli, &empty_env(), &empty_profiles(), &product_default).unwrap();
    assert_eq!(
        resolved.credential_requirements(),
        &std::collections::BTreeSet::from(
            [CredentialRequirementName::new("gateway-auth").unwrap()]
        )
    );
}
