use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};

use openengine_cluster_client::{ClientError, ClusterClient, NdjsonTransport};
use openengine_cluster_protocol::{
    ApplyParams, ApplyResult, Generation, GetParams, GetResult, GraphSpec, IdempotencyKey, Phase,
    TerminalResult,
};
use serde_json::Value;
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::time::{timeout, Duration};

static NEXT_STATE_ROOT: AtomicU64 = AtomicU64::new(1);

pub type NativeClient = ClusterClient<NdjsonTransport<ChildStdout, ChildStdin>>;

pub struct TempState {
    root: PathBuf,
}

impl TempState {
    pub fn new(label: &str) -> Self {
        let sequence = NEXT_STATE_ROOT.fetch_add(1, Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!(
            "zeroshot-native-{label}-{}-{sequence}",
            std::process::id()
        ));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(root.join(".git")).unwrap();
        Self { root }
    }

    pub fn path(&self) -> &Path {
        &self.root
    }
}

impl Drop for TempState {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

pub struct NativeProcess {
    child: Child,
}

pub fn spawn(state_dir: &Path, cluster_id: &str) -> (NativeProcess, NativeClient) {
    spawn_with_workspace(state_dir, cluster_id, state_dir, &[])
}

pub fn spawn_with_workspace(
    state_dir: &Path,
    cluster_id: &str,
    workspace: &Path,
    environment: &[(&str, &str)],
) -> (NativeProcess, NativeClient) {
    let mut child = Command::new(env!("CARGO_BIN_EXE_zeroshot-rust"))
        .args([
            "serve-stdio",
            "--state-dir",
            state_dir
                .to_str()
                .expect("temporary state path must be UTF-8"),
            "--cluster-id",
            cluster_id,
            "--workspace",
            workspace
                .to_str()
                .expect("temporary workspace path must be UTF-8"),
        ])
        .env_remove("OPENAI_API_KEY")
        .envs(environment.iter().copied())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let stdin = child.stdin.take().unwrap();
    let stdout = child.stdout.take().unwrap();
    (
        NativeProcess { child },
        ClusterClient::new(NdjsonTransport::new(stdout, stdin)),
    )
}

pub struct ProviderProcess<'a> {
    state_dir: &'a Path,
    cluster_id: &'a str,
    workspace: &'a Path,
    environment: &'a [(String, String)],
}

impl<'a> ProviderProcess<'a> {
    pub fn new(
        state_dir: &'a Path,
        cluster_id: &'a str,
        workspace: &'a Path,
        environment: &'a [(String, String)],
    ) -> Self {
        Self {
            state_dir,
            cluster_id,
            workspace,
            environment,
        }
    }

    pub fn spawn(self, include_credential: bool) -> (NativeProcess, NativeClient) {
        let selected = self
            .environment
            .iter()
            .filter(|(name, _)| include_credential || name != "OPENAI_API_KEY")
            .map(|(name, value)| (name.as_str(), value.as_str()))
            .collect::<Vec<_>>();
        spawn_with_workspace(self.state_dir, self.cluster_id, self.workspace, &selected)
    }
}

pub fn provider_environment(bin: &Path, credential: &str) -> Vec<(String, String)> {
    let inherited = std::env::var("PATH").unwrap();
    vec![
        (
            "PATH".to_owned(),
            format!("{}:{inherited}", bin.to_str().unwrap()),
        ),
        ("OPENAI_API_KEY".to_owned(), credential.to_owned()),
        (
            "ZEROSHOT_SECRET_SENTINEL".to_owned(),
            "must-not-reach-provider".to_owned(),
        ),
    ]
}

pub fn install_test_executable(root: &Path, name: &str, contents: &[u8]) -> (PathBuf, PathBuf) {
    use std::os::unix::fs::PermissionsExt;

    let bin = root.join("fake-bin");
    std::fs::create_dir_all(&bin).unwrap();
    let executable = bin.join(name);
    std::fs::write(&executable, contents).unwrap();
    let mut permissions = std::fs::metadata(&executable).unwrap().permissions();
    permissions.set_mode(0o700);
    std::fs::set_permissions(&executable, permissions).unwrap();
    (bin, executable)
}

pub fn apply_params(graph: GraphSpec, input: Value, key: &str) -> ApplyParams {
    ApplyParams {
        graph,
        input: Some(input),
        dry_run: false,
        if_generation: Some(Generation::new(0).unwrap()),
        idempotency_key: Some(IdempotencyKey::new(key).unwrap()),
    }
}

pub async fn initialize_and_get_finished(client: &NativeClient) -> GetResult {
    let initialized = client.initialize().await.unwrap();
    assert_eq!(initialized.status.phase, Phase::Finished);
    client.get(GetParams::default()).await.unwrap()
}

pub async fn assert_running(client: &NativeClient) {
    assert_eq!(
        client.get(GetParams::default()).await.unwrap().status.phase,
        Phase::Running
    );
}

pub async fn assert_finished_failure(client: &NativeClient) {
    let result = client.get(GetParams::default()).await.unwrap();
    assert_eq!(result.status.phase, Phase::Finished);
    assert!(matches!(
        result.terminal_result,
        Some(TerminalResult::Failed { .. })
    ));
}

pub async fn concurrent_apply(
    client: &NativeClient,
    request: ApplyParams,
) -> (ApplyResult, ApplyResult) {
    let (first, second) = tokio::join!(client.apply(request.clone()), client.apply(request));
    (first.unwrap(), second.unwrap())
}

pub fn rpc_domain_code(error: &ClientError) -> Option<&str> {
    let ClientError::Rpc(error) = error else {
        return None;
    };
    error.data.as_ref().map(|data| data.code.as_str())
}

pub fn assert_one_deduped(first: &ApplyResult, second: &ApplyResult) {
    assert_ne!(first.deduped, second.deduped);
    assert_eq!(first.generation, second.generation);
    assert_eq!(first.run_id, second.run_id);
}

impl NativeProcess {
    pub async fn kill(&mut self) {
        self.child.kill().await.unwrap();
    }

    pub async fn join_success(self) {
        let output = timeout(Duration::from_secs(5), self.child.wait_with_output())
            .await
            .expect("native process must exit after EOF")
            .unwrap();
        assert!(
            output.status.success(),
            "native process failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(
            output.stderr.is_empty(),
            "successful native process wrote diagnostics: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    pub async fn join_failure(self) -> String {
        let output = timeout(Duration::from_secs(5), self.child.wait_with_output())
            .await
            .expect("failed native process must exit promptly")
            .unwrap();
        assert!(
            !output.status.success(),
            "native process unexpectedly succeeded"
        );
        String::from_utf8(output.stderr).expect("native diagnostics must be UTF-8")
    }
}
