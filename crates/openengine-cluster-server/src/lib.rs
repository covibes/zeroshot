//! Backend-neutral Cluster Protocol dispatcher.

pub mod admission;
pub mod graph_verifier;
pub mod lifecycle;
pub mod stdio;
pub mod watch;
pub mod worker_registry;

mod wire;
pub(crate) use wire::{serialize_backend_error, serialize_error, serialize_success};

use std::sync::Arc;

use async_trait::async_trait;
use openengine_cluster_protocol::{
    ApplyParams, ApplyResult, DomainErrorData, GetParams, GetResult, InitializeParams,
    InitializeResult, PlanParams, PlanResult, RequestId, APPLICATION_ERROR, INTERNAL_ERROR_CODE,
    INVALID_PARAMS, INVALID_PHASE, INVALID_REQUEST, JSON_RPC_VERSION, METHOD_NOT_FOUND,
    PARSE_ERROR, PROTOCOL_VERSION, SCHEMA_VIOLATION, ResubmitParams, ResubmitResult, RetryParams,
    RetryResult, StopParams, StopResult, UNSUPPORTED_PROTOCOL_VERSION, UpdateParams, UpdateResult,
    WatchParams, WatchResult,
};
use serde_json::{json, Map, Value};
use thiserror::Error;

use crate::watch::{WatchEventStream, WatchHandle};

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct ConnectionContext {
    pub peer_label: Option<String>,
    pub cancellation: admission::CancellationSignal,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum BackendErrorKind {
    Internal,
    InvalidParams,
    Application,
}

#[derive(Clone, Debug, Error, Eq, PartialEq)]
#[error("{message}")]
pub struct BackendError {
    pub kind: BackendErrorKind,
    pub code: String,
    pub message: String,
    pub details: Option<Value>,
}

impl BackendError {
    #[must_use]
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            kind: BackendErrorKind::Internal,
            code: code.into(),
            message: message.into(),
            details: None,
        }
    }

    #[must_use]
    pub fn invalid_params(
        code: impl Into<String>,
        message: impl Into<String>,
        details: Option<Value>,
    ) -> Self {
        Self {
            kind: BackendErrorKind::InvalidParams,
            code: code.into(),
            message: message.into(),
            details,
        }
    }

    #[must_use]
    pub fn application(
        code: impl Into<String>,
        message: impl Into<String>,
        details: Option<Value>,
    ) -> Self {
        Self {
            kind: BackendErrorKind::Application,
            code: code.into(),
            message: message.into(),
            details,
        }
    }
}

#[async_trait]
pub trait ClusterBackend: Send + Sync + 'static {
    async fn initialize(
        &self,
        context: &ConnectionContext,
        params: InitializeParams,
    ) -> Result<InitializeResult, BackendError>;

    async fn plan(
        &self,
        _context: &ConnectionContext,
        _params: PlanParams,
    ) -> Result<PlanResult, BackendError> {
        Err(BackendError::application(
            INVALID_PHASE,
            "Backend does not admit graphs",
            None,
        ))
    }

    async fn apply(
        &self,
        _context: &ConnectionContext,
        _params: ApplyParams,
    ) -> Result<ApplyResult, BackendError> {
        Err(BackendError::application(
            INVALID_PHASE,
            "Backend does not admit graphs",
            None,
        ))
    }

    async fn get(
        &self,
        context: &ConnectionContext,
        params: GetParams,
    ) -> Result<GetResult, BackendError>;

    async fn update(
        &self,
        _context: &ConnectionContext,
        _params: UpdateParams,
    ) -> Result<UpdateResult, BackendError> {
        Err(BackendError::application(
            INVALID_PHASE,
            "Backend does not support lifecycle updates",
            None,
        ))
    }

    async fn stop(
        &self,
        _context: &ConnectionContext,
        _params: StopParams,
    ) -> Result<StopResult, BackendError> {
        Err(BackendError::application(
            INVALID_PHASE,
            "Backend does not support lifecycle stop",
            None,
        ))
    }

    async fn retry(
        &self,
        _context: &ConnectionContext,
        _params: RetryParams,
    ) -> Result<RetryResult, BackendError> {
        Err(BackendError::application(
            INVALID_PHASE,
            "Backend does not support lifecycle retry",
            None,
        ))
    }

    async fn resubmit(
        &self,
        _context: &ConnectionContext,
        _params: ResubmitParams,
    ) -> Result<ResubmitResult, BackendError> {
        Err(BackendError::application(
            INVALID_PHASE,
            "Backend does not support lifecycle resubmit",
            None,
        ))
    }

    async fn watch(
        &self,
        _context: &ConnectionContext,
        _params: WatchParams,
        _queue_capacity: usize,
    ) -> Result<(WatchResult, WatchEventStream, WatchHandle), BackendError> {
        Err(BackendError::application(
            INVALID_PHASE,
            "Backend does not support watch",
            None,
        ))
    }
}

