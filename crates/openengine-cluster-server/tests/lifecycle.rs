use async_trait::async_trait;
use openengine_cluster_protocol::{
    ClusterStatus, Cursor, DeleteParams, DeleteResult, DispatchState, Generation, GetParams,
    GetResult, InitializeParams, InitializeResult, OperationalStatus, Phase, ResubmitParams,
    ResubmitResult, RunId, ServerCapabilities, StopMode, StopParams, StopResult, UpdateParams,
    UpdateResult, GENERATION_CONFLICT, INVALID_PHASE, RUN_CONFLICT, SCHEMA_VIOLATION,
};
use openengine_cluster_server::{BackendError, ClusterBackend, ConnectionContext, Dispatcher};
use serde_json::{json, Value};

struct RoutingBackend;

fn operational(state: DispatchState, mode: Option<StopMode>) -> OperationalStatus {
    OperationalStatus {
        dispatch_state: state,
        stop_mode: mode,
        ..OperationalStatus::default()
    }
}

fn initialized() -> InitializeResult {
    InitializeResult::new(ServerCapabilities::default(), ClusterStatus::empty())
}

#[async_trait]
impl ClusterBackend for RoutingBackend {
    async fn initialize(
        &self,
        _context: &ConnectionContext,
        _params: InitializeParams,
    ) -> Result<InitializeResult, BackendError> {
        Ok(initialized())
    }

    async fn get(
        &self,
        _context: &ConnectionContext,
        _params: GetParams,
    ) -> Result<GetResult, BackendError> {
        Ok(GetResult::empty())
    }

    async fn update(
        &self,
        _context: &ConnectionContext,
        _params: UpdateParams,
    ) -> Result<UpdateResult, BackendError> {
        Ok(UpdateResult {
            generation: Generation::new(1).assert_value(),
            run_id: RunId::new("run-1"),
            phase: Phase::Running,
            operational: operational(DispatchState::Suspended, None),
            at_cursor: Cursor::new("cursor-2"),
            deduped: false,
        })
    }

    async fn stop(
        &self,
        _context: &ConnectionContext,
        _params: StopParams,
    ) -> Result<StopResult, BackendError> {
        Ok(StopResult {
            generation: Generation::new(1).assert_value(),
            run_id: RunId::new("run-1"),
            phase: Phase::Finished,
            accepted_mode: StopMode::Force,
            effective_mode: StopMode::Force,
            operational: operational(DispatchState::Stopped, Some(StopMode::Force)),
            at_cursor: Cursor::new("cursor-4"),
            deduped: false,
        })
    }

    async fn delete(
        &self,
        _context: &ConnectionContext,
        params: DeleteParams,
    ) -> Result<DeleteResult, BackendError> {
        match params.idempotency_key.as_str() {
            "stale-generation" => Err(BackendError::application(
                GENERATION_CONFLICT,
                "Generation precondition failed",
                Some(json!({ "currentGeneration": 1 })),
            )),
            "stale-run" => Err(BackendError::application(
                RUN_CONFLICT,
                "Run precondition failed",
                Some(json!({ "currentRunId": "run-1" })),
            )),
            "not-terminal" => Err(BackendError::application(
                INVALID_PHASE,
                "Cluster phase does not admit delete",
                Some(json!({ "currentPhase": "running" })),
            )),
            _ => Ok(DeleteResult {
                deleted: true,
                phase: Phase::Empty,
                generation: None,
                run_id: None,
                at_cursor: None,
                deduped: false,
            }),
        }
    }

    async fn resubmit(
        &self,
        _context: &ConnectionContext,
        params: ResubmitParams,
    ) -> Result<ResubmitResult, BackendError> {
        match params.idempotency_key.as_str() {
            "stale-generation" => Err(BackendError::application(
                GENERATION_CONFLICT,
                "Generation precondition failed",
                Some(json!({ "currentGeneration": 1 })),
            )),
            "stale-run" => Err(BackendError::application(
                RUN_CONFLICT,
                "Run precondition failed",
                Some(json!({ "currentRunId": "run-1" })),
            )),
            "bad-input" => Err(BackendError::application(
                SCHEMA_VIOLATION,
                "Admission parameters violate the schema",
                Some(json!({ "reason": "replacement input rejected" })),
            )),
            _ => Ok(ResubmitResult {
                generation: Generation::new(1).assert_value(),
                prior_run_id: RunId::new("run-1"),
                run_id: RunId::new("run-2"),
                phase: Phase::Running,
                operational: operational(DispatchState::Active, None),
                at_cursor: Cursor::new("cursor-3"),
                deduped: false,
            }),
        }
    }
}

