use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use async_trait::async_trait;
use openengine_cluster_protocol::{NodeName, RunId, WorkerOutcome, WorkerRef};
use serde_json::{Value, json};
use tokio::sync::Notify;

use super::*;
use crate::execution::{SessionScope, process::HostedProcessPool};
use crate::native_v2_contract::{ExecutionId, NodeInstanceId, NodeInvocation, NodeRuntimeBinding};
use crate::native_v2_runner::{ResolvedEnvironment, remote_node_handle};
use crate::worker_catalog::{ModelId, ReasoningEffort};

fn request(run: &str, execution: u64) -> NodeRunRequest {
    let binding = NodeRuntimeBinding::Agent {
        model: ModelId::new("gpt-5.6").unwrap(),
        effort: Some(ReasoningEffort::Max),
        session_scope: SessionScope::Execution,
        env: BTreeSet::new(),
    };
    NodeRunRequest {
        invocation: NodeInvocation {
            reference: ExecutionRef {
                run_id: RunId::new(run),
                node: NodeName::new("worker").unwrap(),
                node_instance: NodeInstanceId::new(execution).unwrap(),
                execution: ExecutionId::new(execution).unwrap(),
            },
            worker: WorkerRef::new("agent.worker@1").unwrap(),
            input: Value::Null,
            binding: binding.clone(),
        },
        environment: ResolvedEnvironment::exact(&binding, BTreeMap::new()).unwrap(),
    }
}

#[derive(Default)]
struct TestRunner {
    proceed: Arc<Notify>,
    started: Arc<Notify>,
    cleaned: Arc<AtomicBool>,
}

#[async_trait]
impl NodeRunner for TestRunner {
    async fn start(&self, request: NodeRunRequest) -> Result<NodeHandle, NodeRunnerError> {
        let reference = request.invocation.reference;
        let (handle, mut bridge) = remote_node_handle(reference.clone());
        let proceed = self.proceed.clone();
        let started = self.started.clone();
        let cleaned = self.cleaned.clone();
        tokio::spawn(async move {
            started.notify_one();
            enum Result {
                Complete,
                Cancel,
            }
            let result = tokio::select! {
                () = proceed.notified() => Result::Complete,
                () = bridge.cancelled() => Result::Cancel,
            };
            match result {
                Result::Complete => {
                    bridge
                        .emit(LiveOutput::new(LiveOutputStream::Output, "working").unwrap())
                        .unwrap();
                    bridge.finish(Ok(NodeCompletion {
                        reference,
                        outcome: WorkerOutcome::Verified {
                            output: json!({"answer": 42}),
                            artifacts: Vec::new(),
                        },
                    }));
                }
                Result::Cancel => {
                    cleaned.store(true, Ordering::SeqCst);
                    bridge.finish(Err(NodeRunnerError::Cancelled));
                }
            }
        });
        Ok(handle)
    }

    async fn close_run(&self, _run_id: &RunId) {}
}

#[tokio::test]
async fn proxy_preserves_durable_live_and_normalized_completion() {
    let local = Arc::new(TestRunner::default());
    let endpoint = Arc::new(NativeCapsuleNodeEndpoint::new(local.clone()));
    let proxy = RemoteCapsuleNodeRunner::new(endpoint);
    let mut handle = proxy.start(request("roundtrip", 1)).await.unwrap();
    let mut durable = handle.take_initial_output().unwrap();
    let mut live = handle.attach();
    local.proceed.notify_one();

    let durable_output = durable.recv().await.unwrap();
    let live_output = live.recv().await.unwrap();
    assert_eq!(durable_output.text, "working");
    assert_eq!(live_output, durable_output);
    let completion = handle.completion().await.unwrap();
    assert_eq!(completion.reference.execution, ExecutionId::new(1).unwrap());
    assert!(matches!(
        completion.outcome,
        WorkerOutcome::Verified { output, .. } if output == json!({"answer": 42})
    ));
}

