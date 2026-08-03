use std::{
    collections::BTreeMap,
    sync::atomic::{AtomicU64, Ordering},
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use async_trait::async_trait;
use openengine_cluster_protocol::{
    legacy_ship_request_payload_type, legacy_ship_result_payload_type, ApplyParams, ApplyResult,
    ClusterStatus, Cursor, DiagnosticSeverity, DispatchState, Generation, GetParams, GetResult,
    GraphDiagnostic, GraphDiagnosticCode, GraphNode, GraphProfile, GraphProfileSet, GraphSpec,
    IdempotencyKey, InitializeParams, InitializeResult, Labels, LegacyShipRequest,
    LegacyShipResult, LegacyShipStatus, LogLevel, NodeAddress, NonEmptyVec, OperationalStatus,
    Phase, PlanParams, PlanResult, PositiveInteger, RunId, ServerCapabilities, StopParams,
    StopResult, StructuralBounds, SubscriptionId, TerminationWitness, WatchEvent, WatchParams,
    WatchResult, WorkerDescriptor, WorkerErrorCode, WorkerOutcome, WorkerRef, GENERATION_CONFLICT,
    GRAPH_INVALID, IDEMPOTENCY_REUSE, INTERNAL_ERROR_CODE, INVALID_PHASE, RUN_CONFLICT,
    SCHEMA_VIOLATION,
};
use openengine_cluster_server::{
    watch::{
        subscribe_and_stream, ObservationStore, SubscribeAndStreamRequest, WatchEventStream,
        WatchHandle,
    },
    worker_registry::{check_graph_workers, WorkerRegistry, WorkerRegistryError},
    BackendError, ClusterBackend, ConnectionContext,
};
use serde_json::{json, Value};
use tokio::sync::Mutex;

use super::{
    credentials::{CredentialBundle, CredentialSlot},
    journal::EventJournal,
    run_intent::MAX_RUN_INTENT_BYTES,
    worker::{WorkerClient, WorkerError},
};

mod protocol;

use protocol::*;

static NEXT_RUN: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Copy)]
struct LegacyRegistry;

#[async_trait]
impl WorkerRegistry for LegacyRegistry {
    async fn resolve(&self, worker: &WorkerRef) -> Result<WorkerDescriptor, WorkerRegistryError> {
        if worker.as_str() != "legacy.zeroshot.ship@1" {
            return Err(WorkerRegistryError::NotFound {
                worker: worker.clone(),
            });
        }
        legacy_descriptor().map_err(|_| WorkerRegistryError::VersionUnavailable {
            worker: worker.clone(),
        })
    }
}

struct HostedState {
    graph: Option<GraphSpec>,
    input: Option<Value>,
    phase: Phase,
    generation: Option<Generation>,
    run_id: Option<RunId>,
    at_cursor: Option<Cursor>,
    committed: Option<ApplyParams>,
    apply_result: Option<ApplyResult>,
    stop_receipt: Option<(StopParams, StopResult)>,
    worker: Option<Arc<WorkerClient>>,
    finished: bool,
    run_intent: Option<RunIntentRecord>,
}

