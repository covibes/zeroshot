//! Reusable native-v2 graph/runtime profile wire contract.

use std::fmt;

use serde::{Deserialize, Serialize};

use crate::{
    GraphSpec, IdempotencyKey, ResolvedSource, RunConnectionValues, RunId, RunProfileName,
    RunTitle, RuntimePlan,
};

pub const RUN_PROFILES_KIND: &str = "zeroshot.run-profiles/v1";

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RunProfileScope {
    User,
    Org,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RunProfile {
    pub id: String,
    pub name: RunProfileName,
    pub scope: RunProfileScope,
    pub graph: GraphSpec,
    pub runtime: RuntimePlan,
    pub is_default: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RunProfileSummary {
    pub id: String,
    pub name: RunProfileName,
    pub scope: RunProfileScope,
    pub is_default: bool,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RunProfileSetRequest {
    pub name: RunProfileName,
    pub scope: RunProfileScope,
    pub graph: GraphSpec,
    pub runtime: RuntimePlan,
    #[serde(default)]
    pub set_default: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RunProfileListRequest {
    pub scope: RunProfileScope,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RunProfileSelector {
    pub scope: RunProfileScope,
    pub name: RunProfileName,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RunProfileDefaultRequest {
    pub scope: RunProfileScope,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<RunProfileName>,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RunProfileListResult {
    pub profiles: Vec<RunProfileSummary>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RunProfileMutationResult {
    pub profile: RunProfile,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RunProfileDeleteResult {
    pub deleted: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RunProfileDefaultResult {
    pub scope: RunProfileScope,
    pub name: Option<RunProfileName>,
}

/// One hosted run whose graph/runtime are resolved atomically from a remote profile.
#[derive(Clone, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RunProfileRunRequest {
    pub run_id: RunId,
    pub profile: RunProfileSelector,
    pub title: RunTitle,
    pub initial_input: serde_json::Value,
    pub source: ResolvedSource,
    pub submission_key: IdempotencyKey,
    pub connections: RunConnectionValues,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub github_token: Option<String>,
}

impl fmt::Debug for RunProfileRunRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("RunProfileRunRequest")
            .field("run_id", &self.run_id)
            .field("profile", &self.profile)
            .field("title", &self.title)
            .field("initial_input", &self.initial_input)
            .field("source", &self.source)
            .field("submission_key", &self.submission_key)
            .field("connections", &self.connections.keys().collect::<Vec<_>>())
            .field("secrets", &"[REDACTED]")
            .finish()
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct TargetRunProfileRoutes {
    pub list: String,
    pub show: String,
    pub set: String,
    pub delete: String,
    pub default: String,
    pub run: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct TargetRunProfilesDiscovery {
    pub kind: String,
    pub base_url: String,
    pub route_templates: TargetRunProfileRoutes,
}
