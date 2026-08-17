//! Ledger-backed native-v2 status, watch, logs, and live read-only attach.
//!
//! Durable observation is reconstructed exclusively from the lean run ledger. Live attach is a
//! deliberately separate, active-execution-only stream: it has no cursor, stores no history, and
//! cannot signal or cancel an execution when a viewer disconnects.

use std::collections::{BTreeMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use async_trait::async_trait;
use openengine_cluster_protocol::{
    ActiveExecution, AgentAttachEvent, BoundedAssistantOutput, BoundedLogMessage, BoundedLogTarget,
    Cursor, ExecutionRef as PublicExecutionRef, LogLevel, LogRecord, RunAttachEventNotification,
    RunAttachParams, RunAttachResult, RunId, RunLogEventNotification, RunLogsParams, RunLogsResult,
    RunStatus, RunStatusParams, RunStatusResult, RunWatchEventNotification, RunWatchParams,
    RunWatchResult, SubscriptionId,
};
use sha2::{Digest, Sha256};
use thiserror::Error;

use crate::native_v2_contract::{ExecutionId, ExecutionRef};
use crate::native_v2_runner::{AttachReceiveError, LiveOutputSource, ReadOnlyAttach};
use crate::native_v2_supervisor::{LiveOutputRegistrar, LiveOutputRegistration, LiveOutputUnavailable};
use crate::v2_run_ledger::{
    apply_event, cursor_sequence, initial_cursor, NodeState, RunEvent, RunLedger, RunLedgerError,
    RunPhase, RunSnapshot, SafeLogStream, StoredRunEvent,
};

const POLL_INTERVAL: Duration = Duration::from_millis(25);
const LOG_TARGET: &str = "agent";

#[cfg(test)]
#[path = "native_v2_observability/tests.rs"]
mod tests;

#[derive(Clone)]
pub struct NativeV2Observability {
    ledger: Arc<dyn RunLedger>,
    live: LiveRegistry,
    next_subscription: Arc<AtomicU64>,
}

impl NativeV2Observability {
    #[must_use]
    pub fn new(ledger: Arc<dyn RunLedger>) -> Self {
        Self {
            ledger,
            live: LiveRegistry::default(),
            next_subscription: Arc::new(AtomicU64::new(1)),
        }
    }

    pub async fn status(
        &self,
        params: RunStatusParams,
    ) -> Result<RunStatusResult, NativeV2ObservationError> {
        let stored = self
            .ledger
            .get(&params.run_id)
            .await?
            .ok_or(NativeV2ObservationError::RunNotFound)?;
        status_result(&stored.snapshot)
    }

    pub async fn watch(
        &self,
        params: RunWatchParams,
    ) -> Result<(RunWatchResult, RunWatchSubscription), NativeV2ObservationError> {
        let start = params.from_cursor.unwrap_or_else(initial_cursor);
        let subscription_id = self.subscription_id("watch");
        let complete = self.ledger.snapshot_and_tail(&params.run_id, None).await?;
        let start_sequence = cursor_sequence(&start)?;
        if start_sequence > cursor_sequence(&complete.snapshot.cursor)? {
            return Err(RunLedgerError::CursorAhead.into());
        }
        let mut projection = RunSnapshot::admitted(params.run_id.clone());
        let mut pending = VecDeque::new();
        WatchFold {
            subscription_id: &subscription_id,
            after: start_sequence,
            projection: &mut projection,
            pending: &mut pending,
        }
        .apply(&complete.events)?;
        let result = RunWatchResult {
            subscription_id: subscription_id.clone(),
            run_id: params.run_id.clone(),
            at_cursor: start.clone(),
        };
        let subscription = RunWatchSubscription {
            ledger: self.ledger.clone(),
            subscription_id,
            run_id: params.run_id,
            scanned_through: complete.snapshot.cursor,
            projection,
            pending,
        };
        Ok((result, subscription))
    }

    pub async fn logs(
        &self,
        params: RunLogsParams,
    ) -> Result<(RunLogsResult, RunLogsSubscription), NativeV2ObservationError> {
        let start = params.from_cursor.unwrap_or_else(initial_cursor);
        let tail = self
            .ledger
            .snapshot_and_tail(&params.run_id, Some(&start))
            .await?;
        let execution = params
            .execution
            .as_ref()
            .map(|public| resolve_public_execution(&tail.snapshot, public))
            .transpose()?;
        let subscription_id = self.subscription_id("logs");
        let result = RunLogsResult {
            subscription_id: subscription_id.clone(),
            run_id: params.run_id.clone(),
            at_cursor: start.clone(),
        };
        let pending = tail
            .events
            .iter()
            .filter_map(|stored| {
                log_notification(&subscription_id, &tail.snapshot, execution, stored).transpose()
            })
            .collect::<Result<VecDeque<_>, _>>()?;
        let subscription = RunLogsSubscription {
            ledger: self.ledger.clone(),
            subscription_id,
            run_id: params.run_id,
            execution,
            scanned_through: tail.snapshot.cursor,
            pending,
        };
        Ok((result, subscription))
    }

    /// Registers one active runner output source for live read-only attach.
    ///
    /// Durable output remains owned by the supervisor and run ledger. The returned registration
    /// is explicitly closed after completion; neither it nor any attached viewer owns execution.
    pub async fn register_live_execution(
        &self,
        reference: &ExecutionRef,
        source: LiveOutputSource,
    ) -> Result<LiveExecutionRegistration, NativeV2ObservationError> {
        let stored = self
            .ledger
            .get(&reference.run_id)
            .await?
            .ok_or(NativeV2ObservationError::RunNotFound)?;
        require_active_reference(&stored.snapshot, reference)?;
        let public_execution = opaque_execution(reference);
        let key = self
            .live
            .register(reference.run_id.clone(), public_execution.clone(), source)
            .await?;
        Ok(LiveExecutionRegistration {
            registry: self.live.clone(),
            key: Some(key),
            public_execution,
        })
    }

    pub async fn attach(
        &self,
        params: RunAttachParams,
    ) -> Result<(RunAttachResult, RunAttachSubscription), NativeV2ObservationError> {
        let stored = self
            .ledger
            .get(&params.run_id)
            .await?
            .ok_or(NativeV2ObservationError::RunNotFound)?;
        let execution = resolve_public_execution(&stored.snapshot, &params.execution)?;
        let node = stored
            .snapshot
            .executions
            .get(&execution)
            .ok_or(NativeV2ObservationError::ExecutionNotFound)?;
        if !matches!(node.state, NodeState::Active) {
            return Err(NativeV2ObservationError::ExecutionNotActive);
        }
        let receiver = self
            .live
            .subscribe(&params.run_id, &params.execution)
            .await
            .ok_or(NativeV2ObservationError::ExecutionNotLive)?;
        let subscription_id = self.subscription_id("attach");
        let result = RunAttachResult {
            subscription_id: subscription_id.clone(),
            run_id: params.run_id.clone(),
            execution: params.execution.clone(),
        };
        let subscription = RunAttachSubscription {
            subscription_id,
            run_id: params.run_id,
            execution: params.execution,
            initial_working: true,
            settled: false,
            receiver,
        };
        Ok((result, subscription))
    }

    fn subscription_id(&self, kind: &str) -> SubscriptionId {
        let sequence = self.next_subscription.fetch_add(1, Ordering::Relaxed);
        SubscriptionId::new(format!("v2-{kind}-{sequence}"))
    }
}

#[derive(Debug, Error)]
pub enum NativeV2ObservationError {
    #[error("run was not found")]
    RunNotFound,
    #[error("execution selector was not found in the run")]
    ExecutionNotFound,
    #[error("execution is not active")]
    ExecutionNotActive,
    #[error("execution has no live attach source")]
    ExecutionNotLive,
    #[error("live execution is already registered")]
    AlreadyLive,
    #[error("live attach fell behind; reconnect through durable logs")]
    AttachLagged,
    #[error("live attach is closed")]
    AttachClosed,
    #[error("durable run state is inconsistent")]
    InvalidState,
    #[error(transparent)]
    Ledger(#[from] RunLedgerError),
}

pub struct LiveExecutionRegistration {
    registry: LiveRegistry,
    key: Option<LiveKey>,
    public_execution: PublicExecutionRef,
}

impl LiveExecutionRegistration {
    #[must_use]
    pub fn public_execution(&self) -> &PublicExecutionRef {
        &self.public_execution
    }

    pub async fn close(mut self) {
        if let Some(key) = self.key.take() {
            self.registry.remove(&key);
        }
    }
}

impl Drop for LiveExecutionRegistration {
    fn drop(&mut self) {
        if let Some(key) = self.key.take() {
            self.registry.remove(&key);
        }
    }
}

#[async_trait]
impl LiveOutputRegistrar for NativeV2Observability {
    async fn register(
        &self,
        reference: &ExecutionRef,
        source: LiveOutputSource,
    ) -> Result<Box<dyn LiveOutputRegistration>, LiveOutputUnavailable> {
        NativeV2Observability::register_live_execution(self, reference, source)
            .await
            .map(|registration| Box::new(registration) as Box<dyn LiveOutputRegistration>)
            .map_err(|_| LiveOutputUnavailable)
    }
}

#[async_trait]
impl LiveOutputRegistration for LiveExecutionRegistration {
    async fn close(self: Box<Self>) {
        LiveExecutionRegistration::close(*self).await;
    }
}

pub struct RunWatchSubscription {
    ledger: Arc<dyn RunLedger>,
    subscription_id: SubscriptionId,
    run_id: RunId,
    scanned_through: Cursor,
    projection: RunSnapshot,
    pending: VecDeque<RunWatchEventNotification>,
}

impl RunWatchSubscription {
    /// Returns all status transitions currently durable after the exclusive resume cursor.
    pub async fn read_available(
        &mut self,
    ) -> Result<Vec<RunWatchEventNotification>, NativeV2ObservationError> {
        self.refresh().await?;
        Ok(self.pending.drain(..).collect())
    }

    /// Waits for the next durable status transition. Dropping this value only stops observation.
    pub async fn recv(
        &mut self,
    ) -> Result<Option<RunWatchEventNotification>, NativeV2ObservationError> {
        recv_durable(self).await
    }

    async fn refresh(&mut self) -> Result<bool, NativeV2ObservationError> {
        let tail = self
            .ledger
            .snapshot_and_tail(&self.run_id, Some(&self.scanned_through))
            .await?;
        WatchFold {
            subscription_id: &self.subscription_id,
            after: cursor_sequence(&self.scanned_through)?,
            projection: &mut self.projection,
            pending: &mut self.pending,
        }
        .apply(&tail.events)?;
        self.scanned_through = tail.snapshot.cursor;
        Ok(tail.snapshot.terminal.is_some())
    }
}

pub struct RunLogsSubscription {
    ledger: Arc<dyn RunLedger>,
    subscription_id: SubscriptionId,
    run_id: RunId,
    execution: Option<ExecutionId>,
    scanned_through: Cursor,
    pending: VecDeque<RunLogEventNotification>,
}

impl RunLogsSubscription {
    /// Returns every currently durable matching log strictly after the resume cursor.
    pub async fn read_available(
        &mut self,
    ) -> Result<Vec<RunLogEventNotification>, NativeV2ObservationError> {
        self.refresh().await?;
        Ok(self.pending.drain(..).collect())
    }

    pub async fn recv(
        &mut self,
    ) -> Result<Option<RunLogEventNotification>, NativeV2ObservationError> {
        recv_durable(self).await
    }

    async fn refresh(&mut self) -> Result<bool, NativeV2ObservationError> {
        let tail = self
            .ledger
            .snapshot_and_tail(&self.run_id, Some(&self.scanned_through))
            .await?;
        for stored in &tail.events {
            if let Some(notification) = log_notification(
                &self.subscription_id,
                &tail.snapshot,
                self.execution,
                stored,
            )? {
                self.pending.push_back(notification);
            }
        }
        self.scanned_through = tail.snapshot.cursor;
        Ok(tail.snapshot.terminal.is_some())
    }
}

#[async_trait]
trait DurableSubscription {
    type Notification: Send;

    fn pending(&mut self) -> &mut VecDeque<Self::Notification>;
    async fn refresh_subscription(&mut self) -> Result<bool, NativeV2ObservationError>;
}

#[async_trait]
impl DurableSubscription for RunWatchSubscription {
    type Notification = RunWatchEventNotification;

    fn pending(&mut self) -> &mut VecDeque<Self::Notification> {
        &mut self.pending
    }

    async fn refresh_subscription(&mut self) -> Result<bool, NativeV2ObservationError> {
        self.refresh().await
    }
}

#[async_trait]
impl DurableSubscription for RunLogsSubscription {
    type Notification = RunLogEventNotification;

    fn pending(&mut self) -> &mut VecDeque<Self::Notification> {
        &mut self.pending
    }

    async fn refresh_subscription(&mut self) -> Result<bool, NativeV2ObservationError> {
        self.refresh().await
    }
}

async fn recv_durable<S>(
    subscription: &mut S,
) -> Result<Option<S::Notification>, NativeV2ObservationError>
where
    S: DurableSubscription + Send,
{
    loop {
        if let Some(event) = subscription.pending().pop_front() {
            return Ok(Some(event));
        }
        let terminal = subscription.refresh_subscription().await?;
        if let Some(event) = subscription.pending().pop_front() {
            return Ok(Some(event));
        }
        if terminal {
            return Ok(None);
        }
        tokio::time::sleep(POLL_INTERVAL).await;
    }
}

pub struct RunAttachSubscription {
    subscription_id: SubscriptionId,
    run_id: RunId,
    execution: PublicExecutionRef,
    initial_working: bool,
    settled: bool,
    receiver: ReadOnlyAttach,
}

impl RunAttachSubscription {
    pub async fn recv(&mut self) -> Result<RunAttachEventNotification, NativeV2ObservationError> {
        let event = if self.initial_working {
            self.initial_working = false;
            AgentAttachEvent::Working {}
        } else {
            match self.receiver.recv().await {
                Ok(output) => AgentAttachEvent::Output {
                    text: bounded_attach_output(&output.text),
                },
                Err(AttachReceiveError::Closed) if !self.settled => {
                    self.settled = true;
                    AgentAttachEvent::Settled {}
                }
                Err(AttachReceiveError::Closed) => {
                    return Err(NativeV2ObservationError::AttachClosed);
                }
                Err(AttachReceiveError::Lagged) => {
                    return Err(NativeV2ObservationError::AttachLagged);
                }
            }
        };
        Ok(RunAttachEventNotification {
            subscription_id: self.subscription_id.clone(),
            run_id: self.run_id.clone(),
            execution: self.execution.clone(),
            event,
        })
    }
}

#[derive(Clone, Default)]
struct LiveRegistry {
    entries: Arc<Mutex<BTreeMap<LiveKey, LiveOutputSource>>>,
}

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
struct LiveKey {
    run_id: RunId,
    execution: PublicExecutionRef,
}

impl LiveRegistry {
    async fn register(
        &self,
        run_id: RunId,
        execution: PublicExecutionRef,
        source: LiveOutputSource,
    ) -> Result<LiveKey, NativeV2ObservationError> {
        let key = LiveKey { run_id, execution };
        let mut entries = self.entries();
        if entries.contains_key(&key) {
            return Err(NativeV2ObservationError::AlreadyLive);
        }
        entries.insert(key.clone(), source);
        Ok(key)
    }

    async fn subscribe(
        &self,
        run_id: &RunId,
        execution: &PublicExecutionRef,
    ) -> Option<ReadOnlyAttach> {
        self.entries()
            .get(&LiveKey {
                run_id: run_id.clone(),
                execution: execution.clone(),
            })
            .map(LiveOutputSource::subscribe)
    }

    fn remove(&self, key: &LiveKey) {
        self.entries().remove(key);
    }

    fn entries(&self) -> MutexGuard<'_, BTreeMap<LiveKey, LiveOutputSource>> {
        self.entries.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

struct WatchFold<'a> {
    subscription_id: &'a SubscriptionId,
    after: u64,
    projection: &'a mut RunSnapshot,
    pending: &'a mut VecDeque<RunWatchEventNotification>,
}

impl WatchFold<'_> {
    fn apply(&mut self, events: &[StoredRunEvent]) -> Result<(), NativeV2ObservationError> {
        for stored in events {
            let sequence = cursor_sequence(&stored.cursor)?;
            apply_event(self.projection, &stored.event, sequence)?;
            if sequence > self.after && changes_public_status(&stored.event) {
                self.pending.push_back(RunWatchEventNotification {
                    subscription_id: self.subscription_id.clone(),
                    run_id: self.projection.run_id.clone(),
                    cursor: stored.cursor.clone(),
                    status: status_from_snapshot(self.projection)?,
                });
            }
        }
        Ok(())
    }
}

fn status_result(snapshot: &RunSnapshot) -> Result<RunStatusResult, NativeV2ObservationError> {
    Ok(RunStatusResult {
        run_id: snapshot.run_id.clone(),
        at_cursor: snapshot.cursor.clone(),
        status: status_from_snapshot(snapshot)?,
    })
}

fn status_from_snapshot(snapshot: &RunSnapshot) -> Result<RunStatus, NativeV2ObservationError> {
    let active_executions = || {
        snapshot
            .active_executions()
            .map(|node| ActiveExecution {
                execution: opaque_execution(&node.reference),
                node: node.reference.node.clone(),
            })
            .collect::<Vec<_>>()
    };
    match snapshot.phase {
        RunPhase::Admitted => Ok(RunStatus::Admitted {}),
        RunPhase::Running => Ok(RunStatus::Running {
            active_executions: active_executions(),
        }),
        RunPhase::Stopping => Ok(RunStatus::Stopping {
            active_executions: active_executions(),
        }),
        RunPhase::Finished => Ok(RunStatus::Finished {
            terminal_result: snapshot
                .terminal
                .clone()
                .ok_or(NativeV2ObservationError::InvalidState)?,
        }),
    }
}

fn changes_public_status(event: &RunEvent) -> bool {
    !matches!(event, RunEvent::SafeLog { .. })
}

fn log_notification(
    subscription_id: &SubscriptionId,
    snapshot: &RunSnapshot,
    filter: Option<ExecutionId>,
    stored: &StoredRunEvent,
) -> Result<Option<RunLogEventNotification>, NativeV2ObservationError> {
    let RunEvent::SafeLog {
        execution,
        stream,
        line,
    } = &stored.event
    else {
        return Ok(None);
    };
    if filter.is_some() && filter != *execution {
        return Ok(None);
    }
    let public_execution = execution
        .map(|execution| {
            snapshot
                .executions
                .get(&execution)
                .map(|node| opaque_execution(&node.reference))
                .ok_or(NativeV2ObservationError::InvalidState)
        })
        .transpose()?;
    Ok(Some(RunLogEventNotification {
        subscription_id: subscription_id.clone(),
        run_id: snapshot.run_id.clone(),
        cursor: stored.cursor.clone(),
        execution: public_execution,
        record: log_record(*stream, line.as_str()),
    }))
}

fn log_record(stream: SafeLogStream, line: &str) -> LogRecord {
    let level = match stream {
        SafeLogStream::Output => LogLevel::Info,
        SafeLogStream::Error => LogLevel::Error,
        SafeLogStream::System => LogLevel::Debug,
    };
    LogRecord {
        level,
        target: BoundedLogTarget::new(LOG_TARGET).expect("fixed log target is valid"),
        message: BoundedLogMessage::new(line).unwrap_or_else(|_| BoundedLogMessage::redacted()),
    }
}

fn bounded_attach_output(text: &str) -> BoundedAssistantOutput {
    BoundedAssistantOutput::new(text).unwrap_or_else(|_| BoundedAssistantOutput::redacted())
}

fn require_active_reference(
    snapshot: &RunSnapshot,
    reference: &ExecutionRef,
) -> Result<(), NativeV2ObservationError> {
    let node = snapshot
        .executions
        .get(&reference.execution)
        .ok_or(NativeV2ObservationError::ExecutionNotFound)?;
    if node.reference != *reference {
        return Err(NativeV2ObservationError::ExecutionNotFound);
    }
    if !matches!(node.state, NodeState::Active) {
        return Err(NativeV2ObservationError::ExecutionNotActive);
    }
    Ok(())
}

fn resolve_public_execution(
    snapshot: &RunSnapshot,
    public: &PublicExecutionRef,
) -> Result<ExecutionId, NativeV2ObservationError> {
    snapshot
        .executions
        .values()
        .find(|node| opaque_execution(&node.reference) == *public)
        .map(|node| node.reference.execution)
        .ok_or(NativeV2ObservationError::ExecutionNotFound)
}

fn opaque_execution(reference: &ExecutionRef) -> PublicExecutionRef {
    let mut digest = Sha256::new();
    digest.update(b"zeroshot/native-v2/execution-ref/v1\0");
    digest.update(reference.run_id.as_str().as_bytes());
    digest.update(b"\0");
    digest.update(reference.node.as_str().as_bytes());
    digest.update(b"\0");
    digest.update(reference.node_instance.to_string().as_bytes());
    digest.update(b"\0");
    digest.update(reference.execution.to_string().as_bytes());
    let token = digest
        .finalize()
        .iter()
        .fold(String::from("nv2-"), |mut token, byte| {
            use std::fmt::Write as _;
            write!(token, "{byte:02x}").expect("writing to String cannot fail");
            token
        });
    PublicExecutionRef::new(token).expect("native-v2 execution token is bounded and printable")
}
