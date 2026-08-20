//! Per-method request routing: decode typed params, invoke the backend, serialize the response.

use std::sync::Arc;

use openengine_cluster_protocol::{
    ApplyParams, DeleteParams, DomainErrorData, GetParams, InitializeParams, PlanParams, RequestId,
    ResubmitParams, RetryParams, RunForceParams, RunListParams, RunStatusParams, RunSubmitParams,
    StopParams, UpdateParams, APPLICATION_ERROR, INTERNAL_ERROR_CODE, INVALID_PARAMS,
    METHOD_NOT_FOUND, PROTOCOL_VERSION, RUN_FORCE_METHOD, RUN_LIST_METHOD, RUN_STATUS_METHOD,
    RUN_SUBMIT_METHOD, SCHEMA_VIOLATION, UNSUPPORTED_PROTOCOL_VERSION,
};
use serde_json::{json, Value};

use crate::connection::DecodedRequest;
use crate::method_registry::{method_descriptor, MethodDescriptor, MethodKind};
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
        let request = match DecodedRequest::decode(input) {
            Ok(request) => request,
            Err(response) => return response,
        };
        let DecodedRequest { id, method, params } = request;
        self.dispatch_decoded(id, &method, params).await
    }

    pub async fn dispatch_decoded(&self, id: RequestId, method: &str, params: Value) -> String {
        let Some(descriptor) = method_descriptor(method) else {
            return serialize_error(Some(id), METHOD_NOT_FOUND, "Method not found", None);
        };
        match descriptor.kind {
            MethodKind::Unary => {}
            MethodKind::Subscription(_) => {
                return serialize_error(Some(id), METHOD_NOT_FOUND, "Method not found", None);
            }
        }
        if !params.is_object() {
            return serialize_error(Some(id), INVALID_PARAMS, "Invalid params", None);
        }
        self.route(descriptor, id, params).await
    }

    async fn route(&self, descriptor: &MethodDescriptor, id: RequestId, params: Value) -> String {
        match descriptor.name {
            "initialize" => self.dispatch_initialize(id, params).await,
            "plan" => self.dispatch_plan(id, params).await,
            "apply" => self.dispatch_apply(id, params).await,
            "get" => self.dispatch_get(id, params).await,
            _ => {
                self.route_lifecycle_or_native(descriptor.name, id, params)
                    .await
            }
        }
    }

    async fn route_lifecycle_or_native(
        &self,
        method: &str,
        id: RequestId,
        params: Value,
    ) -> String {
        match method {
            "update" => self.dispatch_update(id, params).await,
            "stop" => self.dispatch_stop(id, params).await,
            "retry" => self.dispatch_retry(id, params).await,
            "resubmit" => self.dispatch_resubmit(id, params).await,
            "delete" => self.dispatch_delete(id, params).await,
            _ => self.route_native_v2(method, id, params).await,
        }
    }

    async fn route_native_v2(&self, method: &str, id: RequestId, params: Value) -> String {
        match method {
            RUN_SUBMIT_METHOD => self.dispatch_run_submit(id, params).await,
            RUN_LIST_METHOD => self.dispatch_run_list(id, params).await,
            RUN_STATUS_METHOD => self.dispatch_run_status(id, params).await,
            RUN_FORCE_METHOD => self.dispatch_run_force(id, params).await,
            _ => serialize_error(Some(id), METHOD_NOT_FOUND, "Method not found", None),
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

    async fn dispatch_run_submit(&self, id: RequestId, params: Value) -> String {
        let params = match serde_json::from_value::<RunSubmitParams>(params) {
            Ok(params) => params,
            Err(_) => return native_v2_invalid_params(id),
        };
        match self.run_submit(params).await {
            Ok(result) => serialize_success(id, result),
            Err(error) => serialize_backend_error(id, error),
        }
    }

    async fn dispatch_run_list(&self, id: RequestId, params: Value) -> String {
        let params = match serde_json::from_value::<RunListParams>(params) {
            Ok(params) => params,
            Err(_) => return native_v2_invalid_params(id),
        };
        match self.run_list(params).await {
            Ok(result) => serialize_success(id, result),
            Err(error) => serialize_backend_error(id, error),
        }
    }

    async fn dispatch_run_status(&self, id: RequestId, params: Value) -> String {
        let params = match serde_json::from_value::<RunStatusParams>(params) {
            Ok(params) => params,
            Err(_) => return native_v2_invalid_params(id),
        };
        match self.run_status(params).await {
            Ok(result) => serialize_success(id, result),
            Err(error) => serialize_backend_error(id, error),
        }
    }

    async fn dispatch_run_force(&self, id: RequestId, params: Value) -> String {
        let params = match serde_json::from_value::<RunForceParams>(params) {
            Ok(params) => params,
            Err(_) => return native_v2_invalid_params(id),
        };
        match self.run_force(params).await {
            Ok(result) => serialize_success(id, result),
            Err(error) => serialize_backend_error(id, error),
        }
    }
}

fn native_v2_invalid_params(id: RequestId) -> String {
    serialize_error(
        Some(id),
        INVALID_PARAMS,
        "Invalid params",
        Some(DomainErrorData::new(SCHEMA_VIOLATION)),
    )
}
