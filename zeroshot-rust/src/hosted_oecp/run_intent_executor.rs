use std::sync::Arc;

use async_trait::async_trait;
use openengine_cluster_protocol::{
    ApplyParams, Generation, IdempotencyKey, LegacyShipResult, LegacyShipStatus, PlanParams,
    WatchEvent, WatchParams, WorkerOutcome,
};
use openengine_cluster_server::admission::CancellationSignal;
use openengine_cluster_server::watch::{WatchEventStream, WatchHandle, WatchStreamItem};
use openengine_cluster_server::{BackendError, BackendErrorKind, ClusterBackend, ConnectionContext};
use serde_json::{to_value, Value};
use tokio::sync::Mutex;

use super::backend::HostedBackend;
use super::run_intent::{
    RunIntentExecutor, RunIntentIdentity, RunIntentLookup, RunIntentStatus, RunIntentSubmission,
    RunIntentSubmitError, MAX_RUN_INTENT_BYTES,
};
use super::worker::validate_worker_request;

#[derive(Clone, Debug, PartialEq)]
struct RunIntentRecord {
    identity: RunIntentIdentity,
    status: RunIntentStatus,
}

#[derive(Clone)]
pub(super) struct HostedRunIntentExecutor {
    backend: Arc<HostedBackend>,
    record: Arc<Mutex<Option<RunIntentRecord>>>,
}

impl HostedRunIntentExecutor {
    pub(super) fn new(backend: Arc<HostedBackend>) -> Self {
        Self {
            backend,
            record: Arc::new(Mutex::new(None)),
        }
    }

    async fn reserve(
        &self,
        submission: &RunIntentSubmission,
    ) -> Result<Reservation, RunIntentSubmitError> {
        let mut record = self.record.lock().await;
        if let Some(existing) = record.as_ref() {
            return Ok(if existing.identity == submission.identity {
                Reservation::Existing(existing.status.clone())
            } else {
                Reservation::Conflict
            });
        }

        let authority = self
            .backend
            .runtime_authority()
            .await
            .map_err(|_| RunIntentSubmitError::Rejected)?;
        let params =
            apply_params(submission, &authority).map_err(|_| RunIntentSubmitError::Rejected)?;
        let planned = self
            .backend
            .plan(
                &ConnectionContext::default(),
                PlanParams {
                    graph: params.graph.clone(),
                },
            )
            .await
            .map_err(|_| RunIntentSubmitError::Unavailable)?;
        if !planned.ok {
            return Err(RunIntentSubmitError::Rejected);
        }
        self.backend
            .reserve_run_intent(&params)
            .await
            .map_err(classify_reservation_error)?;
        let watch = self
            .backend
            .watch(&ConnectionContext::default(), WatchParams::default(), 16)
            .await;
        let Ok((_receipt, stream, handle)) = watch else {
            self.backend.release_run_intent_reservation(&params).await;
            return Err(RunIntentSubmitError::Unavailable);
        };
        *record = Some(RunIntentRecord {
            identity: submission.identity.clone(),
            status: RunIntentStatus::Running,
        });
        Ok(Reservation::Reserved(Box::new(ReservedRun {
            params,
            stream,
            _handle: handle,
        })))
    }

    async fn execute(&self, identity: RunIntentIdentity, reserved: ReservedRun) {
        let ReservedRun {
            params,
            mut stream,
            _handle,
        } = reserved;
        let started = self
            .backend
            .begin_reserved_run(params, CancellationSignal::default())
            .await;
        let status = match started {
            Err(_) => None,
            Ok(_) => terminal_status(&self.backend, &mut stream).await,
        };
        match status {
            Some(status) => self.finish(&identity, status).await,
            None => self.clear(&identity).await,
        }
    }

    async fn finish(&self, identity: &RunIntentIdentity, status: RunIntentStatus) {
        let mut record = self.record.lock().await;
        let Some(record) = record.as_mut() else {
            return;
        };
        if &record.identity == identity && matches!(record.status, RunIntentStatus::Running) {
            record.status = status;
        }
    }

    async fn clear(&self, identity: &RunIntentIdentity) {
        let mut record = self.record.lock().await;
        if record
            .as_ref()
            .is_some_and(|record| &record.identity == identity)
        {
            *record = None;
        }
    }
}

struct ReservedRun {
    params: ApplyParams,
    stream: WatchEventStream,
    _handle: WatchHandle,
}

enum Reservation {
    Reserved(Box<ReservedRun>),
    Existing(RunIntentStatus),
    Conflict,
}

#[async_trait]
impl RunIntentExecutor for HostedRunIntentExecutor {
    async fn submit(
        &self,
        submission: RunIntentSubmission,
    ) -> Result<RunIntentStatus, RunIntentSubmitError> {
        match self.reserve(&submission).await? {
            Reservation::Existing(status) => Ok(status),
            Reservation::Conflict => Err(RunIntentSubmitError::Conflict),
            Reservation::Reserved(reserved) => {
                let executor = self.clone();
                let identity = submission.identity;
                tokio::spawn(async move {
                    executor.execute(identity, *reserved).await;
                });
                Ok(RunIntentStatus::Running)
            }
        }
    }

