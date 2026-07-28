use thiserror::Error;

use crate::SINGLE_WORKER_GRAPH_PROFILE;

#[derive(Clone, Debug, Error, Eq, PartialEq)]
pub enum WorkerContractError {
    #[error("unsupported worker protocol version/profile binding")]
    UnsupportedProtocolBinding,
    #[error("invalid opaque registry handle")]
    InvalidOpaqueHandle,
    #[error("{0} must not be empty")]
    Empty(&'static str),
    #[error("{0} must not contain duplicates")]
    Duplicate(&'static str),
    #[error("worker errors must contain timeout, crash, malformed, and refusal")]
    IncompleteRuntimeErrors,
    #[error("legacy.zeroshot.ship@1 must use its pinned binding and {SINGLE_WORKER_GRAPH_PROFILE}")]
    InvalidLegacyBinding,
    #[error("openengine.worker.builtin/v1 descriptors must not declare credential requirements")]
    InvalidBuiltinBinding,
    #[error("legacy ship source fields are inconsistent")]
    InvalidLegacySource,
    #[error("worker error code and failure reason are inconsistent")]
    InvalidFailurePair,
}
