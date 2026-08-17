//! Transport-neutral cloud controller for one native-v2 run per disposable capsule.
//!
//! Admission, durable graph truth, supervision, observation, environment selection, and terminal
//! policy remain controller-owned. The allocator supplies exactly one opaque node runner, one
//! liveness signal, and one result-bearing cleanup authority for the run's capsule/workspace.

use std::collections::BTreeMap;
use std::fmt;
use std::sync::Arc;

use async_trait::async_trait;
use openengine_cluster_protocol::{
    ClusterStatus, EnumLabel, GetParams, GetResult, GraphProfile, GraphProfileSet, GraphSpec,
    IdempotencyKey, InitializeParams, InitializeResult, NodeName, RunAttachEventNotification,
    RunAttachParams, RunAttachResult, RunForceParams, RunForceResult, RunId, RunListParams,
    RunListResult, RunLogEventNotification, RunLogsParams, RunLogsResult, RunStatusParams,
    RunStatusResult, RunSubmitParams, RunSubmitResult, RunWatchEventNotification, RunWatchParams,
    RunWatchResult, ServerCapabilities, Sha256Digest, SubscriptionCloseReason, TerminalResult,
    WorkerErrorCode, WorkerOutcome, GRAPH_INVALID, IDEMPOTENCY_REUSE, INTERNAL_ERROR_CODE,
    NOT_FOUND,
};
use openengine_cluster_server::native_v2::{
    RunAttachEventStream, RunLogEventStream, RunSubscriptionItem, RunSubscriptionSource,
    RunSubscriptionStream, RunWatchEventStream,
};
use openengine_cluster_server::{BackendError, ClusterBackend, ConnectionContext};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use thiserror::Error;
use tokio::sync::{watch, Mutex};

use crate::native_v2_admission::{NativeV2Admission, NativeV2AdmissionError};
use crate::native_v2_contract::{
    AdmittedRun, EnvironmentVariableName, NodeCompletion, NodeRuntimeBinding, RunSubmission,
    RuntimePlan,
};
use crate::native_v2_observability::{
    NativeV2Observability, NativeV2ObservationError, RunAttachSubscription, RunLogsSubscription,
    RunWatchSubscription,
};
use crate::native_v2_runner::{NodeRunner, ResolvedEnvironment};
use crate::native_v2_supervisor::{
    EnvironmentUnavailable, NativeV2Supervisor, NativeV2SupervisorError, NodeEnvironmentResolver,
    RunRuntimeCleanup, RunRuntimeExit, RuntimeCleanupUnavailable,
};
use crate::v2_run_ledger::{
    CreateRun, CreateRunOutcome, RunEvent, RunLedger, RunLedgerError, RunSummary, StoredRun,
};

#[cfg(test)]
#[path = "native_v2_cloud/tests.rs"]
mod tests;

/// Public, provider-neutral submission accepted by a selected cloud target.
///
/// The target-owned runtime plan is deliberately absent and is attached by the controller before
/// pure admission.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CloudRunSubmission {
    pub graph: GraphSpec,
    pub initial_input: Value,
    #[serde(default)]
    pub ship: bool,
    pub submission_key: IdempotencyKey,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CloudRunReceipt {
    pub run_id: RunId,
    pub deduped: bool,
}

#[derive(Clone, Copy, Debug, Eq, Error, PartialEq)]
#[error("capsule allocation is unavailable")]
pub struct CapsuleAllocationUnavailable;

#[derive(Clone, Copy, Debug, Eq, Error, PartialEq)]
#[error("exclusive controller authority is unavailable")]
pub struct ControllerClaimUnavailable;

#[derive(Clone, Copy, Debug, Eq, Error, PartialEq)]
#[error("capsule destruction could not be confirmed")]
pub struct CapsuleCleanupUnavailable;

/// Opaque acknowledgement from allocator authority that the disposable runtime no longer exists.
///
/// For a live capsule this follows successful destruction. After an observed connection loss the
/// same receipt confirms that allocator authority observes the capsule absent; loss therefore
/// cannot strand an otherwise terminalizable run.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CapsuleDestroyed {
    _closed: (),
}

