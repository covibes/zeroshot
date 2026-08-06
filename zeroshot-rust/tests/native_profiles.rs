//! Duplicate/unknown/cycle rejection, canonicalization, and digest coverage for named profiles.

use zeroshot_engine::native_settings::profile::{Profile, ProfileFile, ProfileRegistry};
use zeroshot_engine::native_settings::{
    NativeSettingsSchema, NativeSettingsSchemaSpec, ProfileId, ProviderSettingsId,
    ProviderSettingsRef,
};

fn id(value: &str) -> ProfileId {
    ProfileId::new(value).unwrap()
}

fn schema_with_provider(provider_id: &str, version: u32) -> NativeSettingsSchema {
    NativeSettingsSchema::new(NativeSettingsSchemaSpec {
        provider: Some(
            ProviderSettingsRef::new(ProviderSettingsId::new(provider_id).unwrap(), version)
                .unwrap(),
        ),
        ..NativeSettingsSchemaSpec::default()
    })
    .unwrap()
}

fn profile(name: &str, extends: Option<&str>, settings: NativeSettingsSchema) -> Profile {
    Profile::new(id(name), extends.map(id), settings).unwrap()
}

#[test]
fn duplicate_profile_id_is_rejected() {
    let a = profile("shared", None, NativeSettingsSchema::default());
    let b = profile("shared", None, NativeSettingsSchema::default());
    let error = ProfileRegistry::new(vec![a, b]).unwrap_err();
    assert_eq!(error.reason(), "duplicate profile id");
}

#[test]
fn unknown_json_field_is_rejected() {
    let json = r#"{
        "version": 1,
        "profiles": [
            { "id": "work", "settings": {}, "apiKey": "secret" }
        ]
    }"#;
    assert!(serde_json::from_str::<ProfileFile>(json).is_err());
}

#[test]
fn unknown_extends_target_is_rejected() {
    let a = profile(
        "child",
        Some("missing-parent"),
        NativeSettingsSchema::default(),
    );
    let error = ProfileRegistry::new(vec![a]).unwrap_err();
    assert_eq!(error.reason(), "unknown profile");
}

#[test]
fn self_cycle_is_rejected() {
    let a = profile("self", Some("self"), NativeSettingsSchema::default());
    let error = ProfileRegistry::new(vec![a]).unwrap_err();
    assert_eq!(error.reason(), "profile inheritance forms a cycle");
}

#[test]
fn two_node_cycle_is_rejected() {
    let a = profile("a", Some("b"), NativeSettingsSchema::default());
    let b = profile("b", Some("a"), NativeSettingsSchema::default());
    let error = ProfileRegistry::new(vec![a, b]).unwrap_err();
    assert_eq!(error.reason(), "profile inheritance forms a cycle");
}

#[test]
fn three_node_cycle_is_rejected() {
    let a = profile("a", Some("b"), NativeSettingsSchema::default());
    let b = profile("b", Some("c"), NativeSettingsSchema::default());
    let c = profile("c", Some("a"), NativeSettingsSchema::default());
    let error = ProfileRegistry::new(vec![a, b, c]).unwrap_err();
    assert_eq!(error.reason(), "profile inheritance forms a cycle");
}

fn chain(node_count: usize) -> Vec<Profile> {
    // node[0] extends node[1] extends ... extends node[node_count - 1] (root, no extends).
    (0..node_count)
        .map(|index| {
            let name = format!("node-{index}");
            let extends = if index + 1 < node_count {
                Some(format!("node-{}", index + 1))
            } else {
                None
            };
            Profile::new(
                id(&name),
                extends.map(|value| id(&value)),
                NativeSettingsSchema::default(),
            )
            .unwrap()
        })
        .collect()
}

#[test]
fn chain_at_the_maximum_depth_is_accepted() {
    // 9 nodes = 8 `extends` edges from node-0 to the root, exactly at the bound.
    let registry = ProfileRegistry::new(chain(9));
    assert!(registry.is_ok());
}

#[test]
fn chain_exceeding_the_maximum_depth_is_rejected() {
    // 10 nodes = 9 `extends` edges from node-0 to the root, one past the bound.
    let error = ProfileRegistry::new(chain(10)).unwrap_err();
    assert_eq!(
        error.reason(),
        "profile inheritance exceeds the maximum depth"
    );
}

