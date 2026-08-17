//! JSON-RPC success/error response framing.

use openengine_cluster_protocol::{
    DomainErrorData, JsonRpcError, JsonRpcErrorResponse, JsonRpcSuccess, RequestId,
    APPLICATION_ERROR, INTERNAL_ERROR, INTERNAL_ERROR_CODE, INVALID_PARAMS, JSON_RPC_VERSION,
};

use crate::{BackendError, BackendErrorKind};

const SERIALIZATION_FAILURE: &str = concat!(
    r#"{"jsonrpc":"2.0","id":null,"error":{"code":-32603,"#,
    r#""message":"Internal error","data":{"code":"INTERNAL_ERROR","details":null}}}"#,
);

pub(crate) fn serialize_success<T>(id: RequestId, result: T) -> String
where
    T: serde::Serialize,
{
    let response = JsonRpcSuccess {
        jsonrpc: JSON_RPC_VERSION.to_owned(),
        id: id.clone(),
        result,
    };
    match serde_json::to_string(&response) {
        Ok(serialized) => serialized,
        Err(_) => serialize_error(
            Some(id),
            INTERNAL_ERROR,
            "Internal error",
            Some(DomainErrorData::new(INTERNAL_ERROR_CODE)),
        ),
    }
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
    let response = JsonRpcErrorResponse {
        jsonrpc: JSON_RPC_VERSION.to_owned(),
        id,
        error: JsonRpcError {
            code,
            message: message.to_owned(),
            data,
        },
    };
    match serde_json::to_string(&response) {
        Ok(serialized) => serialized,
        Err(_) => SERIALIZATION_FAILURE.to_owned(),
    }
}
