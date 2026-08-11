use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use openengine_cluster_protocol::{
    ApplyParams, ApplyResult, Cursor, Generation, GetParams, GetResult, GraphProfile,
    GraphProfileSet, GraphSpec, InitializeParams, InitializeResult, LegacyShipRequest, Phase,
    PlanParams, PlanResult, ServerCapabilities, StopMode, StopParams, StopResult, SubscriptionId,
    WatchParams, WatchResult, GONE, INTERNAL_ERROR_CODE, NOT_FOUND,
};
use openengine_cluster_server::admission::StoreError;
use openengine_cluster_server::watch::{
    subscribe_and_stream, ObservationStore, SubscribeAndStreamRequest, WatchEventStream,
    WatchHandle,
};
use openengine_cluster_server::{BackendError, ClusterBackend, ConnectionContext};
use tokio::sync::{watch, Mutex, Notify};

use super::backend_admission_support::RunMetadata;
use super::backend_support::{
    internal_error, safe_application_error, status_from, terminal_failure_error,
};
use super::config::HostedAuthority;
use super::credentials::{CredentialInstallError, CredentialInstaller, CredentialStore};
use super::journal::EventJournal;
use super::ports::{ProxyReadinessPort, WorktreeReadinessPort, WorkspaceDeliveryPort};
use super::worker::{WorkerCommand, WorkerError, WorkerExecution};

pub(super) struct HostedState {
    pub(super) graph: Option<GraphSpec>,
    pub(super) phase: Phase,
    pub(super) generation: Option<Generation>,
    pub(super) run_id: Option<openengine_cluster_protocol::RunId>,
    pub(super) at_cursor: Option<Cursor>,
    pub(super) admission: Option<ApplyParams>,
    pub(super) committed: Option<ApplyParams>,
    pub(super) apply_result: Option<ApplyResult>,
    pub(super) stop_request: Option<StopParams>,
    pub(super) stop_requests: Vec<StopParams>,
    pub(super) stop_receipts: Vec<(StopParams, StopResult)>,
    pub(super) finalization_request:
        Option<watch::Sender<Option<openengine_cluster_protocol::StopMode>>>,
    pub(super) finalizing: bool,
    pub(super) finished: bool,
    pub(super) terminal_failure: bool,
    pub(super) terminal_failure_retryable: bool,
    pub(super) shutdown_forced_run: bool,
    pub(super) shutting_down: bool,
    pub(super) proxy_cleanup_result: Option<bool>,
}
pub(super) struct WorkerDrive {
    pub(super) execution: WorkerExecution,
    pub(super) process_cancellation: watch::Sender<bool>,
    pub(super) finalization_observer: watch::Receiver<Option<StopMode>>,
    pub(super) timeout: Duration,
}
pub(super) struct PreparedRun {
    pub(super) params: ApplyParams,
    pub(super) request: LegacyShipRequest,
    pub(super) metadata: RunMetadata,
}
pub(super) enum RunFinalization {
    Active(watch::Sender<Option<StopMode>>),
    FailedStart,
}
pub(super) enum WorkerStartFailure {
    PreLaunch(WorkerError),
    PostLaunch {
        error: WorkerError,
        execution: Option<WorkerExecution>,
        process_cancellation: watch::Sender<bool>,
    },
}

impl Default for HostedState {
    fn default() -> Self {
        Self {
            graph: None,

            phase: Phase::Empty,
            generation: None,
            run_id: None,
            at_cursor: None,
            admission: None,
            committed: None,
            apply_result: None,
            stop_request: None,
            stop_requests: Vec::new(),
            stop_receipts: Vec::new(),
            finalization_request: None,
            finalizing: false,
            finished: false,
            terminal_failure: false,
            terminal_failure_retryable: false,
            shutdown_forced_run: false,
            shutting_down: false,
            proxy_cleanup_result: None,
        }
    }
}

#[derive(Clone)]
struct BackendCredentials {
    authority: Option<HostedAuthority>,
    store: CredentialStore,
}

#[derive(Clone)]
pub struct HostedBackend {
    pub(super) state: Arc<Mutex<HostedState>>,
    pub(super) journal: Arc<EventJournal>,
    pub(super) worktree: Arc<dyn WorktreeReadinessPort>,
    pub(super) proxy: Arc<dyn ProxyReadinessPort>,
    pub(super) delivery: Arc<dyn WorkspaceDeliveryPort>,
    pub(super) authority: Option<HostedAuthority>,
    pub(super) credentials: CredentialStore,
    pub(super) changed: Arc<Notify>,
    pub(super) worker_command: WorkerCommand,
    next_subscription: Arc<AtomicU64>,
}

impl HostedBackend {
    #[must_use]
    pub fn new(
        worktree: Arc<dyn WorktreeReadinessPort>,
        proxy: Arc<dyn ProxyReadinessPort>,
        delivery: Arc<dyn WorkspaceDeliveryPort>,
        authority: HostedAuthority,
    ) -> Self {
        Self::from_parts(
            worktree,
            proxy,
            delivery,
            BackendCredentials {
                authority: Some(authority),
                store: CredentialStore::default(),
            },
        )
    }

