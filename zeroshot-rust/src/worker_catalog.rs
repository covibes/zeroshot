//! Small, provider-neutral model values used by native v2 runtime bindings.

use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Clone, Debug, Eq, Error, PartialEq)]
#[error("invalid {field}: {reason}")]
pub struct WorkerCatalogError {
    field: &'static str,
    reason: String,
}

impl WorkerCatalogError {
    fn new(field: &'static str, error: impl std::fmt::Display) -> Self {
        Self {
            field,
            reason: error.to_string(),
        }
    }

    #[must_use]
    pub const fn field(&self) -> &'static str {
        self.field
    }

    #[must_use]
    pub fn reason(&self) -> &str {
        &self.reason
    }
}

crate::provider_value::bounded_bytes_type!(ModelId, 128, WorkerCatalogError, "model id");

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ReasoningEffort {
    Low,
    Medium,
    High,
    Xhigh,
    Max,
}
