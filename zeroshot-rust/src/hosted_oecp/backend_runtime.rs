use openengine_cluster_protocol::{
    ApplyParams, ApplyResult, Cursor, GraphSpec, LegacyShipRequest, NodeAddress, Phase, PlanResult,
    PositiveInteger, RunId, StopMode, WatchEvent, WorkerOutcome,
};
use openengine_cluster_server::admission::CancellationSignal;
use openengine_cluster_server::{BackendError, ConnectionContext};
use tokio::sync::watch;
use tokio::time::sleep;

use super::backend::{
    HostedBackend, HostedState, PreparedRun, RunFinalization, WorkerDrive, WorkerStartFailure,
};
use super::backend_admission_support::{
    graph_diff, reject_cancelled, replay_apply, run_metadata, RunMetadata,
};
use super::backend_support::{
    accepted_plan, graph_invalid, idempotency_reuse, internal_error, precheck_generation,
    redact_request, rejected_plan, safe_application_error, same_apply_identity, second_apply_error,
    single_worker_diagnostics, status_from, step_timeout, terminal_failure_error, validate_apply,
    validate_graph_input, validate_request, verify_trusted_service, worker_error_outcome,
    worker_start_error,
};
use super::worker::{WorkerError, WorkerExecution, WorkerSpawnError};

pub(super) struct Finalization {
    pub(super) execution: WorkerExecution,
    pub(super) process_cancellation: watch::Sender<bool>,
    pub(super) candidate: Result<WorkerOutcome, WorkerError>,
    pub(super) worker_cluster_id: String,
}

pub(super) struct PostWorkerFinalization {
    pub(super) outcome: WorkerOutcome,
    pub(super) cleanup_ok: bool,
    pub(super) process_cleanup_ok: bool,
    pub(super) stop_mode: Option<StopMode>,
    pub(super) worker_cluster_id: Option<String>,
}
fn shutdown_can_force(state: &HostedState) -> bool {
    !state.finished && !state.finalizing && state.phase == Phase::Running
}

impl HostedBackend {
    pub async fn verify_startup_readiness(&self) -> Result<(), BackendError> {
        verify_trusted_service(
            self.worktree.verify_ready(),
            "WORKSPACE_NOT_READY",
            "Prepared workspace is not ready",
        )
        .await?;
        verify_trusted_service(
            self.proxy.verify_ready(),
            "PROXY_NOT_READY",
            "Fixed model proxy is not ready",
        )
        .await?;
        verify_trusted_service(
            self.delivery.verify_ready(),
            "DELIVERY_NOT_READY",
            "Trusted delivery channel is not ready",
        )
        .await?;
        Ok(())
    }

    pub async fn shutdown(&self) -> Result<(), BackendError> {
        loop {
            let notified = self.changed.notified();
            let (finished, terminal_failure, cleanup_without_run, request) = {
                let mut state = self.state.lock().await;
                state.shutting_down = true;
                if shutdown_can_force(&state) {
                    state.shutdown_forced_run = true;
                }
                (
                    state.finished,
                    state.terminal_failure,
                    state.phase == Phase::Empty && state.admission.is_none(),
                    state.finalization_request.clone(),
                )
            };
            if finished {
                self.require_proxy_cleanup().await?;
                return if terminal_failure {
                    Err(terminal_failure_error())
                } else {
                    Ok(())
                };
            }
            if cleanup_without_run {
                self.cleanup_proxy_once().await;
                return self.require_proxy_cleanup().await;
            }
            if let Some(request) = request {
                request.send_replace(Some(StopMode::Force));
            }
            notified.await;
        }
    }

    pub(super) async fn verify(&self, graph: &GraphSpec) -> Result<PlanResult, BackendError> {
        let diagnostics = single_worker_diagnostics(graph);
        if diagnostics.is_empty() {
            accepted_plan(graph)
        } else {
            Ok(rejected_plan(diagnostics))
        }
    }

