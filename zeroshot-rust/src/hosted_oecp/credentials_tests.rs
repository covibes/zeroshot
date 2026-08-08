use std::collections::BTreeMap;

use super::credential_runtime::{apply_fixed_git_arguments, run_bounded};
#[cfg(unix)]
use super::credential_runtime::prepare_shared_mount;
use super::credentials::{
    apply_uncredentialed_worker_to, CredentialInstallError, CredentialStore,
    EXECUTABLE_RUNTIME_ROOT, RUNTIME_DIRECTORY_MODE, RUNTIME_EXECUTABLE_MODE, RUNTIME_FILE_MODE,
    RUNTIME_ROOT, SHARED_MOUNT_MODE,
};
use super::run_intent_test_support::credential_bundle;
use crate::execution::process::{MAX_PROCESS_ENV_BYTES, MAX_PROCESS_ENV_ITEMS};
use serde_json::json;

fn bundle(provider: &str, environment: serde_json::Value) -> Vec<u8> {
    let mut value = credential_bundle(provider, environment);
    value["runtime"]["setupCommand"] = json!("future-cli --version");
    serde_json::to_vec(&value).unwrap()
}

#[tokio::test]
async fn setup_command_has_a_fixed_deadline_and_process_group_cleanup() {
    let mut command = tokio::process::Command::new("/bin/sh");
    command.args(["-c", "sleep 30 & wait"]);
    let result = run_bounded(
        &mut command,
        "runtime setup",
        tokio::time::Duration::from_millis(25),
    )
    .await;
    assert_eq!(
        result,
        Err("runtime setup exceeded its fixed deadline".to_owned())
    );
}

fn command_environment(command: &tokio::process::Command) -> BTreeMap<String, Option<String>> {
    command
        .as_std()
        .get_envs()
        .filter_map(|(key, value)| {
            Some((
                key.to_str()?.to_owned(),
                value.and_then(|item| item.to_str()).map(str::to_owned),
            ))
        })
        .collect()
}

fn environment_bytes(environment: &BTreeMap<String, String>) -> usize {
    environment
        .iter()
        .map(|(name, value)| name.len() + value.len() + 2)
        .sum()
}

#[test]
fn git_commands_trust_only_the_fixed_capsule_workspace() {
    let mut command = tokio::process::Command::new("/usr/bin/git");
    apply_fixed_git_arguments(&mut command);
    let arguments = command
        .as_std()
        .get_args()
        .map(|argument| argument.to_string_lossy().into_owned())
        .collect::<Vec<_>>();

    assert_eq!(
        arguments,
        [
            "-c",
            "credential.helper=",
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "safe.directory=/workspace",
        ]
    );
}

#[tokio::test]
async fn install_is_provider_neutral_bounded_and_exact_replay_idempotent() {
    let store = CredentialStore::default();
    let bytes = bundle(
        "future-provider",
        json!({
            "FUTURE_PROVIDER_TOKEN": "provider-canary",
            "FUTURE_PROVIDER_ENDPOINT": "https://models.example"
        }),
    );
    store.install(bytes.clone()).await.unwrap();
    store.install(bytes.clone()).await.unwrap();
    assert!(store.is_exact_replay(&bytes).await);
    assert_eq!(
        store
            .install(bundle("another-provider", json!({"OTHER_TOKEN": "secret"})))
            .await,
        Err(CredentialInstallError::Conflict)
    );

    let installed = store.resolve().await.unwrap();
    let environment = installed.worker_environment();
    assert_eq!(
        environment.get("FUTURE_PROVIDER_TOKEN").map(String::as_str),
        Some("provider-canary")
    );
    assert_eq!(installed.authority().provider(), "future-provider");
    assert_eq!(
        environment
            .get("ZEROSHOT_HOSTED_EXECUTABLE")
            .map(String::as_str),
        Some("future-cli")
    );
    assert_eq!(
        environment
            .get("ZEROSHOT_HOSTED_EXEC_ROOT")
            .map(String::as_str),
        Some(EXECUTABLE_RUNTIME_ROOT)
    );
    assert!(
        environment
            .get("PATH")
            .is_some_and(|path| path.starts_with(&format!(
                "{EXECUTABLE_RUNTIME_ROOT}/.local/bin:{EXECUTABLE_RUNTIME_ROOT}/bin:"
            )))
    );
}

