use std::collections::{BTreeMap, BTreeSet};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{
    ConnectionKey, EnvironmentVariableName, GraphSpec, IdempotencyKey, NodeName, RunId,
    RunStatusResult,
};

use super::{ClaudeProvider, CodexProvider, NodeRuntimeBinding, RunSize, ResolvedSource};

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields, tag = "harness", rename_all = "snake_case")]
pub enum RuntimePlan {
    Codex {
        provider: CodexProvider,
        size: RunSize,
        nodes: BTreeMap<NodeName, NodeRuntimeBinding>,
    },
    Claude {
        provider: ClaudeProvider,
        size: RunSize,
        nodes: BTreeMap<NodeName, NodeRuntimeBinding>,
    },
}

impl RuntimePlan {
    #[must_use]
    pub const fn size(&self) -> RunSize {
        match self {
            Self::Codex { size, .. } | Self::Claude { size, .. } => *size,
        }
    }

    #[must_use]
    pub const fn nodes(&self) -> &BTreeMap<NodeName, NodeRuntimeBinding> {
        match self {
            Self::Codex { nodes, .. } | Self::Claude { nodes, .. } => nodes,
        }
    }

    /// Union of the fields required from each connection key across all executable nodes.
    #[must_use]
    pub fn connection_requirements(
        &self,
    ) -> BTreeMap<ConnectionKey, BTreeSet<EnvironmentVariableName>> {
        let mut requirements = BTreeMap::<ConnectionKey, BTreeSet<EnvironmentVariableName>>::new();
        for binding in self.nodes().values() {
            for (key, fields) in binding.declared_connections().iter() {
                requirements
                    .entry(key.clone())
                    .or_default()
                    .extend(fields.iter().cloned());
            }
        }
        requirements
    }
}

/// Immutable, secret-free native-v2 submission admitted by the selected target.
#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RunSubmission {
    pub title: super::RunTitle,
    pub graph: GraphSpec,
    pub initial_input: Value,
    pub runtime: RuntimePlan,
    pub source: ResolvedSource,
    pub submission_key: IdempotencyKey,
}

/// Trusted controller bootstrap admission. The host assigns the only public run identity before
/// controller start; the immutable submission remains identity-neutral.
#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RunSubmitParams {
    pub run_id: RunId,
    pub submission: RunSubmission,
}

/// A successful submission returns the one public identity used by every later run method.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RunSubmitResult {
    pub run_id: RunId,
}

/// The MVP inventory has no filters or pagination controls.
#[derive(Clone, Debug, Default, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RunListParams {}

/// Current durable projections for every retained run.
#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RunListResult {
    pub runs: Vec<RunStatusResult>,
}
