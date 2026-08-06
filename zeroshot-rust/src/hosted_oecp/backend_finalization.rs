use openengine_cluster_protocol::{
    Generation, NodeAddress, Phase, PositiveInteger, RunId, StopMode, StopParams, StopResult,
    WatchEvent, WorkerErrorCode, WorkerOutcome,
};
use openengine_cluster_server::BackendError;
use tokio::sync::watch;
use tokio::time::timeout;

use super::backend::{HostedBackend, HostedState};
use super::backend_runtime::{Finalization, PostWorkerFinalization};
use super::backend_support::{
    generation_error, idempotency_reuse, internal_error, operational, safe_application_error,
    status_from, terminal_failure_error, worker_error_outcome, TRUSTED_SERVICE_DEADLINE,
};
use super::ports::DeliveryIntent;
use super::worker::WorkerError;

impl HostedBackend {
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

    pub(super) async fn require_proxy_cleanup(&self) -> Result<(), BackendError> {
        if self.state.lock().await.proxy_cleanup_result == Some(true) {
            Ok(())
        } else {
            Err(safe_application_error(
                "PROXY_CLEANUP",
                "Fixed model proxy cleanup failed",
            ))
        }
    }

    pub(super) async fn reject_shutdown(&self) -> Result<(), BackendError> {
        if self.state.lock().await.shutting_down {
            Err(safe_application_error(
                "SHUTTING_DOWN",
                "Hosted runtime is shutting down",
            ))
        } else {
            Ok(())
        }
    }
    pub(super) async fn finalize(&self, request: Finalization) {
        let Some(stop_mode) = self.claim_finalization().await else {
            return;
        };
        let cleanup_ok = self.cleanup_proxy_once().await;
        request.process_cancellation.send_replace(true);
        let process_cleanup_ok = request.execution.prove_stopped().await.is_ok();
        self.complete_post_worker(PostWorkerFinalization {
            outcome: terminal_candidate(stop_mode, request.candidate),
            cleanup_ok,
            process_cleanup_ok,
            worker_cluster_id: Some(request.worker_cluster_id),
            stop_mode,
        })
        .await;
    }

    pub(super) async fn complete_post_worker(&self, request: PostWorkerFinalization) {
        let terminal_ready = match (&request.outcome, request.stop_mode) {
            (WorkerOutcome::Verified { .. }, _) => self.deliver_after_cleanup(&request).await,
            (_, Some(StopMode::Force)) => request.cleanup_ok && request.process_cleanup_ok,
            _ => false,
        };
        if terminal_ready {
            self.publish_terminal(request.outcome, request.stop_mode)
                .await;
        } else {
            let retryable = request.stop_mode.is_some()
                || !request.cleanup_ok
                || !request.process_cleanup_ok
                || matches!(request.outcome, WorkerOutcome::Verified { .. });
            self.close_failed_terminal(request.outcome, retryable).await;
        }
    }

    async fn claim_finalization(&self) -> Option<Option<StopMode>> {
        let mut state = self.state.lock().await;
        if state.finished || state.finalizing {
            return None;
        }
        state.finalizing = true;
        Some(if state.shutdown_forced_run {
            Some(StopMode::Force)
        } else {
            state.stop_request.as_ref().map(|params| params.mode)
        })
    }

    async fn deliver_after_cleanup(&self, request: &PostWorkerFinalization) -> bool {
        if !request.cleanup_ok || !request.process_cleanup_ok {
            return false;
        }
        let worktree_ok = timeout(
            TRUSTED_SERVICE_DEADLINE,
            self.worktree.verify_delivery_ready(),
        )
        .await
        .is_ok_and(|result| result.is_ok());
        if !worktree_ok {
            return false;
        }
        let Some((generation, run_id)) = self.run_identity().await else {
            return false;
        };
        let Some(worker_cluster_id) = request.worker_cluster_id.as_deref() else {
            return false;
        };
        let Ok(intent) =
            DeliveryIntent::new(generation, run_id, worker_cluster_id, &request.outcome)
        else {
            return false;
        };
        self.delivery_succeeded(&intent).await
    }
    async fn delivery_succeeded(&self, intent: &DeliveryIntent) -> bool {
        timeout(
            TRUSTED_SERVICE_DEADLINE,
            self.delivery.deliver(intent.clone()),
        )
        .await
        .is_ok_and(|result| result.is_ok_and(|receipt| receipt.validate_for(intent).is_ok()))
    }

    async fn run_identity(&self) -> Option<(Generation, RunId)> {
        let state = self.state.lock().await;
        Some((state.generation?, state.run_id.clone()?))
    }

