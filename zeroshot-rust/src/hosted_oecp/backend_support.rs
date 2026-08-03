use std::collections::BTreeMap;
use std::future::Future;
use std::sync::atomic::{AtomicU64, Ordering};

use openengine_cluster_protocol::{
    legacy_ship_request_payload_type, legacy_ship_result_payload_type, ApplyParams, ClusterStatus,
    DiagnosticSeverity, DispatchState, Generation, GraphDiagnostic, GraphDiagnosticCode, GraphNode,
    GraphProfile, GraphSpec, Labels, LegacyShipRequest, LogLevel, NonEmptyVec, OperationalStatus,
    Phase, PlanResult, PositiveInteger, RunId, StopMode, StructuralBounds, TerminationWitness,
    WorkerErrorCode, WorkerOutcome, GENERATION_CONFLICT, GRAPH_INVALID, IDEMPOTENCY_REUSE,
    INTERNAL_ERROR_CODE, RUN_CONFLICT, SCHEMA_VIOLATION,
};
use openengine_cluster_server::BackendError;
use serde_json::{json, Value};
use tokio::time::{timeout, Duration};

use super::backend::HostedState;
use super::ports::{TrustedServiceError, ISOLATION_PROFILE, PROVIDER_PROFILE};
use super::worker::WorkerError;

static NEXT_RUN: AtomicU64 = AtomicU64::new(1);
pub(super) const MAX_WORKER_TIMEOUT: Duration = Duration::from_secs(24 * 60 * 60);
pub(super) const TRUSTED_SERVICE_DEADLINE: Duration = Duration::from_secs(5);

pub(super) async fn verify_trusted_service<F, T>(
    future: F,
    code: &'static str,
    message: &'static str,
) -> Result<T, BackendError>
where
    F: Future<Output = Result<T, TrustedServiceError>>,
{
    timeout(TRUSTED_SERVICE_DEADLINE, future)
        .await
        .map_err(|_| safe_application_error(code, message))?
        .map_err(|_| safe_application_error(code, message))
}

