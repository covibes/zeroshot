//! Native-v2 target HTTP boundary shared by the CLI, target server, and hosting authority.
//!
//! These values are deliberately separate from OECP JSON-RPC methods. HTTP submission is the
//! only run-creation seam; OECP begins after a target has accepted the exact immutable run.

use std::collections::BTreeMap;
use std::fmt;

use serde::{Deserialize, Serialize};

use crate::{EnvironmentVariableName, RunId, RunSubmission};

pub const TARGET_DISCOVERY_PATH: &str = "/.well-known/zeroshot-native-v2";
pub const TARGET_RUN_PATH: &str = "/native-v2/run";
pub const TARGET_SESSION_PATH: &str = "/native-v2/oecp-session";
pub const TARGET_OECP_PATH: &str = "/native-v2/oecp";
pub const TARGET_PRIVATE_BOOTSTRAP_PATH: &str = "/native-v2/private-bootstrap";
pub const TARGET_DISCOVERY_KIND: &str = "zeroshot.native-v2-target/v2";
pub const TARGET_CONTROLLER_AUDIENCE: &str = "controller";
pub const HOSTED_RUNS_KIND: &str = "zeroshot.hosted-runs/v1";

/// One exact run envelope. Secret values are ephemeral and excluded from submission identity.
#[derive(Clone, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct TargetRunRequest {
    pub run_id: RunId,
    pub submission: RunSubmission,
    pub environment: BTreeMap<EnvironmentVariableName, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub github_token: Option<String>,
}

impl fmt::Debug for TargetRunRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("TargetRunRequest")
            .field("run_id", &self.run_id)
            .field("submission", &self.submission)
            .field(
                "environment_names",
                &self.environment.keys().collect::<Vec<_>>(),
            )
            .field("environment_values", &"[REDACTED]")
            .field(
                "github_token",
                &self.github_token.as_ref().map(|_| "[REDACTED]"),
            )
            .finish()
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct TargetRunReceipt {
    pub run_id: RunId,
}

/// A hosted authority requires a run so it can route to one exact task attempt. Direct targets
/// may omit it for target-wide operations such as listing runs.
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct TargetOecpSessionRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_id: Option<RunId>,
}

/// Same-authority OECP access. Bearer values are never included in Debug output.
#[derive(Clone, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct TargetOecpSession {
    pub endpoint: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bearer_token: Option<String>,
}

/// Authenticated ciphertext delivered once to a private target task.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct TargetPrivateBootstrapRequest {
    pub nonce: String,
    pub ciphertext: String,
}

impl fmt::Debug for TargetOecpSession {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("TargetOecpSession")
            .field("endpoint", &self.endpoint)
            .field(
                "bearer_token",
                &self.bearer_token.as_ref().map(|_| "[REDACTED]"),
            )
            .finish()
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TargetAuthentication {
    HostedOauth,
    PrivateCapability,
    None,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct TargetOAuthDiscovery {
    pub metadata_url: String,
    pub device_authorization_endpoint: String,
    pub token_endpoint: String,
    pub revocation_endpoint: String,
    pub client_id: String,
    pub device_grant_type: String,
    pub device_exchange_fields: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct TargetLoginSessionDiscovery {
    pub route_template: String,
    pub method: String,
    pub cache_policy: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct TargetHostedRunRoutes {
    pub list: String,
    pub status: String,
    pub watch: String,
    pub logs: String,
    pub force: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct TargetHostedRunsDiscovery {
    pub kind: String,
    pub base_url: String,
    pub route_templates: TargetHostedRunRoutes,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(default, rename_all = "snake_case")]
pub struct TargetDiscoveryExtensions {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hosted_runs: Option<TargetHostedRunsDiscovery>,
}

/// One discovery document for direct Docker targets and OAuth-hosted targets.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct TargetDiscoveryDocument {
    pub kind: String,
    pub authentication: TargetAuthentication,
    pub run_path: String,
    pub session_path: String,
    pub oecp_path: String,
    pub audience: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub private_bootstrap_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub oauth: Option<TargetOAuthDiscovery>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub login_session: Option<TargetLoginSessionDiscovery>,
    #[serde(default, skip_serializing_if = "TargetDiscoveryExtensions::is_empty")]
    pub extensions: TargetDiscoveryExtensions,
}

impl TargetDiscoveryExtensions {
    #[must_use]
    pub const fn is_empty(&self) -> bool {
        self.hosted_runs.is_none()
    }
}

impl TargetDiscoveryDocument {
    #[must_use]
    pub fn direct(authentication: TargetAuthentication) -> Self {
        Self {
            kind: TARGET_DISCOVERY_KIND.to_owned(),
            authentication,
            run_path: TARGET_RUN_PATH.to_owned(),
            session_path: TARGET_SESSION_PATH.to_owned(),
            oecp_path: TARGET_OECP_PATH.to_owned(),
            audience: TARGET_CONTROLLER_AUDIENCE.to_owned(),
            private_bootstrap_path: matches!(
                authentication,
                TargetAuthentication::PrivateCapability
            )
            .then(|| TARGET_PRIVATE_BOOTSTRAP_PATH.to_owned()),
            oauth: None,
            login_session: None,
            extensions: TargetDiscoveryExtensions::default(),
        }
    }
}

/// Validates the canonical lower-case UUIDv7 spelling required at the target HTTP boundary.
#[must_use]
pub fn is_canonical_uuid_v7(run_id: &RunId) -> bool {
    let bytes = run_id.as_str().as_bytes();
    bytes.len() == 36
        && bytes.get(14) == Some(&b'7')
        && bytes
            .get(19)
            .is_some_and(|byte| matches!(byte, b'8' | b'9' | b'a' | b'b'))
        && bytes.iter().enumerate().all(|(index, byte)| {
            if matches!(index, 8 | 13 | 18 | 23) {
                *byte == b'-'
            } else {
                byte.is_ascii_digit() || matches!(byte, b'a'..=b'f')
            }
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uuid_v7_validation_is_canonical_and_versioned() {
        assert!(is_canonical_uuid_v7(&RunId::new(
            "018f5e78-7f95-7c22-8d98-3f15af20c991"
        )));
        for invalid in [
            "018f5e78-7f95-4c22-8d98-3f15af20c991",
            "018F5E78-7F95-7C22-8D98-3F15AF20C991",
            "run-018f5e78-7f95-7c22-8d98-3f15af20c991",
        ] {
            assert!(!is_canonical_uuid_v7(&RunId::new(invalid)));
        }
    }

    #[test]
    fn target_request_debug_redacts_ephemeral_values() {
        let request = serde_json::from_str::<TargetRunRequest>(include_str!(
            "../tests/fixtures/native-v2-target-request.json"
        ));
        assert!(request.is_ok());
        let Ok(request) = request else {
            return;
        };
        let debug = format!("{request:?}");
        assert!(!debug.contains("environment-secret"));
        assert!(!debug.contains("github-secret"));
        assert!(debug.contains("OPENAI_API_KEY"));
    }
}
