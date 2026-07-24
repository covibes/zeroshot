use async_trait::async_trait;
use openengine_cluster_protocol::{
    ClusterStatus, DeleteParams, DeleteResult, GetParams, GetResult, InitializeParams,
    InitializeResult, Phase, ServerCapabilities, GENERATION_CONFLICT, INVALID_PHASE, RUN_CONFLICT,
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
}

async fn dispatch_delete(
    dispatcher: &Dispatcher<RoutingBackend>,
    id: i64,
    params: serde_json::Value,
) -> serde_json::Value {
    serde_json::from_str(
        &dispatcher
            .dispatch(
                &json!({"jsonrpc":"2.0","id":id,"method":"delete","params":params}).to_string(),
            )
            .await,
    )
    .unwrap()
}

#[tokio::test]
async fn delete_dispatches_to_cluster_backend_and_maps_domain_errors() {
    let dispatcher = Dispatcher::new(RoutingBackend, ConnectionContext::default());

    let success = dispatch_delete(
        &dispatcher,
        1,
        json!({"ifGeneration":1,"ifRunId":"run-1","idempotencyKey":"delete-1"}),
    )
    .await;
    assert_eq!(success["result"]["deleted"], true);
    assert_eq!(success["result"]["phase"], "empty");

    let stale_generation = dispatch_delete(
        &dispatcher,
        2,
        json!({"ifGeneration":1,"ifRunId":"run-1","idempotencyKey":"stale-generation"}),
    )
    .await;
    assert_eq!(
        stale_generation["error"]["data"]["code"],
        GENERATION_CONFLICT
    );

    let stale_run = dispatch_delete(
        &dispatcher,
        3,
        json!({"ifGeneration":1,"ifRunId":"run-1","idempotencyKey":"stale-run"}),
    )
    .await;
    assert_eq!(stale_run["error"]["data"]["code"], RUN_CONFLICT);

    let not_terminal = dispatch_delete(
        &dispatcher,
        4,
        json!({"ifGeneration":1,"idempotencyKey":"not-terminal"}),
    )
    .await;
    assert_eq!(not_terminal["error"]["data"]["code"], INVALID_PHASE);

    for params in [
        json!({"idempotencyKey":"empty"}),
        json!({"ifGeneration":1}),
        json!({"ifGeneration":1,"ifRunId":"run-1","idempotencyKey":"turn","turnId":"turn-1"}),
        json!({"ifGeneration":1,"ifRunId":"run-1","idempotencyKey":"provider","provider":"claude"}),
    ] {
        let response = dispatch_delete(&dispatcher, 5, params).await;
        assert!(
            response["error"].is_object(),
            "expected rejection for {response}"
        );
    }
}

#[tokio::test]
async fn default_backend_rejects_delete_with_invalid_phase() {
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

    let error = ClusterBackend::delete(
        &DefaultBackend,
        &ConnectionContext::default(),
        DeleteParams {
            if_generation: openengine_cluster_protocol::Generation::new(1).unwrap(),
            if_run_id: Some(openengine_cluster_protocol::RunId::new("run-1")),
            idempotency_key: openengine_cluster_protocol::IdempotencyKey::new("default").unwrap(),
        },
    )
    .await
    .unwrap_err();
    assert_eq!(error.code, INVALID_PHASE);
}
