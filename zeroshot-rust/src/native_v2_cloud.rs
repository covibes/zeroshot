//! Transport-neutral cloud controller for one native-v2 run per disposable capsule.
//!
//! Admission, durable graph truth, supervision, observation, environment selection, and terminal
//! policy remain controller-owned. The allocator supplies exactly one opaque node runner, one
//! liveness signal, and one result-bearing cleanup authority for the run's capsule/workspace.

use std::collections::BTreeMap;
use std::sync::Arc;

use async_trait::async_trait;
use openengine_cluster_protocol::{
    ClusterStatus, EnumLabel, GetParams, GetResult, GraphProfile, GraphProfileSet,
    InitializeParams, InitializeResult, RunAttachEventNotification, RunAttachParams,
    RunAttachResult, RunForceParams, RunForceResult, RunId, RunListParams, RunListResult,
    RunLogEventNotification, RunLogsParams, RunLogsResult, RunStatusParams, RunStatusResult,
    RunSubmitParams, RunSubmitResult, RunWatchEventNotification, RunWatchParams, RunWatchResult,
    ServerCapabilities, Sha256Digest, SubscriptionCloseReason, TerminalResult, WorkerErrorCode,
    WorkerOutcome, GRAPH_INVALID, IDEMPOTENCY_REUSE, INTERNAL_ERROR_CODE, NOT_FOUND,
};
use openengine_cluster_server::native_v2::{
    RunAttachEventStream, RunLogEventStream, RunSubscriptionItem, RunSubscriptionSource,
    RunSubscriptionStream, RunWatchEventStream,
};
use openengine_cluster_server::{BackendError, ClusterBackend, ConnectionContext};
use sha2::{Digest, Sha256};
use thiserror::Error;
use tokio::sync::{watch, Mutex};

use crate::native_v2_admission::{DeliveryPolicy, NativeV2Admission, NativeV2AdmissionError};
use crate::native_v2_contract::{AdmittedRun, NodeCompletion, RunSubmission, RunSubmissionIntent};
#[cfg(test)]
use crate::native_v2_contract::EnvironmentVariableName;
use crate::native_v2_observability::{
    NativeV2Observability, NativeV2ObservationError, RunAttachSubscription, RunLogsSubscription,
    RunWatchSubscription,
};
use crate::native_v2_portable_controller::{
    PortableRunEngine, PortableRunEngineBootstrap, PortableRuntime,
};
use crate::native_v2_runner::NodeRunner;
use crate::native_v2_supervisor::{
    NativeV2SupervisorError, RunEnvironmentError, RunRuntimeExit, RuntimeCleanupUnavailable,
};
use crate::v2_run_ledger::{
    CreateRun, CreateRunOutcome, RunEvent, RunLedger, RunLedgerError, RunSummary, StoredRun,
};

#[cfg(test)]
#[path = "native_v2_cloud/tests.rs"]
mod tests;

mod contracts;
pub use contracts::{
    AllocatedCapsule, CapsuleAllocationUnavailable, CapsuleAllocator, CapsuleCleanup,
    CapsuleCleanupUnavailable, CapsuleDestroyed, CloudRunReceipt, ControllerClaimUnavailable,
    ExclusiveControllerClaim,
};
pub use crate::native_v2_supervisor::RunEnvironment;

/// Compatibility name for the protocol-owned submission while downstream callers migrate.
pub type CloudRunSubmission = RunSubmission;

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
    #[error(transparent)]
    Environment(#[from] RunEnvironmentError),
    #[error("submission identity could not be constructed")]
    SubmissionIdentity,
}

#[derive(Clone)]
pub struct NativeV2CloudController {
    ledger: Arc<dyn RunLedger>,
    allocator: Arc<dyn CapsuleAllocator>,
    observability: NativeV2Observability,
    runtimes: Arc<Mutex<BTreeMap<RunId, RuntimeSlot>>>,
    submission_turn: Arc<Mutex<()>>,
    reconstructed_turn: Arc<Mutex<()>>,
    delivery_policy: DeliveryPolicy,
}

