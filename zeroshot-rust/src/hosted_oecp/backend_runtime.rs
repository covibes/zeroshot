use openengine_cluster_protocol::{
    ApplyParams, ApplyResult, Cursor, GraphSpec, LegacyShipRequest, NodeAddress, Phase, PlanResult,
    PositiveInteger, RunId, StopMode, WatchEvent, WorkerErrorCode, WorkerOutcome,
};
use openengine_cluster_server::admission::CancellationSignal;
use openengine_cluster_server::{BackendError, ConnectionContext};
use tokio::sync::watch;
use tokio::time::{sleep, timeout, Duration};

use super::backend::HostedBackend;
use super::backend_admission_support::{
    graph_diff, reject_cancelled, replay_apply, run_metadata, RunMetadata,
};
use super::backend_support::{
    accepted_plan, graph_invalid, idempotency_reuse, internal_error, precheck_generation,
    redact_request, rejected_plan, safe_application_error, same_apply_identity, second_apply_error,
    single_worker_diagnostics, status_from, step_timeout, validate_apply, validate_graph_input,
    validate_request, verify_trusted_service, worker_start_error, TRUSTED_SERVICE_DEADLINE,
};
use super::worker::{WorkerError, WorkerExecution};

struct WorkerDrive {
    execution: WorkerExecution,
    process_cancellation: watch::Sender<bool>,
    finalization_observer: watch::Receiver<Option<StopMode>>,
    timeout: Duration,
}

