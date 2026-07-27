use async_trait::async_trait;
use openengine_cluster_protocol::{
    ClusterStatus, Cursor, DispatchState, Generation, GetParams, GetResult, InitializeParams,
    InitializeResult, OperationalStatus, Phase, RetryParams, RetryResult, RunId,
    ServerCapabilities, NO_RETRYABLE_FRONTIER,
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

    async fn retry(
        &self,
        _context: &ConnectionContext,
        params: RetryParams,
    ) -> Result<RetryResult, BackendError> {
        if params.idempotency_key.as_str() == "no-frontier" {
            return Err(BackendError::application(
                NO_RETRYABLE_FRONTIER,
                "No retryable failed frontier",
                Some(json!({ "reason": "exhausted" })),
            ));
        }
        Ok(RetryResult {
            generation: Generation::new(1).unwrap(),
            run_id: RunId::new("run-1"),
            phase: Phase::Running,
            retried_turn_id: "turn-1".to_owned(),
            retry_turn_id: "turn-2".to_owned(),
            operational: OperationalStatus {
                dispatch_state: DispatchState::Active,
                ..OperationalStatus::default()
            },
            at_cursor: Cursor::new("cursor-2"),
            deduped: false,
        })
    }
}

#[tokio::test]
async fn retry_dispatches_to_cluster_backend_and_maps_no_retryable_frontier() {
    let dispatcher = Dispatcher::new(RoutingBackend, ConnectionContext::default());

    let success: serde_json::Value = serde_json::from_str(
        &dispatcher
            .dispatch(
                &json!({
                    "jsonrpc":"2.0","id":1,"method":"retry",
                    "params":{"ifGeneration":1,"idempotencyKey":"retry-1"}
                })
                .to_string(),
            )
            .await,
    )
    .unwrap();
    assert_eq!(success["result"]["retriedTurnId"], "turn-1");
    assert_eq!(success["result"]["retryTurnId"], "turn-2");

    let denied: serde_json::Value = serde_json::from_str(
        &dispatcher
            .dispatch(
                &json!({
                    "jsonrpc":"2.0","id":2,"method":"retry",
                    "params":{"ifGeneration":1,"idempotencyKey":"no-frontier"}
                })
                .to_string(),
            )
            .await,
    )
    .unwrap();
    assert_eq!(denied["error"]["data"]["code"], NO_RETRYABLE_FRONTIER);
    assert_eq!(denied["error"]["data"]["details"]["reason"], "exhausted");

    for params in [
        json!({"idempotencyKey":"empty"}),
        json!({"ifGeneration":1}),
        json!({"ifGeneration":1,"idempotencyKey":"mode","mode":"force"}),
        json!({"ifGeneration":1,"idempotencyKey":"turn","turnId":"turn-1"}),
    ] {
        let response: serde_json::Value = serde_json::from_str(
            &dispatcher
                .dispatch(
                    &json!({"jsonrpc":"2.0","id":3,"method":"retry","params":params}).to_string(),
                )
                .await,
        )
        .unwrap();
        assert!(
            response["error"].is_object(),
            "expected rejection for {response}"
        );
    }
}

#[tokio::test]
async fn default_backend_rejects_retry_with_invalid_phase() {
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

    let error = ClusterBackend::retry(
        &DefaultBackend,
        &ConnectionContext::default(),
        RetryParams {
            if_generation: Generation::new(1).unwrap(),
            idempotency_key: openengine_cluster_protocol::IdempotencyKey::new("default").unwrap(),
        },
    )
    .await
    .unwrap_err();
    assert_eq!(error.code, openengine_cluster_protocol::INVALID_PHASE);
}
