//! Operational lifecycle coordination ports and fingerprint helpers.

pub mod ports;
pub use ports::*;

use openengine_cluster_protocol::{
    admission_fingerprint, RequestFingerprint, ResubmitParams, RetryParams, StopParams,
    UpdateParams, INTERNAL_ERROR_CODE,
};
use serde_json::Value;

use crate::BackendError;

pub(crate) fn update_fingerprint(
    params: &UpdateParams,
) -> Result<RequestFingerprint, BackendError> {
    method_fingerprint("update", params)
}

pub(crate) fn stop_fingerprint(params: &StopParams) -> Result<RequestFingerprint, BackendError> {
    method_fingerprint("stop", params)
}

pub(crate) fn retry_fingerprint(params: &RetryParams) -> Result<RequestFingerprint, BackendError> {
    method_fingerprint("retry", params)
}

pub(crate) fn resubmit_fingerprint(
    params: &ResubmitParams,
) -> Result<RequestFingerprint, BackendError> {
    method_fingerprint("resubmit", params)
}

pub(crate) fn method_fingerprint<T>(
    method: &str,
    params: &T,
) -> Result<RequestFingerprint, BackendError>
where
    T: serde::Serialize,
{
    let value = serde_json::to_value(params)
        .map_err(|error| BackendError::new(INTERNAL_ERROR_CODE, error.to_string()))?;
    let Value::Object(mut parameters) = value else {
        return Err(BackendError::new(
            INTERNAL_ERROR_CODE,
            "serialized lifecycle parameters were not an object",
        ));
    };
    parameters.remove("idempotencyKey");
    admission_fingerprint(method, &Value::Object(parameters))
        .map_err(|error| BackendError::new(INTERNAL_ERROR_CODE, error.to_string()))
}