pub(super) fn accepted_plan(graph: &GraphSpec) -> Result<PlanResult, BackendError> {
    let GraphNode::Step(step) = &graph.root else {
        return Err(internal_error("validated graph lost its step root"));
    };
    let one = PositiveInteger::new(1).map_err(|_| internal_error("invalid fixed bound"))?;
    let order = NonEmptyVec::new(vec![step.name.clone()])
        .map_err(|_| internal_error("invalid fixed graph order"))?;
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

pub(super) fn single_worker_diagnostics(graph: &GraphSpec) -> Vec<GraphDiagnostic> {
    let mut messages = Vec::new();
    if graph.profile != GraphProfile::SingleWorker {
        messages.push("runtime accepts only openengine.graph.single-worker/v1");
    }
    let GraphNode::Step(step) = &graph.root else {
        messages.push("single-worker graph requires exactly one step root");
        return messages.into_iter().map(graph_diagnostic).collect();
    };
    if step.worker.as_str() != openengine_cluster_protocol::LEGACY_ZEROSHOT_WORKER {
        messages.push("single-worker graph requires legacy.zeroshot.ship@1");
    }
    let input = legacy_ship_request_payload_type();
    if graph.initial_input != input || step.input != input {
        messages.push("graph and step input must use canonical LegacyShipRequest");
    }
    if step.output != legacy_ship_result_payload_type() {
        messages.push("step output must use canonical LegacyShipResult");
    }
    if !step.input_bindings.is_empty() || !step.write_bindings.is_empty() {
        messages.push("single-worker graph cannot contain data bindings");
    }
    if step.attempts.get() != 1 {
        messages.push("runtime permits exactly one worker attempt");
    }
    if graph.policy.policy.as_str() != "policy.strict@1" {
        messages.push("runtime requires policy.strict@1");
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

pub(super) fn rejected_plan(diagnostics: Vec<GraphDiagnostic>) -> PlanResult {
    PlanResult {
        ok: false,
        diagnostics,
        bounds: None,
    }
}

pub(super) fn validate_apply(params: &ApplyParams) -> Result<(), BackendError> {
    match (
        params.dry_run,
        params.idempotency_key.is_some(),
        params.input.is_some(),
    ) {
        (true, false, false) | (false, true, true) => Ok(()),
        (true, _, _) => Err(schema_error(
            "dry-run apply must omit idempotencyKey and input",
        )),
        (false, _, _) => Err(schema_error(
            "committed apply requires idempotencyKey and input",
        )),
    }
}

pub(super) fn validate_request(params: &ApplyParams) -> Result<LegacyShipRequest, BackendError> {
    let input = params
        .input
        .clone()
        .ok_or_else(|| schema_error("committed apply requires input"))?;
    let request: LegacyShipRequest = serde_json::from_value(input)
        .map_err(|_| schema_error("input does not match LegacyShipRequest"))?;
    if request.isolation_profile.as_str() != ISOLATION_PROFILE
        || request.provider_profile.as_str() != PROVIDER_PROFILE
    {
        return Err(schema_error(
            "legacy request must select the fixed prepared-worktree and proxy profiles",
        ));
    }
    Ok(request)
}

pub(super) fn validate_graph_input(params: &ApplyParams) -> Result<(), BackendError> {
    let input = params
        .input
        .as_ref()
        .ok_or_else(|| schema_error("committed apply requires input"))?;
    params
        .graph
        .initial_input
        .validate_value(input)
        .map_err(|_| schema_error("input violates the graph contract"))
}

pub(super) fn same_apply_identity(left: &ApplyParams, right: &ApplyParams) -> bool {
    left.idempotency_key == right.idempotency_key
}

pub(super) fn second_apply_error(committed: &ApplyParams, requested: &ApplyParams) -> BackendError {
    if same_apply_identity(committed, requested) {
        idempotency_reuse()
    } else {
        safe_application_error(RUN_CONFLICT, "Capsule already admitted its one run")
    }
}

pub(super) fn idempotency_reuse() -> BackendError {
    safe_application_error(
        IDEMPOTENCY_REUSE,
        "Idempotency key was reused with different parameters",
    )
}

pub(super) fn precheck_generation(
    expected: Option<Generation>,
    current: Option<Generation>,
) -> Result<(), BackendError> {
    match (expected, current) {
        (None, _) => Ok(()),
        (Some(expected), Some(current)) if expected == current => Ok(()),
        (Some(expected), None) if expected.get() == 0 => Ok(()),
        _ => Err(generation_error(current)),
    }
}

pub(super) fn generation_error(current: Option<Generation>) -> BackendError {
    BackendError::application(
        GENERATION_CONFLICT,
        "Generation precondition failed",
        Some(json!({ "currentGeneration": current })),
    )
}

pub(super) fn graph_invalid(diagnostics: Vec<GraphDiagnostic>) -> BackendError {
    BackendError::application(
        GRAPH_INVALID,
        "Graph verification failed",
        Some(json!({ "diagnostics": diagnostics })),
    )
}

pub(super) fn schema_error(reason: &str) -> BackendError {
    BackendError::invalid_params(
        SCHEMA_VIOLATION,
        "Admission parameters violate the hosted schema",
        Some(json!({ "reason": reason })),
    )
}

pub(super) fn safe_application_error(code: &str, message: &str) -> BackendError {
    BackendError::application(code, message, None)
}

pub(super) fn internal_error(message: &str) -> BackendError {
    BackendError::new(INTERNAL_ERROR_CODE, message)
}

pub(super) fn worker_start_error(_error: WorkerError) -> BackendError {
    safe_application_error("WORKER_START", "Contained worker failed to start")
}

pub(super) fn worker_error_outcome(error: WorkerError) -> WorkerOutcome {
    match error {
        WorkerError::Protocol => WorkerOutcome::malformed(),
        WorkerError::Launch | WorkerError::Exited | WorkerError::Cleanup => {
            WorkerOutcome::declared_failure(WorkerErrorCode::Crash)
        }
    }
}

pub(super) fn redact_request(request: &LegacyShipRequest) -> Value {
    json!({
        "source": request.source,
        "artifacts": request.artifacts.len(),
        "profiles": "fixed",
    })
}

pub(super) fn status_from(state: &HostedState) -> ClusterStatus {
    ClusterStatus {
        phase: state.phase,
        observed_generation: state.generation,
        current_run_id: state.run_id.clone(),
        at_cursor: state.at_cursor.clone(),
        operational: (state.phase != Phase::Empty).then(|| {
            operational(
                state.phase,
                state.stop_request.as_ref().map(|request| request.mode),
            )
        }),
    }
}

pub(super) fn operational(phase: Phase, stop_mode: Option<StopMode>) -> OperationalStatus {
    let terminal = phase == Phase::Finished;
    OperationalStatus {
        labels: Labels::default(),
        log_level: LogLevel::Info,
        dispatch_state: if terminal {
            DispatchState::Stopped
        } else {
            match stop_mode {
                Some(StopMode::Drain) => DispatchState::Draining,
                Some(StopMode::Force) => DispatchState::ForceStopping,
                None => DispatchState::Active,
            }
        },
        stop_mode,
        in_flight: u32::from(!terminal),
    }
}

pub(super) fn step_timeout(graph: &GraphSpec) -> Duration {
    let GraphNode::Step(step) = &graph.root else {
        return MAX_WORKER_TIMEOUT;
    };
    Duration::from_millis(step.timeout_ms.get()).min(MAX_WORKER_TIMEOUT)
}

pub(super) fn new_run_id() -> RunId {
    RunId::new(format!(
        "hosted-run-{}",
        NEXT_RUN.fetch_add(1, Ordering::Relaxed)
    ))
}
