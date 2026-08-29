use std::fmt;

use serde::{Deserialize, Serialize};

use super::{TargetConnectorError, validate_bearer_token};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(
    deny_unknown_fields,
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    tag = "mode"
)]
pub enum TargetAccess {
    Hosted { device_token: String },
    Direct,
}

impl TargetAccess {
    pub(super) const fn authentication(
        &self,
    ) -> zeroshot_engine::native_v2_target_authority::TargetAuthentication {
        match self {
            Self::Hosted { .. } => {
                zeroshot_engine::native_v2_target_authority::TargetAuthentication::HostedOauth
            }
            Self::Direct => zeroshot_engine::native_v2_target_authority::TargetAuthentication::None,
        }
    }

    pub(super) fn device_token(&self) -> Option<&str> {
        match self {
            Self::Hosted { device_token } => Some(device_token),
            Self::Direct => None,
        }
    }
}

/// Same-authority OECP access minted by the target control authority. Hosted targets carry a
/// short-lived bearer; explicit direct targets do not. Debug output never includes bearer values.
pub struct TargetOecpAccess {
    endpoint: String,
    bearer_token: Option<String>,
}

impl TargetOecpAccess {
    pub(super) fn new(
        endpoint: impl Into<String>,
        bearer_token: Option<String>,
        access: &TargetAccess,
    ) -> Result<Self, TargetConnectorError> {
        let session = Self {
            endpoint: endpoint.into(),
            bearer_token,
        };
        match (access, session.bearer_token.as_deref()) {
            (TargetAccess::Hosted { .. }, Some(token)) => validate_bearer_token(token)?,
            (TargetAccess::Direct, None) => {}
            _ => return Err(TargetConnectorError::InvalidBearerToken),
        }
        Ok(session)
    }

    #[must_use]
    pub fn endpoint(&self) -> &str {
        &self.endpoint
    }

    pub(super) fn bearer_token(&self) -> Option<&str> {
        self.bearer_token.as_deref()
    }
}

impl fmt::Debug for TargetOecpAccess {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("TargetOecpAccess")
            .field("endpoint", &self.endpoint)
            .field(
                "bearer_token",
                &self.bearer_token.as_ref().map(|_| "[REDACTED]"),
            )
            .finish()
    }
}