#[derive(Clone)]
enum RuntimeSlot {
    Running(Arc<PortableRunEngine>),
}

enum ForceTarget {
    Terminal,
    Running(Arc<PortableRunEngine>),
    Reconstructed,
}

impl NativeV2CloudController {
    /// Claims exclusive target authority, reconciles durable nonterminal runs, then constructs
    /// the target adapter. Each submitted run carries its own immutable runtime plan.
    pub async fn new(
        ledger: Arc<dyn RunLedger>,
        allocator: Arc<dyn CapsuleAllocator>,
    ) -> Result<Self, NativeV2CloudError> {
        Self::new_with_delivery_policy(ledger, allocator, DeliveryPolicy::Required).await
    }

    pub async fn new_with_delivery_policy(
        ledger: Arc<dyn RunLedger>,
        allocator: Arc<dyn CapsuleAllocator>,
        delivery_policy: DeliveryPolicy,
    ) -> Result<Self, NativeV2CloudError> {
        let controller = Self {
            observability: NativeV2Observability::new(ledger.clone()),
            ledger,
            allocator,
            runtimes: Arc::new(Mutex::new(BTreeMap::new())),
            submission_turn: Arc::new(Mutex::new(())),
            reconstructed_turn: Arc::new(Mutex::new(())),
            delivery_policy,
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
            let _claim = self.allocator.claim_controller(&summary.run_id).await?;
            self.allocator
                .destroy_or_confirm_absent(&summary.run_id, RunRuntimeExit::RuntimeLost)
                .await
                .map_err(|_| NativeV2SupervisorError::RuntimeCleanup(RuntimeCleanupUnavailable))?;
            append_runtime_lost(self.ledger.as_ref(), &stored).await?;
        }
        Ok(())
    }

    /// Admits before every durable or allocation effect. Run identity is assigned by the host and
    /// exact resubmissions retain that identity without allocating a replacement runtime.
    pub async fn submit(
        &self,
        request: RunSubmitParams,
    ) -> Result<CloudRunReceipt, NativeV2CloudError> {
        let intent_digest = run_intent_digest(&RunSubmissionIntent::from(&request.submission))?;
        let environment = RunEnvironment::exact(&request.submission.runtime, BTreeMap::new())?;
        self.submit_inner(request, intent_digest, environment).await
    }

    pub async fn submit_with_intent_digest(
        &self,
        request: RunSubmitParams,
        intent_digest: Sha256Digest,
    ) -> Result<CloudRunReceipt, NativeV2CloudError> {
        let environment = RunEnvironment::exact(&request.submission.runtime, BTreeMap::new())?;
        self.submit_inner(request, intent_digest, environment).await
    }

    /// Trusted bootstrap path for a run whose exact, bounded environment and immutable intent
    /// identity were already selected by the host.
    pub async fn submit_with_intent_digest_and_exact_environment(
        &self,
        request: RunSubmitParams,
        intent_digest: Sha256Digest,
        environment: RunEnvironment,
    ) -> Result<CloudRunReceipt, NativeV2CloudError> {
        self.submit_inner(request, intent_digest, environment).await
    }

    /// Trusted bootstrap path for a run whose exact, bounded environment was already selected.
    pub async fn submit_with_exact_environment(
        &self,
        request: RunSubmitParams,
        environment: RunEnvironment,
    ) -> Result<CloudRunReceipt, NativeV2CloudError> {
        let intent_digest = run_intent_digest(&RunSubmissionIntent::from(&request.submission))?;
        self.submit_inner(request, intent_digest, environment).await
    }

