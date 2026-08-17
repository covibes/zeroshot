//! Private controller-to-capsule node execution boundary for native v2.
//!
//! The public OECP protocol remains run-oriented. This transport-neutral seam is deliberately
//! private to the allocated capsule: one start produces a safe output stream and exactly one
//! normalized terminal event. A broken stream is terminal and is never retried or replaced.

use std::fs;
use std::future::Future;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use openengine_cluster_protocol::RunId;
use serde::{Deserialize, Serialize};
use tokio::sync::{Mutex, mpsc, watch};

use crate::execution::process::{HostedProcessPool, HostedProcessScope};
use crate::native_v2_contract::{ExecutionRef, NodeCompletion};
use crate::native_v2_runner::{
    LiveOutput, LiveOutputStream, NodeHandle, NodeRunRequest, NodeRunner, NodeRunnerError,
    RemoteNodeHandleBridge, remote_node_handle,
};

const CONTROL_RPC_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CapsuleOutputStream {
    Output,
    Error,
    System,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CapsuleOutput {
    pub stream: CapsuleOutputStream,
    pub text: String,
}

impl CapsuleOutput {
    fn into_live(self) -> Result<LiveOutput, NodeRunnerError> {
        let stream = match self.stream {
            CapsuleOutputStream::Output => LiveOutputStream::Output,
            CapsuleOutputStream::Error => LiveOutputStream::Error,
            CapsuleOutputStream::System => LiveOutputStream::System,
        };
        LiveOutput::new(stream, self.text)
    }
}

impl From<LiveOutput> for CapsuleOutput {
    fn from(value: LiveOutput) -> Self {
        let stream = match value.stream {
            LiveOutputStream::Output => CapsuleOutputStream::Output,
            LiveOutputStream::Error => CapsuleOutputStream::Error,
            LiveOutputStream::System => CapsuleOutputStream::System,
        };
        Self {
            stream,
            text: value.text,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CapsuleNodeFailure {
    Cancelled,
    SessionLost,
    RunClosed,
    ExecutionActive,
    ExecutionFailed,
}

impl CapsuleNodeFailure {
    fn from_runner(error: &NodeRunnerError) -> Self {
        match error {
            NodeRunnerError::Cancelled => Self::Cancelled,
            NodeRunnerError::SessionLost => Self::SessionLost,
            NodeRunnerError::RunClosed => Self::RunClosed,
            NodeRunnerError::ExecutionActive => Self::ExecutionActive,
            _ => Self::ExecutionFailed,
        }
    }

    fn into_runner(self) -> NodeRunnerError {
        match self {
            Self::Cancelled => NodeRunnerError::Cancelled,
            Self::SessionLost => NodeRunnerError::SessionLost,
            Self::RunClosed => NodeRunnerError::RunClosed,
            Self::ExecutionActive => NodeRunnerError::ExecutionActive,
            Self::ExecutionFailed => NodeRunnerError::Driver,
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields, tag = "kind", rename_all = "snake_case")]
pub enum CapsuleNodeEvent {
    Output { output: CapsuleOutput },
    Completed { completion: NodeCompletion },
    Failed { failure: CapsuleNodeFailure },
}

pub struct CapsuleExecutionStream {
    events: mpsc::UnboundedReceiver<CapsuleNodeEvent>,
}

impl CapsuleExecutionStream {
    #[must_use]
    pub fn from_receiver(events: mpsc::UnboundedReceiver<CapsuleNodeEvent>) -> Self {
        Self { events }
    }

    pub async fn recv(&mut self) -> Option<CapsuleNodeEvent> {
        self.events.recv().await
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
pub enum CapsuleConnectionError {
    #[error("the capsule connection was lost")]
    Lost,
    #[error("the capsule rejected node execution")]
    Rejected(CapsuleNodeFailure),
}

#[async_trait]
pub trait CapsuleNodeChannel: Send + Sync {
    async fn start(
        &self,
        request: NodeRunRequest,
    ) -> Result<CapsuleExecutionStream, CapsuleConnectionError>;

    async fn cancel(&self, reference: &ExecutionRef) -> Result<(), CapsuleConnectionError>;

    /// Closes the run and returns only after capsule-side node cleanup has completed.
    async fn close_run(&self, run_id: &RunId) -> Result<(), CapsuleConnectionError>;

    fn connection_loss(&self) -> watch::Receiver<bool>;
}

#[derive(Clone)]
pub struct RemoteCapsuleNodeRunner {
    channel: Arc<dyn CapsuleNodeChannel>,
    connection_loss: watch::Receiver<bool>,
    loss: RunnerLoss,
    activity: ProxyActivity,
    control_timeout: Duration,
}

impl RemoteCapsuleNodeRunner {
    #[must_use]
    pub fn new(channel: Arc<dyn CapsuleNodeChannel>) -> Self {
        let channel_loss = channel.connection_loss();
        let initially_lost = connection_is_lost(&channel_loss);
        let (loss, connection_loss) = RunnerLoss::new(initially_lost);
        if !initially_lost {
            let forward = loss.clone();
            tokio::spawn(async move {
                let mut channel_loss = channel_loss;
                wait_for_connection_loss(&mut channel_loss).await;
                forward.promote();
            });
        }
        Self {
            channel,
            connection_loss,
            loss,
            activity: ProxyActivity::default(),
            control_timeout: CONTROL_RPC_TIMEOUT,
        }
    }

    #[cfg(test)]
    fn with_control_timeout(mut self, timeout: Duration) -> Self {
        self.control_timeout = timeout;
        self
    }

    #[must_use]
    pub fn connection_loss(&self) -> watch::Receiver<bool> {
        self.connection_loss.clone()
    }
}

#[async_trait]
impl NodeRunner for RemoteCapsuleNodeRunner {
    async fn start(&self, request: NodeRunRequest) -> Result<NodeHandle, NodeRunnerError> {
        if connection_is_lost(&self.connection_loss) {
            return Err(NodeRunnerError::ConnectionLost);
        }
        let reference = request.invocation.reference.clone();
        let mut connection_loss = self.connection_loss.clone();
        let start = self.channel.start(request);
        tokio::pin!(start);
        let stream = tokio::select! {
            result = &mut start => match result {
                Ok(stream) => stream,
                Err(CapsuleConnectionError::Lost) => {
                    self.loss.promote();
                    return Err(NodeRunnerError::ConnectionLost);
                }
                Err(CapsuleConnectionError::Rejected(failure)) => {
                    return Err(failure.into_runner());
                }
            },
            () = wait_for_connection_loss(&mut connection_loss) => {
                return Err(NodeRunnerError::ConnectionLost);
            }
        };
        let (handle, bridge) = remote_node_handle(reference.clone());
        let registration = self.activity.register(reference.clone()).await;
        let runtime = ProxyRuntime {
            channel: self.channel.clone(),
            connection_loss: self.connection_loss.clone(),
            loss: self.loss.clone(),
            activity: self.activity.clone(),
            control_timeout: self.control_timeout,
        };
        tokio::spawn(drive_remote_execution(RemoteExecutionTask {
            runtime,
            reference,
            stream,
            bridge,
            registration,
        }));
        Ok(handle)
    }

    async fn close_run(&self, run_id: &RunId) {
        let mut connection_loss = self.connection_loss.clone();
        let closed = control_rpc(
            self.channel.close_run(run_id),
            &mut connection_loss,
            self.control_timeout,
        )
        .await;
        if !closed {
            self.loss.promote();
            self.activity.lose_run(run_id).await;
        }
        if tokio::time::timeout(self.control_timeout, self.activity.wait_run(run_id))
            .await
            .is_err()
        {
            self.loss.promote();
            self.activity.lose_run(run_id).await;
            let _ =
                tokio::time::timeout(self.control_timeout, self.activity.wait_run(run_id)).await;
        }
    }
}

#[derive(Clone)]
struct RunnerLoss {
    raised: Arc<AtomicBool>,
    signal: watch::Sender<bool>,
}

impl RunnerLoss {
    fn new(initially_lost: bool) -> (Self, watch::Receiver<bool>) {
        let (signal, receiver) = watch::channel(initially_lost);
        (
            Self {
                raised: Arc::new(AtomicBool::new(initially_lost)),
                signal,
            },
            receiver,
        )
    }

    fn promote(&self) {
        if self
            .raised
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
        {
            self.signal.send_replace(true);
        }
    }
}

struct ProxyRuntime {
    channel: Arc<dyn CapsuleNodeChannel>,
    connection_loss: watch::Receiver<bool>,
    loss: RunnerLoss,
    activity: ProxyActivity,
    control_timeout: Duration,
}

struct RemoteExecutionTask {
    runtime: ProxyRuntime,
    reference: ExecutionRef,
    stream: CapsuleExecutionStream,
    bridge: RemoteNodeHandleBridge,
    registration: ProxyRegistration,
}

struct RemoteEventContext<'a> {
    runtime: &'a ProxyRuntime,
    reference: &'a ExecutionRef,
    bridge: &'a mut RemoteNodeHandleBridge,
    connection_loss: &'a mut watch::Receiver<bool>,
}

enum RemoteInput {
    Event(Option<CapsuleNodeEvent>),
    Cancel,
    Lost,
}

async fn drive_remote_execution(task: RemoteExecutionTask) {
    let RemoteExecutionTask {
        runtime,
        reference,
        mut stream,
        mut bridge,
        registration,
    } = task;
    let mut local_loss = registration.loss;
    let mut cancellation_forwarded = false;
    let mut connection_loss = runtime.connection_loss.clone();
    let result = loop {
        let next = tokio::select! {
            biased;
            () = wait_for_connection_loss(&mut connection_loss) => RemoteInput::Lost,
            () = wait_for_connection_loss(&mut local_loss) => RemoteInput::Lost,
            () = bridge.cancelled(), if !cancellation_forwarded => RemoteInput::Cancel,
            event = stream.recv() => RemoteInput::Event(event),
        };
        let finished = match next {
            RemoteInput::Lost => Some(Err(NodeRunnerError::ConnectionLost)),
            RemoteInput::Cancel => {
                cancellation_forwarded = true;
                forward_cancel(&runtime, &reference, &mut connection_loss)
                    .await
                    .err()
                    .map(Err)
            }
            RemoteInput::Event(event) => {
                handle_remote_event(
                    event,
                    RemoteEventContext {
                        runtime: &runtime,
                        reference: &reference,
                        bridge: &mut bridge,
                        connection_loss: &mut connection_loss,
                    },
                )
                .await
            }
        };
        if let Some(result) = finished {
            break result;
        }
    };
    bridge.finish(result);
    let _ = registration.done.send(true);
    runtime.activity.finish(&reference).await;
}

async fn handle_remote_event(
    event: Option<CapsuleNodeEvent>,
    context: RemoteEventContext<'_>,
) -> Option<Result<NodeCompletion, NodeRunnerError>> {
    match event {
        None => {
            context.runtime.loss.promote();
            Some(Err(NodeRunnerError::ConnectionLost))
        }
        Some(CapsuleNodeEvent::Output { output }) => handle_remote_output(output, context).await,
        Some(CapsuleNodeEvent::Completed { completion })
            if completion.reference == *context.reference =>
        {
            Some(Ok(completion))
        }
        Some(CapsuleNodeEvent::Completed { .. }) => Some(Err(NodeRunnerError::Driver)),
        Some(CapsuleNodeEvent::Failed { failure }) => Some(Err(failure.into_runner())),
    }
}

async fn handle_remote_output(
    output: CapsuleOutput,
    context: RemoteEventContext<'_>,
) -> Option<Result<NodeCompletion, NodeRunnerError>> {
    let output = match output.into_live() {
        Ok(output) => output,
        Err(error) => return Some(Err(error)),
    };
    let Err(error) = context.bridge.emit(output) else {
        return None;
    };
    Some(
        match forward_cancel(context.runtime, context.reference, context.connection_loss).await {
            Ok(()) => Err(error),
            Err(connection_lost) => Err(connection_lost),
        },
    )
}

async fn forward_cancel(
    runtime: &ProxyRuntime,
    reference: &ExecutionRef,
    connection_loss: &mut watch::Receiver<bool>,
) -> Result<(), NodeRunnerError> {
    if control_rpc(
        runtime.channel.cancel(reference),
        connection_loss,
        runtime.control_timeout,
    )
    .await
    {
        Ok(())
    } else {
        runtime.loss.promote();
        Err(NodeRunnerError::ConnectionLost)
    }
}

async fn control_rpc<F>(
    operation: F,
    connection_loss: &mut watch::Receiver<bool>,
    timeout: Duration,
) -> bool
where
    F: Future<Output = Result<(), CapsuleConnectionError>>,
{
    tokio::pin!(operation);
    tokio::select! {
        biased;
        () = wait_for_connection_loss(connection_loss) => false,
        result = &mut operation => result.is_ok(),
        () = tokio::time::sleep(timeout) => false,
    }
}

fn connection_is_lost(receiver: &watch::Receiver<bool>) -> bool {
    *receiver.borrow() || receiver.has_changed().is_err()
}

async fn wait_for_connection_loss(receiver: &mut watch::Receiver<bool>) {
    while !*receiver.borrow_and_update() {
        if receiver.changed().await.is_err() {
            return;
        }
    }
}

#[derive(Clone, Default)]
struct ProxyActivity {
    entries: Arc<Mutex<Vec<ProxyExecution>>>,
}

struct ProxyExecution {
    reference: ExecutionRef,
    loss: watch::Sender<bool>,
    done: watch::Receiver<bool>,
}

impl ProxyActivity {
    async fn register(&self, reference: ExecutionRef) -> ProxyRegistration {
        let (loss, loss_receiver) = watch::channel(false);
        let (done_sender, done) = watch::channel(false);
        self.entries.lock().await.push(ProxyExecution {
            reference,
            loss,
            done,
        });
        ProxyRegistration {
            loss: loss_receiver,
            done: done_sender,
        }
    }

    async fn finish(&self, reference: &ExecutionRef) {
        let mut entries = self.entries.lock().await;
        if let Some(index) = entries
            .iter()
            .position(|entry| &entry.reference == reference)
        {
            entries.swap_remove(index);
        }
    }

    async fn lose_run(&self, run_id: &RunId) {
        let entries = self.entries.lock().await;
        for entry in entries
            .iter()
            .filter(|entry| &entry.reference.run_id == run_id)
        {
            let _ = entry.loss.send(true);
        }
    }

    async fn wait_run(&self, run_id: &RunId) {
        let mut completions = {
            let entries = self.entries.lock().await;
            entries
                .iter()
                .filter(|entry| &entry.reference.run_id == run_id)
                .map(|entry| entry.done.clone())
                .collect::<Vec<_>>()
        };
        for completion in &mut completions {
            while !*completion.borrow_and_update() {
                if completion.changed().await.is_err() {
                    break;
                }
            }
        }
    }
}

struct ProxyRegistration {
    loss: watch::Receiver<bool>,
    done: watch::Sender<bool>,
}

#[derive(Clone)]
pub struct NativeCapsuleNodeEndpoint {
    runner: Arc<dyn NodeRunner>,
    loss: watch::Sender<bool>,
    active: Arc<Mutex<Vec<EndpointExecution>>>,
}

struct EndpointExecution {
    reference: ExecutionRef,
    cancel: mpsc::UnboundedSender<()>,
    done: watch::Receiver<bool>,
}

impl NativeCapsuleNodeEndpoint {
    #[must_use]
    pub fn new(runner: Arc<dyn NodeRunner>) -> Self {
        let (loss, _) = watch::channel(false);
        Self {
            runner,
            loss,
            active: Arc::new(Mutex::new(Vec::new())),
        }
    }

    /// Breaks the private connection and waits for all capsule-side provider cleanup.
    pub async fn disconnect(&self) {
        let _ = self.loss.send(true);
        let run_ids = {
            let entries = self.active.lock().await;
            entries
                .iter()
                .map(|entry| entry.reference.run_id.clone())
                .collect::<std::collections::BTreeSet<_>>()
        };
        for run_id in run_ids {
            self.close_local_run(&run_id).await;
        }
    }

    async fn close_local_run(&self, run_id: &RunId) {
        let mut completions = {
            let entries = self.active.lock().await;
            for entry in entries
                .iter()
                .filter(|entry| &entry.reference.run_id == run_id)
            {
                let _ = entry.cancel.send(());
            }
            entries
                .iter()
                .filter(|entry| &entry.reference.run_id == run_id)
                .map(|entry| entry.done.clone())
                .collect::<Vec<_>>()
        };
        self.runner.close_run(run_id).await;
        for completion in &mut completions {
            while !*completion.borrow_and_update() {
                if completion.changed().await.is_err() {
                    break;
                }
            }
        }
    }
}

#[async_trait]
impl CapsuleNodeChannel for NativeCapsuleNodeEndpoint {
    async fn start(
        &self,
        request: NodeRunRequest,
    ) -> Result<CapsuleExecutionStream, CapsuleConnectionError> {
        if *self.loss.borrow() {
            return Err(CapsuleConnectionError::Lost);
        }
        let mut handle = self.runner.start(request).await.map_err(|error| {
            CapsuleConnectionError::Rejected(CapsuleNodeFailure::from_runner(&error))
        })?;
        let reference = handle.reference().clone();
        let Some(durable) = handle.take_initial_output() else {
            handle.cancel();
            let _ = handle.completion().await;
            return Err(CapsuleConnectionError::Rejected(
                CapsuleNodeFailure::ExecutionFailed,
            ));
        };
        // Provider output is capped by the harness, so this lossless queue is bounded by that
        // cap while keeping cancellation and cleanup independent of a slow controller reader.
        let (events, receiver) = mpsc::unbounded_channel();
        let (cancel, commands) = mpsc::unbounded_channel();
        let (done_sender, done) = watch::channel(false);
        {
            let mut active = self.active.lock().await;
            if *self.loss.borrow() {
                handle.cancel();
                drop(active);
                let _ = handle.completion().await;
                return Err(CapsuleConnectionError::Lost);
            }
            active.push(EndpointExecution {
                reference: reference.clone(),
                cancel,
                done,
            });
        }
        let active = self.active.clone();
        tokio::spawn(serve_local_execution(LocalExecutionTask {
            handle,
            durable,
            commands,
            events,
            active,
            reference,
            done: done_sender,
        }));
        Ok(CapsuleExecutionStream::from_receiver(receiver))
    }

    async fn cancel(&self, reference: &ExecutionRef) -> Result<(), CapsuleConnectionError> {
        if *self.loss.borrow() {
            return Err(CapsuleConnectionError::Lost);
        }
        let entries = self.active.lock().await;
        if let Some(entry) = entries.iter().find(|entry| &entry.reference == reference) {
            let _ = entry.cancel.send(());
        }
        Ok(())
    }

    async fn close_run(&self, run_id: &RunId) -> Result<(), CapsuleConnectionError> {
        if *self.loss.borrow() {
            return Err(CapsuleConnectionError::Lost);
        }
        self.close_local_run(run_id).await;
        Ok(())
    }

    fn connection_loss(&self) -> watch::Receiver<bool> {
        self.loss.subscribe()
    }
}

struct LocalExecutionTask {
    handle: NodeHandle,
    durable: crate::native_v2_runner::DurableOutput,
    commands: mpsc::UnboundedReceiver<()>,
    events: mpsc::UnboundedSender<CapsuleNodeEvent>,
    active: Arc<Mutex<Vec<EndpointExecution>>>,
    reference: ExecutionRef,
    done: watch::Sender<bool>,
}

enum LocalInput {
    Completion(Result<NodeCompletion, NodeRunnerError>),
    Output(Result<LiveOutput, crate::native_v2_runner::AttachReceiveError>),
    Cancel,
}

struct LocalAwait {
    completion: bool,
    output: bool,
    command: bool,
}

struct LocalOutputContext<'a> {
    events: &'a mpsc::UnboundedSender<CapsuleNodeEvent>,
    handle: &'a mut NodeHandle,
    output_closed: &'a mut bool,
    consumer_gone: &'a mut bool,
}

async fn serve_local_execution(task: LocalExecutionTask) {
    let LocalExecutionTask {
        mut handle,
        mut durable,
        mut commands,
        events,
        active,
        reference,
        done,
    } = task;
    let mut completion = None;
    let mut output_closed = false;
    let mut consumer_gone = false;
    while local_execution_pending(&completion, output_closed) {
        let next = next_local_input(
            &mut handle,
            &mut durable,
            &mut commands,
            LocalAwait {
                completion: completion.is_none(),
                output: !output_closed,
                command: !consumer_gone,
            },
        )
        .await;
        match next {
            LocalInput::Completion(result) => completion = Some(result),
            LocalInput::Output(output) => apply_local_output(
                output,
                LocalOutputContext {
                    events: &events,
                    handle: &mut handle,
                    output_closed: &mut output_closed,
                    consumer_gone: &mut consumer_gone,
                },
            ),
            LocalInput::Cancel => handle.cancel(),
        }
    }
    send_local_completion(&events, completion, consumer_gone);
    remove_endpoint_execution(&active, &reference).await;
    let _ = done.send(true);
}

fn local_execution_pending(
    completion: &Option<Result<NodeCompletion, NodeRunnerError>>,
    output_closed: bool,
) -> bool {
    completion.is_none() || !output_closed
}

async fn next_local_input(
    handle: &mut NodeHandle,
    durable: &mut crate::native_v2_runner::DurableOutput,
    commands: &mut mpsc::UnboundedReceiver<()>,
    awaiting: LocalAwait,
) -> LocalInput {
    tokio::select! {
        result = handle.completion(), if awaiting.completion => LocalInput::Completion(result),
        output = durable.recv(), if awaiting.output => LocalInput::Output(output),
        _ = commands.recv(), if awaiting.command => LocalInput::Cancel,
    }
}

fn apply_local_output(
    output: Result<LiveOutput, crate::native_v2_runner::AttachReceiveError>,
    context: LocalOutputContext<'_>,
) {
    let Ok(output) = output else {
        *context.output_closed = true;
        return;
    };
    if context
        .events
        .send(CapsuleNodeEvent::Output {
            output: output.into(),
        })
        .is_err()
    {
        *context.consumer_gone = true;
        context.handle.cancel();
    }
}

fn send_local_completion(
    events: &mpsc::UnboundedSender<CapsuleNodeEvent>,
    completion: Option<Result<NodeCompletion, NodeRunnerError>>,
    consumer_gone: bool,
) {
    if consumer_gone {
        return;
    }
    let event = match completion.expect("loop requires a completion") {
        Ok(completion) => CapsuleNodeEvent::Completed { completion },
        Err(error) => CapsuleNodeEvent::Failed {
            failure: CapsuleNodeFailure::from_runner(&error),
        },
    };
    let _ = events.send(event);
}

async fn remove_endpoint_execution(
    active: &Mutex<Vec<EndpointExecution>>,
    reference: &ExecutionRef,
) {
    let mut entries = active.lock().await;
    if let Some(index) = entries
        .iter()
        .position(|entry| &entry.reference == reference)
    {
        entries.swap_remove(index);
    }
}

pub struct CapsuleFilesystemSpec<'a> {
    pub workspace: &'a Path,
    pub runtime_home: &'a Path,
    pub process_pool: HostedProcessPool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CapsuleFilesystem {
    pub workspace: PathBuf,
    pub runtime_home: PathBuf,
}

/// Establishes the capsule's role-aware Linux filesystem boundary.
///
/// The single writer owns the shared workspace. Distinct verifier UIDs receive read/traverse but
/// no mutation authority. The runtime root remains root-owned and non-writable; provider-specific
/// private homes are created beneath it by [`HostedProcessPool`] identities.
pub fn prepare_capsule_filesystem(
    specification: CapsuleFilesystemSpec<'_>,
) -> Result<CapsuleFilesystem, CapsuleFilesystemError> {
    if specification.workspace == specification.runtime_home {
        return Err(CapsuleFilesystemError::InvalidLayout);
    }
    prepare_directory(specification.workspace)?;
    prepare_directory(specification.runtime_home)?;
    let workspace =
        fs::canonicalize(specification.workspace).map_err(CapsuleFilesystemError::Prepare)?;
    let runtime_home =
        fs::canonicalize(specification.runtime_home).map_err(CapsuleFilesystemError::Prepare)?;
    if paths_overlap(&workspace, &runtime_home) {
        return Err(CapsuleFilesystemError::InvalidLayout);
    }
    let writer = specification
        .process_pool
        .identity(HostedProcessScope::Writer)
        .map_err(|_| CapsuleFilesystemError::InvalidIdentity)?;
    set_directory_boundary(&workspace, 0o755, writer.uid(), writer.gid())?;
    set_directory_boundary(&runtime_home, 0o711, 0, 0)?;
    Ok(CapsuleFilesystem {
        workspace,
        runtime_home,
    })
}

fn paths_overlap(left: &Path, right: &Path) -> bool {
    left.starts_with(right) || right.starts_with(left)
}

#[derive(Debug, thiserror::Error)]
pub enum CapsuleFilesystemError {
    #[error("capsule filesystem paths must be disjoint directories")]
    InvalidLayout,
    #[error("capsule process identities are invalid")]
    InvalidIdentity,
    #[error("capsule filesystem boundary could not be prepared")]
    Prepare(#[source] io::Error),
    #[error("capsule filesystem preparation requires Linux")]
    Unsupported,
}

fn prepare_directory(path: &Path) -> Result<(), CapsuleFilesystemError> {
    match fs::create_dir(path) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(CapsuleFilesystemError::Prepare(error)),
    }
    let metadata = fs::symlink_metadata(path).map_err(CapsuleFilesystemError::Prepare)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(CapsuleFilesystemError::InvalidLayout);
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn set_directory_boundary(
    path: &Path,
    mode: u32,
    uid: u32,
    gid: u32,
) -> Result<(), CapsuleFilesystemError> {
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::fs::PermissionsExt;

    fs::set_permissions(path, fs::Permissions::from_mode(mode))
        .map_err(CapsuleFilesystemError::Prepare)?;
    let path = std::ffi::CString::new(path.as_os_str().as_bytes())
        .map_err(|_| CapsuleFilesystemError::InvalidLayout)?;
    // SAFETY: `path` is a live NUL-free C string and the IDs come from the validated pool.
    if unsafe { libc::chown(path.as_ptr(), uid, gid) } != 0 {
        return Err(CapsuleFilesystemError::Prepare(io::Error::last_os_error()));
    }
    Ok(())
}

#[cfg(not(target_os = "linux"))]
fn set_directory_boundary(
    _path: &Path,
    _mode: u32,
    _uid: u32,
    _gid: u32,
) -> Result<(), CapsuleFilesystemError> {
    Err(CapsuleFilesystemError::Unsupported)
}

#[cfg(test)]
#[path = "native_v2_capsule/tests.rs"]
mod tests;