#[test]
fn runtime_access_is_private_to_the_supervisor_and_worker_group() {
    assert_eq!(SHARED_MOUNT_MODE, 0o2770);
    assert_eq!(RUNTIME_DIRECTORY_MODE, 0o770);
    assert_eq!(RUNTIME_FILE_MODE, 0o660);
    assert_eq!(RUNTIME_EXECUTABLE_MODE, 0o770);
    assert_eq!(RUNTIME_DIRECTORY_MODE & 0o007, 0);
    assert_eq!(RUNTIME_FILE_MODE & 0o007, 0);
    assert_eq!(RUNTIME_EXECUTABLE_MODE & 0o007, 0);
    assert_ne!(RUNTIME_ROOT, EXECUTABLE_RUNTIME_ROOT);
    assert!(EXECUTABLE_RUNTIME_ROOT.starts_with("/workspace/.git/"));
}

#[cfg(unix)]
#[tokio::test]
async fn shared_mount_is_private_idempotent_and_inherits_the_worker_group() {
    use std::fs;
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT_DIRECTORY: AtomicU64 = AtomicU64::new(1);
    let directory = std::env::temp_dir().join(format!(
        "zeroshot-hosted-mount-{}-{}",
        std::process::id(),
        NEXT_DIRECTORY.fetch_add(1, Ordering::Relaxed)
    ));
    fs::create_dir(&directory).unwrap();
    let original_gid = fs::metadata(&directory).unwrap().gid();
    fs::remove_dir(&directory).unwrap();
    assert!(!directory.exists());

    prepare_shared_mount(&directory, original_gid)
        .await
        .unwrap();
    prepare_shared_mount(&directory, original_gid)
        .await
        .unwrap();
    let child = directory.join("worker-owned");
    fs::create_dir(&child).unwrap();

    let metadata = fs::metadata(&directory).unwrap();
    assert_eq!(metadata.gid(), original_gid);
    assert_eq!(metadata.permissions().mode() & 0o7777, SHARED_MOUNT_MODE);
    assert_eq!(fs::metadata(&child).unwrap().gid(), original_gid);
    fs::remove_dir_all(directory).unwrap();
}

#[tokio::test]
async fn git_setup_and_worker_receive_only_their_owned_credentials() {
    let store = CredentialStore::default();
    store
        .install(bundle(
            "future-provider",
            json!({"FUTURE_PROVIDER_TOKEN": "provider-canary"}),
        ))
        .await
        .unwrap();
    let installed = store.resolve().await.unwrap();

    let mut git = tokio::process::Command::new("true");
    installed.apply_git_to(&mut git);
    let git_environment = command_environment(&git);
    assert_eq!(
        git_environment.get("GH_TOKEN"),
        Some(&Some("github-canary".to_owned()))
    );
    assert!(!git_environment.contains_key("FUTURE_PROVIDER_TOKEN"));

    let mut setup = tokio::process::Command::new("true");
    installed.apply_setup_to(&mut setup);
    let setup_environment = command_environment(&setup);
    assert_eq!(
        setup_environment.get("FUTURE_PROVIDER_TOKEN"),
        Some(&Some("provider-canary".to_owned()))
    );
    assert!(!setup_environment.contains_key("GH_TOKEN"));

    let mut uncredentialed = tokio::process::Command::new("true");
    apply_uncredentialed_worker_to(&mut uncredentialed);
    let uncredentialed_environment = command_environment(&uncredentialed);
    assert!(!uncredentialed_environment.contains_key("FUTURE_PROVIDER_TOKEN"));
    assert!(!uncredentialed_environment.contains_key("GH_TOKEN"));

    assert_eq!(
        installed
            .worker_environment()
            .get("FUTURE_PROVIDER_TOKEN")
            .map(String::as_str),
        Some("provider-canary")
    );
}

