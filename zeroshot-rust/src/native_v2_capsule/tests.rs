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
use crate::native_v2_contract::{self, NodeInvocation, NodeRuntimeBinding};
use crate::native_v2_runner::{ResolvedEnvironment, remote_node_handle};
use crate::worker_catalog::{self, ReasoningEffort};

fn request(run: &str, execution: u64) -> NodeRunRequest {
    let binding = NodeRuntimeBinding::Agent {
        model: worker_catalog::ModelId::new("gpt-5.6").assert_value(),
        effort: Some(ReasoningEffort::Max),
        session_scope: SessionScope::Execution,
        env: BTreeSet::new(),
    };
    let environment = ResolvedEnvironment::exact(&binding, BTreeMap::new()).assert_value();
    NodeRunRequest {
        invocation: NodeInvocation {
            reference: ExecutionRef {
                run_id: RunId::new(run),
                node: NodeName::new("worker").assert_value(),
                node_instance: native_v2_contract::NodeInstanceId::new(execution).assert_value(),
                execution: native_v2_contract::ExecutionId::new(execution).assert_value(),
            },
            worker: WorkerRef::new("agent.worker@1").assert_value(),
            input: Value::Null,
            binding: binding.clone(),
        },
        environment,
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
                        .emit(LiveOutput::new(LiveOutputStream::Output, "working").assert_value())
                        .assert_value();
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
    let mut handle = proxy.start(request("roundtrip", 1)).await.assert_value();
    let mut durable = handle.take_initial_output().assert_value();
    let mut live = handle.attach();
    local.proceed.notify_one();

    let durable_output = durable.recv().await.assert_value();
    let live_output = live.recv().await.assert_value();
    assert_eq!(durable_output.text, "working");
    assert_eq!(live_output, durable_output);
    let completion = handle.completion().await.assert_value();
    assert_eq!(
        completion.reference.execution,
        native_v2_contract::ExecutionId::new(1).assert_value()
    );
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
    let mut handle = proxy.start(request("close", 1)).await.assert_value();
    local.started.notified().await;

    proxy.close_run(&RunId::new("close")).await;

    assert!(local.cleaned.load(Ordering::SeqCst));
    assert_eq!(
        handle.completion().await.assert_error(),
        NodeRunnerError::Cancelled
    );
}

#[tokio::test]
async fn connection_loss_is_terminal_and_cleans_capsule_execution() {
    let local = Arc::new(TestRunner::default());
    let endpoint = Arc::new(NativeCapsuleNodeEndpoint::new(local.clone()));
    let proxy = RemoteCapsuleNodeRunner::new(endpoint.clone());
    let mut loss = proxy.connection_loss();
    let mut handle = proxy.start(request("lost", 1)).await.assert_value();
    local.started.notified().await;

    endpoint.disconnect().await;

    loss.changed().await.assert_value();
    assert!(*loss.borrow());
    assert!(local.cleaned.load(Ordering::SeqCst));
    assert_eq!(
        handle.completion().await.assert_error(),
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
    let mut handle = proxy.start(request("stream-close", 1)).await.assert_value();
    assert_eq!(
        handle.completion().await.assert_error(),
        NodeRunnerError::ConnectionLost
    );
    loss.changed().await.assert_value();
    assert!(*loss.borrow_and_update());
    assert!(!loss.has_changed().assert_value());
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
        self.streams.lock().assert_value().push(events);
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
    let mut handle = proxy.start(request("cancel-hangs", 1)).await.assert_value();

    handle.cancel();
    let result = tokio::time::timeout(Duration::from_secs(1), handle.completion())
        .await
        .assert_value_with("hanging cancel must be bounded");

    assert_eq!(result, Err(NodeRunnerError::ConnectionLost));
    assert!(*loss.borrow());
}

#[tokio::test]
async fn hanging_close_is_bounded_and_promotes_loss() {
    let proxy = hanging_proxy();
    let loss = proxy.connection_loss();
    let mut handle = proxy.start(request("close-hangs", 1)).await.assert_value();

    tokio::time::timeout(
        Duration::from_secs(1),
        proxy.close_run(&RunId::new("close-hangs")),
    )
    .await
    .assert_value_with("hanging close must be bounded");

    assert!(*loss.borrow());
    assert_eq!(
        handle.completion().await,
        Err(NodeRunnerError::ConnectionLost)
    );
}

static TEMP_ID: AtomicU64 = AtomicU64::new(1);

#[path = "tests/filesystem.rs"]
mod filesystem;

use openengine_cluster_testkit::assertions::{AssertValue, AssertError};
