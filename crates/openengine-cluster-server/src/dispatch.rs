//! Per-method request routing: decode typed params, invoke the backend, serialize the response.

use std::sync::Arc;

use openengine_cluster_protocol::{
    ApplyParams, DeleteParams, DomainErrorData, GetParams, InitializeParams, PlanParams, RequestId,
    ResubmitParams, RetryParams, StopParams, UpdateParams, APPLICATION_ERROR, INTERNAL_ERROR_CODE,
    INVALID_PARAMS, INVALID_REQUEST, JSON_RPC_VERSION, METHOD_NOT_FOUND, PARSE_ERROR,
    PROTOCOL_VERSION, SCHEMA_VIOLATION, UNSUPPORTED_PROTOCOL_VERSION,
};
use serde_json::{json, Map, Value};

use crate::{
    serialize_backend_error, serialize_error, serialize_success, BackendError, ClusterBackend,
    ConnectionContext, Dispatcher,
};

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
        let (id, method, params) = match Self::parse_request(&object) {
            Ok(parsed) => parsed,
            Err(response) => return response,
        };

        self.route(method, id, params).await
    }

    fn parse_request(
        object: &Map<String, Value>,
    ) -> Result<(RequestId, ImplementedMethod, Value), String> {
        if object.get("jsonrpc") != Some(&Value::String(JSON_RPC_VERSION.to_owned())) {
            return Err(serialize_error(
                None,
                INVALID_REQUEST,
                "Invalid Request",
                None,
            ));
        }

        let Some(Value::String(method_name)) = object.get("method") else {
            return Err(serialize_error(
                None,
                INVALID_REQUEST,
                "Invalid Request",
                None,
            ));
        };
        let Some(id_value) = object.get("id") else {
            return Err(serialize_error(
                None,
                INVALID_REQUEST,
                "Invalid Request",
                None,
            ));
        };
        let Some(id) = RequestId::from_json_value(id_value) else {
            return Err(serialize_error(
                None,
                INVALID_REQUEST,
                "Invalid Request",
                None,
            ));
        };

        let Some(method) = ImplementedMethod::from_name(method_name) else {
            return Err(serialize_error(
                Some(id),
                METHOD_NOT_FOUND,
                "Method not found",
                None,
            ));
        };

        let params = match object.get("params") {
            Some(Value::Object(params)) => Value::Object(params.clone()),
            _ => {
                return Err(serialize_error(
                    Some(id),
                    INVALID_PARAMS,
                    "Invalid params",
                    None,
                ));
            }
        };

        Ok((id, method, params))
    }

    async fn route(&self, method: ImplementedMethod, id: RequestId, params: Value) -> String {
        match method {
            ImplementedMethod::Initialize => self.dispatch_initialize(id, params).await,
            ImplementedMethod::Plan => self.dispatch_plan(id, params).await,
            ImplementedMethod::Apply => self.dispatch_apply(id, params).await,
            ImplementedMethod::Get => self.dispatch_get(id, params).await,
            ImplementedMethod::Update => self.dispatch_update(id, params).await,
            ImplementedMethod::Stop => self.dispatch_stop(id, params).await,
            ImplementedMethod::Retry => self.dispatch_retry(id, params).await,
            ImplementedMethod::Resubmit => self.dispatch_resubmit(id, params).await,
            ImplementedMethod::Delete => self.dispatch_delete(id, params).await,
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

    async fn dispatch_delete(&self, id: RequestId, params: Value) -> String {
        let params = match serde_json::from_value::<DeleteParams>(params) {
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
        match self.backend.delete(&self.context, params).await {
            Ok(result) => serialize_success(id, result),
            Err(error) => serialize_backend_error(id, error),
        }
    }
}

#[derive(Clone, Copy)]
enum ImplementedMethod {
    Initialize,
    Plan,
    Apply,
    Get,
    Update,
    Stop,
    Retry,
    Resubmit,
    Delete,
}

impl ImplementedMethod {
    const NAMES: &'static [(&'static str, Self)] = &[
        ("initialize", Self::Initialize),
        ("plan", Self::Plan),
        ("apply", Self::Apply),
        ("get", Self::Get),
        ("update", Self::Update),
        ("stop", Self::Stop),
        ("retry", Self::Retry),
        ("resubmit", Self::Resubmit),
        ("delete", Self::Delete),
    ];

    fn from_name(name: &str) -> Option<Self> {
        Self::NAMES
            .iter()
            .find(|(candidate, _)| *candidate == name)
            .map(|(_, method)| *method)
    }
}
