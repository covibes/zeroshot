#[path = "support/native_process.rs"]
pub mod native_process;

use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use native_process::{rpc_domain_code, spawn_with_workspace, NativeClient, NativeProcess, TempState};
use openengine_cluster_protocol::{
    ApplyParams, ArtifactRef, Generation, GetParams, IdempotencyKey, Phase, PlanParams,
    TerminalResult, GENERATION_CONFLICT, IDEMPOTENCY_REUSE,
};
use serde_json::json;
use tokio::io::AsyncReadExt;
use zeroshot_engine::artifact_store::local_cas::LocalCasArtifactStore;
use zeroshot_engine::artifact_store::ArtifactStore;

const API_KEY: &str = "test-native-openai-key";
const GREETING: &str = "hello from native zeroshot\n";

#[derive(Clone, Copy)]
enum FakeMode {
    Success,
    Malformed,
}

struct ForegroundFixture {
    state: TempState,
    workspace: TempState,
    counter: PathBuf,
    environment: Vec<(String, String)>,
}

impl ForegroundFixture {
    fn new(label: &str, mode: FakeMode) -> Self {
        let state = TempState::new(label);
        let workspace = prepare_workspace(&format!("{label}-workspace"));
        let (bin, counter) = install_fake_codex(&state, workspace.path(), mode);
        Self {
            state,
            workspace,
            counter,
            environment: environment(&bin),
        }
    }

    fn spawn(&self, cluster: &str, include_credential: bool) -> (NativeProcess, NativeClient) {
        let environment = self
            .environment
            .iter()
            .filter(|(name, _)| include_credential || name != "OPENAI_API_KEY")
            .map(|(name, value)| (name.as_str(), value.as_str()))
            .collect::<Vec<_>>();
        spawn_with_workspace(
            self.state.path(),
            cluster,
            self.workspace.path(),
            &environment,
        )
    }

    fn invocation_count(&self) -> u64 {
        invocation_count(&self.counter)
    }
}

fn apply_request(key: &str) -> ApplyParams {
    ApplyParams {
        graph: zeroshot_engine::native_foreground_graph(),
        input: Some(json!({
            "prompt": "Make the requested deterministic greeting change.",
            "expectedGreeting": GREETING
        })),
        dry_run: false,
        if_generation: Some(Generation::new(0).unwrap()),
        idempotency_key: Some(IdempotencyKey::new(key).unwrap()),
    }
}

fn prepare_workspace(label: &str) -> TempState {
    let workspace = TempState::new(label);
    let status = std::process::Command::new("git")
        .args(["init", "-q"])
        .current_dir(workspace.path())
        .status()
        .unwrap();
    assert!(status.success());
    workspace
}

fn install_fake_codex(state: &TempState, workspace: &Path, mode: FakeMode) -> (PathBuf, PathBuf) {
    let bin = state.path().join("fake-bin");
    std::fs::create_dir_all(&bin).unwrap();
    let executable = bin.join("codex");
    let counter = state.path().join("codex-invocations");
    let expected_args = [
        "exec",
        "--json",
        "--sandbox",
        "workspace-write",
        "--config",
        "approval_policy=\"never\"",
        "--ephemeral",
        "--ignore-user-config",
        "--ignore-rules",
        "--strict-config",
        "--config",
        "web_search=\"disabled\"",
        "-",
    ];
    let emitted = match mode {
        FakeMode::Success => concat!(
            "print(json.dumps({'type':'thread.started','thread_id':'native-test'}))\n",
            "print(json.dumps({'type':'item.completed','item':",
            "{'type':'agent_message','text':'{\\\"summary\\\":\\\"greeting updated\\\"}'}}))\n",
            "print(json.dumps({'type':'turn.completed','usage':",
            "{'input_tokens':1,'output_tokens':1}}))\n"
        ),
        FakeMode::Malformed => "print(json.dumps({'type':'unknown.event'}))\n",
    };
    let script = format!(
        concat!(
            "#!/usr/bin/python3\n",
            "import json, os, pathlib, sys\n\n",
            "if sys.argv[1:] == ['--version']:\n",
            "    print('codex-cli 0.147.0')\n",
            "    raise SystemExit(0)\n",
            "if sys.argv[1:] == ['exec', '--help']:\n",
            "    print('--json --sandbox --config --ephemeral --ignore-user-config ",
            "--ignore-rules --strict-config')\n",
            "    raise SystemExit(0)\n",
            "expected = {expected_args:?}\n",
            "if sys.argv[1:] != expected:\n",
            "    raise SystemExit(21)\n",
            "if os.environ.get('OPENAI_API_KEY') != {API_KEY:?}:\n",
            "    raise SystemExit(22)\n",
            "if 'ZEROSHOT_SECRET_SENTINEL' in os.environ:\n",
            "    raise SystemExit(23)\n",
            "prompt = sys.stdin.read()\n",
            "if 'Make the requested deterministic greeting change.' not in prompt ",
            "or {GREETING:?}.strip() not in prompt:\n",
            "    raise SystemExit(24)\n",
            "counter = pathlib.Path({counter:?})\n",
            "count = int(counter.read_text()) if counter.exists() else 0\n",
            "counter.write_text(str(count + 1))\n",
            "pathlib.Path({workspace:?}, 'greeting.txt').write_text({GREETING:?})\n",
            "{emitted}"
        ),
        expected_args = expected_args,
        API_KEY = API_KEY,
        GREETING = GREETING,
        counter = counter.to_str().unwrap(),
        workspace = workspace.to_str().unwrap(),
        emitted = emitted,
    );
    std::fs::write(&executable, script).unwrap();
    let mut permissions = std::fs::metadata(&executable).unwrap().permissions();
    permissions.set_mode(0o700);
    std::fs::set_permissions(&executable, permissions).unwrap();
    (bin, counter)
}