    #[must_use]
    pub(super) fn production(
        worktree: Arc<dyn WorktreeReadinessPort>,
        proxy: Arc<dyn ProxyReadinessPort>,
        delivery: Arc<dyn WorkspaceDeliveryPort>,
        credentials: CredentialStore,
    ) -> Self {
        Self::from_parts(
            worktree,
            proxy,
            delivery,
            BackendCredentials {
                authority: None,
                store: credentials,
            },
        )
    }

    fn from_parts(
        worktree: Arc<dyn WorktreeReadinessPort>,
        proxy: Arc<dyn ProxyReadinessPort>,
        delivery: Arc<dyn WorkspaceDeliveryPort>,
        credentials: BackendCredentials,
    ) -> Self {
        Self {
            state: Arc::new(Mutex::new(HostedState::default())),
            journal: Arc::new(EventJournal::new()),
            worktree,
            proxy,
            delivery,
            authority: credentials.authority,
            credentials: credentials.store,
            changed: Arc::new(Notify::new()),
            worker_command: WorkerCommand::unconfigured(),
            next_subscription: Arc::new(AtomicU64::new(1)),
        }
    }

    pub(super) async fn runtime_authority(
        &self,
    ) -> Result<HostedAuthority, CredentialInstallError> {
        if let Ok(credentials) = self.credentials.resolve().await {
            return Ok(credentials.authority());
        }
        self.authority
            .clone()
            .ok_or(CredentialInstallError::Missing)
    }
}

#[async_trait]
impl CredentialInstaller for HostedBackend {
    async fn install_credentials(&self, bytes: Vec<u8>) -> Result<(), CredentialInstallError> {
        if self.credentials.is_exact_replay(&bytes).await {
            return Ok(());
        }
        if self.state.lock().await.phase != Phase::Empty {
            return Err(CredentialInstallError::Conflict);
        }
        self.credentials.install(bytes).await
    }
}

#[async_trait]
impl ClusterBackend for HostedBackend {
    async fn initialize(
        &self,
        _context: &ConnectionContext,
        _params: InitializeParams,
    ) -> Result<InitializeResult, BackendError> {
        let graph_profiles = GraphProfileSet::new(vec![GraphProfile::SingleWorker])
            .map_err(|_| internal_error("invalid capability set"))?;
        Ok(InitializeResult::new(
            ServerCapabilities {
                graph_profiles,
                logs: false,
                agent_attach: false,
            },
            self.status().await?,
        ))
    }

    async fn plan(
        &self,
        _context: &ConnectionContext,
        params: PlanParams,
    ) -> Result<PlanResult, BackendError> {
        self.verify(&params.graph).await
    }

    async fn apply(
        &self,
        context: &ConnectionContext,
        params: ApplyParams,
    ) -> Result<ApplyResult, BackendError> {
        self.apply_once(context, params).await
    }

    async fn get(
        &self,
        _context: &ConnectionContext,
        params: GetParams,
    ) -> Result<GetResult, BackendError> {
        let state = self.state.lock().await;
        if state.terminal_failure {
            return Err(terminal_failure_error());
        }
        if params
            .at_cursor
            .as_ref()
            .is_some_and(|cursor| state.at_cursor.as_ref() != Some(cursor))
        {
            return Err(safe_application_error(
                openengine_cluster_protocol::INVALID_PHASE,
                "Requested cursor is not available",
            ));
        }
        Ok(GetResult {
            spec: state.graph.clone(),
            status: status_from(&state),
            at_cursor: state.at_cursor.clone(),
            terminal_result: None,
        })
    }

    async fn stop(
        &self,
        _context: &ConnectionContext,
        params: StopParams,
    ) -> Result<StopResult, BackendError> {
        self.stop_once(params).await
    }

    async fn watch(
        &self,
        _context: &ConnectionContext,
        params: WatchParams,
        queue_capacity: usize,
    ) -> Result<(WatchResult, WatchEventStream, WatchHandle), BackendError> {
        let cursor_was_supplied = params.from_cursor.is_some();
        let store: Arc<dyn ObservationStore> = self.journal.clone();
        subscribe_and_stream(
            &store,
            SubscribeAndStreamRequest {
                subscription_id: SubscriptionId::new(format!(
                    "hosted-watch-{}",
                    self.next_subscription.fetch_add(1, Ordering::Relaxed)
                )),
                params,
                queue_capacity,
            },
            move |error| map_watch_store_error(error, cursor_was_supplied),
        )
        .await
    }
}

fn map_watch_store_error(error: StoreError, cursor_was_supplied: bool) -> BackendError {
    match error {
        StoreError::UnknownRun => BackendError::application(NOT_FOUND, "Run does not exist", None),
        StoreError::RunGone { .. } if cursor_was_supplied => {
            BackendError::application(NOT_FOUND, "Watch cursor does not exist", None)
        }
        StoreError::RunGone { .. } => {
            BackendError::application(GONE, "Run history is no longer available", None)
        }
        _ => BackendError::new(INTERNAL_ERROR_CODE, "Hosted watch is unavailable"),
    }
}

#[cfg(all(test, unix))]
#[path = "backend_tests.rs"]
mod tests;