async fn dispatch_mutation(id: i64, method: &str, params: Value) -> Value {
    let dispatcher = Dispatcher::new(RoutingBackend, ConnectionContext::default());
    serde_json::from_str(
        &dispatcher
            .dispatch(&json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}).to_string())
            .await,
    )
    .assert_value()
}

async fn dispatch_default(method: &str, params: Value) -> Value {
    serde_json::from_str(
        &bare_watch_dispatcher(8)
            .dispatch(&json!({"jsonrpc":"2.0","id":9,"method":method,"params":params}).to_string())
            .await,
    )
    .assert_value()
}

fn error_code(response: &Value) -> &Value {
    response
        .assert_at("error")
        .assert_at("data")
        .assert_at("code")
}

fn common_invalid_mutation_params() -> Vec<Value> {
    vec![
        json!({"idempotencyKey":"empty"}),
        json!({"ifGeneration":1,"ifRunId":"run-1","idempotencyKey":"turn","turnId":"turn-1"}),
        json!({"ifGeneration":1,"ifRunId":"run-1","idempotencyKey":"provider","provider":"claude"}),
    ]
}

async fn assert_invalid_mutations(method: &str, params: Vec<Value>) {
    for params in params {
        let response = dispatch_mutation(5, method, params).await;
        assert!(
            response.assert_at("error").is_object(),
            "expected rejection for {response}"
        );
    }
}

async fn assert_common_domain_errors(method: &str) {
    let stale_generation = dispatch_mutation(
        2,
        method,
        json!({"ifGeneration":1,"ifRunId":"run-1","idempotencyKey":"stale-generation"}),
    )
    .await;
    assert_eq!(error_code(&stale_generation), GENERATION_CONFLICT);

    let stale_run = dispatch_mutation(
        3,
        method,
        json!({"ifGeneration":1,"ifRunId":"run-1","idempotencyKey":"stale-run"}),
    )
    .await;
    assert_eq!(error_code(&stale_run), RUN_CONFLICT);
}

#[tokio::test]
async fn lifecycle_dispatch_routes_typed_methods_and_rejects_mutation_fields() {
    let dispatcher = Dispatcher::new(RoutingBackend, ConnectionContext::default());
    let update: serde_json::Value = serde_json::from_str(
        &dispatcher
            .dispatch(
                &json!({
                    "jsonrpc":"2.0","id":1,"method":"update",
                    "params":{"suspended":true,"ifGeneration":1,"idempotencyKey":"suspend"}
                })
                .to_string(),
            )
            .await,
    )
    .assert_value();
    assert_eq!(
        update
            .assert_at("result")
            .assert_at("operational")
            .assert_at("dispatchState"),
        "suspended"
    );

    let stop: serde_json::Value = serde_json::from_str(
        &dispatcher
            .dispatch(
                &json!({
                    "jsonrpc":"2.0","id":2,"method":"stop",
                    "params":{"mode":"force","ifGeneration":1,"idempotencyKey":"force"}
                })
                .to_string(),
            )
            .await,
    )
    .assert_value();
    assert_eq!(stop.assert_at("result").assert_at("effectiveMode"), "force");

    for params in [
        json!({"ifGeneration":1,"idempotencyKey":"empty"}),
        json!({"graph":{},"ifGeneration":1,"idempotencyKey":"graph"}),
        json!({"input":null,"ifGeneration":1,"idempotencyKey":"input"}),
        json!({"policy":{},"ifGeneration":1,"idempotencyKey":"policy"}),
        json!({"worker":"x","ifGeneration":1,"idempotencyKey":"worker"}),
    ] {
        let response: serde_json::Value = serde_json::from_str(
            &dispatcher
                .dispatch(
                    &json!({"jsonrpc":"2.0","id":3,"method":"update","params":params}).to_string(),
                )
                .await,
        )
        .assert_value();
        assert_eq!(
            response
                .assert_at("error")
                .assert_at("data")
                .assert_at("code"),
            SCHEMA_VIOLATION
        );
    }
}
#[path = "support/assert_value.rs"]
mod assert_value;
use assert_value::AssertValue;
#[path = "support/assert_at.rs"]
mod assert_at;
use assert_at::AssertAt;
#[path = "capability_default_support/mod.rs"]
mod capability_default_support;
use capability_default_support::bare_watch_dispatcher;

#[path = "lifecycle/lifecycle_delete.rs"]
mod lifecycle_delete;
#[path = "lifecycle/lifecycle_resubmit.rs"]
mod lifecycle_resubmit;