    pub(super) async fn status(
        &self,
    ) -> Result<openengine_cluster_protocol::ClusterStatus, BackendError> {
        let state = self.state.lock().await;
        if state.terminal_failure {
            return Err(terminal_failure_error());
        }
        Ok(status_from(&state))
    }

    pub(super) async fn publish(
        &self,
        run_id: RunId,
        mut event: WatchEvent,
    ) -> Result<Cursor, BackendError> {
        let mut state = self.state.lock().await;
        let cursor = self
            .journal
            .publish_with(run_id, |cursor| {
                match &mut event {
                    WatchEvent::Phase { status, .. } => {
                        status.at_cursor = Some(cursor.clone());
                    }
                    WatchEvent::Finished { final_status, .. } => {
                        final_status.at_cursor = Some(cursor.clone());
                    }
                    _ => {}
                }
                event
            })
            .map_err(|_| internal_error("hosted event journal rejected a bounded event"))?;
        state.at_cursor = Some(cursor.clone());
        Ok(cursor)
    }

    async fn wait_for_admission(&self, params: &ApplyParams) -> Result<(), BackendError> {
        loop {
            let notified = self.changed.notified();
            {
                let state = self.state.lock().await;
                if let Some(committed) = &state.committed {
                    return if same_apply_identity(committed, params) {
                        Ok(())
                    } else {
                        Err(second_apply_error(committed, params))
                    };
                }
                if let Some(admitting) = &state.admission {
                    if !same_apply_identity(admitting, params) {
                        return Err(second_apply_error(admitting, params));
                    }
                    if admitting != params {
                        return Err(idempotency_reuse());
                    }
                } else {
                    return Ok(());
                }
            }
            notified.await;
        }
    }

    pub(super) async fn apply_once(
        &self,
        context: &ConnectionContext,
        params: ApplyParams,
    ) -> Result<ApplyResult, BackendError> {
        validate_apply(&params)?;
        let planned = self.verify(&params.graph).await?;
        if !planned.ok {
            return Err(graph_invalid(planned.diagnostics));
        }
        if params.dry_run {
            return self.dry_run_result(&params).await;
        }
        if let Some(replay) = self.reserve_apply(context, &params).await? {
            return Ok(replay);
        }
        let backend = self.clone();
        let cancellation = context.cancellation.clone();
        tokio::spawn(async move { backend.begin_reserved_run(params, cancellation).await })
            .await
            .map_err(|_| internal_error("backend-owned admission task failed"))?
    }

    async fn dry_run_result(&self, params: &ApplyParams) -> Result<ApplyResult, BackendError> {
        let state = self.state.lock().await;
        precheck_generation(params.if_generation, state.generation)?;
        if state.terminal_failure {
            return Err(terminal_failure_error());
        }
        Ok(ApplyResult {
            generation: state.generation,
            run_id: state.run_id.clone(),
            phase: state.phase,
            deduped: false,
            diff: Some(graph_diff(state.graph.as_ref(), &params.graph)),
        })
    }

    pub(super) async fn reserve_apply(
        &self,
        context: &ConnectionContext,
        params: &ApplyParams,
    ) -> Result<Option<ApplyResult>, BackendError> {
        loop {
            self.wait_for_admission(params).await?;
            let mut state = self.state.lock().await;
            if state.shutting_down {
                return Err(safe_application_error(
                    "SHUTTING_DOWN",
                    "Hosted runtime is shutting down",
                ));
            }
            if let Some(committed) = &state.committed {
                return replay_apply(&state, committed, params).map(Some);
            }
            if state.terminal_failure {
                return Err(terminal_failure_error());
            }
            if state.admission.is_some() {
                continue;
            }
            precheck_generation(params.if_generation, state.generation)?;
            validate_graph_input(params)?;
            if context.cancellation.is_cancelled() {
                return Err(safe_application_error(
                    "CANCELLED",
                    "Apply was cancelled before commit",
                ));
            }
            state.phase = Phase::Admitting;
            state.admission = Some(params.clone());
            return Ok(None);
        }
    }