#[tokio::test]
async fn close_run_waits_for_remote_cleanup_acknowledgement() {
    let local = Arc::new(TestRunner::default());
    let endpoint = Arc::new(NativeCapsuleNodeEndpoint::new(local.clone()));
    let proxy = RemoteCapsuleNodeRunner::new(endpoint);
    let mut handle = proxy.start(request("close", 1)).await.unwrap();
    local.started.notified().await;

    proxy.close_run(&RunId::new("close")).await;

    assert!(local.cleaned.load(Ordering::SeqCst));
    assert_eq!(
        handle.completion().await.unwrap_err(),
        NodeRunnerError::Cancelled
    );
}

#[tokio::test]
async fn connection_loss_is_terminal_and_cleans_capsule_execution() {
    let local = Arc::new(TestRunner::default());
    let endpoint = Arc::new(NativeCapsuleNodeEndpoint::new(local.clone()));
    let proxy = RemoteCapsuleNodeRunner::new(endpoint.clone());
    let mut loss = proxy.connection_loss();
    let mut handle = proxy.start(request("lost", 1)).await.unwrap();
    local.started.notified().await;

    endpoint.disconnect().await;

    loss.changed().await.unwrap();
    assert!(*loss.borrow());
    assert!(local.cleaned.load(Ordering::SeqCst));
    assert_eq!(
        handle.completion().await.unwrap_err(),
        NodeRunnerError::ConnectionLost
    );
    assert!(matches!(
        proxy.start(request("lost", 2)).await,
        Err(NodeRunnerError::ConnectionLost)
    ));
}

#[derive(Clone)]
struct BrokenChannel {
    loss: watch::Sender<bool>,
}

impl BrokenChannel {
    fn new() -> Self {
        let (loss, _) = watch::channel(false);
        Self { loss }
    }
}

#[async_trait]
impl CapsuleNodeChannel for BrokenChannel {
    async fn start(
        &self,
        _request: NodeRunRequest,
    ) -> Result<CapsuleExecutionStream, CapsuleConnectionError> {
        let (events, receiver) = mpsc::unbounded_channel();
        drop(events);
        Ok(CapsuleExecutionStream::from_receiver(receiver))
    }

    async fn cancel(&self, _reference: &ExecutionRef) -> Result<(), CapsuleConnectionError> {
        Ok(())
    }

    async fn close_run(&self, _run_id: &RunId) -> Result<(), CapsuleConnectionError> {
        Ok(())
    }

    fn connection_loss(&self) -> watch::Receiver<bool> {
        self.loss.subscribe()
    }
}

#[tokio::test]
async fn premature_execution_stream_close_is_connection_loss_without_retry() {
    let proxy = RemoteCapsuleNodeRunner::new(Arc::new(BrokenChannel::new()));
    let mut loss = proxy.connection_loss();
    let mut handle = proxy.start(request("stream-close", 1)).await.unwrap();
    assert_eq!(
        handle.completion().await.unwrap_err(),
        NodeRunnerError::ConnectionLost
    );
    loss.changed().await.unwrap();
    assert!(*loss.borrow_and_update());
    assert!(!loss.has_changed().unwrap());
}

#[derive(Clone)]
struct StartLostChannel {
    loss: watch::Sender<bool>,
}

impl StartLostChannel {
    fn new() -> Self {
        let (loss, _) = watch::channel(false);
        Self { loss }
    }
}

#[async_trait]
impl CapsuleNodeChannel for StartLostChannel {
    async fn start(
        &self,
        _request: NodeRunRequest,
    ) -> Result<CapsuleExecutionStream, CapsuleConnectionError> {
        Err(CapsuleConnectionError::Lost)
    }

    async fn cancel(&self, _reference: &ExecutionRef) -> Result<(), CapsuleConnectionError> {
        Ok(())
    }

    async fn close_run(&self, _run_id: &RunId) -> Result<(), CapsuleConnectionError> {
        Ok(())
    }

    fn connection_loss(&self) -> watch::Receiver<bool> {
        self.loss.subscribe()
    }
}

#[tokio::test]
async fn start_loss_promotes_the_runner_loss_signal() {
    let proxy = RemoteCapsuleNodeRunner::new(Arc::new(StartLostChannel::new()));
    let loss = proxy.connection_loss();

    assert!(matches!(
        proxy.start(request("start-lost", 1)).await,
        Err(NodeRunnerError::ConnectionLost)
    ));
    assert!(*loss.borrow());
}