pub struct Dispatcher<B> {
    backend: Arc<B>,
    context: ConnectionContext,
}

impl<B> Clone for Dispatcher<B> {
    fn clone(&self) -> Self {
        Self {
            backend: Arc::clone(&self.backend),
            context: self.context.clone(),
        }
    }
}

impl<B> Dispatcher<B>
where
    B: ClusterBackend,
{
    #[must_use]
    pub fn new(backend: B, context: ConnectionContext) -> Self {
        Self {
            backend: Arc::new(backend),
            context,
        }
    }

    #[must_use]
    pub fn from_shared(backend: Arc<B>, context: ConnectionContext) -> Self {
        Self { backend, context }
    }

    pub(crate) fn backend(&self) -> &Arc<B> {
        &self.backend
    }

    pub(crate) fn context(&self) -> &ConnectionContext {
        &self.context
    }

    pub async fn dispatch(&self, input: &str) -> String {
        let value = match serde_json::from_str::<Value>(input) {
            Ok(value) => value,
            Err(_) => return serialize_error(None, PARSE_ERROR, "Parse error", None),
        };

        let object = match value {
            Value::Object(object) => object,
            Value::Array(_) => {
                return serialize_error(None, INVALID_REQUEST, "Invalid Request", None);
            }
            _ => return serialize_error(None, INVALID_REQUEST, "Invalid Request", None),
        };

        self.dispatch_object(object).await
    }

    async fn dispatch_object(&self, object: Map<String, Value>) -> String {
        if object.get("jsonrpc") != Some(&Value::String(JSON_RPC_VERSION.to_owned())) {
            return serialize_error(None, INVALID_REQUEST, "Invalid Request", None);
        }

        let Some(Value::String(method)) = object.get("method") else {
            return serialize_error(None, INVALID_REQUEST, "Invalid Request", None);
        };
        let Some(id_value) = object.get("id") else {
            return serialize_error(None, INVALID_REQUEST, "Invalid Request", None);
        };
        let Some(id) = RequestId::from_json_value(id_value) else {
            return serialize_error(None, INVALID_REQUEST, "Invalid Request", None);
        };

        let method = match method.as_str() {
            "initialize" => ImplementedMethod::Initialize,
            "plan" => ImplementedMethod::Plan,
            "apply" => ImplementedMethod::Apply,
            "get" => ImplementedMethod::Get,
            "update" => ImplementedMethod::Update,
            "stop" => ImplementedMethod::Stop,
            "retry" => ImplementedMethod::Retry,
            "resubmit" => ImplementedMethod::Resubmit,
            _ => {
                return serialize_error(Some(id), METHOD_NOT_FOUND, "Method not found", None);
            }
        };

        let params = match object.get("params") {
            Some(Value::Object(params)) => Value::Object(params.clone()),
            Some(_) => {
                return serialize_error(Some(id), INVALID_PARAMS, "Invalid params", None);
            }
            None => return serialize_error(Some(id), INVALID_PARAMS, "Invalid params", None),
        };

        match method {
            ImplementedMethod::Initialize => self.dispatch_initialize(id, params).await,
            ImplementedMethod::Plan => self.dispatch_plan(id, params).await,
            ImplementedMethod::Apply => self.dispatch_apply(id, params).await,
            ImplementedMethod::Get => self.dispatch_get(id, params).await,
            ImplementedMethod::Update => self.dispatch_update(id, params).await,
            ImplementedMethod::Stop => self.dispatch_stop(id, params).await,
            ImplementedMethod::Retry => self.dispatch_retry(id, params).await,
            ImplementedMethod::Resubmit => self.dispatch_resubmit(id, params).await,
        }
    }

    async fn dispatch_plan(&self, id: RequestId, params: Value) -> String {
        let params = match serde_json::from_value::<PlanParams>(params) {
            Ok(params) => params,
            Err(_) => {
                return serialize_error(
                    Some(id),
                    INVALID_PARAMS,
                    "Invalid params",
                    Some(DomainErrorData::new(SCHEMA_VIOLATION)),
                );
            }
        };
        match self.backend.plan(&self.context, params).await {
            Ok(result) => serialize_success(id, result),
            Err(error) => serialize_backend_error(id, error),
        }
    }

    async fn dispatch_apply(&self, id: RequestId, params: Value) -> String {
        let params = match serde_json::from_value::<ApplyParams>(params) {
            Ok(params) => params,
            Err(_) => {
                return serialize_error(
                    Some(id),
                    INVALID_PARAMS,
                    "Invalid params",
                    Some(DomainErrorData::new(SCHEMA_VIOLATION)),
                );
            }
        };
        match self.backend.apply(&self.context, params).await {
            Ok(result) => serialize_success(id, result),
            Err(error) => serialize_backend_error(id, error),
        }
    }

    async fn dispatch_initialize(&self, id: RequestId, params: Value) -> String {
        let params = match serde_json::from_value::<InitializeParams>(params) {
            Ok(params) => params,
            Err(_) => {
                return serialize_error(Some(id), INVALID_PARAMS, "Invalid params", None);
            }
        };
        if params.protocol_version != PROTOCOL_VERSION {
            return serialize_error(
                Some(id),
                APPLICATION_ERROR,
                "Unsupported protocol version",
                Some(DomainErrorData {
                    code: UNSUPPORTED_PROTOCOL_VERSION.to_owned(),
                    details: Some(json!({
                        "requestedProtocolVersion": params.protocol_version,
                        "supportedProtocolVersion": PROTOCOL_VERSION,
                    })),
                }),
            );
        }

        match self.backend.initialize(&self.context, params).await {
            Ok(result) => match result.validate_protocol_version() {
                Ok(()) => serialize_success(id, result),
                Err(error) => serialize_backend_error(
                    id,
                    BackendError::new(INTERNAL_ERROR_CODE, error.to_string()),
                ),
            },
            Err(error) => serialize_backend_error(id, error),
        }
    }

    async fn dispatch_get(&self, id: RequestId, params: Value) -> String {
        let params = match serde_json::from_value::<GetParams>(params) {
            Ok(params) => params,
            Err(_) => {
                return serialize_error(Some(id), INVALID_PARAMS, "Invalid params", None);
            }
        };

        match self.backend.get(&self.context, params).await {
            Ok(result) => serialize_success(id, result),
            Err(error) => serialize_backend_error(id, error),
        }
    }

    async fn dispatch_update(&self, id: RequestId, params: Value) -> String {
        let params = match serde_json::from_value::<UpdateParams>(params) {
            Ok(params) => params,
            Err(error) => {
                return serialize_error(
                    Some(id),
                    INVALID_PARAMS,
                    "Invalid params",
                    Some(DomainErrorData {
                        code: SCHEMA_VIOLATION.to_owned(),
                        details: Some(json!({ "reason": error.to_string() })),
                    }),
                );
            }
        };
        match self.backend.update(&self.context, params).await {
            Ok(result) => serialize_success(id, result),
            Err(error) => serialize_backend_error(id, error),
        }
    }

    async fn dispatch_stop(&self, id: RequestId, params: Value) -> String {
        let params = match serde_json::from_value::<StopParams>(params) {
            Ok(params) => params,
            Err(error) => {
                return serialize_error(
                    Some(id),
                    INVALID_PARAMS,
                    "Invalid params",
                    Some(DomainErrorData {
                        code: SCHEMA_VIOLATION.to_owned(),
                        details: Some(json!({ "reason": error.to_string() })),
                    }),
                );
            }
        };
        match self.backend.stop(&self.context, params).await {
            Ok(result) => serialize_success(id, result),
            Err(error) => serialize_backend_error(id, error),
        }
    }

    async fn dispatch_retry(&self, id: RequestId, params: Value) -> String {
        let params = match serde_json::from_value::<RetryParams>(params) {
            Ok(params) => params,
            Err(error) => {
                return serialize_error(
                    Some(id),
                    INVALID_PARAMS,
                    "Invalid params",
                    Some(DomainErrorData {
                        code: SCHEMA_VIOLATION.to_owned(),
                        details: Some(json!({ "reason": error.to_string() })),
                    }),
                );
            }
        };
        match self.backend.retry(&self.context, params).await {
            Ok(result) => serialize_success(id, result),
            Err(error) => serialize_backend_error(id, error),
        }
    }

    async fn dispatch_resubmit(&self, id: RequestId, params: Value) -> String {
        let params = match serde_json::from_value::<ResubmitParams>(params) {
            Ok(params) => params,
            Err(error) => {
                return serialize_error(
                    Some(id),
                    INVALID_PARAMS,
                    "Invalid params",
                    Some(DomainErrorData {
                        code: SCHEMA_VIOLATION.to_owned(),
                        details: Some(json!({ "reason": error.to_string() })),
                    }),
                );
            }
        };
        match self.backend.resubmit(&self.context, params).await {
            Ok(result) => serialize_success(id, result),
            Err(error) => serialize_backend_error(id, error),
        }
    }
}

enum ImplementedMethod {
    Initialize,
    Plan,
    Apply,
    Get,
    Update,
    Stop,
    Retry,
    Resubmit,
}
