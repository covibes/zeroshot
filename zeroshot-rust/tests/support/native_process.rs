use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};

use openengine_cluster_client::{ClientError, ClusterClient, NdjsonTransport};
use openengine_cluster_protocol::ApplyResult;
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
