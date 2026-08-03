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

fn run_intent_apply_params(
    intent_id: &str,
    request: LegacyShipRequest,
) -> Result<ApplyParams, BackendError> {
    let graph = intent_graph()?;
    let input = serde_json::to_value(request)
        .map_err(|error| BackendError::new(INTERNAL_ERROR_CODE, error.to_string()))?;
    Ok(ApplyParams {
        graph,
        input: Some(input),
        dry_run: false,
        if_generation: Some(Generation::new(0).expect("zero is a safe generation")),
        idempotency_key: Some(
            IdempotencyKey::new(format!("run-intent:{intent_id}"))
                .map_err(|error| BackendError::new(INTERNAL_ERROR_CODE, error))?,
        ),
    })
}

fn intent_graph() -> Result<GraphSpec, BackendError> {
    serde_json::from_value(json!({
        "profile": "openengine.graph.single-worker/v1",
        "initialInput": legacy_ship_request_payload_type(),
        "policy": { "policy": "policy.strict@1", "default": "deny" },
        "root": {
            "kind": "step",
            "name": "zeroshot",
            "worker": "legacy.zeroshot.ship@1",
            "input": legacy_ship_request_payload_type(),
            "output": legacy_ship_result_payload_type(),
            "inputBindings": [],
            "writeBindings": [],
            "timeoutMs": 3_600_000,
            "attempts": 1
        }
    }))
    .map_err(|error| BackendError::new(INTERNAL_ERROR_CODE, error.to_string()))
}

fn run_intent_status(outcome: &WorkerOutcome) -> RunIntentStatus {
    match outcome {
        WorkerOutcome::Verified { output, .. } => {
            let Ok(result) = serde_json::from_value::<LegacyShipResult>(output.clone()) else {
                return RunIntentStatus::Failed("malformed_result");
            };
            if result.status == LegacyShipStatus::Failed {
                return RunIntentStatus::Failed("worker_failed");
            }
            let response = json!({ "state": "succeeded", "result": output });
            if serde_json::to_vec(&response).is_ok_and(|bytes| bytes.len() <= MAX_RUN_INTENT_BYTES)
            {
                RunIntentStatus::Succeeded(output.clone())
            } else {
                RunIntentStatus::Failed("result_too_large")
            }
        }
        WorkerOutcome::Verifier { .. } => RunIntentStatus::Failed("verification_failed"),
        WorkerOutcome::Error { code, .. } => RunIntentStatus::Failed(code.as_str()),
    }
}

fn single_worker_diagnostics(graph: &GraphSpec) -> Vec<GraphDiagnostic> {
    let mut messages = Vec::new();
    if graph.profile != GraphProfile::SingleWorker {
        messages.push("hosted Zeroshot accepts only openengine.graph.single-worker/v1");
    }
    let GraphNode::Step(step) = &graph.root else {
        messages.push("single-worker graphs require exactly one step root");
        return messages.into_iter().map(graph_diagnostic).collect();
    };
    if step.worker.as_str() != "legacy.zeroshot.ship@1" {
        messages.push("single-worker graphs require legacy.zeroshot.ship@1");
    }
    let input = legacy_ship_request_payload_type();
    if graph.initial_input != input || step.input != input {
        messages.push("graph and worker input must use the canonical legacy Zeroshot request");
    }
    if step.output != legacy_ship_result_payload_type() {
        messages.push("worker output must use the canonical legacy Zeroshot result");
    }
    if !step.input_bindings.is_empty() || !step.write_bindings.is_empty() {
        messages.push("single-worker facade graphs cannot contain data bindings");
    }
    if step.attempts.get() != 1 {
        messages.push("minimal hosted execution supports exactly one worker attempt");
    }
    if graph.policy.policy.as_str() != "policy.strict@1" {
        messages.push("hosted Zeroshot requires policy.strict@1");
    }
    messages.into_iter().map(graph_diagnostic).collect()
}

fn graph_diagnostic(message: impl Into<String>) -> GraphDiagnostic {
    GraphDiagnostic {
        severity: DiagnosticSeverity::Error,
        code: GraphDiagnosticCode::InvalidGraphShape,
        message: message.into(),
        path: Vec::new(),
        related_nodes: Vec::new(),
    }
}

