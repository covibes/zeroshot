use std::collections::BTreeMap;

use openengine_cluster_protocol::{
    EnumLabel, FieldName, NodeName, NodeRuntimeBinding, PositiveInteger, ReasoningEffort, RunSize,
    RuntimePlan, SessionScope, SourceBranchId, SourceRepositoryId, SourceRevisionId,
    SourceSnapshot, WorkerOutcome,
};
use openengine_cluster_server::graph_verifier::graph_node_children;
use openengine_cluster_testkit::assertions::AssertValue;
use serde_json::json;

use crate::full_v1_reducer::{
    DurableExecution, DurableExecutionState, ExecutionId, HistoryPosition, NodeInstanceId,
    StructuralOccurrence,
};
use crate::native_v2_contract::{CodexProvider, DeclaredEnvironment, ModelId};

use super::super::*;

pub(super) fn executable_leaves(root: &GraphNode) -> Vec<&GraphNode> {
    let mut leaves = Vec::new();
    let mut pending = vec![root];
    while let Some(node) = pending.pop() {
        if matches!(node, GraphNode::Step(_) | GraphNode::Verifier(_)) {
            leaves.push(node);
        } else {
            pending.extend(graph_node_children(node));
        }
    }
    leaves
}

pub(super) fn assert_instruction_ownership(leaves: &[&GraphNode]) {
    for node in leaves {
        match node {
            GraphNode::Step(step) => assert!(step.instructions.is_some()),
            GraphNode::Verifier(verifier) if verifier.name.as_str() == DELIVERY_NODE => {
                assert!(verifier.instructions.is_none());
            }
            GraphNode::Verifier(verifier) => assert!(verifier.instructions.is_some()),
            _ => assert!(
                matches!(node, GraphNode::Step(_) | GraphNode::Verifier(_)),
                "executable leaf helper returned a control node"
            ),
        }
    }
}

pub(super) fn runtime_for(
    template: BuiltinGraphTemplate,
    delivery: TemplateDelivery,
    leaves: &[&GraphNode],
) -> RuntimePlan {
    let mut nodes = leaves
        .iter()
        .filter(|node| node.name().as_str() != DELIVERY_NODE)
        .map(|node| (node.name().clone(), agent_binding()))
        .collect::<BTreeMap<_, _>>();
    if let Some((name, binding)) = template.delivery_runtime_binding(delivery).assert_value() {
        nodes.insert(name, binding);
    }
    RuntimePlan::Codex {
        provider: CodexProvider::OpenAi,
        size: RunSize::Standard,
        nodes,
    }
}

fn agent_binding() -> NodeRuntimeBinding {
    NodeRuntimeBinding::Agent {
        model: ModelId::new("gpt-5.6").assert_value(),
        effort: Some(ReasoningEffort::Max),
        session_scope: SessionScope::Execution,
        env: DeclaredEnvironment::empty(),
    }
}

pub(super) fn source_snapshot() -> SourceSnapshot {
    SourceSnapshot {
        repository: SourceRepositoryId::new("acme/project").assert_value(),
        target_branch: SourceBranchId::new("main").assert_value(),
        base_revision: SourceRevisionId::new("a".repeat(40)).assert_value(),
    }
}

pub(super) fn accepted_review_history() -> Vec<DurableExecution> {
    vec![
        settled_worker(),
        settled_review(2, "acceptance", ACCEPTED_LABEL, "requirements met"),
        settled_review(3, "code", ACCEPTED_LABEL, "implementation sound"),
    ]
}

pub(super) fn settled_worker() -> DurableExecution {
    settled_agent(SettledExecutionSpec {
        execution: 1,
        node_instance: 1,
        node: "worker",
        settled_at: 1,
        input: json!({"task":"repair checkout"}),
    })
}

pub(super) fn settled_agent(spec: SettledExecutionSpec<'_>) -> DurableExecution {
    settled_execution(
        spec,
        WorkerOutcome::Verified {
            output: serde_json::Value::Null,
            artifacts: Vec::new(),
        },
    )
}

pub(super) fn settled_review(
    execution: u64,
    node: &str,
    verdict: &str,
    diagnostic: &str,
) -> DurableExecution {
    settled_review_execution(
        SettledExecutionSpec {
            execution,
            node_instance: execution,
            node,
            settled_at: execution,
            input: json!({"task":"repair checkout","deliveryFeedback":""}),
        },
        verdict,
        diagnostic,
    )
}

pub(super) fn settled_review_execution(
    spec: SettledExecutionSpec<'_>,
    verdict: &str,
    diagnostic: &str,
) -> DurableExecution {
    settled_execution(
        spec,
        WorkerOutcome::Verifier {
            output: serde_json::Value::Null,
            signals: BTreeMap::from([(
                FieldName::new(VERDICT_FIELD).assert_value(),
                EnumLabel::new(verdict).assert_value(),
            )]),
            diagnostic: json!({DIAGNOSTIC_MESSAGE_FIELD:diagnostic}),
            artifacts: Vec::new(),
        },
    )
}

pub(super) fn settled_delivery(
    spec: SettledExecutionSpec<'_>,
    mode: DeliveryMode,
    outcome: &str,
) -> DurableExecution {
    settled_delivery_with_diagnostic(spec, mode, outcome, "delivery outcome")
}

pub(super) fn settled_delivery_with_diagnostic(
    spec: SettledExecutionSpec<'_>,
    mode: DeliveryMode,
    outcome: &str,
    diagnostic: &str,
) -> DurableExecution {
    settled_execution(
        spec,
        WorkerOutcome::Verifier {
            output: delivery_receipt(mode, outcome),
            signals: BTreeMap::from([(
                FieldName::new(DELIVERY_SIGNAL_FIELD).assert_value(),
                EnumLabel::new(outcome).assert_value(),
            )]),
            diagnostic: json!({DIAGNOSTIC_MESSAGE_FIELD:diagnostic}),
            artifacts: Vec::new(),
        },
    )
}

pub(super) fn delivery_receipt(mode: DeliveryMode, outcome: &str) -> serde_json::Value {
    let mode = match mode {
        DeliveryMode::PullRequest => "pr",
        DeliveryMode::Merge => "merge",
    };
    json!({
        "version":"v1",
        "mode":mode,
        "outcome":outcome,
        "repository":"acme/project",
        "targetBranch":"main",
        "headRevision":"b".repeat(40),
        "pullRequestId":"17"
    })
}

pub(super) struct SettledExecutionSpec<'a> {
    pub(super) execution: u64,
    pub(super) node_instance: u64,
    pub(super) node: &'a str,
    pub(super) settled_at: u64,
    pub(super) input: serde_json::Value,
}

fn settled_execution(spec: SettledExecutionSpec<'_>, outcome: WorkerOutcome) -> DurableExecution {
    let dispatch_position = HistoryPosition::new(spec.settled_at.saturating_sub(1)).assert_value();
    let node_instance = NodeInstanceId::new(spec.node_instance).assert_value();
    let execution = ExecutionId::new(spec.execution).assert_value();
    let occurrence = StructuralOccurrence {
        node: NodeName::new(spec.node).assert_value(),
        map_indices: Vec::new(),
    };
    let state = DurableExecutionState::Settled {
        position: HistoryPosition::new(spec.settled_at).assert_value(),
        outcome,
    };
    DurableExecution {
        dispatch_position,
        node_instance,
        execution,
        occurrence,
        attempt: PositiveInteger::new(1).assert_value(),
        input: spec.input,
        state,
    }
}