pub(super) struct Finalization {
    pub(super) execution: WorkerExecution,
    pub(super) process_cancellation: watch::Sender<bool>,
    pub(super) candidate: Result<WorkerOutcome, WorkerError>,
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
            let (finished, cleanup_without_run, request) = {
                let mut state = self.state.lock().await;
                state.shutting_down = true;
                (
                    state.finished,
                    state.phase == Phase::Empty && state.admission.is_none(),
                    state.finalization_request.clone(),
                )
            };
            if finished {
                return self.require_proxy_cleanup().await;
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

    pub(super) async fn cleanup_proxy_once(&self) -> bool {
        {
            let mut state = self.state.lock().await;
            if let Some(result) = state.proxy_cleanup_result {
                return result;
            }
            state.proxy_cleanup_result = Some(false);
        }
        let cleaned = timeout(
            TRUSTED_SERVICE_DEADLINE,
            self.proxy.stop_admission_and_cleanup(),
        )
        .await
        .is_ok_and(|result| result.is_ok());
        self.state.lock().await.proxy_cleanup_result = Some(cleaned);
        self.changed.notify_waiters();
        cleaned
    }

    async fn require_proxy_cleanup(&self) -> Result<(), BackendError> {
        if self.state.lock().await.proxy_cleanup_result == Some(true) {
            Ok(())
        } else {
            Err(safe_application_error(
                "PROXY_CLEANUP",
                "Fixed model proxy cleanup failed",
            ))
        }
    }

    async fn reject_shutdown(&self) -> Result<(), BackendError> {
        if self.state.lock().await.shutting_down {
            Err(safe_application_error(
                "SHUTTING_DOWN",
                "Hosted runtime is shutting down",
            ))
        } else {
            Ok(())
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

    pub(super) async fn status(&self) -> openengine_cluster_protocol::ClusterStatus {
        let state = self.state.lock().await;
        status_from(&state)
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
        Ok(ApplyResult {
            generation: state.generation,
            run_id: state.run_id.clone(),
            phase: state.phase,
            deduped: false,
            diff: Some(graph_diff(state.graph.as_ref(), &params.graph)),
        })
    }

    async fn reserve_apply(
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

    async fn begin_reserved_run(
        &self,
        params: ApplyParams,
        cancellation: CancellationSignal,
    ) -> Result<ApplyResult, BackendError> {
        let (request, metadata) = self.prepare_reserved_run(&params, &cancellation).await?;
        let started = self.start_worker(&request, &params.graph).await;
        self.finish_worker_start(params, request, metadata, started)
            .await
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
        let request = validate_request(params)?;
        reject_cancelled(cancellation)?;
        let metadata = run_metadata(params.graph.clone())?;
        Ok((request, metadata))
    }

    async fn finish_worker_start(
        &self,
        params: ApplyParams,
        request: LegacyShipRequest,
        metadata: RunMetadata,
        started: Result<(WorkerDrive, watch::Sender<Option<StopMode>>), WorkerError>,
    ) -> Result<ApplyResult, BackendError> {
        match started {
            Ok((drive, finalization_request)) => {
                let committed = self
                    .commit_run(&params, &metadata, &request, Some(finalization_request))
                    .await;
                let node_started = if committed.is_ok() {
                    self.publish_node_begin(&metadata, &request).await
                } else {
                    Ok(())
                };
                self.spawn_worker_drive(drive);
                committed?;
                node_started?;
                Ok(metadata.result)
            }
            Err(WorkerError::Launch) => {
                self.clear_reservation().await;
                Err(worker_start_error(WorkerError::Launch))
            }
            Err(error) => {
                let committed = self.commit_run(&params, &metadata, &request, None).await;
                let node_started = if committed.is_ok() {
                    self.publish_node_begin(&metadata, &request).await
                } else {
                    Ok(())
                };
                self.finish_failed_start(&metadata, error).await;
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
    ) -> Result<(WorkerDrive, watch::Sender<Option<StopMode>>), WorkerError> {
        let (process_cancellation, process_observer) = watch::channel(false);
        let execution =
            WorkerExecution::spawn_command(request, process_observer, self.worker_command.clone())
                .await?;
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
        params: &ApplyParams,
        metadata: &RunMetadata,
        request: &LegacyShipRequest,
        finalization_request: Option<watch::Sender<Option<StopMode>>>,
    ) -> Result<(), BackendError> {
        let mut state = self.state.lock().await;
        state.graph = Some(metadata.graph.clone());
        state.phase = Phase::Running;
        state.generation = Some(metadata.generation);
        state.run_id = Some(metadata.run_id.clone());
        state.committed = Some(params.clone());
        state.apply_result = Some(metadata.result.clone());
        state.admission = None;
        state.finalization_request = finalization_request;
        let cursor = self
            .journal
            .publish_with(metadata.run_id.clone(), |cursor| {
                let mut status = status_from(&state);
                status.at_cursor = Some(cursor.clone());
                WatchEvent::Phase {
                    status,
                    admission: Some(Box::new(openengine_cluster_protocol::AdmissionTransition {
                        run_id: metadata.run_id.clone(),
                        spec: metadata.graph.clone(),
                        seed_input: redact_request(request),
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

    async fn finish_failed_start(&self, metadata: &RunMetadata, _error: WorkerError) {
        let _ = self.cleanup_proxy_once().await;
        let outcome = WorkerOutcome::declared_failure(WorkerErrorCode::Crash);
        let _ = self
            .publish(
                metadata.run_id.clone(),
                WatchEvent::NodeEnd {
                    node: NodeAddress {
                        node: metadata.graph.root.name().clone(),
                        attempt: PositiveInteger::new(1).expect("one is positive"),
                    },
                    outcome,
                },
            )
            .await;
        let mut state = self.state.lock().await;
        state.phase = Phase::Finished;
        let published = self
            .journal
            .publish_with(metadata.run_id.clone(), |cursor| {
                let mut final_status = status_from(&state);
                final_status.at_cursor = Some(cursor.clone());
                WatchEvent::Finished {
                    final_status,
                    stop_mode: None,
                }
            });
        if let Ok(cursor) = &published {
            state.at_cursor = Some(cursor.clone());
        }
        state.finished = true;
        state.finalizing = false;
        self.journal.close();
        drop(state);
        let _ = published;
        self.changed.notify_waiters();
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
            () = sleep(request.timeout) => Err(WorkerError::Exited),
        };
        self.finalize(Finalization {
            execution: request.execution,
            process_cancellation: request.process_cancellation,
            candidate,
        })
        .await;
    }
}