    pub(super) async fn begin_reserved_run(
        &self,
        params: ApplyParams,
        cancellation: CancellationSignal,
    ) -> Result<ApplyResult, BackendError> {
        let (request, metadata) = self.prepare_reserved_run(&params, &cancellation).await?;
        let prepared = PreparedRun {
            params,
            request,
            metadata,
        };
        let started = self
            .start_worker(&prepared.request, &prepared.params.graph)
            .await;
        self.finish_worker_start(prepared, started).await
    }

    async fn prepare_reserved_run(
        &self,
        params: &ApplyParams,
        cancellation: &CancellationSignal,
    ) -> Result<(LegacyShipRequest, RunMetadata), BackendError> {
        let prepared = self.prepare_prelaunch(params, cancellation).await;
        if prepared.is_err() {
            self.clear_reservation().await;
        }
        prepared
    }

    async fn prepare_prelaunch(
        &self,
        params: &ApplyParams,
        cancellation: &CancellationSignal,
    ) -> Result<(LegacyShipRequest, RunMetadata), BackendError> {
        reject_cancelled(cancellation)?;
        self.verify_startup_readiness().await?;
        reject_cancelled(cancellation)?;
        self.reject_shutdown().await?;
        let request = validate_request(params, &self.authority)?;
        reject_cancelled(cancellation)?;
        let metadata = run_metadata(params.graph.clone())?;
        Ok((request, metadata))
    }

    async fn finish_worker_start(
        &self,
        prepared: PreparedRun,
        started: Result<(WorkerDrive, watch::Sender<Option<StopMode>>), WorkerStartFailure>,
    ) -> Result<ApplyResult, BackendError> {
        match started {
            Ok((drive, finalization_request)) => {
                let committed = self
                    .commit_run(&prepared, RunFinalization::Active(finalization_request))
                    .await;
                let node_started = if committed.is_ok() {
                    self.publish_node_begin(&prepared.metadata, &prepared.request)
                        .await
                } else {
                    Ok(())
                };
                self.spawn_worker_drive(drive);
                committed?;
                node_started?;
                Ok(prepared.metadata.result)
            }
            Err(WorkerStartFailure::PreLaunch(error)) => {
                self.clear_reservation().await;
                Err(worker_start_error(error))
            }
            Err(WorkerStartFailure::PostLaunch {
                error,
                execution,
                process_cancellation,
            }) => {
                let committed = self
                    .commit_run(&prepared, RunFinalization::FailedStart)
                    .await;
                let node_started = if committed.is_ok() {
                    self.publish_node_begin(&prepared.metadata, &prepared.request)
                        .await
                } else {
                    Ok(())
                };
                self.finish_failed_start(error, execution, process_cancellation)
                    .await;
                committed?;
                node_started?;
                Err(worker_start_error(error))
            }
        }
    }

    async fn clear_reservation(&self) {
        let mut state = self.state.lock().await;
        state.phase = Phase::Empty;
        state.admission = None;
        drop(state);
        self.changed.notify_waiters();
    }

    async fn start_worker(
        &self,
        request: &LegacyShipRequest,
        graph: &GraphSpec,
    ) -> Result<(WorkerDrive, watch::Sender<Option<StopMode>>), WorkerStartFailure> {
        let (process_cancellation, process_observer) = watch::channel(false);
        let execution = match WorkerExecution::spawn_command(
            request,
            process_observer,
            self.worker_command.clone(),
        )
        .await
        {
            Ok(execution) => execution,
            Err(WorkerSpawnError::PreLaunch(error)) => {
                return Err(WorkerStartFailure::PreLaunch(error));
            }
            Err(WorkerSpawnError::PostLaunch { error, execution }) => {
                return Err(WorkerStartFailure::PostLaunch {
                    error,
                    execution,
                    process_cancellation,
                });
            }
        };
        let (finalization_request, finalization_observer) = watch::channel(None);
        Ok((
            WorkerDrive {
                execution,
                process_cancellation,
                finalization_observer,
                timeout: step_timeout(graph),
            },
            finalization_request,
        ))
    }

