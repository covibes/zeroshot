//! Minimal, secret-free composition contracts for the native-v2 engine.
//!
//! `GraphSpec` remains the graph language. This module only binds executable graph leaves to one
//! graph-wide harness/provider lane and defines the neutral values exchanged by admission, the
//! reducer, the runner, and the run ledger. It deliberately contains no admission or execution
//! policy.

use std::fmt;
use std::marker::PhantomData;
use std::num::NonZeroU64;

use openengine_cluster_protocol::{
    CompiledGraphIr, GraphSpec, IdempotencyKey, NodeName, RunId, WorkerOutcome, WorkerRef,
};
pub use openengine_cluster_protocol::{
    ClaudeProvider, CodexProvider, DeclaredEnvironment, EnvironmentVariableName, ModelId,
    NodeRuntimeBinding, ReasoningEffort, RunSize, RunSubmission, RunTitle, RuntimePlan,
    SessionScope, SourceBranchId, SourceRepositoryId, SourceRevisionId, SourceSnapshot,
    MAX_DECLARED_ENVIRONMENT_NAMES,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;

/// Graph-visible PR delivery worker backed by the shared Git delivery implementation.
pub const GIT_DELIVERY_PR_WORKER_REF: &str = "builtin.git-delivery.pr@1";
/// Graph-visible merge delivery worker backed by the shared Git delivery implementation.
pub const GIT_DELIVERY_MERGE_WORKER_REF: &str = "builtin.git-delivery.merge@1";

/// Source- and identity-neutral request used before a host snapshots mutable source selection.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RunSubmissionIntent {
    pub title: RunTitle,
    pub graph: GraphSpec,
    pub initial_input: Value,
    pub runtime: RuntimePlan,
    pub submission_key: IdempotencyKey,
}

impl From<&RunSubmission> for RunSubmissionIntent {
    fn from(submission: &RunSubmission) -> Self {
        Self {
            title: submission.title.clone(),
            graph: submission.graph.clone(),
            initial_input: submission.initial_input.clone(),
            runtime: submission.runtime.clone(),
            submission_key: submission.submission_key.clone(),
        }
    }
}

/// Admission's secret-free output. The compiler promotes the unchanged `GraphSpec` to the existing
/// verified `CompiledGraphIr`; later stages never execute raw graph syntax.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct AdmittedRun {
    pub title: RunTitle,
    pub graph: CompiledGraphIr,
    pub initial_input: Value,
    pub runtime: RuntimePlan,
    pub source: SourceSnapshot,
}

#[derive(Clone, Copy, Debug, Eq, Error, PartialEq)]
#[error("identity must be greater than zero")]
pub struct IdentityError;

/// Positive numeric identity whose marker keeps distinct identity domains type-safe.
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct PositiveIdentity<Tag> {
    value: NonZeroU64,
    marker: PhantomData<fn() -> Tag>,
}

impl<Tag> PositiveIdentity<Tag> {
    pub fn new(value: u64) -> Result<Self, IdentityError> {
        let value = NonZeroU64::new(value).ok_or(IdentityError)?;
        Ok(Self {
            value,
            marker: PhantomData,
        })
    }

    #[must_use]
    pub const fn get(self) -> u64 {
        self.value.get()
    }
}

impl<Tag> TryFrom<u64> for PositiveIdentity<Tag> {
    type Error = IdentityError;

    fn try_from(value: u64) -> Result<Self, Self::Error> {
        Self::new(value)
    }
}

impl<Tag> fmt::Display for PositiveIdentity<Tag> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.value.fmt(formatter)
    }
}

impl<Tag> Serialize for PositiveIdentity<Tag> {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_u64(self.value.get())
    }
}

impl<'de, Tag> Deserialize<'de> for PositiveIdentity<Tag> {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let value = u64::deserialize(deserializer)?;
        Self::new(value).map_err(serde::de::Error::custom)
    }
}

#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub enum NodeInstanceIdentity {}

#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub enum ExecutionIdentity {}