#[tokio::test]
async fn install_rejects_reserved_environment_and_path_escape() {
    for environment_name in [
        "GH_TOKEN",
        "GITHUB_TOKEN",
        "GIT_ASKPASS",
        "GIT_CONFIG_GLOBAL",
        "GIT_CONFIG_NOSYSTEM",
        "GIT_TERMINAL_PROMPT",
        "HOME",
        "LANG",
        "LD_AUDIT",
        "LD_LIBRARY_PATH",
        "LD_PRELOAD",
        "NODE_ENV",
        "NODE_OPTIONS",
        "PATH",
        "TMPDIR",
        "ZEROSHOT_HOSTED_BASE_REVISION",
        "ZEROSHOT_HOSTED_DELIVERY_MODE",
        "ZEROSHOT_HOSTED_DELIVERY_TARGET",
        "ZEROSHOT_HOSTED_DELIVERY_VERSION",
        "ZEROSHOT_HOSTED_EXECUTABLE",
        "ZEROSHOT_HOSTED_EXEC_ROOT",
        "ZEROSHOT_HOSTED_MODEL",
        "ZEROSHOT_HOSTED_PROVIDER",
        "ZEROSHOT_HOSTED_REPOSITORY",
        "ZEROSHOT_ISOLATION_PROFILE",
        "ZEROSHOT_PROVIDER_PROFILE",
        "ZEROSHOT_SETTINGS_FILE",
    ] {
        assert_eq!(
            CredentialStore::default()
                .install(bundle(
                    "future-provider",
                    json!({(environment_name): "/untrusted"}),
                ))
                .await,
            Err(CredentialInstallError::Invalid)
        );
    }

    for filename in ["../escape", "settings.json", "settings.json/nested"] {
        let bytes = serde_json::to_vec(&json!({
            "githubToken": "github",
            "repository": "the-open-engine/zeroshot",
            "baseRevision": "a".repeat(40),
            "runtime": {
                "provider": "future-provider",
                "executable": "future-cli",
                "environment": {},
                "files": {(filename): "secret"},
                "settings": {}
            }
        }))
        .unwrap();
        assert_eq!(
            CredentialStore::default().install(bytes).await,
            Err(CredentialInstallError::Invalid)
        );
    }
}

#[tokio::test]
async fn install_matches_worker_process_environment_item_bound() {
    let baseline = CredentialStore::default();
    baseline
        .install(bundle("future-provider", json!({})))
        .await
        .unwrap();
    let fixed_items = baseline.resolve().await.unwrap().worker_environment().len();
    let available_items = MAX_PROCESS_ENV_ITEMS - fixed_items;
    let environment = (0..available_items)
        .map(|index| (format!("RUNTIME_{index}"), json!("x")))
        .collect::<serde_json::Map<_, _>>();

    let accepted = CredentialStore::default();
    accepted
        .install(bundle(
            "future-provider",
            serde_json::Value::Object(environment.clone()),
        ))
        .await
        .unwrap();
    assert_eq!(
        accepted.resolve().await.unwrap().worker_environment().len(),
        MAX_PROCESS_ENV_ITEMS
    );

    let mut rejected_environment = environment;
    rejected_environment.insert("RUNTIME_OVERFLOW".to_owned(), json!("x"));
    assert_eq!(
        CredentialStore::default()
            .install(bundle(
                "future-provider",
                serde_json::Value::Object(rejected_environment),
            ))
            .await,
        Err(CredentialInstallError::Invalid)
    );
}

#[tokio::test]
async fn install_matches_worker_process_environment_byte_bound() {
    const NAME: &str = "RUNTIME_CREDENTIAL";

    let baseline = CredentialStore::default();
    baseline
        .install(bundle("future-provider", json!({})))
        .await
        .unwrap();
    let fixed_bytes = environment_bytes(&baseline.resolve().await.unwrap().worker_environment());
    let maximum_value_bytes = MAX_PROCESS_ENV_BYTES - fixed_bytes - NAME.len() - 2;

    let accepted = CredentialStore::default();
    accepted
        .install(bundle(
            "future-provider",
            json!({(NAME): "x".repeat(maximum_value_bytes)}),
        ))
        .await
        .unwrap();
    assert_eq!(
        environment_bytes(&accepted.resolve().await.unwrap().worker_environment()),
        MAX_PROCESS_ENV_BYTES
    );

    assert_eq!(
        CredentialStore::default()
            .install(bundle(
                "future-provider",
                json!({(NAME): "x".repeat(maximum_value_bytes + 1)}),
            ))
            .await,
        Err(CredentialInstallError::Invalid)
    );
}