    async fn publish_terminal(&self, outcome: WorkerOutcome, stop_mode: Option<StopMode>) {
        let Some(run_id) = self.publish_node_end(outcome).await else {
            self.complete_terminal_failure(true).await;
            return;
        };
        let mut state = self.state.lock().await;
        state.phase = Phase::Finished;
        let published = self.journal.publish_with(run_id, |cursor| {
            let mut final_status = status_from(&state);
            final_status.at_cursor = Some(cursor.clone());
            WatchEvent::Finished {
                final_status,
                stop_mode,
            }
        });
        if let Ok(cursor) = &published {
            state.at_cursor = Some(cursor.clone());
        }
        state.finished = true;
        state.finalizing = false;
        finish_stop_receipts(&mut state);
        self.journal.close();
        drop(state);
        let _ = published;
        self.changed.notify_waiters();
    }

    async fn publish_node_end(&self, outcome: WorkerOutcome) -> Option<RunId> {
        let (run_id, node) = self.terminal_event_identity().await?;
        let _ = self
            .publish(
                run_id.clone(),
                WatchEvent::NodeEnd {
                    node: NodeAddress {
                        node,
                        attempt: PositiveInteger::new(1).expect("one is positive"),
                    },
                    outcome,
                },
            )
            .await;
        Some(run_id)
    }

    async fn close_failed_terminal(&self, outcome: WorkerOutcome, retryable: bool) {
        let outcome = match outcome {
            WorkerOutcome::Verified { .. } => {
                WorkerOutcome::declared_failure(WorkerErrorCode::Crash)
            }
            outcome => outcome,
        };
        self.publish_node_end(outcome).await;
        self.complete_terminal_failure(retryable).await;
    }
    async fn terminal_event_identity(
        &self,
    ) -> Option<(RunId, openengine_cluster_protocol::NodeName)> {
        let state = self.state.lock().await;
        Some((
            state.run_id.clone()?,
            state.graph.as_ref()?.root.name().clone(),
        ))
    }

    async fn complete_terminal_failure(&self, retryable: bool) {
        let mut state = self.state.lock().await;
        state.finished = true;
        state.terminal_failure = true;
        state.terminal_failure_retryable = retryable;
        state.finalizing = false;
        state.finalization_request = None;
        self.journal.close();
        drop(state);
        self.changed.notify_waiters();
    }

    pub(super) async fn stop_once(&self, params: StopParams) -> Result<StopResult, BackendError> {
        let (receipt, newly_accepted) = self.request_stop(&params).await?;
        if let Some(receipt) = receipt {
            return Ok(receipt);
        }
        self.wait_for_stop(&params, !newly_accepted).await
    }

    async fn request_stop(
        &self,
        params: &StopParams,
    ) -> Result<(Option<StopResult>, bool), BackendError> {
        let mut state = self.state.lock().await;
        if let Some(known) = known_stop(&state, params)? {
            return Ok(match known {
                KnownStop::Receipt(receipt) => (Some(receipt), false),
                KnownStop::Pending => (None, false),
            });
        }
        validate_stoppable(&state, params)?;
        validate_stop_transition(&state, params)?;
        let request = state
            .finalization_request
            .as_ref()
            .cloned()
            .ok_or_else(|| internal_error("running worker lacks finalization ownership"))?;
        let run_id = state
            .run_id
            .clone()
            .ok_or_else(|| internal_error("running worker lacks run identity"))?;
        self.append_stop_phase(&mut state, run_id, params)?;

        drop(state);
        signal_stop(&request, params.mode);
        self.changed.notify_waiters();
        Ok((None, true))
    }
    fn append_stop_phase(
        &self,
        state: &mut HostedState,
        run_id: RunId,
        params: &StopParams,
    ) -> Result<(), BackendError> {
        let previous = state.stop_request.replace(params.clone());
        state.stop_requests.push(params.clone());
        let published = self.journal.publish_with(run_id, |cursor| {
            let mut status = status_from(state);
            status.at_cursor = Some(cursor.clone());
            WatchEvent::Phase {
                status,
                admission: None,
            }
        });
        match published {
            Ok(cursor) => {
                state.at_cursor = Some(cursor);
                Ok(())
            }
            Err(_) => {
                state.stop_requests.pop();
                state.stop_request = previous;
                Err(internal_error("hosted event journal rejected stop phase"))
            }
        }
    }