fn environment(bin: &Path) -> Vec<(String, String)> {
    let inherited = std::env::var("PATH").unwrap();
    vec![
        (
            "PATH".to_owned(),
            format!("{}:{inherited}", bin.to_str().unwrap()),
        ),
        ("OPENAI_API_KEY".to_owned(), API_KEY.to_owned()),
        (
            "ZEROSHOT_SECRET_SENTINEL".to_owned(),
            "must-not-reach-provider".to_owned(),
        ),
    ]
}

fn invocation_count(counter: &Path) -> u64 {
    std::fs::read_to_string(counter)
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(0)
}

fn terminal_artifact(terminal: &TerminalResult) -> ArtifactRef {
    let TerminalResult::Succeeded { output } = terminal else {
        panic!("expected successful terminal result: {terminal:?}");
    };
    serde_json::from_value(output["validationArtifact"].clone()).unwrap()
}

fn artifact_root(state: &TempState) -> PathBuf {
    std::fs::read_dir(state.path())
        .unwrap()
        .filter_map(Result::ok)
        .find(|entry| {
            entry
                .file_name()
                .to_str()
                .is_some_and(|name| name.starts_with("artifacts-"))
        })
        .unwrap()
        .path()
}

fn artifact_blob(state: &TempState, artifact: &ArtifactRef) -> PathBuf {
    let digest = artifact.sha256.as_str();
    artifact_root(state)
        .join("blobs/sha256")
        .join(&digest[..2])
        .join(digest)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn real_foreground_agent_validates_publishes_and_restarts_without_a_second_invocation() {
    let fixture = ForegroundFixture::new("foreground-agent", FakeMode::Success);
    let (process, client) = fixture.spawn("foreground-agent", true);
    client.initialize().await.unwrap();
    let plan = client
        .plan(PlanParams {
            graph: zeroshot_engine::native_foreground_graph(),
        })
        .await
        .unwrap();
    assert!(plan.ok, "{:#?}", plan.diagnostics);
    let request = apply_request("foreground-once");
    client.apply(request.clone()).await.unwrap();
    let before = client.get(GetParams::default()).await.unwrap();
    assert_eq!(before.status.phase, Phase::Finished);
    let terminal = before.terminal_result.as_ref().unwrap();
    let artifact = terminal_artifact(terminal);
    assert_eq!(fixture.invocation_count(), 1);
    assert_eq!(
        std::fs::read_to_string(fixture.workspace.path().join("greeting.txt")).unwrap(),
        GREETING
    );
    drop(client);
    process.join_success().await;

    let store = LocalCasArtifactStore::new(artifact_root(&fixture.state)).unwrap();
    let mut bytes = Vec::new();
    store
        .open(&artifact.artifact_id)
        .await
        .unwrap()
        .read_to_end(&mut bytes)
        .await
        .unwrap();
    assert_eq!(artifact.byte_length.get(), bytes.len() as u64);
    drop(store);

    let (restart, restart_client) = fixture.spawn("foreground-agent", true);
    let initialized = restart_client.initialize().await.unwrap();
    assert_eq!(initialized.status.phase, Phase::Finished);
    let after = restart_client.get(GetParams::default()).await.unwrap();
    assert_eq!(after, before);
    assert_eq!(
        terminal_artifact(after.terminal_result.as_ref().unwrap()),
        artifact
    );
    assert!(restart_client.apply(request).await.unwrap().deduped);
    assert_eq!(fixture.invocation_count(), 1);
    drop(restart_client);
    restart.join_success().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn corrupt_validation_artifact_refuses_restart_without_relaunch() {
    let fixture = ForegroundFixture::new("foreground-corrupt-artifact", FakeMode::Success);
    let (process, client) = fixture.spawn("foreground-corrupt-artifact", true);
    client.initialize().await.unwrap();
    client
        .apply(apply_request("corrupt-artifact"))
        .await
        .unwrap();
    let result = client.get(GetParams::default()).await.unwrap();
    let artifact = terminal_artifact(result.terminal_result.as_ref().unwrap());
    drop(client);
    process.join_success().await;

    std::fs::write(artifact_blob(&fixture.state, &artifact), b"corrupt").unwrap();
    let (restart, restart_client) = fixture.spawn("foreground-corrupt-artifact", true);
    assert!(restart_client.initialize().await.is_err());
    drop(restart_client);
    assert!(
        restart
            .join_failure()
            .await
            .contains("execution state is invalid")
    );
    assert_eq!(fixture.invocation_count(), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn missing_credential_rejects_before_dispatch_or_provider_effect() {
    let fixture = ForegroundFixture::new("foreground-missing-credential", FakeMode::Success);
    let (process, client) = fixture.spawn("foreground-missing-credential", false);
    client.initialize().await.unwrap();
    assert!(
        client
            .apply(apply_request("missing-credential"))
            .await
            .is_err()
    );
    assert_eq!(
        client.get(GetParams::default()).await.unwrap().status.phase,
        Phase::Running
    );
    assert_eq!(fixture.invocation_count(), 0);
    assert!(!fixture.workspace.path().join("greeting.txt").exists());
    drop(client);
    process.join_success().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn malformed_provider_output_settles_failure_without_relaunch() {
    let fixture = ForegroundFixture::new("foreground-malformed", FakeMode::Malformed);
    let (process, client) = fixture.spawn("foreground-malformed", true);
    client.initialize().await.unwrap();
    client.apply(apply_request("malformed-once")).await.unwrap();
    let result = client.get(GetParams::default()).await.unwrap();
    assert_eq!(result.status.phase, Phase::Finished);
    assert!(matches!(
        result.terminal_result,
        Some(TerminalResult::Failed { .. })
    ));
    assert_eq!(fixture.invocation_count(), 1);
    drop(client);
    process.join_success().await;

    let (restart, restart_client) = fixture.spawn("foreground-malformed", true);
    restart_client.initialize().await.unwrap();
    assert_eq!(
        restart_client.get(GetParams::default()).await.unwrap(),
        result
    );
    assert_eq!(fixture.invocation_count(), 1);
    drop(restart_client);
    restart.join_success().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_applies_share_one_provider_authority() {
    let fixture = ForegroundFixture::new("foreground-concurrent", FakeMode::Success);
    let (process, client) = fixture.spawn("foreground-concurrent", true);
    client.initialize().await.unwrap();
    let same = apply_request("same-key");
    let (first, second) = tokio::join!(client.apply(same.clone()), client.apply(same));
    assert_ne!(first.unwrap().deduped, second.unwrap().deduped);
    assert_eq!(fixture.invocation_count(), 1);

    let mut mismatched = apply_request("same-key");
    mismatched.input = Some(json!({
        "prompt": "A different prompt must not reuse the key.",
        "expectedGreeting": GREETING
    }));
    let reuse = client.apply(mismatched).await.unwrap_err();
    assert_eq!(rpc_domain_code(&reuse), Some(IDEMPOTENCY_REUSE));

    let distinct = client
        .apply(apply_request("distinct-key"))
        .await
        .unwrap_err();
    assert_eq!(rpc_domain_code(&distinct), Some(GENERATION_CONFLICT));
    assert_eq!(fixture.invocation_count(), 1);
    drop(client);
    process.join_success().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_distinct_keys_still_create_one_provider_effect() {
    let fixture = ForegroundFixture::new("foreground-distinct-keys", FakeMode::Success);
    let (process, client) = fixture.spawn("foreground-distinct-keys", true);
    client.initialize().await.unwrap();

    let (first, second) = tokio::join!(
        client.apply(apply_request("first-key")),
        client.apply(apply_request("second-key"))
    );
    assert_eq!(first.is_ok() as u8 + second.is_ok() as u8, 1);
    let conflict = first.err().or_else(|| second.err()).unwrap();
    assert_eq!(rpc_domain_code(&conflict), Some(GENERATION_CONFLICT));
    assert_eq!(fixture.invocation_count(), 1);
    drop(client);
    process.join_success().await;
}
