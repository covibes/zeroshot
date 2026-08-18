use std::collections::BTreeMap;

use openengine_cluster_protocol::{
    CodexProvider, DeclaredEnvironment, EnumLabel, FieldName, IdempotencyKey, NodeName,
    PositiveInteger, RunId, RunSize, RunTitle, SessionScope, SourceBranchId, SourceRepositoryId,
    SourceRevisionId, SourceSnapshot, TerminalResult, WorkerOutcome,
};
use serde_json::{Value, json};

use super::super::enforce_delivery_terminal;
use crate::full_v1_reducer::StructuralOccurrence;
use crate::native_v2_admission::{DeliveryPolicy, NativeV2Admission};
use crate::native_v2_candidate::test_support::{full_graph, git_delivery_node, success_node};
use crate::native_v2_contract::{
    AdmittedRun, ExecutionId, ExecutionRef, NodeInstanceId, NodeRuntimeBinding, ReasoningEffort,
    RunSubmission, RuntimePlan,
};
use crate::native_v2_delivery::{DELIVERY_MERGED_LABEL, DELIVERY_SIGNAL_FIELD};
use crate::v2_run_ledger::{NodeSnapshot, NodeState, RunPhase, RunSnapshot, cursor_for};
use openengine_cluster_testkit::assertions::AssertValue;

fn agent_binding() -> NodeRuntimeBinding {
    NodeRuntimeBinding::Agent {
        model: crate::worker_catalog::ModelId::new("gpt-5.6-sol").assert_value(),
        effort: Some(ReasoningEffort::Max),
        session_scope: SessionScope::Execution,
        env: DeclaredEnvironment::empty(),
    }
}