impl CapsuleDestroyed {
    #[must_use]
    pub const fn confirmed() -> Self {
        Self { _closed: () }
    }
}

#[async_trait]
pub trait CapsuleCleanup: Send + Sync {
    async fn destroy_or_confirm_absent(
        &self,
        exit: RunRuntimeExit,
    ) -> Result<CapsuleDestroyed, CapsuleCleanupUnavailable>;
}

pub struct AllocatedCapsule {
    pub runner: Arc<dyn NodeRunner>,
    pub loss: watch::Receiver<bool>,
    pub cleanup: Arc<dyn CapsuleCleanup>,
}

/// Allocator-owned proof that this is the only active controller for the target.
///
/// The allocator must keep the claim exclusive until the last reference is dropped. This is a
/// hosting authority contract, not a product-local distributed lease implementation.
pub trait ExclusiveControllerClaim: Send + Sync {}

#[async_trait]
pub trait CapsuleAllocator: Send + Sync {
    /// Acquires exclusive controller authority before any startup reconciliation or OECP serving.
    async fn claim_controller(
        &self,
    ) -> Result<Arc<dyn ExclusiveControllerClaim>, ControllerClaimUnavailable>;

    /// An error guarantees that allocation left no surviving capsule. Once allocation succeeds,
    /// cleanup authority is carried by [`AllocatedCapsule`].
    async fn allocate(
        &self,
        run_id: &RunId,
        admitted: &AdmittedRun,
    ) -> Result<AllocatedCapsule, CapsuleAllocationUnavailable>;

    /// Destroys an allocator-known capsule for a controller-reconstructed run, or confirms that
    /// it is already absent. This operation never allocates a replacement.
    async fn destroy_or_confirm_absent(
        &self,
        run_id: &RunId,
        exit: RunRuntimeExit,
    ) -> Result<CapsuleDestroyed, CapsuleCleanupUnavailable>;
}

/// Exact target-owned environment available for node declaration resolution.
///
/// Debug output contains names only. Values are never part of an admitted run or ledger event.
#[derive(Clone, Default)]
pub struct ControllerEnvironment {
    values: Arc<BTreeMap<EnvironmentVariableName, String>>,
}

impl ControllerEnvironment {
    #[must_use]
    pub fn new(values: BTreeMap<EnvironmentVariableName, String>) -> Self {
        Self {
            values: Arc::new(values),
        }
    }
}

impl fmt::Debug for ControllerEnvironment {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ControllerEnvironment")
            .field("names", &self.values.keys().collect::<Vec<_>>())
            .field("values", &"[REDACTED]")
            .finish()
    }
}

#[async_trait]
impl NodeEnvironmentResolver for ControllerEnvironment {
    async fn resolve(
        &self,
        _node: &NodeName,
        binding: &NodeRuntimeBinding,
    ) -> Result<ResolvedEnvironment, EnvironmentUnavailable> {
        let values = binding
            .declared_environment()
            .iter()
            .map(|name| {
                self.values
                    .get(name)
                    .cloned()
                    .map(|value| (name.clone(), value))
                    .ok_or(EnvironmentUnavailable)
            })
            .collect::<Result<BTreeMap<_, _>, _>>()?;
        ResolvedEnvironment::exact(binding, values).map_err(|_| EnvironmentUnavailable)
    }
}

