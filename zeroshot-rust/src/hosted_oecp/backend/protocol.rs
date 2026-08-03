use super::*;

pub(super) fn run_intent_apply_params(
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

pub(super) fn intent_graph() -> Result<GraphSpec, BackendError> {
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

pub(super) fn run_intent_status(outcome: &WorkerOutcome) -> RunIntentStatus {
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

pub(super) fn single_worker_diagnostics(graph: &GraphSpec) -> Vec<GraphDiagnostic> {
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

pub(super) fn graph_diagnostic(message: impl Into<String>) -> GraphDiagnostic {
    GraphDiagnostic {
        severity: DiagnosticSeverity::Error,
        code: GraphDiagnosticCode::InvalidGraphShape,
        message: message.into(),
        path: Vec::new(),
        related_nodes: Vec::new(),
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
            return Ok(dry_run_result(self).await);
        }
        if let Some(replayed) = reserve_apply(self, &params).await? {
            return Ok(replayed);
        }
        begin_reserved_apply(self, params).await
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

async fn dry_run_result(backend: &HostedBackend) -> ApplyResult {
    let state = backend.state.lock().await;
    ApplyResult {
        generation: state.generation,
        run_id: state.run_id.clone(),
        phase: state.phase,
        deduped: false,
        diff: None,
    }
}

async fn reserve_apply(
    backend: &HostedBackend,
    params: &ApplyParams,
) -> Result<Option<ApplyResult>, BackendError> {
    let mut state = backend.state.lock().await;
    if let Some(committed) = &state.committed {
        if committed == params {
            let mut replayed = state
                .apply_result
                .clone()
                .ok_or_else(|| BackendError::new(INTERNAL_ERROR_CODE, "missing receipt"))?;
            replayed.deduped = true;
            return Ok(Some(replayed));
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
    Ok(None)
}

async fn begin_reserved_apply(
    backend: &HostedBackend,
    params: ApplyParams,
) -> Result<ApplyResult, BackendError> {
    let credentials = backend.credentials.lock().await.clone().ok_or_else(|| {
        BackendError::application(
            "CREDENTIALS_REQUIRED",
            "Capsule credentials must be installed before apply",
            None,
        )
    });
    let result = match credentials {
        Ok(credentials) => backend.begin_run(params, credentials).await,
        Err(error) => Err(error),
    };
    if result.is_err() {
        backend.state.lock().await.phase = Phase::Empty;
    }
    result
}

pub(super) fn validate_apply(params: &ApplyParams) -> Result<(), BackendError> {
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

pub(super) fn precheck_generation(
    expected: Option<Generation>,
    current: Option<Generation>,
) -> Result<(), BackendError> {
    if expected.is_none() || expected.is_some_and(|value| value.get() == 0 && current.is_none()) {
        Ok(())
    } else {
        Err(generation_error(current))
    }
}

pub(super) fn generation_error(current: Option<Generation>) -> BackendError {
    BackendError::application(
        GENERATION_CONFLICT,
        "Generation precondition failed",
        Some(json!({ "currentGeneration": current })),
    )
}

pub(super) fn schema_error(reason: &str) -> BackendError {
    BackendError::invalid_params(
        SCHEMA_VIOLATION,
        "Admission parameters violate the schema",
        Some(json!({ "reason": reason })),
    )
}

pub(super) fn worker_backend_error(error: WorkerError) -> BackendError {
    BackendError::application(
        error.code,
        "Legacy Zeroshot worker failed",
        Some(json!({ "reason": error.message })),
    )
}

pub(super) fn worker_outcome(receipt: Result<Value, WorkerError>) -> WorkerOutcome {
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

pub(super) fn status_from(state: &HostedState) -> ClusterStatus {
    ClusterStatus {
        phase: state.phase,
        observed_generation: state.generation,
        current_run_id: state.run_id.clone(),
        at_cursor: state.at_cursor.clone(),
        operational: (state.phase != Phase::Empty).then(|| operational(state.phase)),
    }
}

pub(super) fn operational(phase: Phase) -> OperationalStatus {
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

pub(super) async fn result_node(
    state: &Mutex<HostedState>,
) -> openengine_cluster_protocol::NodeName {
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

pub(super) fn new_run_id() -> RunId {
    let time = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let sequence = NEXT_RUN.fetch_add(1, Ordering::Relaxed);
    RunId::new(format!("hosted-{time:x}-{sequence:x}"))
}

pub(super) fn legacy_descriptor() -> Result<WorkerDescriptor, serde_json::Error> {
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