fn source() -> SourceSnapshot {
    SourceSnapshot {
        repository: SourceRepositoryId::new("acme/project").assert_value(),
        target_branch: SourceBranchId::new("main").assert_value(),
        base_revision: SourceRevisionId::new("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
            .assert_value(),
    }
}

async fn admitted_with_delivery() -> AdmittedRun {
    let graph = full_graph(vec![
        json!({
            "kind":"step","name":"worker","worker":"agent.worker@1",
            "input":{"kind":"null"},"output":{"kind":"null"},
            "inputBindings":[],"writeBindings":[],"timeoutMs":1000,"attempts":1
        }),
        git_delivery_node(),
        json!({
            "kind":"verifier","name":"verify","worker":"agent.verify@1",
            "input":{"kind":"null"},"output":{"kind":"null"},
            "inputBindings":[],"writeBindings":[],"timeoutMs":1000,"attempts":1,
            "signals":{"verdict":["accepted"]},"diagnostic":{"kind":"null"}
        }),
        success_node(),
    ]);
    let runtime = RuntimePlan::Codex {
        provider: CodexProvider::OpenAi,
        size: RunSize::Standard,
        nodes: BTreeMap::from([
            (NodeName::new("worker").assert_value(), agent_binding()),
            (
                NodeName::new("deliver").assert_value(),
                NodeRuntimeBinding::GitDelivery {
                    env: DeclaredEnvironment::empty(),
                },
            ),
            (NodeName::new("verify").assert_value(), agent_binding()),
        ]),
    };
    NativeV2Admission
        .admit_with_policy(
            RunSubmission {
                title: RunTitle::new("Required delivery gate").assert_value(),
                graph,
                initial_input: Value::Null,
                runtime,
                source: source(),
                submission_key: IdempotencyKey::new("required-delivery-gate").assert_value(),
            },
            DeliveryPolicy::Required,
        )
        .await
        .assert_value()
}

async fn admitted_without_delivery() -> AdmittedRun {
    NativeV2Admission
        .admit(RunSubmission {
            title: RunTitle::new("Local optional run").assert_value(),
            graph: full_graph(vec![success_node()]),
            initial_input: Value::Null,
            runtime: RuntimePlan::Codex {
                provider: CodexProvider::OpenAi,
                size: RunSize::Standard,
                nodes: BTreeMap::new(),
            },
            source: source(),
            submission_key: IdempotencyKey::new("optional-delivery-gate").assert_value(),
        })
        .await
        .assert_value()
}

fn delivery_receipt() -> Value {
    json!({
        "version": "v1",
        "mode": "merge",
        "outcome": "merged",
        "repository": "acme/project",
        "targetBranch": "main",
        "headRevision": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        "pullRequestId": "17"
    })
}

fn worker_outcome() -> WorkerOutcome {
    WorkerOutcome::Verified {
        output: Value::Null,
        artifacts: Vec::new(),
    }
}

fn verifier_outcome() -> WorkerOutcome {
    WorkerOutcome::Verifier {
        output: Value::Null,
        signals: BTreeMap::from([(
            FieldName::new("verdict").assert_value(),
            EnumLabel::new("accepted").assert_value(),
        )]),
        diagnostic: Value::Null,
        artifacts: Vec::new(),
    }
}

fn delivery_outcome(receipt: Value) -> WorkerOutcome {
    WorkerOutcome::Verifier {
        output: receipt,
        signals: BTreeMap::from([(
            FieldName::new(DELIVERY_SIGNAL_FIELD).assert_value(),
            EnumLabel::new(DELIVERY_MERGED_LABEL).assert_value(),
        )]),
        diagnostic: Value::String("authoritatively observed merge".to_owned()),
        artifacts: Vec::new(),
    }
}

fn snapshot(
    admitted: &AdmittedRun,
    completions: impl IntoIterator<Item = (&'static str, WorkerOutcome)>,
) -> RunSnapshot {
    let run_id = RunId::new("delivery-gate-run");
    let mut snapshot = RunSnapshot::admitted(run_id.clone(), admitted);
    snapshot.phase = RunPhase::Running;
    for (index, (node, outcome)) in completions.into_iter().enumerate() {
        let identity = u64::try_from(index + 1).assert_value();
        let reference = ExecutionRef {
            run_id: run_id.clone(),
            node: NodeName::new(node).assert_value(),
            node_instance: NodeInstanceId::new(identity).assert_value(),
            execution: ExecutionId::new(identity).assert_value(),
        };
        snapshot.executions.insert(
            reference.execution,
            NodeSnapshot {
                reference: reference.clone(),
                occurrence: StructuralOccurrence {
                    node: reference.node.clone(),
                    map_indices: Vec::new(),
                },
                attempt: PositiveInteger::new(1).assert_value(),
                input: Value::Null,
                started_at: cursor_for(identity * 2 - 1),
                state: NodeState::Completed {
                    at: cursor_for(identity * 2),
                    outcome,
                },
            },
        );
    }
    snapshot
}

fn delivery_unconfirmed() -> TerminalResult {
    TerminalResult::Failed {
        reason: EnumLabel::new("delivery_unconfirmed").assert_value(),
    }
}

#[tokio::test]
async fn required_success_needs_exact_terminal_receipt_from_last_completed_writer() {
    let admitted = admitted_with_delivery().await;
    let receipt = delivery_receipt();
    let accepted = TerminalResult::Succeeded {
        output: json!({"delivery": receipt.clone()}),
    };
    let delivery_then_read_only_verifier = snapshot(
        &admitted,
        [
            ("worker", worker_outcome()),
            ("deliver", delivery_outcome(receipt.clone())),
            ("verify", verifier_outcome()),
        ],
    );
    assert_eq!(
        enforce_delivery_terminal(
            DeliveryPolicy::Required,
            &admitted,
            &delivery_then_read_only_verifier,
            accepted.clone(),
        )
        .assert_value(),
        accepted
    );

    let missing_inline_receipt = TerminalResult::Succeeded {
        output: Value::Null,
    };
    assert_eq!(
        enforce_delivery_terminal(
            DeliveryPolicy::Required,
            &admitted,
            &delivery_then_read_only_verifier,
            missing_inline_receipt,
        )
        .assert_value(),
        delivery_unconfirmed()
    );

    let stale_after_later_write = snapshot(
        &admitted,
        [
            ("deliver", delivery_outcome(receipt.clone())),
            ("worker", worker_outcome()),
        ],
    );
    assert_eq!(
        enforce_delivery_terminal(
            DeliveryPolicy::Required,
            &admitted,
            &stale_after_later_write,
            TerminalResult::Succeeded {
                output: receipt.clone(),
            },
        )
        .assert_value(),
        delivery_unconfirmed()
    );

    let no_durable_delivery = snapshot(&admitted, [("worker", worker_outcome())]);
    assert_eq!(
        enforce_delivery_terminal(
            DeliveryPolicy::Required,
            &admitted,
            &no_durable_delivery,
            TerminalResult::Succeeded { output: receipt },
        )
        .assert_value(),
        delivery_unconfirmed()
    );
}

#[tokio::test]
async fn optional_local_success_still_allows_no_delivery() {
    let admitted = admitted_without_delivery().await;
    let terminal = TerminalResult::Succeeded {
        output: Value::Null,
    };
    assert_eq!(
        enforce_delivery_terminal(
            DeliveryPolicy::Optional,
            &admitted,
            &RunSnapshot::admitted(RunId::new("local-run"), &admitted),
            terminal.clone(),
        )
        .assert_value(),
        terminal
    );
}