    async fn lookup(&self, identity: &RunIntentIdentity) -> RunIntentLookup {
        let record = self.record.lock().await;
        let Some(record) = record.as_ref() else {
            return RunIntentLookup::NotFound;
        };
        if record.identity.intent_id() != identity.intent_id() {
            return RunIntentLookup::NotFound;
        }
        if record.identity.digest() != identity.digest() {
            return RunIntentLookup::Conflict;
        }
        RunIntentLookup::Found(record.status.clone())
    }
}

fn apply_params(
    submission: &RunIntentSubmission,
    authority: &super::config::HostedAuthority,
) -> Result<ApplyParams, ()> {
    let request = submission.input.hosted_request(authority)?;
    validate_worker_request(&request).map_err(|_| ())?;
    let mut input = to_value(request).map_err(|_| ())?;
    let Value::Object(fields) = &mut input else {
        return Err(());
    };
    fields.retain(|_, value| !value.is_null());
    Ok(ApplyParams {
        graph: submission.graph.clone(),
        input: Some(input),
        dry_run: false,
        if_generation: Some(Generation::new(0).map_err(|_| ())?),
        idempotency_key: Some(
            IdempotencyKey::new(format!("run-intent:{}", submission.identity.intent_id()))
                .map_err(|_| ())?,
        ),
    })
}

fn classify_reservation_error(error: BackendError) -> RunIntentSubmitError {
    if error.code == openengine_cluster_protocol::RUN_CONFLICT {
        RunIntentSubmitError::Conflict
    } else if error.kind == BackendErrorKind::InvalidParams
        || error.code == "HOSTED_ARTIFACT_UNSUPPORTED"
    {
        RunIntentSubmitError::Rejected
    } else {
        RunIntentSubmitError::Unavailable
    }
}

async fn terminal_status(
    backend: &HostedBackend,
    stream: &mut WatchEventStream,
) -> Option<RunIntentStatus> {
    let mut outcome = None;
    while let Some(item) = stream.next().await {
        match item {
            WatchStreamItem::Record(record) => match record.event {
                WatchEvent::NodeEnd {
                    outcome: terminal, ..
                } => outcome = Some(terminal),
                WatchEvent::Finished { .. } => {
                    return completed_status(backend, outcome.as_ref()).await;
                }
                _ => {}
            },
            WatchStreamItem::Closed { .. } => return None,
        }
    }
    completed_status(backend, outcome.as_ref()).await
}

async fn completed_status(
    backend: &HostedBackend,
    outcome: Option<&WorkerOutcome>,
) -> Option<RunIntentStatus> {
    if backend.run_intent_platform_failure().await {
        None
    } else {
        finished_terminal_status(outcome)
    }
}

fn finished_terminal_status(outcome: Option<&WorkerOutcome>) -> Option<RunIntentStatus> {
    outcome.map(finished_status)
}

fn finished_status(outcome: &WorkerOutcome) -> RunIntentStatus {
    match outcome {
        WorkerOutcome::Verified { output, .. } => verified_status(output),
        outcome => failed_outcome_status(outcome),
    }
}

fn verified_status(output: &Value) -> RunIntentStatus {
    let Ok(result) = serde_json::from_value::<LegacyShipResult>(output.clone()) else {
        return RunIntentStatus::Failed("malformed_result");
    };
    if result.status != LegacyShipStatus::Succeeded {
        return RunIntentStatus::Failed("worker_failed");
    }
    let public_result = serde_json::json!({
        "artifacts": result.artifacts,
        "summary": "Hosted worker completed",
        "status": "succeeded"
    });
    let response = serde_json::json!({ "state": "succeeded", "result": public_result });
    if serde_json::to_vec(&response).is_ok_and(|bytes| bytes.len() <= MAX_RUN_INTENT_BYTES) {
        RunIntentStatus::Succeeded(public_result)
    } else {
        RunIntentStatus::Failed("result_too_large")
    }
}

fn failed_outcome_status(outcome: &WorkerOutcome) -> RunIntentStatus {
    match outcome {
        WorkerOutcome::Verifier { .. } => RunIntentStatus::Failed("verification_failed"),
        WorkerOutcome::Error { code, .. } => RunIntentStatus::Failed(code.as_str()),
        WorkerOutcome::Verified { .. } => RunIntentStatus::Failed("finalization_failed"),
    }
}

#[cfg(test)]
mod tests {
    use super::finished_terminal_status;

    #[test]
    fn finished_without_node_outcome_is_retryable_platform_failure() {
        assert_eq!(finished_terminal_status(None), None);
    }
}