    async fn commit_run(
        &self,
        prepared: &PreparedRun,
        finalization: RunFinalization,
    ) -> Result<(), BackendError> {
        let mut state = self.state.lock().await;
        state.graph = Some(prepared.metadata.graph.clone());
        state.phase = Phase::Running;
        state.generation = Some(prepared.metadata.generation);
        state.run_id = Some(prepared.metadata.run_id.clone());
        state.committed = Some(prepared.params.clone());
        state.apply_result = Some(prepared.metadata.result.clone());
        state.admission = None;
        match finalization {
            RunFinalization::Active(request) => {
                state.finalization_request = Some(request);
                state.finalizing = false;
            }
            RunFinalization::FailedStart => {
                state.finalization_request = None;
                state.finalizing = true;
            }
        }
        let cursor = self
            .journal
            .publish_with(prepared.metadata.run_id.clone(), |cursor| {
                let mut status = status_from(&state);
                status.at_cursor = Some(cursor.clone());
                WatchEvent::Phase {
                    status,
                    admission: Some(Box::new(openengine_cluster_protocol::AdmissionTransition {
                        run_id: prepared.metadata.run_id.clone(),
                        spec: prepared.metadata.graph.clone(),
                        seed_input: redact_request(&prepared.request),
                    })),
                }
            })
            .map_err(|_| internal_error("hosted event journal rejected admission"))?;
        state.at_cursor = Some(cursor);
        drop(state);
        self.changed.notify_waiters();
        Ok(())
    }

    async fn publish_node_begin(
        &self,
        metadata: &RunMetadata,
        request: &LegacyShipRequest,
    ) -> Result<(), BackendError> {
        self.publish(
            metadata.run_id.clone(),
            WatchEvent::NodeBegin {
                node: NodeAddress {
                    node: metadata.graph.root.name().clone(),
                    attempt: PositiveInteger::new(1)
                        .map_err(|_| internal_error("invalid attempt"))?,
                },
                input: redact_request(request),
            },
        )
        .await?;
        Ok(())
    }

    async fn finish_failed_start(
        &self,
        error: WorkerError,
        execution: Option<WorkerExecution>,
        process_cancellation: watch::Sender<bool>,
    ) {
        let cleanup_ok = self.cleanup_proxy_once().await;
        process_cancellation.send_replace(true);
        let process_cleanup_ok = match execution {
            Some(execution) => execution.prove_stopped().await.is_ok(),
            None => false,
        };
        self.complete_post_worker(PostWorkerFinalization {
            outcome: worker_error_outcome(error),
            cleanup_ok,
            process_cleanup_ok,
            stop_mode: None,
            worker_cluster_id: None,
        })
        .await;
    }

    fn spawn_worker_drive(&self, drive: WorkerDrive) {
        let backend = self.clone();
        tokio::spawn(async move { backend.drive_worker(drive).await });
    }

    async fn drive_worker(&self, mut request: WorkerDrive) {
        let candidate = tokio::select! {
            outcome = request.execution.wait_terminal() => outcome,
            changed = request.finalization_observer.changed() => {
                if changed.is_ok()
                    && *request.finalization_observer.borrow_and_update() == Some(StopMode::Force)
                {
                    Err(WorkerError::Exited)
                } else {
                    request.execution.wait_terminal().await
                }
            }
            () = sleep(request.timeout) => Err(WorkerError::Timeout),
        };
        let worker_cluster_id = request.execution.cluster_id().to_owned();
        self.finalize(Finalization {
            execution: request.execution,
            process_cancellation: request.process_cancellation,
            candidate,
            worker_cluster_id,
        })
        .await;
    }
}