impl Default for HostedState {
    fn default() -> Self {
        Self {
            graph: None,
            input: None,
            phase: Phase::Empty,
            generation: None,
            run_id: None,
            at_cursor: None,
            committed: None,
            apply_result: None,
            stop_receipt: None,
            worker: None,
            finished: false,
            run_intent: None,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub(super) enum RunIntentStatus {
    Running,
    Succeeded(Value),
    Failed(&'static str),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct RunIntentIdentity {
    intent_id: String,
    digest: String,
}

impl RunIntentIdentity {
    pub(super) fn new(intent_id: String, digest: String) -> Self {
        Self { intent_id, digest }
    }

    pub(super) fn digest(&self) -> &str {
        &self.digest
    }
}

#[derive(Clone, Debug, PartialEq)]
struct RunIntentRecord {
    identity: RunIntentIdentity,
    status: RunIntentStatus,
}

#[derive(Clone, Debug, PartialEq)]
enum RunIntentReservation {
    Reserved,
    Existing(RunIntentStatus),
    Conflict,
}

#[derive(Clone, Debug, PartialEq)]
pub(super) enum RunIntentLookup {
    Found(RunIntentStatus),
    NotFound,
    Conflict,
}

#[derive(Clone)]
pub struct HostedBackend {
    state: Arc<Mutex<HostedState>>,
    credentials: CredentialSlot,
    journal: Arc<EventJournal>,
    next_subscription: Arc<AtomicU64>,
}

impl HostedBackend {
    #[must_use]
    pub fn new() -> Self {
        Self {
            state: Arc::new(Mutex::new(HostedState::default())),
            credentials: CredentialSlot::default(),
            journal: Arc::new(EventJournal::new()),
            next_subscription: Arc::new(AtomicU64::new(1)),
        }
    }

    pub async fn install_credentials(&self, bundle: CredentialBundle) -> Result<(), &'static str> {
        if self.state.lock().await.phase != Phase::Empty {
            return Err("credentials are frozen after admission begins");
        }
        let mut credentials = self.credentials.lock().await;
        if credentials.is_some() {
            return Err("credentials are already installed");
        }
        *credentials = Some(bundle);
        Ok(())
    }

    pub(super) async fn submit_run_intent(
        &self,
        identity: RunIntentIdentity,
        credentials: CredentialBundle,
        request: LegacyShipRequest,
    ) -> Result<RunIntentStatus, ()> {
        match self.reserve_run_intent(identity.clone()).await {
            RunIntentReservation::Existing(status) => Ok(status),
            RunIntentReservation::Conflict => Err(()),
            RunIntentReservation::Reserved => {
                let backend = self.clone();
                tokio::spawn(async move {
                    backend
                        .execute_run_intent(identity, credentials, request)
                        .await;
                });
                Ok(RunIntentStatus::Running)
            }
        }
    }

    pub(super) async fn get_run_intent(&self, intent_id: &str, digest: &str) -> RunIntentLookup {
        let state = self.state.lock().await;
        let Some(record) = &state.run_intent else {
            return RunIntentLookup::NotFound;
        };
        if record.identity.intent_id != intent_id {
            return RunIntentLookup::NotFound;
        }
        if record.identity.digest != digest {
            return RunIntentLookup::Conflict;
        }
        RunIntentLookup::Found(record.status.clone())
    }

    async fn reserve_run_intent(&self, identity: RunIntentIdentity) -> RunIntentReservation {
        let mut state = self.state.lock().await;
        if let Some(record) = &state.run_intent {
            return if record.identity == identity {
                RunIntentReservation::Existing(record.status.clone())
            } else {
                RunIntentReservation::Conflict
            };
        }
        if state.phase != Phase::Empty
            || state.committed.is_some()
            || self.credentials.lock().await.is_some()
        {
            return RunIntentReservation::Conflict;
        }
        state.phase = Phase::Admitting;
        state.run_intent = Some(RunIntentRecord {
            identity,
            status: RunIntentStatus::Running,
        });
        RunIntentReservation::Reserved
    }

    async fn execute_run_intent(
        &self,
        identity: RunIntentIdentity,
        credentials: CredentialBundle,
        request: LegacyShipRequest,
    ) {
        let params = run_intent_apply_params(&identity.intent_id, request);
        let result = match params {
            Ok(params) => self.begin_run(params, credentials).await,
            Err(error) => Err(error),
        };
        if result.is_err() {
            self.fail_run_intent(&identity, "worker_start_failed").await;
        }
    }

    async fn fail_run_intent(&self, identity: &RunIntentIdentity, error_code: &'static str) {
        let mut state = self.state.lock().await;
        let Some(record) = state.run_intent.as_mut() else {
            return;
        };
        if &record.identity != identity || !matches!(record.status, RunIntentStatus::Running) {
            return;
        }
        record.status = RunIntentStatus::Failed(error_code);
        state.phase = Phase::Finished;
        state.finished = true;
    }

    pub async fn shutdown(&self) {
        let worker = self.state.lock().await.worker.clone();
        if let Some(worker) = worker {
            worker.terminate().await;
        }
    }

    async fn verify(&self, graph: &GraphSpec) -> Result<PlanResult, BackendError> {
        let diagnostics = single_worker_diagnostics(graph);
        if !diagnostics.is_empty() {
            return Ok(PlanResult {
                ok: false,
                diagnostics,
                bounds: None,
            });
        }
        if let Err(worker_diagnostics) = check_graph_workers(graph, &LegacyRegistry).await {
            return Ok(PlanResult {
                ok: false,
                diagnostics: worker_diagnostics
                    .into_iter()
                    .map(|diagnostic| graph_diagnostic(diagnostic.message))
                    .collect(),
                bounds: None,
            });
        }
        let GraphNode::Step(step) = &graph.root else {
            return Err(BackendError::new(
                INTERNAL_ERROR_CODE,
                "validated single-worker graph lost its step root",
            ));
        };
        let one = PositiveInteger::new(1)
            .map_err(|error| BackendError::new(INTERNAL_ERROR_CODE, error.to_string()))?;
        let order = NonEmptyVec::new(vec![step.name.clone()])
            .map_err(|error| BackendError::new(INTERNAL_ERROR_CODE, error.to_string()))?;
        Ok(PlanResult {
            ok: true,
            diagnostics: Vec::new(),
            bounds: Some(StructuralBounds {
                termination: TerminationWitness::Acyclic { order },
                max_node_executions: one,
                peak_concurrency: one,
                attempts_per_node: BTreeMap::from([(step.name.clone(), one)]),
            }),
        })
    }

    async fn publish(&self, run_id: RunId, event: WatchEvent) -> Cursor {
        let cursor = self.journal.publish(run_id, event).await;
        self.state.lock().await.at_cursor = Some(cursor.clone());
        cursor
    }

    async fn settle(&self, receipt: Result<Value, WorkerError>) {
        let outcome = worker_outcome(receipt);
        let intent_status = run_intent_status(&outcome);
        let (run_id, node) = {
            let mut state = self.state.lock().await;
            if state.finished {
                return;
            }
            state.finished = true;
            state.phase = Phase::Finished;
            if let Some(record) = state.run_intent.as_mut() {
                record.status = intent_status;
            }
            let Some(run_id) = state.run_id.clone() else {
                return;
            };
            let Some(graph) = state.graph.clone() else {
                return;
            };
            (run_id, graph.root.name().clone())
        };
        self.publish(
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
        let final_status = self.status().await;
        self.publish(
            run_id,
            WatchEvent::Finished {
                final_status,
                stop_mode: None,
            },
        )
        .await;
    }

    async fn status(&self) -> ClusterStatus {
        let state = self.state.lock().await;
        status_from(&state)
    }

    async fn begin_run(
        &self,
        params: ApplyParams,
        credentials: CredentialBundle,
    ) -> Result<ApplyResult, BackendError> {
        let request = params
            .input
            .clone()
            .ok_or_else(|| schema_error("committed apply requires input"))?;
        serde_json::from_value::<LegacyShipRequest>(request.clone())
            .map_err(|_| schema_error("input does not match the legacy Zeroshot request"))?;
        let worker = WorkerClient::spawn(&credentials)
            .await
            .map_err(worker_backend_error)?;
        worker
            .start(request.clone())
            .await
            .map_err(worker_backend_error)?;
        let (run_id, graph, result) = {
            let mut state = self.state.lock().await;
            let generation = Generation::new(1).expect("one is a safe generation");
            let run_id = new_run_id();
            state.graph = Some(params.graph.clone());
            state.input = Some(request.clone());
            state.phase = Phase::Running;
            state.generation = Some(generation);
            state.run_id = Some(run_id.clone());
            state.worker = Some(Arc::clone(&worker));
            let result = ApplyResult {
                generation: Some(generation),
                run_id: Some(run_id.clone()),
                phase: Phase::Running,
                deduped: false,
                diff: None,
            };
            state.committed = Some(params);
            state.apply_result = Some(result.clone());
            (
                run_id,
                state.graph.clone().expect("graph was stored"),
                result,
            )
        };
        let running = self.status().await;
        self.publish(
            run_id.clone(),
            WatchEvent::Phase {
                status: running,
                admission: Some(Box::new(openengine_cluster_protocol::AdmissionTransition {
                    run_id: run_id.clone(),
                    spec: graph,
                    seed_input: request.clone(),
                })),
            },
        )
        .await;
        self.publish(
            run_id,
            WatchEvent::NodeBegin {
                node: NodeAddress {
                    node: result_node(&self.state).await,
                    attempt: PositiveInteger::new(1).expect("one is positive"),
                },
                input: request,
            },
        )
        .await;
        let backend = self.clone();
        tokio::spawn(async move {
            backend.settle(worker.result().await).await;
        });
        Ok(result)
    }
}

impl Default for HostedBackend {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests;
