//! Native-v2 target HTTP boundary shared by the CLI, target server, and hosting authority.
//!
//! These values are deliberately separate from OECP JSON-RPC methods. HTTP submission is the
//! only run-creation seam; OECP begins after a target has accepted the exact immutable run.

use std::collections::BTreeMap;
use std::fmt;

use serde::{Deserialize, Serialize};

use crate::{
    ConnectionKey, EnvironmentVariableName, NativeV2RunValueError, RunId, RunSubmission,
    MAX_DECLARED_ENVIRONMENT_NAMES,
};

pub const TARGET_DISCOVERY_PATH: &str = "/.well-known/zeroshot-native-v2";
pub const TARGET_RUN_PATH: &str = "/native-v2/run";
pub const TARGET_SESSION_PATH: &str = "/native-v2/oecp-session";
pub const TARGET_OECP_PATH: &str = "/native-v2/oecp";
pub const TARGET_PRIVATE_BOOTSTRAP_PATH: &str = "/native-v2/private-bootstrap";
pub const TARGET_DISCOVERY_KIND: &str = "zeroshot.native-v2-target/v2";
pub const TARGET_CONTROLLER_AUDIENCE: &str = "controller";
pub const HOSTED_RUNS_KIND: &str = "zeroshot.hosted-runs/v1";
pub const CONNECTIONS_KIND: &str = "zeroshot.connections/v1";
pub const STATIC_CONNECTION_KIND: &str = "static";
/// A GitHub App installation whose repository-scoped token is minted by the hosted target.
pub const GITHUB_APP_INSTALLATION_CONNECTION_KIND: &str = "github-app-installation";

const MAX_CONNECTION_VALUE_BYTES: usize = 64 * 1024;
const MAX_CONNECTION_BYTES: usize = 256 * 1024;

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ConnectionScope {
    User,
    Org,
}

/// Bounded static credential fields. Debug output exposes field names, never secret values.
#[derive(Clone, Eq, PartialEq, Serialize)]
#[serde(transparent)]
pub struct StaticConnectionValues(BTreeMap<EnvironmentVariableName, String>);

impl StaticConnectionValues {
    pub fn new(
        values: BTreeMap<EnvironmentVariableName, String>,
    ) -> Result<Self, NativeV2RunValueError> {
        if values.is_empty() || values.len() > MAX_DECLARED_ENVIRONMENT_NAMES {
            return Err(NativeV2RunValueError(
                "static connection must contain 1..=64 fields",
            ));
        }
        let mut total = 0_usize;
        for (name, value) in &values {
            if value.is_empty() || value.contains('\0') || value.len() > MAX_CONNECTION_VALUE_BYTES
            {
                return Err(NativeV2RunValueError(
                    "static connection values must be non-empty, NUL-free, and at most 64 KiB",
                ));
            }
            total = total
                .checked_add(name.as_str().len())
                .and_then(|size| size.checked_add(value.len()))
                .ok_or(NativeV2RunValueError(
                    "static connection exceeds the aggregate size bound",
                ))?;
        }
        if total > MAX_CONNECTION_BYTES {
            return Err(NativeV2RunValueError(
                "static connection exceeds the aggregate size bound",
            ));
        }
        Ok(Self(values))
    }

    #[must_use]
    pub const fn as_map(&self) -> &BTreeMap<EnvironmentVariableName, String> {
        &self.0
    }

    #[must_use]
    pub fn field_names(&self) -> Vec<EnvironmentVariableName> {
        self.0.keys().cloned().collect()
    }
}

impl<'de> Deserialize<'de> for StaticConnectionValues {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        Self::new(BTreeMap::<EnvironmentVariableName, String>::deserialize(
            deserializer,
        )?)
        .map_err(serde::de::Error::custom)
    }
}

