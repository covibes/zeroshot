//! JSON-RPC success/error response framing.

use openengine_cluster_protocol::{
    DomainErrorData, JsonRpcError, JsonRpcErrorResponse, JsonRpcSuccess, RequestId,
    APPLICATION_ERROR, INTERNAL_ERROR, INTERNAL_ERROR_CODE, INVALID_PARAMS, JSON_RPC_VERSION,
};

use crate::{BackendError, BackendErrorKind};

pub(crate) fn serialize_success<T>(id: RequestId, result: T) -> String
where
    T: serde::Serialize,
{
    serde_json::to_string(&JsonRpcSuccess {
        jsonrpc: JSON_RPC_VERSION.to_owned(),
        id,
        result,
    })
    .expect("protocol response serialization must succeed")
}

pub(crate) fn serialize_backend_error(id: RequestId, error: BackendError) -> String {
    let code = if error.code.is_empty() {
        INTERNAL_ERROR_CODE.to_owned()
    } else {
        error.code
    };
    match error.kind {
        BackendErrorKind::Internal => serialize_error(
            Some(id),
            INTERNAL_ERROR,
            "Internal error",
            Some(DomainErrorData {
                code,
                details: None,
            }),
        ),
        BackendErrorKind::InvalidParams => serialize_error(
            Some(id),
            INVALID_PARAMS,
            "Invalid params",
            Some(DomainErrorData {
                code,
                details: error.details,
            }),
        ),
        BackendErrorKind::Application => serialize_error(
            Some(id),
            APPLICATION_ERROR,
            &error.message,
            Some(DomainErrorData {
                code,
                details: error.details,
            }),
        ),
    }
}

pub(crate) fn serialize_error(
    id: Option<RequestId>,
    code: i64,
    message: &str,
    data: Option<DomainErrorData>,
) -> String {
    serde_json::to_string(&JsonRpcErrorResponse {
        jsonrpc: JSON_RPC_VERSION.to_owned(),
        id,
        error: JsonRpcError {
            code,
            message: message.to_owned(),
            data,
        },
    })
    .expect("protocol error serialization must succeed")
}