    async fn submit_inner(
        &self,
        request: RunSubmitParams,
        intent_digest: Sha256Digest,
        environment: RunEnvironment,
    ) -> Result<CloudRunReceipt, NativeV2CloudError> {
        let _turn = self.submission_turn.lock().await;
        let RunSubmitParams { run_id, submission } = request;
        let digest = submission_digest(&submission)?;
        let submission_key = submission.submission_key.clone();
        let admitted = NativeV2Admission
            .admit_with_policy(submission, self.delivery_policy)
            .await?;
        let environment = environment.for_runtime(&admitted.runtime)?;
        let created = self
            .ledger
            .create_or_get(CreateRun {
                run_id,
                submission_key,
                intent_digest,
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
            CreateRunOutcome::Created(stored) => {
                self.start_created(stored, admitted, Arc::new(environment))
                    .await
            }
        }
    }

    /// Resolves a named-target retry before mutable source or environment authority is consulted.
    pub async fn resolve_intent(
        &self,
        submission_key: &openengine_cluster_protocol::IdempotencyKey,
        intent_digest: &Sha256Digest,
    ) -> Result<Option<CloudRunReceipt>, NativeV2CloudError> {
        let _turn = self.submission_turn.lock().await;
        let Some(stored) = self.ledger.get_by_submission_key(submission_key).await? else {
            return Ok(None);
        };
        if stored.intent_digest != *intent_digest {
            return Err(RunLedgerError::SubmissionConflict {
                existing_run_id: stored.snapshot.run_id,
            }
            .into());
        }
        self.fail_orphaned_runtime(&stored).await?;
        Ok(Some(CloudRunReceipt {
            run_id: stored.snapshot.run_id,
            deduped: true,
        }))
    }

    async fn start_created(
        &self,
        stored: StoredRun,
        admitted: AdmittedRun,
        environment: Arc<RunEnvironment>,
    ) -> Result<CloudRunReceipt, NativeV2CloudError> {
        let run_id = stored.snapshot.run_id;
        let controller_claim = self.allocator.claim_controller(&run_id).await?;
        let capsule = match self.allocator.allocate(&run_id, &admitted).await {
            Ok(capsule) => capsule,
            Err(error) => {
                self.append_unavailable(&run_id).await?;
                return Err(error.into());
            }
        };
        let AllocatedCapsule {
            runner,
            loss,
            cleanup,
        } = capsule;
        let engine = PortableRunEngine::start(PortableRunEngineBootstrap {
            run_id: run_id.clone(),
            ledger: self.ledger.clone(),
            environment: environment.as_ref().clone(),
            runtime: PortableRuntime::with_cleanup(runner, cleanup),
            loss,
            controller_claim,
            delivery_policy: self.delivery_policy,
            live_output: Arc::new(self.observability.clone()),
        });
        self.runtimes
            .lock()
            .await
            .insert(run_id.clone(), RuntimeSlot::Running(engine.clone()));
        self.remove_finished_runtime(run_id.clone(), engine);
        Ok(CloudRunReceipt {
            run_id,
            deduped: false,
        })
    }

    fn remove_finished_runtime(&self, run_id: RunId, engine: Arc<PortableRunEngine>) {
        let runtimes = self.runtimes.clone();
        tokio::spawn(async move {
            engine.wait_removable().await;
            runtimes.lock().await.remove(&run_id);
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
        let _claim = self
            .allocator
            .claim_controller(&stored.snapshot.run_id)
            .await?;
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
        // can therefore observe neither the durable-create gap nor an in-flight allocation; the
        // potentially slow runner and allocator cleanup remains outside this turn.
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
            None => Ok(ForceTarget::Reconstructed),
        }
    }

    async fn force_running(
        &self,
        run_id: &RunId,
        engine: &PortableRunEngine,
    ) -> Result<(), NativeV2CloudError> {
        // `drive` is internally serialized. Usually this waits behind the live driving turn; if
        // that turn stopped on cleanup error, this is the one retry that can finish cleanup.
        engine.force_stop().await?;
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
        let _claim = self.allocator.claim_controller(run_id).await?;
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
            title: status.title,
            source: status.source,
            size: status.size,
            at_cursor: status.at_cursor,
            status: status.status,
        })
    }
}

mod backend;
use backend::*;

pub fn run_intent_digest(intent: &RunSubmissionIntent) -> Result<Sha256Digest, NativeV2CloudError> {
    let bytes = serde_json::to_vec(intent).map_err(|_| NativeV2CloudError::SubmissionIdentity)?;
    Sha256Digest::new(format!("{:x}", Sha256::digest(bytes)))
        .map_err(|_| NativeV2CloudError::SubmissionIdentity)
}