impl fmt::Debug for StaticConnectionValues {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("StaticConnectionValues")
            .field("fields", &self.0.keys().collect::<Vec<_>>())
            .field("values", &"[REDACTED]")
            .finish()
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ConnectionSetRequest {
    pub key: ConnectionKey,
    pub scope: ConnectionScope,
    pub values: StaticConnectionValues,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ConnectionDeleteRequest {
    pub key: ConnectionKey,
    pub scope: ConnectionScope,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ConnectionListRequest {
    pub scope: ConnectionScope,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ConnectionSummary {
    pub key: ConnectionKey,
    pub scope: ConnectionScope,
    pub kind: String,
    pub fields: Vec<EnvironmentVariableName>,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ConnectionListResult {
    pub connections: Vec<ConnectionSummary>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ConnectionMutationResult {
    pub connection: ConnectionSummary,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ConnectionDeleteResult {
    pub deleted: bool,
}

/// Ephemeral, keyed connection snapshots supplied with one run.
///
/// Each included key carries only fields declared for that key by the runtime. A hosted target may
/// receive a partial map and resolve omitted keys from its user and organization stores. A direct
/// target requires an exact map before dispatch. Keeping values keyed until node start allows two
/// different connections to use the same environment name on different nodes without conflation.
pub type RunConnectionValues = BTreeMap<ConnectionKey, StaticConnectionValues>;

/// Exact fields requested from dynamic connections at one resolution point.
pub type RunConnectionRequirements = BTreeMap<ConnectionKey, Vec<EnvironmentVariableName>>;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ConnectionResolveRequest {
    pub run_id: RunId,
    pub connections: RunConnectionRequirements,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ConnectionResolveResult {
    pub connections: RunConnectionValues,
}

/// Run-scoped callback authority for dynamic connection keys.
#[derive(Clone, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct TargetConnectionResolver {
    pub endpoint: String,
    pub bearer_token: String,
    pub keys: Vec<ConnectionKey>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_connection: Option<ConnectionKey>,
}

impl fmt::Debug for TargetConnectionResolver {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("TargetConnectionResolver")
            .field("endpoint", &self.endpoint)
            .field("bearer_token", &"[REDACTED]")
            .field("keys", &self.keys)
            .field("source_connection", &self.source_connection)
            .finish()
    }
}

/// One run envelope. Explicit secret values are ephemeral and excluded from submission identity.
#[derive(Clone, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct TargetRunRequest {
    pub run_id: RunId,
    pub submission: RunSubmission,
    pub connections: RunConnectionValues,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connection_resolver: Option<TargetConnectionResolver>,
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
                "connections",
                &self
                    .connections
                    .iter()
                    .map(|(key, values)| (key, values.field_names()))
                    .collect::<BTreeMap<_, _>>(),
            )
            .field("connection_values", &"[REDACTED]")
            .field("connection_resolver", &self.connection_resolver)
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

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct TargetConnectionRoutes {
    pub list: String,
    pub set: String,
    pub delete: String,
    pub resolve: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct TargetConnectionsDiscovery {
    pub kind: String,
    pub base_url: String,
    pub route_templates: TargetConnectionRoutes,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub dynamic_kinds: Vec<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(default, rename_all = "snake_case")]
pub struct TargetDiscoveryExtensions {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hosted_runs: Option<TargetHostedRunsDiscovery>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub connections: Option<TargetConnectionsDiscovery>,
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
        self.hosted_runs.is_none() && self.connections.is_none()
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
    use openengine_cluster_testkit::assertions::AssertValue;

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
        assert!(!debug.contains("resolver-secret"));
        assert!(debug.contains("OPENAI_API_KEY"));
    }

    #[test]
    fn static_connection_debug_redacts_values_and_validates_shape() {
        let values = StaticConnectionValues::new(BTreeMap::from([(
            EnvironmentVariableName::new("TOKEN").assert_value(),
            "secret-value".to_owned(),
        )]))
        .assert_value();
        let debug = format!("{values:?}");
        assert!(debug.contains("TOKEN"));
        assert!(!debug.contains("secret-value"));
        assert!(StaticConnectionValues::new(BTreeMap::new()).is_err());
    }
}