pub type NodeInstanceId = PositiveIdentity<NodeInstanceIdentity>;
pub type ExecutionId = PositiveIdentity<ExecutionIdentity>;

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
    use openengine_cluster_testkit::assertions::AssertValue;
    use super::*;
    use serde_json::{json, Value};

    fn canonical_submission() -> Value {
        json!({
            "title": "Repair checkout flow",
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
                "size": "standard",
                "nodes": {
                    "worker": {
                        "kind": "agent",
                        "model": "gpt-5.6",
                        "effort": "max",
                        "env": ["GH_TOKEN", "OPENAI_API_KEY"]
                    }
                }
            },
            "source": {
                "repository": "open-engine/zeroshot",
                "targetBranch": "main",
                "baseRevision": "0123456789abcdef0123456789abcdef01234567"
            },
            "submissionKey": "submission-1"
        })
    }

    #[test]
    fn canonical_submission_round_trips_without_changing_graph_spec() {
        let expected = canonical_submission();
        let submission: RunSubmission = serde_json::from_value(expected.clone())
            .assert_value_with("canonical fixture must decode");

        let session_scope = submission
            .runtime
            .nodes()
            .get(&NodeName::new("worker").assert_value())
            .and_then(|binding| match binding {
                NodeRuntimeBinding::Agent { session_scope, .. } => Some(session_scope),
                NodeRuntimeBinding::GitDelivery { .. } => None,
            })
            .assert_value_with("worker must be an agent binding");
        assert_eq!(*session_scope, SessionScope::Execution);
        assert_eq!(serde_json::to_value(submission).assert_value(), expected);
    }

    #[test]
    fn submission_serialization_is_idempotent() {
        let submission: RunSubmission =
            serde_json::from_value(canonical_submission()).assert_value();
        let first = serde_json::to_vec(&submission).assert_value();
        let decoded: RunSubmission = serde_json::from_slice(&first).assert_value();
        let second = serde_json::to_vec(&decoded).assert_value();

        assert_eq!(first, second);
        assert_eq!(decoded, submission);
    }

    #[test]
    fn unsupported_harness_provider_pair_is_rejected_by_shape() {
        let mut fixture = canonical_submission();
        *fixture
            .pointer_mut("/runtime/provider")
            .assert_value_with("runtime provider exists") = json!("anthropic");

        assert!(serde_json::from_value::<RunSubmission>(fixture).is_err());
    }

    #[test]
    fn claude_openrouter_lane_round_trips() {
        let mut expected = canonical_submission();
        *expected.pointer_mut("/runtime/harness").assert_value() = json!("claude");
        *expected.pointer_mut("/runtime/provider").assert_value() = json!("openrouter");
        *expected
            .pointer_mut("/runtime/nodes/worker/model")
            .assert_value() = json!("claude-sonnet-5");

        let submission: RunSubmission = serde_json::from_value(expected.clone()).assert_value();
        assert_eq!(serde_json::to_value(submission).assert_value(), expected);
    }

    #[test]
    fn environment_values_and_graph_runtime_fields_are_rejected() {
        let mut secret_fixture = canonical_submission();
        *secret_fixture
            .pointer_mut("/runtime/nodes/worker/env")
            .assert_value() = json!({ "OPENAI_API_KEY": "secret" });
        assert!(serde_json::from_value::<RunSubmission>(secret_fixture).is_err());

        let mut graph_fixture = canonical_submission();
        graph_fixture
            .pointer_mut("/graph/root/children/0")
            .assert_value()
            .as_object_mut()
            .assert_value()
            .insert("model".to_owned(), json!("gpt-5.6"));
        assert!(serde_json::from_value::<RunSubmission>(graph_fixture).is_err());
    }

    #[test]
    fn title_source_and_one_run_size_are_required_and_bounded() {
        for (pointer, owner_pointer, field) in [
            ("/title", "", "title"),
            ("/source", "", "source"),
            ("/runtime/size", "/runtime", "size"),
        ] {
            let mut missing = canonical_submission();
            missing
                .pointer_mut(owner_pointer)
                .assert_value()
                .as_object_mut()
                .assert_value()
                .remove(field);
            assert!(
                serde_json::from_value::<RunSubmission>(missing).is_err(),
                "{pointer} must be required"
            );
        }

        let mut invalid_title = canonical_submission();
        *invalid_title.pointer_mut("/title").assert_value() = json!("");
        assert!(serde_json::from_value::<RunSubmission>(invalid_title).is_err());

        let mut invalid_size = canonical_submission();
        *invalid_size.pointer_mut("/runtime/size").assert_value() = json!("xlarge");
        assert!(serde_json::from_value::<RunSubmission>(invalid_size).is_err());

        for (pointer, value) in [
            ("/source/repository", json!("not-a-repository")),
            ("/source/targetBranch", json!("bad..branch")),
            ("/source/baseRevision", json!("not-an-exact-revision")),
        ] {
            let mut invalid_source = canonical_submission();
            *invalid_source.pointer_mut(pointer).assert_value() = value;
            assert!(
                serde_json::from_value::<RunSubmission>(invalid_source).is_err(),
                "{pointer} must be validated"
            );
        }
    }

    #[test]
    fn declared_environment_rejects_duplicates_and_per_node_overflow() {
        let mut duplicate = canonical_submission();
        *duplicate
            .pointer_mut("/runtime/nodes/worker/env")
            .assert_value() = json!(["OPENAI_API_KEY", "OPENAI_API_KEY"]);
        assert!(serde_json::from_value::<RunSubmission>(duplicate).is_err());

        let mut overflow = canonical_submission();
        *overflow
            .pointer_mut("/runtime/nodes/worker/env")
            .assert_value() = Value::Array(
            (0..=MAX_DECLARED_ENVIRONMENT_NAMES)
                .map(|index| json!(format!("ENV_{index}")))
                .collect(),
        );
        assert!(serde_json::from_value::<RunSubmission>(overflow).is_err());
    }

    #[test]
    fn environment_names_and_execution_identities_are_bounded() {
        assert!(EnvironmentVariableName::new("GH_TOKEN").is_ok());
        assert!(EnvironmentVariableName::new("GH-TOKEN").is_err());
        assert!(EnvironmentVariableName::new("1TOKEN").is_err());
        assert!(NodeInstanceId::new(0).is_err());
        assert!(ExecutionId::new(0).is_err());
        assert_eq!(ExecutionId::new(7).assert_value().get(), 7);
    }
}
