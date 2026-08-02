//! Proves OS-native namespace resolution only ever reads `ZEROSHOT_RUST_*_DIR`/platform
//! location variables from an explicit map, never real `~/.zeroshot`, npm, or legacy state.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use zeroshot_engine::native_settings::paths::resolve_namespace;

static NEXT_TEMP: AtomicU64 = AtomicU64::new(1);

fn temp_home(label: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!(
        "zeroshot-native-namespace-{label}-{}-{}",
        std::process::id(),
        NEXT_TEMP.fetch_add(1, Ordering::Relaxed)
    ));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).expect("temp home must be creatable");
    root
}

fn env_with_home(home: &Path) -> BTreeMap<String, String> {
    let mut env = BTreeMap::new();
    env.insert("HOME".to_owned(), home.to_string_lossy().into_owned());
    env
}

#[test]
fn explicit_directory_overrides_win_verbatim() {
    let mut env = BTreeMap::new();
    env.insert(
        "ZEROSHOT_RUST_CONFIG_DIR".to_owned(),
        "/custom/config".to_owned(),
    );
    env.insert(
        "ZEROSHOT_RUST_DATA_DIR".to_owned(),
        "/custom/data".to_owned(),
    );
    env.insert(
        "ZEROSHOT_RUST_CACHE_DIR".to_owned(),
        "/custom/cache".to_owned(),
    );
    env.insert(
        "ZEROSHOT_RUST_RUNTIME_DIR".to_owned(),
        "/custom/runtime".to_owned(),
    );

    let namespace = resolve_namespace(&env).unwrap();
    assert_eq!(namespace.config(), std::path::Path::new("/custom/config"));
    assert_eq!(namespace.data(), std::path::Path::new("/custom/data"));
    assert_eq!(namespace.cache(), std::path::Path::new("/custom/cache"));
    assert_eq!(namespace.runtime(), std::path::Path::new("/custom/runtime"));
}

#[test]
fn empty_directory_override_is_rejected() {
    let home = temp_home("empty-override");
    let mut env = env_with_home(&home);
    env.insert("ZEROSHOT_RUST_CONFIG_DIR".to_owned(), String::new());
    assert!(resolve_namespace(&env).is_err());
}

#[cfg(all(unix, not(target_os = "macos")))]
#[test]
fn host_os_default_never_contains_the_legacy_dot_zeroshot_directory() {
    let home = temp_home("no-legacy-dir");
    let env = env_with_home(&home);
    let namespace = resolve_namespace(&env).unwrap();
    for path in [
        namespace.config(),
        namespace.data(),
        namespace.cache(),
        namespace.runtime(),
    ] {
        let rendered = path.to_string_lossy();
        assert!(
            !rendered.contains(".zeroshot"),
            "unexpected legacy segment in {rendered}"
        );
    }
}

#[cfg(all(unix, not(target_os = "macos")))]
#[test]
fn unrelated_node_shaped_keys_have_zero_effect() {
    let home = temp_home("node-shaped-keys");
    let baseline_env = env_with_home(&home);
    let mut polluted_env = baseline_env.clone();
    polluted_env.insert(
        "ZEROSHOT_HOME".to_owned(),
        "/tmp/legacy-zeroshot".to_owned(),
    );
    polluted_env.insert("npm_config_prefix".to_owned(), "/tmp/npm".to_owned());
    polluted_env.insert("ZEROSHOT_PROVIDER".to_owned(), "legacy-claude".to_owned());

    let baseline = resolve_namespace(&baseline_env).unwrap();
    let polluted = resolve_namespace(&polluted_env).unwrap();
    assert_eq!(baseline, polluted);
}

#[cfg(all(unix, not(target_os = "macos")))]
#[test]
fn the_four_namespace_directories_are_mutually_distinct() {
    let home = temp_home("mutual-distinctness");
    let env = env_with_home(&home);
    let namespace = resolve_namespace(&env).unwrap();
    let dirs = [
        namespace.config(),
        namespace.data(),
        namespace.cache(),
        namespace.runtime(),
    ];
    for (left_index, left) in dirs.iter().enumerate() {
        for (right_index, right) in dirs.iter().enumerate() {
            if left_index != right_index {
                assert_ne!(
                    left, right,
                    "namespace directories must be mutually distinct"
                );
            }
        }
    }
}

#[test]
fn resolving_the_same_snapshot_twice_is_deterministic() {
    let home = temp_home("determinism");
    let env = env_with_home(&home);
    let first = resolve_namespace(&env).unwrap();
    let second = resolve_namespace(&env).unwrap();
    assert_eq!(first, second);
}

#[cfg(all(unix, not(target_os = "macos")))]
#[test]
fn a_real_legacy_settings_fixture_on_disk_never_affects_resolution() {
    let home = temp_home("legacy-fixture-ignored");
    let legacy_dir = home.join(".zeroshot");
    std::fs::create_dir_all(&legacy_dir).unwrap();
    std::fs::write(
        legacy_dir.join("settings.json"),
        br#"{"defaultConfig":{"provider":"claude"}}"#,
    )
    .unwrap();

    let env = env_with_home(&home);
    let namespace = resolve_namespace(&env).unwrap();
    assert_eq!(
        namespace.config(),
        home.join(".config").join("zeroshot-rust")
    );
    assert_ne!(namespace.config(), legacy_dir);
}

#[cfg(all(unix, not(target_os = "macos")))]
#[test]
fn xdg_environment_variables_take_precedence_over_the_home_default() {
    let home = temp_home("xdg-precedence");
    let mut env = env_with_home(&home);
    let xdg_config = temp_home("xdg-config-home");
    env.insert(
        "XDG_CONFIG_HOME".to_owned(),
        xdg_config.to_string_lossy().into_owned(),
    );

    let namespace = resolve_namespace(&env).unwrap();
    assert_eq!(namespace.config(), xdg_config.join("zeroshot-rust"));
}