#[derive(Debug, Error)]
pub enum NativeV2CloudError {
    #[error(transparent)]
    ControllerClaim(#[from] ControllerClaimUnavailable),
    #[error(transparent)]
    Admission(#[from] NativeV2AdmissionError),
    #[error(transparent)]
    Ledger(#[from] RunLedgerError),
    #[error(transparent)]
    Observation(#[from] NativeV2ObservationError),
    #[error(transparent)]
    Allocation(#[from] CapsuleAllocationUnavailable),
    #[error(transparent)]
    Supervisor(#[from] NativeV2SupervisorError),
    #[error("submission identity could not be constructed")]
    SubmissionIdentity,
}

#[derive(Clone)]
pub struct NativeV2CloudController {
    _controller_claim: Arc<dyn ExclusiveControllerClaim>,
    ledger: Arc<dyn RunLedger>,
    runtime: RuntimePlan,
    environments: Arc<ControllerEnvironment>,
    allocator: Arc<dyn CapsuleAllocator>,
    observability: NativeV2Observability,
    runtimes: Arc<Mutex<BTreeMap<RunId, RuntimeSlot>>>,
    submission_turn: Arc<Mutex<()>>,
    reconstructed_turn: Arc<Mutex<()>>,
}

#[derive(Clone)]
enum RuntimeSlot {
    Starting,
    Running(Arc<NativeV2Supervisor>),
}

enum ForceTarget {
    Terminal,
    Running(Arc<NativeV2Supervisor>),
    Reconstructed,
}

impl NativeV2CloudController {
    /// Claims exclusive target authority, reconciles durable nonterminal runs, then constructs
    /// one target controller with its graph-companion runtime plan.
    ///
    /// Public OECP submission remains GraphSpec-only. The target owns these node bindings; this
    /// does not introduce another wire field or CLI flag.
    pub async fn new(
        ledger: Arc<dyn RunLedger>,
        runtime: RuntimePlan,
        environments: ControllerEnvironment,
        allocator: Arc<dyn CapsuleAllocator>,
    ) -> Result<Self, NativeV2CloudError> {
        let controller_claim = allocator.claim_controller().await?;
        let controller = Self {
            _controller_claim: controller_claim,
            observability: NativeV2Observability::new(ledger.clone()),
            ledger,
            runtime,
            environments: Arc::new(environments),
            allocator,
            runtimes: Arc::new(Mutex::new(BTreeMap::new())),
            submission_turn: Arc::new(Mutex::new(())),
            reconstructed_turn: Arc::new(Mutex::new(())),
        };
        controller.reconcile_persisted_runs().await?;
        Ok(controller)
    }

    /// Reconciles durable nonterminal truth before this controller can serve any OECP method.
    /// A replacement runtime is never allocated during startup.
    async fn reconcile_persisted_runs(&self) -> Result<(), NativeV2CloudError> {
        for summary in self.ledger.list().await? {
            let stored = self
                .ledger
                .get(&summary.run_id)
                .await?
                .ok_or(RunLedgerError::RunNotFound)?;
            if stored.snapshot.terminal.is_some() {
                continue;
            }
            self.allocator
                .destroy_or_confirm_absent(&summary.run_id, RunRuntimeExit::RuntimeLost)
                .await
                .map_err(|_| NativeV2SupervisorError::RuntimeCleanup(RuntimeCleanupUnavailable))?;
            append_runtime_lost(self.ledger.as_ref(), &stored).await?;
        }
        Ok(())
    }

    /// Admits before every durable or allocation effect, then allocates only for a newly created
    /// run. The submission turn closes the tiny create-to-runtime-slot race for concurrent exact
    /// resubmissions without introducing a scheduler.
    pub async fn submit(
        &self,
        request: CloudRunSubmission,
    ) -> Result<CloudRunReceipt, NativeV2CloudError> {
        let _turn = self.submission_turn.lock().await;
        let submission = RunSubmission {
            graph: request.graph,
            initial_input: request.initial_input,
            runtime: self.runtime.clone(),
            ship: request.ship,
            submission_key: request.submission_key,
        };
        let digest = submission_digest(&submission)?;
        let submission_key = submission.submission_key.clone();
        let admitted = NativeV2Admission.admit(submission).await?;
        let run_id = fresh_run_id()?;
        let created = self
            .ledger
            .create_or_get(CreateRun {
                run_id,
                submission_key,
                submission_digest: digest,
                admitted: admitted.clone(),
            })
            .await?;

        match created {
            CreateRunOutcome::Existing(stored) => {
                self.fail_orphaned_runtime(&stored).await?;
                Ok(CloudRunReceipt {
                    run_id: stored.snapshot.run_id,
                    deduped: true,
                })
            }
            CreateRunOutcome::Created(stored) => self.start_created(stored, admitted).await,
        }
    }

    async fn start_created(
        &self,
        stored: StoredRun,
        admitted: AdmittedRun,
    ) -> Result<CloudRunReceipt, NativeV2CloudError> {
        let run_id = stored.snapshot.run_id;
        self.runtimes
            .lock()
            .await
            .insert(run_id.clone(), RuntimeSlot::Starting);
        let capsule = match self.allocator.allocate(&run_id, &admitted).await {
            Ok(capsule) => capsule,
            Err(error) => {
                self.append_unavailable(&run_id).await?;
                self.runtimes.lock().await.remove(&run_id);
                return Err(error.into());
            }
        };
        let AllocatedCapsule {
            runner,
            loss,
            cleanup,
        } = capsule;
        let supervisor = Arc::new(
            NativeV2Supervisor::new(
                run_id.clone(),
                self.ledger.clone(),
                runner,
                self.environments.clone(),
            )
            .with_live_output(Arc::new(self.observability.clone()))
            .with_runtime_cleanup(Arc::new(CapsuleRuntimeCleanup { cleanup })),
        );
        self.runtimes
            .lock()
            .await
            .insert(run_id.clone(), RuntimeSlot::Running(supervisor.clone()));
        self.spawn_drive(run_id.clone(), supervisor, loss);
        Ok(CloudRunReceipt {
            run_id,
            deduped: false,
        })
    }

    fn spawn_drive(
        &self,
        run_id: RunId,
        supervisor: Arc<NativeV2Supervisor>,
        mut loss: watch::Receiver<bool>,
    ) {
        let runtimes = self.runtimes.clone();
        let controller_claim = self._controller_claim.clone();
        tokio::spawn(async move {
            let _controller_claim = controller_claim;
            let drive_supervisor = supervisor.clone();
            let mut drive = Box::pin(async move { drive_supervisor.drive().await });
            let result = tokio::select! {
                result = &mut drive => result,
                () = wait_for_capsule_loss(&mut loss) => {
                    supervisor.runtime_lost().await;
                    drive.await
                }
            };
            if result.is_ok() {
                runtimes.lock().await.remove(&run_id);
            }
        });
    }

    async fn fail_orphaned_runtime(&self, stored: &StoredRun) -> Result<(), NativeV2CloudError> {
        let _turn = self.reconstructed_turn.lock().await;
        let stored = self
            .ledger
            .get(&stored.snapshot.run_id)
            .await?
            .ok_or(RunLedgerError::RunNotFound)?;
        if stored.snapshot.terminal.is_some()
            || self
                .runtimes
                .lock()
                .await
                .contains_key(&stored.snapshot.run_id)
        {
            return Ok(());
        }
        self.allocator
            .destroy_or_confirm_absent(&stored.snapshot.run_id, RunRuntimeExit::RuntimeLost)
            .await
            .map_err(|_| NativeV2SupervisorError::RuntimeCleanup(RuntimeCleanupUnavailable))?;
        append_runtime_lost(self.ledger.as_ref(), &stored).await?;
        Ok(())
    }

    async fn append_unavailable(&self, run_id: &RunId) -> Result<(), NativeV2CloudError> {
        let stored = self
            .ledger
            .get(run_id)
            .await?
            .ok_or(RunLedgerError::RunNotFound)?;
        append_terminal_failure(self.ledger.as_ref(), &stored, "runtime_unavailable").await?;
        Ok(())
    }

    pub async fn list(&self) -> Result<Vec<RunSummary>, NativeV2CloudError> {
        Ok(self.ledger.list().await?)
    }

    pub async fn status(
        &self,
        params: RunStatusParams,
    ) -> Result<RunStatusResult, NativeV2CloudError> {
        Ok(self.observability.status(params).await?)
    }

    pub async fn watch(
        &self,
        params: RunWatchParams,
    ) -> Result<(RunWatchResult, RunWatchSubscription), NativeV2CloudError> {
        Ok(self.observability.watch(params).await?)
    }

    pub async fn logs(
        &self,
        params: RunLogsParams,
    ) -> Result<(RunLogsResult, RunLogsSubscription), NativeV2CloudError> {
        Ok(self.observability.logs(params).await?)
    }

    pub async fn attach(
        &self,
        params: RunAttachParams,
    ) -> Result<(RunAttachResult, RunAttachSubscription), NativeV2CloudError> {
        Ok(self.observability.attach(params).await?)
    }

    pub async fn force(
        &self,
        params: RunForceParams,
    ) -> Result<RunForceResult, NativeV2CloudError> {
        match self.prepare_force(&params.run_id).await? {
            ForceTarget::Terminal => {}
            ForceTarget::Running(supervisor) => {
                self.force_running(&params.run_id, &supervisor).await?;
            }
            ForceTarget::Reconstructed => {
                self.force_reconstructed(&params.run_id).await?;
            }
        }
        self.force_result(&params.run_id).await
    }

    async fn prepare_force(&self, run_id: &RunId) -> Result<ForceTarget, NativeV2CloudError> {
        // Serialize only the durable decision and runtime-slot capture with submission. A force
        // can therefore observe neither the create-to-Starting gap nor an in-flight allocation;
        // the potentially slow runner and allocator cleanup remains outside this turn.
        let _turn = self.submission_turn.lock().await;
        let stored = self
            .ledger
            .get(run_id)
            .await?
            .ok_or(RunLedgerError::RunNotFound)?;
        if stored.snapshot.terminal.is_some() {
            return Ok(ForceTarget::Terminal);
        }
        self.ledger.request_force_stop(run_id).await?;
        match self.runtimes.lock().await.get(run_id).cloned() {
            Some(RuntimeSlot::Running(supervisor)) => Ok(ForceTarget::Running(supervisor)),
            Some(RuntimeSlot::Starting) | None => Ok(ForceTarget::Reconstructed),
        }
    }

    async fn force_running(
        &self,
        run_id: &RunId,
        supervisor: &NativeV2Supervisor,
    ) -> Result<(), NativeV2CloudError> {
        // `drive` is internally serialized. Usually this waits behind the live driving turn; if
        // that turn stopped on cleanup error, this is the one retry that can finish cleanup.
        supervisor.force_stop().await?;
        supervisor.drive().await?;
        self.runtimes.lock().await.remove(run_id);
        Ok(())
    }

    async fn force_reconstructed(&self, run_id: &RunId) -> Result<(), NativeV2CloudError> {
        let _turn = self.reconstructed_turn.lock().await;
        let stored = self
            .ledger
            .get(run_id)
            .await?
            .ok_or(RunLedgerError::RunNotFound)?;
        if stored.snapshot.terminal.is_some() {
            return Ok(());
        }
        self.allocator
            .destroy_or_confirm_absent(run_id, RunRuntimeExit::ForceStopped)
            .await
            .map_err(|_| NativeV2SupervisorError::RuntimeCleanup(RuntimeCleanupUnavailable))?;
        let stored = self
            .ledger
            .get(run_id)
            .await?
            .ok_or(RunLedgerError::RunNotFound)?;
        append_terminal_failure(self.ledger.as_ref(), &stored, "force_stopped").await?;
        Ok(())
    }

    async fn force_result(&self, run_id: &RunId) -> Result<RunForceResult, NativeV2CloudError> {
        let status = self
            .observability
            .status(RunStatusParams {
                run_id: run_id.clone(),
            })
            .await?;
        Ok(RunForceResult {
            run_id: status.run_id,
            at_cursor: status.at_cursor,
            status: status.status,
        })
    }
}

#[async_trait]
impl ClusterBackend for NativeV2CloudController {
    async fn initialize(
        &self,
        _context: &ConnectionContext,
        _params: InitializeParams,
    ) -> Result<InitializeResult, BackendError> {
        let graph_profiles = GraphProfileSet::new(vec![GraphProfile::Full])
            .map_err(|_| BackendError::new(INTERNAL_ERROR_CODE, "invalid capability set"))?;
        Ok(InitializeResult::new(
            ServerCapabilities {
                graph_profiles,
                logs: true,
                agent_attach: true,
            },
            ClusterStatus::empty(),
        ))
    }

    async fn get(
        &self,
        _context: &ConnectionContext,
        _params: GetParams,
    ) -> Result<GetResult, BackendError> {
        Ok(GetResult::empty())
    }

    async fn run_submit(
        &self,
        _context: &ConnectionContext,
        params: RunSubmitParams,
    ) -> Result<RunSubmitResult, BackendError> {
        let receipt = self
            .submit(CloudRunSubmission {
                graph: params.graph,
                initial_input: params.initial_input,
                ship: params.ship,
                submission_key: params.submission_key,
            })
            .await
            .map_err(cloud_backend_error)?;
        Ok(RunSubmitResult {
            run_id: receipt.run_id,
        })
    }

    async fn run_list(
        &self,
        _context: &ConnectionContext,
        _params: RunListParams,
    ) -> Result<RunListResult, BackendError> {
        let summaries = self.list().await.map_err(cloud_backend_error)?;
        let mut runs = Vec::with_capacity(summaries.len());
        for summary in summaries {
            runs.push(
                self.status(RunStatusParams {
                    run_id: summary.run_id,
                })
                .await
                .map_err(cloud_backend_error)?,
            );
        }
        Ok(RunListResult { runs })
    }

    async fn run_status(
        &self,
        _context: &ConnectionContext,
        params: RunStatusParams,
    ) -> Result<RunStatusResult, BackendError> {
        self.status(params).await.map_err(cloud_backend_error)
    }

    async fn run_watch(
        &self,
        _context: &ConnectionContext,
        params: RunWatchParams,
    ) -> Result<(RunWatchResult, RunWatchEventStream), BackendError> {
        let (result, source) = self.watch(params).await.map_err(cloud_backend_error)?;
        Ok((result, RunSubscriptionStream::new(WatchSource(source))))
    }

    async fn run_logs(
        &self,
        _context: &ConnectionContext,
        params: RunLogsParams,
    ) -> Result<(RunLogsResult, RunLogEventStream), BackendError> {
        let (result, source) = self.logs(params).await.map_err(cloud_backend_error)?;
        Ok((result, RunSubscriptionStream::new(LogsSource(source))))
    }

    async fn run_attach(
        &self,
        _context: &ConnectionContext,
        params: RunAttachParams,
    ) -> Result<(RunAttachResult, RunAttachEventStream), BackendError> {
        let (result, source) = self.attach(params).await.map_err(cloud_backend_error)?;
        Ok((result, RunSubscriptionStream::new(AttachSource(source))))
    }

    async fn run_force(
        &self,
        _context: &ConnectionContext,
        params: RunForceParams,
    ) -> Result<RunForceResult, BackendError> {
        self.force(params).await.map_err(cloud_backend_error)
    }
}

struct WatchSource(RunWatchSubscription);

#[async_trait]
impl RunSubscriptionSource<RunWatchEventNotification> for WatchSource {
    async fn next(&mut self) -> Option<RunSubscriptionItem<RunWatchEventNotification>> {
        match self.0.recv().await {
            Ok(Some(event)) => Some(RunSubscriptionItem::Event(event)),
            Ok(None) | Err(_) => Some(RunSubscriptionItem::Closed {
                reason: SubscriptionCloseReason::Done,
            }),
        }
    }
}

struct LogsSource(RunLogsSubscription);

#[async_trait]
impl RunSubscriptionSource<RunLogEventNotification> for LogsSource {
    async fn next(&mut self) -> Option<RunSubscriptionItem<RunLogEventNotification>> {
        match self.0.recv().await {
            Ok(Some(event)) => Some(RunSubscriptionItem::Event(event)),
            Ok(None) | Err(_) => Some(RunSubscriptionItem::Closed {
                reason: SubscriptionCloseReason::Done,
            }),
        }
    }
}

struct AttachSource(RunAttachSubscription);

#[async_trait]
impl RunSubscriptionSource<RunAttachEventNotification> for AttachSource {
    async fn next(&mut self) -> Option<RunSubscriptionItem<RunAttachEventNotification>> {
        match self.0.recv().await {
            Ok(event) => Some(RunSubscriptionItem::Event(event)),
            Err(NativeV2ObservationError::AttachLagged) => Some(RunSubscriptionItem::Closed {
                reason: SubscriptionCloseReason::SlowConsumer,
            }),
            Err(_) => Some(RunSubscriptionItem::Closed {
                reason: SubscriptionCloseReason::Done,
            }),
        }
    }
}

fn cloud_backend_error(error: NativeV2CloudError) -> BackendError {
    match error {
        NativeV2CloudError::Admission(error) => {
            BackendError::invalid_params(GRAPH_INVALID, error.to_string(), None)
        }
        NativeV2CloudError::Ledger(RunLedgerError::SubmissionConflict { existing_run_id }) => {
            BackendError::application(
                IDEMPOTENCY_REUSE,
                "submission key identifies another run",
                Some(serde_json::json!({ "runId": existing_run_id })),
            )
        }
        NativeV2CloudError::Ledger(RunLedgerError::RunNotFound)
        | NativeV2CloudError::Observation(NativeV2ObservationError::RunNotFound) => {
            BackendError::application(NOT_FOUND, "run was not found", None)
        }
        _ => BackendError::new(INTERNAL_ERROR_CODE, "native-v2 operation failed"),
    }
}

struct CapsuleRuntimeCleanup {
    cleanup: Arc<dyn CapsuleCleanup>,
}

#[async_trait]
impl RunRuntimeCleanup for CapsuleRuntimeCleanup {
    async fn cleanup(&self, exit: RunRuntimeExit) -> Result<(), RuntimeCleanupUnavailable> {
        self.cleanup
            .destroy_or_confirm_absent(exit)
            .await
            .map(|_| ())
            .map_err(|_| RuntimeCleanupUnavailable)
    }
}

async fn wait_for_capsule_loss(loss: &mut watch::Receiver<bool>) {
    loop {
        if *loss.borrow_and_update() {
            return;
        }
        if loss.changed().await.is_err() {
            return;
        }
    }
}

fn submission_digest(submission: &RunSubmission) -> Result<Sha256Digest, NativeV2CloudError> {
    let bytes =
        serde_json::to_vec(submission).map_err(|_| NativeV2CloudError::SubmissionIdentity)?;
    Sha256Digest::new(format!("{:x}", Sha256::digest(bytes)))
        .map_err(|_| NativeV2CloudError::SubmissionIdentity)
}

fn fresh_run_id() -> Result<RunId, NativeV2CloudError> {
    let mut random = [0_u8; 16];
    getrandom::fill(&mut random).map_err(|_| NativeV2CloudError::SubmissionIdentity)?;
    Ok(RunId::new(format!("run-{}", hex(&random))))
}

fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;

    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        write!(&mut output, "{byte:02x}").expect("writing to a String cannot fail");
    }
    output
}

async fn append_runtime_lost(
    ledger: &dyn RunLedger,
    stored: &StoredRun,
) -> Result<(), RunLedgerError> {
    append_terminal_failure(ledger, stored, "runtime_lost").await
}

async fn append_terminal_failure(
    ledger: &dyn RunLedger,
    stored: &StoredRun,
    reason: &str,
) -> Result<(), RunLedgerError> {
    if stored.snapshot.terminal.is_some() {
        return Ok(());
    }
    let mut events = stored
        .snapshot
        .active_executions()
        .map(|node| RunEvent::NodeCompleted {
            completion: NodeCompletion {
                reference: node.reference.clone(),
                outcome: WorkerOutcome::declared_failure(WorkerErrorCode::Crash),
            },
        })
        .collect::<Vec<_>>();
    events.push(RunEvent::Terminal {
        result: TerminalResult::Failed {
            reason: EnumLabel::new(reason).map_err(|_| RunLedgerError::Corrupt)?,
        },
    });
    ledger.append(&stored.snapshot.run_id, events).await?;
    Ok(())
}
