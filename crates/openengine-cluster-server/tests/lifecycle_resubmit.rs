use async_trait::async_trait;
use openengine_cluster_protocol::{
    ClusterStatus, Cursor, DispatchState, Generation, GetParams, GetResult, InitializeParams,
    InitializeResult, OperationalStatus, Phase, ResubmitParams, ResubmitResult, RunId,
    ServerCapabilities, GENERATION_CONFLICT, INVALID_PHASE, RUN_CONFLICT, SCHEMA_VIOLATION,
};
use openengine_cluster_server::{BackendError, ClusterBackend, ConnectionContext, Dispatcher};
use serde_json::json;

struct RoutingBackend;

#[async_trait]
impl ClusterBackend for RoutingBackend {
    async fn initialize(
        &self,
        _context: &ConnectionContext,
        _params: InitializeParams,
    ) -> Result<InitializeResult, BackendError> {
        Ok(InitializeResult::new(
            ServerCapabilities::default(),
            ClusterStatus::empty(),
        ))
    }

    async fn get(
        &self,
        _context: &ConnectionContext,
        _params: GetParams,
    ) -> Result<GetResult, BackendError> {
        unreachable!()
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
                generation: Generation::new(1).unwrap(),
                prior_run_id: RunId::new("run-1"),
                run_id: RunId::new("run-2"),
                phase: Phase::Running,
                operational: OperationalStatus {
                    dispatch_state: DispatchState::Active,
                    ..OperationalStatus::default()
                },
                at_cursor: Cursor::new("cursor-3"),
                deduped: false,
            }),
        }
    }
}

async fn dispatch_resubmit(
    dispatcher: &Dispatcher<RoutingBackend>,
    id: i64,
    params: serde_json::Value,
) -> serde_json::Value {
    serde_json::from_str(
        &dispatcher
            .dispatch(
                &json!({"jsonrpc":"2.0","id":id,"method":"resubmit","params":params}).to_string(),
            )
            .await,
    )
    .unwrap()
}

#[tokio::test]
async fn resubmit_dispatches_to_cluster_backend_and_maps_domain_errors() {
    let dispatcher = Dispatcher::new(RoutingBackend, ConnectionContext::default());

    let success = dispatch_resubmit(
        &dispatcher,
        1,
        json!({"ifGeneration":1,"ifRunId":"run-1","idempotencyKey":"resubmit-1"}),
    )
    .await;
    assert_eq!(success["result"]["priorRunId"], "run-1");
    assert_eq!(success["result"]["runId"], "run-2");

    let stale_generation = dispatch_resubmit(
        &dispatcher,
        2,
        json!({"ifGeneration":1,"ifRunId":"run-1","idempotencyKey":"stale-generation"}),
    )
    .await;
    assert_eq!(
        stale_generation["error"]["data"]["code"],
        GENERATION_CONFLICT
    );

    let stale_run = dispatch_resubmit(
        &dispatcher,
        3,
        json!({"ifGeneration":1,"ifRunId":"run-1","idempotencyKey":"stale-run"}),
    )
    .await;
    assert_eq!(stale_run["error"]["data"]["code"], RUN_CONFLICT);

    let bad_input = dispatch_resubmit(
        &dispatcher,
        4,
        json!({"ifGeneration":1,"ifRunId":"run-1","idempotencyKey":"bad-input",
            "replacementInput":{"bad":true}}),
    )
    .await;
    assert_eq!(bad_input["error"]["data"]["code"], SCHEMA_VIOLATION);

    for params in [
        json!({"idempotencyKey":"empty"}),
        json!({"ifGeneration":1,"idempotencyKey":"missing-run"}),
        json!({"ifGeneration":1,"ifRunId":"run-1"}),
        json!({"ifGeneration":1,"ifRunId":"run-1","idempotencyKey":"turn","turnId":"turn-1"}),
        json!({"ifGeneration":1,"ifRunId":"run-1","idempotencyKey":"provider","provider":"claude"}),
    ] {
        let response = dispatch_resubmit(&dispatcher, 5, params).await;
        assert!(
            response["error"].is_object(),
            "expected rejection for {response}"
        );
    }
}

#[tokio::test]
async fn default_backend_rejects_resubmit_with_invalid_phase() {
    struct DefaultBackend;

    #[async_trait]
    impl ClusterBackend for DefaultBackend {
        async fn initialize(
            &self,
            _context: &ConnectionContext,
            _params: InitializeParams,
        ) -> Result<InitializeResult, BackendError> {
            Ok(InitializeResult::new(
                ServerCapabilities::default(),
                ClusterStatus::empty(),
            ))
        }

        async fn get(
            &self,
            _context: &ConnectionContext,
            _params: GetParams,
        ) -> Result<GetResult, BackendError> {
            unreachable!()
        }
    }

    let error = ClusterBackend::resubmit(
        &DefaultBackend,
        &ConnectionContext::default(),
        ResubmitParams {
            if_generation: Generation::new(1).unwrap(),
            if_run_id: RunId::new("run-1"),
            idempotency_key: openengine_cluster_protocol::IdempotencyKey::new("default").unwrap(),
            replacement_input: None,
        },
    )
    .await
    .unwrap_err();
    assert_eq!(error.code, INVALID_PHASE);
}