#[test]
fn valid_inheritance_canonicalizes_with_the_child_overriding_the_parent() {
    let parent = profile("parent", None, schema_with_provider("claude", 1));
    let child = profile("child", Some("parent"), schema_with_provider("codex", 2));
    let registry = ProfileRegistry::new(vec![parent, child]).unwrap();

    let canonical = registry.canonicalize();
    assert_eq!(
        canonical[&id("child")].provider(),
        schema_with_provider("codex", 2).provider()
    );
    assert_eq!(
        canonical[&id("parent")].provider(),
        schema_with_provider("claude", 1).provider()
    );
}

#[test]
fn child_inherits_unset_fields_from_its_parent() {
    use zeroshot_engine::native_settings::{SourceSettingsId, SourceSettingsRef};

    let parent_settings = NativeSettingsSchema::new(NativeSettingsSchemaSpec {
        provider: Some(
            ProviderSettingsRef::new(ProviderSettingsId::new("claude").unwrap(), 1).unwrap(),
        ),
        source: Some(SourceSettingsRef::new(SourceSettingsId::new("github").unwrap(), 1).unwrap()),
        ..NativeSettingsSchemaSpec::default()
    })
    .unwrap();
    let child_settings = schema_with_provider("codex", 2);

    let parent = profile("parent", None, parent_settings.clone());
    let child = profile("child", Some("parent"), child_settings.clone());
    let registry = ProfileRegistry::new(vec![parent, child]).unwrap();

    let canonical = registry.canonicalize();
    let resolved_child = &canonical[&id("child")];
    assert_eq!(resolved_child.provider(), child_settings.provider());
    assert_eq!(resolved_child.source(), parent_settings.source());
}

#[test]
fn digest_is_deterministic_and_changes_when_a_field_changes() {
    let a = profile("a", None, schema_with_provider("claude", 1));
    let registry = ProfileRegistry::new(vec![a]).unwrap();
    let first = registry.digest().unwrap();
    let second = registry.digest().unwrap();
    assert_eq!(first, second);

    let changed = profile("a", None, schema_with_provider("claude", 2));
    let changed_registry = ProfileRegistry::new(vec![changed]).unwrap();
    let third = changed_registry.digest().unwrap();
    assert_ne!(first, third);
}

#[test]
fn cross_profile_canonicalization_is_independent() {
    let a = profile("a", None, schema_with_provider("claude", 1));
    let b = profile("b", None, schema_with_provider("codex", 2));
    let registry = ProfileRegistry::new(vec![a, b]).unwrap();

    let first_pass = registry.canonicalize();
    let a_settings_before = first_pass[&id("a")].clone();

    // Resolving/canonicalizing again, including profile "b", must not perturb "a"'s result.
    let second_pass = registry.canonicalize();
    assert_eq!(a_settings_before, second_pass[&id("a")]);
    assert_eq!(first_pass[&id("b")], second_pass[&id("b")]);
}

#[test]
fn missing_profile_file_resolves_to_an_empty_registry() {
    let missing = std::env::temp_dir().join(format!(
        "zeroshot-native-profiles-missing-{}-{}",
        std::process::id(),
        "test"
    ));
    let registry = ProfileRegistry::load_from(&missing).unwrap();
    assert!(registry.is_empty());
}

#[test]
fn malformed_profile_file_names_the_path_in_its_error() {
    let path = std::env::temp_dir().join(format!(
        "zeroshot-native-profiles-malformed-{}.json",
        std::process::id()
    ));
    std::fs::write(&path, b"not json").unwrap();
    let error = ProfileRegistry::load_from(&path).unwrap_err();
    let _ = std::fs::remove_file(&path);
    assert!(error.reason().contains(path.display().to_string().as_str()));
}

#[test]
fn oversized_profile_file_is_rejected_before_parsing() {
    let path = std::env::temp_dir().join(format!(
        "zeroshot-native-profiles-oversized-{}.json",
        std::process::id()
    ));
    std::fs::File::create(&path)
        .unwrap()
        .set_len(1024 * 1024 + 1)
        .unwrap();
    let error = ProfileRegistry::load_from(&path).unwrap_err();
    let _ = std::fs::remove_file(&path);
    assert_eq!(error.field(), "profile file");
    assert!(error.reason().contains("exceeds 1048576-byte limit"));
}