#[derive(Clone)]
struct HangingControlChannel {
    loss: watch::Sender<bool>,
    streams: Arc<StdMutex<Vec<mpsc::UnboundedSender<CapsuleNodeEvent>>>>,
}

impl HangingControlChannel {
    fn new() -> Self {
        let (loss, _) = watch::channel(false);
        Self {
            loss,
            streams: Arc::new(StdMutex::new(Vec::new())),
        }
    }
}

#[async_trait]
impl CapsuleNodeChannel for HangingControlChannel {
    async fn start(
        &self,
        _request: NodeRunRequest,
    ) -> Result<CapsuleExecutionStream, CapsuleConnectionError> {
        let (events, receiver) = mpsc::unbounded_channel();
        self.streams.lock().unwrap().push(events);
        Ok(CapsuleExecutionStream::from_receiver(receiver))
    }

    async fn cancel(&self, _reference: &ExecutionRef) -> Result<(), CapsuleConnectionError> {
        std::future::pending().await
    }

    async fn close_run(&self, _run_id: &RunId) -> Result<(), CapsuleConnectionError> {
        std::future::pending().await
    }

    fn connection_loss(&self) -> watch::Receiver<bool> {
        self.loss.subscribe()
    }
}

fn hanging_proxy() -> RemoteCapsuleNodeRunner {
    RemoteCapsuleNodeRunner::new(Arc::new(HangingControlChannel::new()))
        .with_control_timeout(Duration::from_millis(20))
}

#[tokio::test]
async fn hanging_cancel_is_bounded_and_promotes_loss() {
    let proxy = hanging_proxy();
    let loss = proxy.connection_loss();
    let mut handle = proxy.start(request("cancel-hangs", 1)).await.unwrap();

    handle.cancel();
    let result = tokio::time::timeout(Duration::from_secs(1), handle.completion())
        .await
        .expect("hanging cancel must be bounded");

    assert_eq!(result, Err(NodeRunnerError::ConnectionLost));
    assert!(*loss.borrow());
}

#[tokio::test]
async fn hanging_close_is_bounded_and_promotes_loss() {
    let proxy = hanging_proxy();
    let loss = proxy.connection_loss();
    let mut handle = proxy.start(request("close-hangs", 1)).await.unwrap();

    tokio::time::timeout(
        Duration::from_secs(1),
        proxy.close_run(&RunId::new("close-hangs")),
    )
    .await
    .expect("hanging close must be bounded");

    assert!(*loss.borrow());
    assert_eq!(
        handle.completion().await,
        Err(NodeRunnerError::ConnectionLost)
    );
}

static TEMP_ID: AtomicU64 = AtomicU64::new(1);

fn temporary_root() -> PathBuf {
    let sequence = TEMP_ID.fetch_add(1, Ordering::Relaxed);
    std::env::temp_dir().join(format!(
        "zeroshot-capsule-permissions-{}-{sequence}",
        std::process::id()
    ))
}

#[test]
fn capsule_filesystem_rejects_nested_workspace_and_runtime_roots() {
    let root = temporary_root();
    fs::create_dir(&root).unwrap();
    let pool = HostedProcessPool::new(31_002, 31_002, 32_000, 32_000).unwrap();

    let workspace = root.join("workspace-parent");
    fs::create_dir(&workspace).unwrap();
    let nested_runtime = workspace.join("runtime-home");
    assert!(matches!(
        prepare_capsule_filesystem(CapsuleFilesystemSpec {
            workspace: &workspace,
            runtime_home: &nested_runtime,
            process_pool: pool,
        }),
        Err(CapsuleFilesystemError::InvalidLayout)
    ));

    let runtime_home = root.join("runtime-parent");
    fs::create_dir(&runtime_home).unwrap();
    let nested_workspace = runtime_home.join("workspace");
    fs::create_dir(&nested_workspace).unwrap();
    assert!(matches!(
        prepare_capsule_filesystem(CapsuleFilesystemSpec {
            workspace: &nested_workspace,
            runtime_home: &runtime_home,
            process_pool: pool,
        }),
        Err(CapsuleFilesystemError::InvalidLayout)
    ));

    fs::remove_dir_all(root).unwrap();
}

#[cfg(target_os = "linux")]
fn run_as(uid: u32, gid: u32, program: &str, arguments: &[&Path]) -> bool {
    use std::os::unix::process::CommandExt;

    Command::new(program)
        .args(arguments)
        .uid(uid)
        .gid(gid)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
}

