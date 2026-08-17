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

/// Bounded provider model identifier.
#[derive(Clone, Debug, Deserialize, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(transparent)]
pub struct ModelId(crate::provider_value::BoundedBytes<128>);

impl ModelId {
    pub fn new(value: impl Into<String>) -> Result<Self, WorkerCatalogError> {
        crate::provider_value::BoundedBytes::new(value)
            .map(Self)
            .map_err(|error| WorkerCatalogError::new("model id", error))
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        self.0.as_str()
    }
}

impl std::fmt::Display for ModelId {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        std::fmt::Display::fmt(self.as_str(), formatter)
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ReasoningEffort {
    Low,
    Medium,
    High,
    Xhigh,
    Max,
}
