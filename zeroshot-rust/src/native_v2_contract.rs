//! Minimal, secret-free composition contracts for the native-v2 engine.
//!
//! `GraphSpec` remains the graph language. This module only binds executable graph leaves to one
//! graph-wide harness/provider lane and defines the neutral values exchanged by admission, the
//! reducer, the runner, and the run ledger. It deliberately contains no admission or execution
//! policy.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::num::NonZeroU64;

use openengine_cluster_protocol::{
    CompiledGraphIr, GraphSpec, IdempotencyKey, NodeName, RunId, WorkerOutcome, WorkerRef,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;

use crate::execution::SessionScope;
use crate::worker_catalog::{ModelId, ReasoningEffort};

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CodexProvider {
    #[serde(rename = "openai")]
    OpenAi,
    #[serde(rename = "openrouter")]
    OpenRouter,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ClaudeProvider {
    Anthropic,
    #[serde(rename = "openrouter")]
    OpenRouter,
}

/// One harness/provider lane for the entire graph.
///
/// The tagged variants make unsupported pairings unrepresentable without a second validation
/// table: Codex supports OpenAI/OpenRouter and Claude supports Anthropic/OpenRouter.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, tag = "harness", rename_all = "snake_case")]
pub enum RuntimePlan {
    Codex {
        provider: CodexProvider,
        nodes: BTreeMap<NodeName, NodeRuntimeBinding>,
    },
    Claude {
        provider: ClaudeProvider,
        nodes: BTreeMap<NodeName, NodeRuntimeBinding>,
    },
}

impl RuntimePlan {
    #[must_use]
    pub fn nodes(&self) -> &BTreeMap<NodeName, NodeRuntimeBinding> {
        match self {
            Self::Codex { nodes, .. } | Self::Claude { nodes, .. } => nodes,
        }
    }
}

/// Runtime configuration for an executable graph leaf.
///
/// Environment values are intentionally absent. The controller resolves only these declared
/// names immediately before invocation. Git delivery is graph-visible but is not an agent session.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, tag = "kind", rename_all = "snake_case")]
pub enum NodeRuntimeBinding {
    Agent {
        model: ModelId,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        effort: Option<ReasoningEffort>,
        #[serde(
            default,
            rename = "sessionScope",
            skip_serializing_if = "is_execution_scope"
        )]
        session_scope: SessionScope,
        #[serde(default, skip_serializing_if = "BTreeSet::is_empty")]
        env: BTreeSet<EnvironmentVariableName>,
    },
    GitDelivery {
        #[serde(default, skip_serializing_if = "BTreeSet::is_empty")]
        env: BTreeSet<EnvironmentVariableName>,
    },
}

fn is_execution_scope(scope: &SessionScope) -> bool {
    *scope == SessionScope::Execution
}

impl NodeRuntimeBinding {
    #[must_use]
    pub fn declared_environment(&self) -> &BTreeSet<EnvironmentVariableName> {
        match self {
            Self::Agent { env, .. } | Self::GitDelivery { env } => env,
        }
    }
}

#[derive(Clone, Debug, Eq, Error, PartialEq)]
pub enum EnvironmentVariableNameError {
    #[error("environment variable name must match [A-Za-z_][A-Za-z0-9_]*")]
    Invalid,
    #[error("environment variable name must be at most 128 bytes")]
    TooLong,
}

#[derive(Clone, Debug, Deserialize, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(try_from = "String")]
pub struct EnvironmentVariableName(String);

impl EnvironmentVariableName {
    pub fn new(value: impl Into<String>) -> Result<Self, EnvironmentVariableNameError> {
        let value = value.into();
        if value.len() > 128 {
            return Err(EnvironmentVariableNameError::TooLong);
        }
        let mut bytes = value.bytes();
        let valid_first = bytes
            .next()
            .is_some_and(|byte| byte.is_ascii_alphabetic() || byte == b'_');
        if !valid_first || !bytes.all(|byte| byte.is_ascii_alphanumeric() || byte == b'_') {
            return Err(EnvironmentVariableNameError::Invalid);
        }
        Ok(Self(value))
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl TryFrom<String> for EnvironmentVariableName {
    type Error = EnvironmentVariableNameError;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        Self::new(value)
    }
}

impl fmt::Display for EnvironmentVariableName {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

/// The immutable, secret-free request admitted by a selected target.
///
/// Target selection is transport/CLI routing and is therefore not duplicated in this payload.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RunSubmission {
    pub graph: GraphSpec,
    pub initial_input: Value,
    pub runtime: RuntimePlan,
    #[serde(default)]
    pub ship: bool,
    pub submission_key: IdempotencyKey,
}

/// Admission's secret-free output. The compiler promotes the unchanged `GraphSpec` to the existing
/// verified `CompiledGraphIr`; later stages never execute raw graph syntax.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct AdmittedRun {
    pub graph: CompiledGraphIr,
    pub initial_input: Value,
    pub runtime: RuntimePlan,
    pub ship: bool,
}

#[derive(Clone, Copy, Debug, Eq, Error, PartialEq)]
#[error("identity must be greater than zero")]
pub struct IdentityError;

