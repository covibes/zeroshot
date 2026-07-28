//! Shared `CARGO_BIN_EXE_openengine-cluster-stdio` subprocess spawn/teardown for tests that
//! compare a live subprocess transport against an in-process one: `protocol_v1.rs`'s
//! initialize/get and full-admission-lifecycle transcript equivalence tests, and
//! `protocol_ndjson.rs`'s NDJSON watch cross-transport equivalence test.

use tokio::io::AsyncReadExt;
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::task::JoinHandle;

/// Tracks a spawned `openengine-cluster-stdio` subprocess and a background task draining its
/// stderr, for [`StdioSubprocess::join`] to assert on. [`spawn`] returns this alongside the
/// child's stdin/stdout, already taken, for driving a transport.
pub struct StdioSubprocess {
    child: Child,
    stderr_task: JoinHandle<Vec<u8>>,
}

/// Spawns a bare `openengine-cluster-stdio` subprocess with piped stdin/stdout/stderr, without
/// taking any of them. Shared with tests that read the child's output via
/// [`Child::wait_with_output`] rather than [`spawn`]'s pre-taken pipes plus background stderr
/// drain.
pub fn spawn_child() -> Child {
    Command::new(env!("CARGO_BIN_EXE_openengine-cluster-stdio"))
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap()
}

/// Spawns the subprocess and starts draining its stderr in the background.
pub fn spawn() -> (StdioSubprocess, ChildStdin, ChildStdout) {
    let mut child = spawn_child();
    let stdin = child.stdin.take().unwrap();
    let stdout = child.stdout.take().unwrap();
    let mut stderr = child.stderr.take().unwrap();
    let stderr_task = tokio::spawn(async move {
        let mut bytes = Vec::new();
        stderr.read_to_end(&mut bytes).await.unwrap();
        bytes
    });
    (StdioSubprocess { child, stderr_task }, stdin, stdout)
}

impl StdioSubprocess {
    /// Awaits child exit and asserts it exited successfully with empty stderr. The caller must
    /// have already dropped whatever held `stdin`/`stdout` (e.g. the transport wrapping them) so
    /// the child observes EOF and exits.
    pub async fn join(mut self) {
        assert!(self.child.wait().await.unwrap().success());
        let stderr_bytes = self.stderr_task.await.unwrap();
        assert!(
            stderr_bytes.is_empty(),
            "unexpected stderr output: {}",
            String::from_utf8_lossy(&stderr_bytes)
        );
    }
}