    async fn wait_for_stop(
        &self,
        params: &StopParams,
        deduped: bool,
    ) -> Result<StopResult, BackendError> {
        loop {
            let notified = self.changed.notified();
            {
                let state = self.state.lock().await;
                if state.terminal_failure {
                    return Err(terminal_failure_error());
                }
                if let Some((committed, result)) = state
                    .stop_receipts
                    .iter()
                    .find(|(committed, _)| committed.idempotency_key == params.idempotency_key)
                {
                    let mut result = replay_stop(committed, result, params)?;
                    result.deduped = deduped;
                    return Ok(result);
                }
            }
            notified.await;
        }
    }
}

fn signal_stop(request: &watch::Sender<Option<StopMode>>, mode: StopMode) {
    if mode == StopMode::Force {
        request.send_replace(Some(StopMode::Force));
    }
}

enum KnownStop {
    Receipt(StopResult),
    Pending,
}

fn known_stop(state: &HostedState, params: &StopParams) -> Result<Option<KnownStop>, BackendError> {
    if state
        .committed
        .as_ref()
        .and_then(|apply| apply.idempotency_key.as_ref())
        == Some(&params.idempotency_key)
    {
        return Err(idempotency_reuse());
    }
    if let Some((committed, result)) = state
        .stop_receipts
        .iter()
        .find(|(committed, _)| committed.idempotency_key == params.idempotency_key)
    {
        return replay_stop(committed, result, params)
            .map(KnownStop::Receipt)
            .map(Some);
    }
    let Some(committed) = state
        .stop_requests
        .iter()
        .find(|committed| committed.idempotency_key == params.idempotency_key)
    else {
        return Ok(None);
    };
    if committed == params {
        Ok(Some(KnownStop::Pending))
    } else {
        Err(idempotency_reuse())
    }
}

fn validate_stop_transition(state: &HostedState, params: &StopParams) -> Result<(), BackendError> {
    if state
        .stop_request
        .as_ref()
        .is_some_and(|pending| pending.mode != StopMode::Drain || params.mode != StopMode::Force)
    {
        Err(safe_application_error(
            openengine_cluster_protocol::INVALID_PHASE,
            "Accepted stop mode cannot be downgraded or replaced",
        ))
    } else {
        Ok(())
    }
}
fn terminal_candidate(
    stop_mode: Option<StopMode>,
    candidate: Result<WorkerOutcome, WorkerError>,
) -> WorkerOutcome {
    match (stop_mode, candidate) {
        (_, Ok(outcome @ WorkerOutcome::Verified { .. })) => outcome,
        (Some(StopMode::Force), _) => WorkerOutcome::declared_failure(WorkerErrorCode::Refusal),
        (Some(StopMode::Drain) | None, candidate) => candidate.unwrap_or_else(worker_error_outcome),
    }
}

fn replay_stop(
    committed: &StopParams,
    result: &StopResult,
    requested: &StopParams,
) -> Result<StopResult, BackendError> {
    if committed != requested {
        return Err(idempotency_reuse());
    }
    let mut replayed = result.clone();
    replayed.deduped = true;
    Ok(replayed)
}

fn finish_stop_receipts(state: &mut HostedState) {
    let (Some(accepted), Some(generation), Some(run_id), Some(at_cursor)) = (
        state.stop_request.as_ref().map(|params| params.mode),
        state.generation,
        state.run_id.clone(),
        state.at_cursor.clone(),
    ) else {
        return;
    };
    let effective = if state.shutdown_forced_run {
        StopMode::Force
    } else {
        accepted
    };
    state.stop_receipts = state
        .stop_requests
        .iter()
        .cloned()
        .map(|params| {
            let result = StopResult {
                generation,
                run_id: run_id.clone(),
                phase: Phase::Finished,
                accepted_mode: params.mode,
                effective_mode: effective,
                operational: operational(Phase::Finished, Some(effective)),
                at_cursor: at_cursor.clone(),
                deduped: false,
            };
            (params, result)
        })
        .collect();
}

fn validate_stoppable(state: &HostedState, params: &StopParams) -> Result<(), BackendError> {
    if state.terminal_failure {
        return Err(terminal_failure_error());
    }
    if state.finalizing {
        return Err(safe_application_error(
            openengine_cluster_protocol::INVALID_PHASE,
            "Worker finalization is already in progress",
        ));
    }
    if state.finished || state.phase != Phase::Running {
        return Err(safe_application_error(
            openengine_cluster_protocol::INVALID_PHASE,
            "No running worker exists",
        ));
    }
    if state.generation != Some(params.if_generation) {
        return Err(generation_error(state.generation));
    }
    Ok(())
}