macro_rules! identity_type {
    ($name:ident) => {
        #[derive(
            Clone, Copy, Debug, Deserialize, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize,
        )]
        #[serde(try_from = "u64")]
        pub struct $name(NonZeroU64);

        impl $name {
            pub fn new(value: u64) -> Result<Self, IdentityError> {
                NonZeroU64::new(value).map(Self).ok_or(IdentityError)
            }

            #[must_use]
            pub const fn get(self) -> u64 {
                self.0.get()
            }
        }

        impl TryFrom<u64> for $name {
            type Error = IdentityError;

            fn try_from(value: u64) -> Result<Self, Self::Error> {
                Self::new(value)
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                self.0.fmt(formatter)
            }
        }
    };
}

identity_type!(NodeInstanceId);
identity_type!(ExecutionId);

/// Stable address for one dispatch. A node instance survives loop revisits; an execution does not.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ExecutionRef {
    pub run_id: RunId,
    pub node: NodeName,
    pub node_instance: NodeInstanceId,
    pub execution: ExecutionId,
}

/// Secret-free runner request produced by the reducer/supervisor boundary.
///
/// Workspace access and resolved environment values are runtime capabilities and do not belong in
/// this durable value.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct NodeInvocation {
    pub reference: ExecutionRef,
    pub worker: WorkerRef,
    pub input: Value,
    pub binding: NodeRuntimeBinding,
}

/// Normalized completion returned to the supervisor and safe to append to the run ledger.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct NodeCompletion {
    pub reference: ExecutionRef,
    pub outcome: WorkerOutcome,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    fn canonical_submission() -> Value {
        json!({
            "graph": {
                "profile": "openengine.graph.full/v1",
                "initialInput": { "kind": "null" },
                "policy": { "policy": "policy.native-v2@1", "default": "deny" },
                "root": {
                    "kind": "seq",
                    "name": "run",
                    "state": { "kind": "null" },
                    "children": [
                        {
                            "kind": "step",
                            "name": "worker",
                            "worker": "agent.worker@1",
                            "input": { "kind": "null" },
                            "output": { "kind": "null" },
                            "inputBindings": [],
                            "writeBindings": [],
                            "timeoutMs": 60000,
                            "attempts": 1
                        },
                        {
                            "kind": "succeed",
                            "name": "done",
                            "output": { "kind": "null" },
                            "bindings": []
                        }
                    ],
                    "promotedStatePaths": []
                }
            },
            "initialInput": null,
            "runtime": {
                "harness": "codex",
                "provider": "openai",
                "nodes": {
                    "worker": {
                        "kind": "agent",
                        "model": "gpt-5.6",
                        "effort": "max",
                        "env": ["GH_TOKEN", "OPENAI_API_KEY"]
                    }
                }
            },
            "ship": false,
            "submissionKey": "submission-1"
        })
    }

    #[test]
    fn canonical_submission_round_trips_without_changing_graph_spec() {
        let expected = canonical_submission();
        let submission: RunSubmission =
            serde_json::from_value(expected.clone()).expect("canonical fixture must decode");

        let NodeRuntimeBinding::Agent { session_scope, .. } = submission
            .runtime
            .nodes()
            .get(&NodeName::new("worker").unwrap())
            .unwrap()
        else {
            panic!("worker must be an agent binding");
        };
        assert_eq!(*session_scope, SessionScope::Execution);
        assert_eq!(serde_json::to_value(submission).unwrap(), expected);
    }

    #[test]
    fn unsupported_harness_provider_pair_is_rejected_by_shape() {
        let mut fixture = canonical_submission();
        fixture["runtime"]["provider"] = json!("anthropic");

        assert!(serde_json::from_value::<RunSubmission>(fixture).is_err());
    }

    #[test]
    fn claude_openrouter_lane_round_trips() {
        let mut expected = canonical_submission();
        expected["runtime"]["harness"] = json!("claude");
        expected["runtime"]["provider"] = json!("openrouter");
        expected["runtime"]["nodes"]["worker"]["model"] = json!("claude-sonnet-5");

        let submission: RunSubmission = serde_json::from_value(expected.clone()).unwrap();
        assert_eq!(serde_json::to_value(submission).unwrap(), expected);
    }

    #[test]
    fn environment_values_and_graph_runtime_fields_are_rejected() {
        let mut secret_fixture = canonical_submission();
        secret_fixture["runtime"]["nodes"]["worker"]["env"] = json!({ "OPENAI_API_KEY": "secret" });
        assert!(serde_json::from_value::<RunSubmission>(secret_fixture).is_err());

        let mut graph_fixture = canonical_submission();
        graph_fixture["graph"]["root"]["children"][0]["model"] = json!("gpt-5.6");
        assert!(serde_json::from_value::<RunSubmission>(graph_fixture).is_err());
    }

    #[test]
    fn environment_names_and_execution_identities_are_bounded() {
        assert!(EnvironmentVariableName::new("GH_TOKEN").is_ok());
        assert!(EnvironmentVariableName::new("GH-TOKEN").is_err());
        assert!(EnvironmentVariableName::new("1TOKEN").is_err());
        assert!(NodeInstanceId::new(0).is_err());
        assert!(ExecutionId::new(0).is_err());
        assert_eq!(ExecutionId::new(7).unwrap().get(), 7);
    }
}