/// Run this exact test as root (the cloud capsule's launch identity) to exercise real UID checks.
#[test]
#[cfg(target_os = "linux")]
fn root_capsule_permissions_enforce_writer_and_parallel_verifier_boundaries() {
    if unsafe { libc::geteuid() } != 0 {
        eprintln!("root-only capsule permission gate skipped outside the capsule identity");
        return;
    }
    use std::os::unix::fs::MetadataExt;
    use std::os::unix::fs::PermissionsExt;

    let root = temporary_root();
    fs::create_dir(&root).unwrap();
    let workspace = root.join("workspace");
    let runtime_home = root.join("runtime-home");
    let pool = HostedProcessPool::new(31_002, 31_002, 32_000, 32_000).unwrap();
    assert!(matches!(
        prepare_capsule_filesystem(CapsuleFilesystemSpec {
            workspace: &workspace,
            runtime_home: &workspace.join("."),
            process_pool: pool,
        }),
        Err(CapsuleFilesystemError::InvalidLayout)
    ));
    let prepared = prepare_capsule_filesystem(CapsuleFilesystemSpec {
        workspace: &workspace,
        runtime_home: &runtime_home,
        process_pool: pool,
    })
    .unwrap();
    let writer = pool.identity(HostedProcessScope::Writer).unwrap();
    let left = pool
        .identity(HostedProcessScope::VerifierExecution(1))
        .unwrap();
    let right = pool
        .identity(HostedProcessScope::VerifierExecution(2))
        .unwrap();

    let workspace_metadata = fs::metadata(&prepared.workspace).unwrap();
    assert_eq!(workspace_metadata.uid(), writer.uid());
    assert_eq!(workspace_metadata.permissions().mode() & 0o777, 0o755);
    let runtime_metadata = fs::metadata(&prepared.runtime_home).unwrap();
    assert_eq!(runtime_metadata.uid(), 0);
    assert_eq!(runtime_metadata.permissions().mode() & 0o777, 0o711);

    let writer_directory = prepared.workspace.join("writer-tree");
    assert!(run_as(
        writer.uid(),
        writer.gid(),
        "/bin/mkdir",
        &[&writer_directory]
    ));
    let writer_file = writer_directory.join("product.txt");
    assert!(run_as(
        writer.uid(),
        writer.gid(),
        "/usr/bin/touch",
        &[&writer_file]
    ));
    assert!(!run_as(
        left.uid(),
        left.gid(),
        "/usr/bin/touch",
        &[&writer_file]
    ));
    assert!(!run_as(
        right.uid(),
        right.gid(),
        "/usr/bin/touch",
        &[&writer_directory.join("verifier-created")]
    ));
    assert!(!run_as(
        left.uid(),
        left.gid(),
        "/bin/mkdir",
        &[&prepared.runtime_home.join("escaped")]
    ));

    let left_home = left.prepare_private_home(&prepared.runtime_home).unwrap();
    let right_home = right.prepare_private_home(&prepared.runtime_home).unwrap();
    assert_ne!(left.uid(), right.uid());
    let mut left_child = verifier_isolation_child(left.uid(), left.gid(), &left_home, &right_home);
    let mut right_child =
        verifier_isolation_child(right.uid(), right.gid(), &right_home, &left_home);
    assert!(left_child.wait().unwrap().success());
    assert!(right_child.wait().unwrap().success());
    assert!(left_home.join("own").exists());
    assert!(right_home.join("own").exists());
    assert!(!left_home.join("stolen").exists());
    assert!(!right_home.join("stolen").exists());

    fs::remove_dir_all(root).unwrap();
}

#[cfg(target_os = "linux")]
fn verifier_isolation_child(
    uid: u32,
    gid: u32,
    own_home: &Path,
    peer_home: &Path,
) -> std::process::Child {
    use std::os::unix::process::CommandExt;

    Command::new("/bin/sh")
        .arg("-c")
        .arg("touch \"$OWN/own\"; ! touch \"$PEER/stolen\"")
        .env_clear()
        .env("OWN", own_home)
        .env("PEER", peer_home)
        .uid(uid)
        .gid(gid)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap()
}