impl Default for HostedBackend {
    fn default() -> Self {
        Self::new()
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
            .map_err(|error| BackendError::new(INTERNAL_ERROR_CODE, error.to_string()))?;
        Ok(InitializeResult::new(
            ServerCapabilities {
                graph_profiles,
                logs: false,
                agent_attach: false,
            },
            self.status().await,
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
        _context: &ConnectionContext,
        params: ApplyParams,
    ) -> Result<ApplyResult, BackendError> {
        validate_apply(&params)?;
        let planned = self.verify(&params.graph).await?;
        if !planned.ok {
            return Err(BackendError::application(
                GRAPH_INVALID,
                "Graph verification failed",
                Some(json!({ "diagnostics": planned.diagnostics })),
            ));
        }
        if params.dry_run {
            let state = self.state.lock().await;
            return Ok(ApplyResult {
                generation: state.generation,
                run_id: state.run_id.clone(),
                phase: state.phase,
                deduped: false,
                diff: None,
            });
        }
        {
            let mut state = self.state.lock().await;
            if let Some(committed) = &state.committed {
                if committed == &params {
                    let mut replayed = state
                        .apply_result
                        .clone()
                        .ok_or_else(|| BackendError::new(INTERNAL_ERROR_CODE, "missing receipt"))?;
                    replayed.deduped = true;
                    return Ok(replayed);
                }
                return Err(BackendError::application(
                    RUN_CONFLICT,
                    "This capsule already admitted its one OECP run",
                    None,
                ));
            }
            if state.phase != Phase::Empty {
                return Err(BackendError::application(
                    RUN_CONFLICT,
                    "Another apply is already being admitted",
                    None,
                ));
            }
            precheck_generation(params.if_generation, state.generation)?;
            params
                .graph
                .initial_input
                .validate_value(params.input.as_ref().expect("validated committed input"))
                .map_err(|error| schema_error(&error.to_string()))?;
            state.phase = Phase::Admitting;
        }
        let credentials = self.credentials.lock().await.clone().ok_or_else(|| {
            BackendError::application(
                "CREDENTIALS_REQUIRED",
                "Capsule credentials must be installed before apply",
                None,
            )
        });
        match credentials {
            Ok(credentials) => match self.begin_run(params, credentials).await {
                Ok(result) => Ok(result),
                Err(error) => {
                    self.state.lock().await.phase = Phase::Empty;
                    Err(error)
                }
            },
            Err(error) => {
                self.state.lock().await.phase = Phase::Empty;
                Err(error)
            }
        }
    }

    async fn get(
        &self,
        _context: &ConnectionContext,
        params: GetParams,
    ) -> Result<GetResult, BackendError> {
        let state = self.state.lock().await;
        if let Some(requested) = params.at_cursor {
            if state.at_cursor.as_ref() != Some(&requested) {
                return Err(BackendError::application(
                    INVALID_PHASE,
                    "Requested cursor is not available",
                    Some(json!({ "currentCursor": state.at_cursor })),
                ));
            }
        }
        Ok(GetResult {
            spec: state.graph.clone(),
            status: status_from(&state),
            at_cursor: state.at_cursor.clone(),
        })
    }

    async fn stop(
        &self,
        _context: &ConnectionContext,
        params: StopParams,
    ) -> Result<StopResult, BackendError> {
        let worker = {
            let state = self.state.lock().await;
            if let Some((committed, result)) = &state.stop_receipt {
                if committed == &params {
                    let mut replayed = result.clone();
                    replayed.deduped = true;
                    return Ok(replayed);
                }
                return Err(BackendError::application(
                    IDEMPOTENCY_REUSE,
                    "Stop idempotency key was reused with different parameters",
                    None,
                ));
            }
            if state.generation != Some(params.if_generation) {
                return Err(generation_error(state.generation));
            }
            state.worker.clone().ok_or_else(|| {
                BackendError::application(INVALID_PHASE, "No running worker exists", None)
            })?
        };
        let receipt = worker.stop().await;
        self.settle(receipt).await;
        let mut state = self.state.lock().await;
        let generation = state.generation.expect("stop validated generation");
        let run_id = state.run_id.clone().expect("stop validated run");
        let at_cursor = state
            .at_cursor
            .clone()
            .unwrap_or_else(|| Cursor::new("event-0"));
        let result = StopResult {
            generation,
            run_id,
            phase: state.phase,
            accepted_mode: params.mode,
            effective_mode: params.mode,
            operational: operational(state.phase),
            at_cursor,
            deduped: false,
        };
        state.stop_receipt = Some((params, result.clone()));
        Ok(result)
    }

    async fn watch(
        &self,
        _context: &ConnectionContext,
        params: WatchParams,
        queue_capacity: usize,
    ) -> Result<(WatchResult, WatchEventStream, WatchHandle), BackendError> {
        let store: Arc<dyn ObservationStore> =
            Arc::clone(&self.journal) as Arc<dyn ObservationStore>;
        subscribe_and_stream(
            &store,
            SubscribeAndStreamRequest {
                subscription_id: SubscriptionId::new(format!(
                    "watch-{}",
                    self.next_subscription.fetch_add(1, Ordering::Relaxed)
                )),
                params,
                queue_capacity,
            },
            |_| BackendError::application("NOT_FOUND", "Run does not exist", None),
        )
        .await
    }
}

fn validate_apply(params: &ApplyParams) -> Result<(), BackendError> {
    if params.dry_run {
        if params.idempotency_key.is_some() || params.input.is_some() {
            return Err(schema_error(
                "dry-run apply must omit idempotencyKey and input",
            ));
        }
    } else if params.idempotency_key.is_none() || params.input.is_none() {
        return Err(schema_error(
            "committed apply requires idempotencyKey and input",
        ));
    }
    Ok(())
}

fn precheck_generation(
    expected: Option<Generation>,
    current: Option<Generation>,
) -> Result<(), BackendError> {
    if expected.is_none() || expected.is_some_and(|value| value.get() == 0 && current.is_none()) {
        Ok(())
    } else {
        Err(generation_error(current))
    }
}

fn generation_error(current: Option<Generation>) -> BackendError {
    BackendError::application(
        GENERATION_CONFLICT,
        "Generation precondition failed",
        Some(json!({ "currentGeneration": current })),
    )
}

fn schema_error(reason: &str) -> BackendError {
    BackendError::invalid_params(
        SCHEMA_VIOLATION,
        "Admission parameters violate the schema",
        Some(json!({ "reason": reason })),
    )
}

fn worker_backend_error(error: WorkerError) -> BackendError {
    BackendError::application(
        error.code,
        "Legacy Zeroshot worker failed",
        Some(json!({ "reason": error.message })),
    )
}

fn worker_outcome(receipt: Result<Value, WorkerError>) -> WorkerOutcome {
    match receipt {
        Ok(receipt) if receipt.get("state").and_then(Value::as_str) == Some("completed") => {
            let result = receipt.get("result").cloned().unwrap_or(Value::Null);
            match serde_json::from_value::<LegacyShipResult>(result.clone()) {
                Ok(result_contract) => WorkerOutcome::Verified {
                    output: result,
                    artifacts: result_contract.artifacts,
                },
                Err(_) => WorkerOutcome::malformed(),
            }
        }
        Ok(receipt) => receipt
            .get("outcome")
            .cloned()
            .and_then(|value| serde_json::from_value(value).ok())
            .unwrap_or_else(|| WorkerOutcome::declared_failure(WorkerErrorCode::Crash)),
        Err(_) => WorkerOutcome::declared_failure(WorkerErrorCode::Crash),
    }
}

fn status_from(state: &HostedState) -> ClusterStatus {
    ClusterStatus {
        phase: state.phase,
        observed_generation: state.generation,
        current_run_id: state.run_id.clone(),
        at_cursor: state.at_cursor.clone(),
        operational: (state.phase != Phase::Empty).then(|| operational(state.phase)),
    }
}

fn operational(phase: Phase) -> OperationalStatus {
    let terminal = phase == Phase::Finished;
    OperationalStatus {
        labels: Labels::default(),
        log_level: LogLevel::Info,
        dispatch_state: if terminal {
            DispatchState::Stopped
        } else {
            DispatchState::Active
        },
        stop_mode: None,
        in_flight: u32::from(!terminal),
    }
}

async fn result_node(state: &Mutex<HostedState>) -> openengine_cluster_protocol::NodeName {
    state
        .lock()
        .await
        .graph
        .as_ref()
        .expect("run graph exists")
        .root
        .name()
        .clone()
}

fn new_run_id() -> RunId {
    let time = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let sequence = NEXT_RUN.fetch_add(1, Ordering::Relaxed);
    RunId::new(format!("hosted-{time:x}-{sequence:x}"))
}

fn legacy_descriptor() -> Result<WorkerDescriptor, serde_json::Error> {
    serde_json::from_value(json!({
        "worker": "legacy.zeroshot.ship@1",
        "graphProfiles": ["openengine.graph.single-worker/v1"],
        "binding": {
            "protocol": "legacy_zeroshot",
            "version": "1",
            "profile": "legacy.zeroshot.ship/v1"
        },
        "contract": {
            "input": serde_json::to_value(legacy_ship_request_payload_type())?,
            "output": serde_json::to_value(legacy_ship_result_payload_type())?,
            "verifier": null,
            "errors": ["timeout", "crash", "malformed", "refusal"]
        },
        "capabilityPolicy": {
            "autonomy": "strict",
            "permissionPolicy": "policy.strict@1"
        },
        "artifactProfile": {
            "allowedTypeIds": ["openengine.result@1"],
            "allowedMediaTypes": ["application/json"],
            "minimumRedaction": "internal"
        },
        "credentialRequirements": []
    }))
}

#[cfg(test)]
mod tests {
    use openengine_cluster_protocol::{
        legacy_ship_request_payload_type, legacy_ship_result_payload_type, GraphProfile, GraphSpec,
    };
    use serde_json::json;

    use super::{
        intent_graph, single_worker_diagnostics, HostedBackend, RunIntentIdentity, RunIntentLookup,
        RunIntentReservation, RunIntentStatus,
    };

    fn graph(profile: GraphProfile, worker: &str) -> GraphSpec {
        serde_json::from_value(json!({
            "profile": profile,
            "initialInput": legacy_ship_request_payload_type(),
            "policy": { "policy": "policy.strict@1", "default": "deny" },
            "root": {
                "kind": "step",
                "name": "zeroshot",
                "worker": worker,
                "input": legacy_ship_request_payload_type(),
                "output": legacy_ship_result_payload_type(),
                "inputBindings": [],
                "writeBindings": [],
                "timeoutMs": 3_600_000,
                "attempts": 1
            }
        }))
        .expect("hosted graph fixture must be valid protocol syntax")
    }

    #[tokio::test]
    async fn canonical_single_worker_graph_has_fixed_structural_bounds() {
        let graph = graph(GraphProfile::SingleWorker, "legacy.zeroshot.ship@1");
        let planned = HostedBackend::new()
            .verify(&graph)
            .await
            .expect("canonical graph must verify");

        assert!(planned.ok);
        assert!(planned.diagnostics.is_empty());
        let bounds = planned.bounds.expect("accepted graph must have bounds");
        assert_eq!(bounds.max_node_executions.get(), 1);
        assert_eq!(bounds.peak_concurrency.get(), 1);
        assert_eq!(bounds.attempts_per_node.len(), 1);
    }

    #[tokio::test]
    async fn internal_run_intent_owns_the_same_fixed_graph() {
        let fixed_graph = intent_graph().expect("the runtime-owned graph must construct");
        assert_eq!(
            fixed_graph,
            graph(GraphProfile::SingleWorker, "legacy.zeroshot.ship@1")
        );

        let planned = HostedBackend::new()
            .verify(&fixed_graph)
            .await
            .expect("the runtime-owned graph must verify");
        assert!(planned.ok);
    }

    #[tokio::test]
    async fn run_intent_reservation_is_idempotent_and_capsule_exclusive() {
        let backend = HostedBackend::new();
        let identity = RunIntentIdentity {
            intent_id: "019f7437-8701-71e3-a056-2ba05c37609c".to_owned(),
            digest: format!("sha256:{}", "a".repeat(64)),
        };
        assert_eq!(
            backend.reserve_run_intent(identity.clone()).await,
            RunIntentReservation::Reserved
        );
        assert_eq!(
            backend.reserve_run_intent(identity.clone()).await,
            RunIntentReservation::Existing(RunIntentStatus::Running)
        );

        let mut conflicting = identity.clone();
        conflicting.digest = format!("sha256:{}", "b".repeat(64));
        assert_eq!(
            backend.reserve_run_intent(conflicting).await,
            RunIntentReservation::Conflict
        );
        assert_eq!(
            backend
                .get_run_intent(&identity.intent_id, &identity.digest)
                .await,
            RunIntentLookup::Found(RunIntentStatus::Running)
        );
        assert_eq!(
            backend
                .get_run_intent(&identity.intent_id, &format!("sha256:{}", "c".repeat(64)))
                .await,
            RunIntentLookup::Conflict
        );
        assert_eq!(
            backend
                .get_run_intent("019f7437-8701-71e3-a056-2ba05c37609d", &identity.digest)
                .await,
            RunIntentLookup::NotFound
        );
    }

    #[test]
    fn broader_profiles_and_workers_are_rejected_at_the_facade() {
        let full = graph(GraphProfile::Full, "legacy.zeroshot.ship@1");
        let unsupported = graph(GraphProfile::SingleWorker, "example.worker@1");

        let full_messages = single_worker_diagnostics(&full)
            .into_iter()
            .map(|diagnostic| diagnostic.message)
            .collect::<Vec<_>>();
        let worker_messages = single_worker_diagnostics(&unsupported)
            .into_iter()
            .map(|diagnostic| diagnostic.message)
            .collect::<Vec<_>>();

        assert!(
            full_messages
                .iter()
                .any(|message| message.contains("single-worker/v1"))
        );
        assert!(
            worker_messages
                .iter()
                .any(|message| message.contains("legacy.zeroshot.ship@1"))
        );
    }

    #[test]
    fn facade_rejects_noncanonical_contracts_before_worker_resolution() {
        let mut graph = graph(GraphProfile::SingleWorker, "legacy.zeroshot.ship@1");
        graph.initial_input = serde_json::from_value(json!({ "kind": "string" }))
            .expect("string is a valid payload type");

        let messages = single_worker_diagnostics(&graph)
            .into_iter()
            .map(|diagnostic| diagnostic.message)
            .collect::<Vec<_>>();
        assert_eq!(messages.len(), 1);
        assert!(messages[0].contains("canonical legacy Zeroshot request"));
    }
}
