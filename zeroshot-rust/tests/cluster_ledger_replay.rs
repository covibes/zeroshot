#[path = "support/ledger.rs"]
mod ledger;

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use openengine_cluster_protocol::{
    GraphSpec, PositiveInteger, WorkerDescriptor, WorkerOutcome, WorkerRef,
};
use ledger::{key, owner, resource, temp_root};
use tokio::sync::Barrier;
use openengine_cluster_server::admission::{AdmissionStore, ControlJournal, VerifiedIoLedger};
use openengine_cluster_server::admission::{CancellationSignal, CommitProposal};
use openengine_cluster_server::admission::{GraphVerifier, VerifiedGraph};
use openengine_cluster_server::graph_verifier::ProductionGraphVerifier;
use openengine_cluster_server::lifecycle::LifecycleStore;
use zeroshot_engine::cluster_ledger::mutations::{
    AdmissionRequest, DispatchAllocation, ExecutionVoidRequest, ReductionDispatchRequest,
    SafeFaultConsequence,
};
use openengine_cluster_server::worker_registry::{WorkerRegistry, WorkerRegistryError};
use zeroshot_engine::cluster_ledger::adapters::ClusterLedgerAdapters;
use zeroshot_engine::cluster_ledger::record::{
    CanonicalDigest, RecordKind, RecordPayload, StoredRecord, MAX_APPEND_RECORDS,
    MAX_RECORD_PAYLOAD_BYTES,
};
use zeroshot_engine::cluster_ledger::replay::{replay, ReplayError};
use zeroshot_engine::cluster_ledger::store::fake::{FakeLedgerStore, ManualLedgerClock};
use zeroshot_engine::cluster_ledger::store::sqlite::SqliteLedgerStore;
use zeroshot_engine::cluster_ledger::store::{
    AppendBatch, AppendGuard, AppendOutcome, DiscoveryPage, Fence, IdempotencyId, LedgerStore,
    MutationReceipt, OwnerId, Position, PrefixSnapshot, ResourceId, ResourceInfo, StoreError,
    MAX_DISCOVERY_PAGE, MAX_IDENTIFIER_BYTES,
};
use zeroshot_engine::cluster_ledger::{
    ClusterLedger, ExecutionVoidAuthorization, ExecutionVoidReason, LedgerErrorKind,
    StructuralOccurrence,
};
use zeroshot_engine::full_v1_reducer::{
    durable_executions_from_replay, Decision, FullV1Reducer, Reduction, ReductionInput,
};
use zeroshot_engine::fault::{
    EvidenceClass, FaultContext, FaultFactory, FaultModule, ModuleEvidence, RawDiagnostic,
    RedactionMarker,
};
use zeroshot_engine::observability::NoopObservationSink;

struct ReducerWorkers;

#[async_trait]
impl WorkerRegistry for ReducerWorkers {
    async fn resolve(&self, worker: &WorkerRef) -> Result<WorkerDescriptor, WorkerRegistryError> {
        serde_json::from_value(serde_json::json!({
            "worker":worker.as_str(),
            "graphProfiles":["openengine.graph.full/v1"],
            "binding":{"protocol":"acp","version":"1","profile":"openengine.worker.acp/v1"},
            "contract":{
                "input":{"kind":"null"},
                "output":{"kind":"null"},
                "errors":["timeout","crash","malformed","refusal"]
            },
            "capabilityPolicy":{"autonomy":"strict","permissionPolicy":"policy.strict@1"},
            "artifactProfile":{
                "allowedTypeIds":["openengine.result@1"],
                "allowedMediaTypes":["application/json"],
                "minimumRedaction":"internal"
            },
            "credentialRequirements":[]
        }))
        .map_err(|_| WorkerRegistryError::NotFound {
            worker: worker.clone(),
        })
    }
}

async fn reducer_void_graph() -> VerifiedGraph {
    let state = serde_json::json!({"kind":"record","fields":{}});
    let step = |name: &str| {
        serde_json::json!({
            "kind":"step","name":name,"worker":"worker.test@1",
            "input":{"kind":"null"},"output":{"kind":"null"},
            "inputBindings":[],"writeBindings":[],"timeoutMs":1,"attempts":1
        })
    };
    let graph: GraphSpec = serde_json::from_value(serde_json::json!({
        "profile":"openengine.graph.full/v1",
        "initialInput":state,
        "policy":{"policy":"policy.test@1","default":"deny"},
        "root":{
            "kind":"seq","name":"void_root","state":state,
            "children":[{
                "kind":"par","name":"void_race","state":state,
                "branches":[step("void_loser_a"),step("void_loser_b"),step("void_winner")],
                "promotedStatePaths":[],"join":{"kind":"any"}
            },{
                "kind":"succeed","name":"void_done","output":{"kind":"null"},"bindings":[]
            }],
            "promotedStatePaths":[]
        }
    }))
    .unwrap();
    ProductionGraphVerifier::new(ReducerWorkers)
        .verify(&graph)
        .await
        .unwrap()
}

fn reducer_admission(graph: &VerifiedGraph) -> AdmissionRequest {
    let input = b"{}".to_vec();
    let canonical_graph = b"reducer-void-graph".to_vec();
    AdmissionRequest {
        graph_digest: CanonicalDigest::of(&canonical_graph),
        input_digest: CanonicalDigest::of(&input),
        policy_digest: CanonicalDigest::of(b"policy"),
        catalog_digest: CanonicalDigest::of(b"catalog"),
        profile_digest: CanonicalDigest::of(b"profile"),
        absolute_deadline_ms: 100_000,
        verified_input: input,
        canonical_graph,
        canonical_compiled_ir: graph.compiled_ir.canonical_bytes().unwrap(),
    }
}

fn reducer_reduction(
    state: &zeroshot_engine::cluster_ledger::ReplayState,
    graph: &VerifiedGraph,
) -> Reduction {
    let run = state.admission.as_ref().unwrap().run;
    let executions = durable_executions_from_replay(state, run).unwrap();
    FullV1Reducer::new(graph)
        .reduce(ReductionInput {
            run,
            prefix_position: state.position,
            initial_input: &serde_json::json!({}),
            executions: &executions,
            next_node_instance: state.identities.next_node_instance,
            next_execution: state.identities.next_execution,
        })
        .unwrap()
}

fn admission(label: &[u8]) -> AdmissionRequest {
    let input = br#"{"task":"verified"}"#.to_vec();
    AdmissionRequest {
        graph_digest: CanonicalDigest::of(label),
        input_digest: CanonicalDigest::of(&input),
        policy_digest: CanonicalDigest::of(b"policy"),
        catalog_digest: CanonicalDigest::of(b"catalog"),
        profile_digest: CanonicalDigest::of(b"profile"),
        absolute_deadline_ms: 100_000,
        verified_input: input,
        canonical_graph: label.to_vec(),
        canonical_compiled_ir: br#"{"ir":"verified"}"#.to_vec(),
    }
}

fn replace_payload(snapshot: &mut PrefixSnapshot, index: usize, payload: RecordPayload) {
    let previous_hash = index
        .checked_sub(1)
        .map_or([0; 32], |previous| snapshot.records[previous].record_hash);
    let sequence = snapshot.records[index].sequence;
    snapshot.records[index] = StoredRecord::build(
        snapshot.records[index].resource.clone(),
        sequence,
        &payload,
        previous_hash,
    )
    .unwrap();
    for next in index + 1..snapshot.records.len() {
        let existing = RecordPayload::decode(
            snapshot.records[next].kind,
            snapshot.records[next].version,
            &snapshot.records[next].payload,
        )
        .unwrap();
        snapshot.records[next] = StoredRecord::build(
            snapshot.records[next].resource.clone(),
            snapshot.records[next].sequence,
            &existing,
            snapshot.records[next - 1].record_hash,
        )
        .unwrap();
    }
}

async fn ledger(label: &str) -> (Arc<dyn LedgerStore>, ClusterLedger) {
    let store: Arc<dyn LedgerStore> = Arc::new(FakeLedgerStore::new(ManualLedgerClock::new(1_000)));
    let ledger = ClusterLedger::create(
        Arc::clone(&store),
        resource(label),
        owner("replay-owner"),
        10_000,
    )
    .await
    .unwrap();
    (store, ledger)
}

struct VoidFixture {
    loser_a: zeroshot_engine::cluster_ledger::ExecutionId,
    loser_b: zeroshot_engine::cluster_ledger::ExecutionId,
    authorization_a: ExecutionVoidAuthorization,
    authorization_b: ExecutionVoidAuthorization,
    forged_input_authorization: ExecutionVoidAuthorization,
}

async fn prepare_void_fixture(
    ledger: &ClusterLedger,
    store: &dyn LedgerStore,
    label: &str,
) -> VoidFixture {
    let graph = reducer_void_graph().await;
    ledger
        .admit(key("void-admit"), [61; 32], reducer_admission(&graph))
        .await
        .unwrap();
    let dispatch = |node: &str| ReductionDispatchRequest {
        occurrence: StructuralOccurrence {
            node: node.parse().unwrap(),
            map_indices: Vec::new(),
        },
        attempt: PositiveInteger::new(1).unwrap(),
        canonical_input: b"null".to_vec(),
    };
    let loser_a = ledger
        .dispatch_reduction(key("void-loser-a"), [62; 32], dispatch("void_loser_a"))
        .await
        .unwrap()
        .value;
    let loser_b = ledger
        .dispatch_reduction(key("void-loser-b"), [63; 32], dispatch("void_loser_b"))
        .await
        .unwrap()
        .value;
    let winner = ledger
        .dispatch_reduction(key("void-winner"), [64; 32], dispatch("void_winner"))
        .await
        .unwrap()
        .value;
    let outcome = WorkerOutcome::Verified {
        output: serde_json::Value::Null,
        artifacts: Vec::new(),
    };
    let outcome_bytes = serde_json::to_vec(&outcome).unwrap();
    ledger
        .settle(
            key("void-winner-settle"),
            [65; 32],
            winner.execution,
            CanonicalDigest::of(&outcome_bytes),
            Some(outcome_bytes),
        )
        .await
        .unwrap();
    let snapshot = store.read_prefix(&resource(label), None).await.unwrap();
    let state = replay(&snapshot, &resource(label)).unwrap();
    let reduction = reducer_reduction(&state, &graph);
    let executions =
        durable_executions_from_replay(&state, state.admission.as_ref().unwrap().run).unwrap();
    let forged_input = serde_json::json!({"forged":true});
    let forged_input_reduction = FullV1Reducer::new(&graph)
        .reduce(ReductionInput {
            run: state.admission.as_ref().unwrap().run,
            prefix_position: state.position,
            initial_input: &forged_input,
            executions: &executions,
            next_node_instance: state.identities.next_node_instance,
            next_execution: state.identities.next_execution,
        })
        .unwrap();
    assert_eq!(
        reduction
            .decisions
            .iter()
            .filter(|decision| matches!(decision, Decision::VoidLoser { .. }))
            .count(),
        2
    );
    VoidFixture {
        loser_a: loser_a.execution,
        loser_b: loser_b.execution,
        authorization_a: reduction.void_authorization(loser_a.execution).unwrap(),
        authorization_b: reduction.void_authorization(loser_b.execution).unwrap(),
        forged_input_authorization: forged_input_reduction
            .void_authorization(loser_a.execution)
            .unwrap(),
    }
}

async fn admit_and_dispatch(
    ledger: &ClusterLedger,
) -> zeroshot_engine::cluster_ledger::ExecutionId {
    ledger
        .admit(key("admit"), [1; 32], admission(b"graph"))
        .await
        .unwrap();
    ledger
        .dispatch(key("dispatch"), [2; 32])
        .await
        .unwrap()
        .value
        .execution
}

#[path = "cluster_ledger_replay/protocol.rs"]
mod protocol;
#[path = "cluster_ledger_replay/races.rs"]
mod races;
#[path = "cluster_ledger_replay/required_proof.rs"]
mod required_proof;
#[path = "cluster_ledger_replay/snapshot_race_store.rs"]
mod snapshot_race_store;
#[path = "cluster_ledger_replay/validation.rs"]
mod validation;

#[tokio::test]
async fn execution_void_requires_exact_reducer_authorization_and_preserves_rejected_state() {
    let label = "reducer-void-authorization";
    let (store, ledger) = ledger(label).await;
    let fixture = prepare_void_fixture(&ledger, store.as_ref(), label).await;
    let before = store.read_prefix(&resource(label), None).await.unwrap();

    let wrong_scope = ledger
        .void_execution(
            key("void-wrong-scope"),
            [66; 32],
            ExecutionVoidRequest::new(
                fixture.loser_b,
                ExecutionVoidReason::ParallelJoin,
                fixture.authorization_a,
            ),
        )
        .await
        .unwrap_err();
    assert_eq!(wrong_scope.kind(), &LedgerErrorKind::InvalidLifecycle);
    let wrong_reason = ledger
        .void_execution(
            key("void-wrong-reason"),
            [67; 32],
            ExecutionVoidRequest::new(
                fixture.loser_b,
                ExecutionVoidReason::MapTerminal,
                fixture.authorization_b,
            ),
        )
        .await
        .unwrap_err();
    assert_eq!(wrong_reason.kind(), &LedgerErrorKind::InvalidLifecycle);
    let wrong_input = ledger
        .void_execution(
            key("void-wrong-input"),
            [69; 32],
            ExecutionVoidRequest::new(
                fixture.loser_a,
                ExecutionVoidReason::ParallelJoin,
                fixture.forged_input_authorization,
            ),
        )
        .await
        .unwrap_err();
    assert_eq!(wrong_input.kind(), &LedgerErrorKind::InvalidLifecycle);

    let after_rejections = store.read_prefix(&resource(label), None).await.unwrap();
    assert_eq!(after_rejections.position, before.position);
    let rejected_state = replay(&after_rejections, &resource(label)).unwrap();
    assert!(rejected_state.execution_voids.is_empty());
    assert!(
        rejected_state
            .active_dispatches
            .contains_key(&fixture.loser_a)
    );
    assert!(
        rejected_state
            .active_dispatches
            .contains_key(&fixture.loser_b)
    );

    ledger
        .void_execution(
            key("void-authorized"),
            [68; 32],
            ExecutionVoidRequest::new(
                fixture.loser_a,
                ExecutionVoidReason::ParallelJoin,
                fixture.authorization_a,
            ),
        )
        .await
        .unwrap();
    let accepted = store.read_prefix(&resource(label), None).await.unwrap();
    let accepted_state = replay(&accepted, &resource(label)).unwrap();
    assert_eq!(
        accepted_state.execution_voids[&fixture.loser_a].reason,
        ExecutionVoidReason::ParallelJoin
    );
    assert!(
        accepted_state
            .active_dispatches
            .contains_key(&fixture.loser_b)
    );
}

#[tokio::test]
async fn concurrent_authorized_voids_share_one_folded_prefix_and_cas() {
    let label = "reducer-void-cas";
    let (race_store, ledger) = snapshot_race_store::race_ledger(label).await;
    let fixture = prepare_void_fixture(&ledger, &race_store, label).await;
    race_store.arm();
    let (first, second) = tokio::join!(
        ledger.void_execution(
            key("void-race-a"),
            [69; 32],
            ExecutionVoidRequest::new(
                fixture.loser_a,
                ExecutionVoidReason::ParallelJoin,
                fixture.authorization_a,
            ),
        ),
        ledger.void_execution(
            key("void-race-b"),
            [70; 32],
            ExecutionVoidRequest::new(
                fixture.loser_b,
                ExecutionVoidReason::ParallelJoin,
                fixture.authorization_b,
            ),
        )
    );
    assert_eq!(usize::from(first.is_ok()) + usize::from(second.is_ok()), 1);
    let failure = first.err().or_else(|| second.err()).unwrap();
    assert_eq!(failure.kind(), &LedgerErrorKind::InvalidLifecycle);
    let snapshot = race_store
        .read_prefix(&resource(label), None)
        .await
        .unwrap();
    let state = replay(&snapshot, &resource(label)).unwrap();
    assert_eq!(state.execution_voids.len(), 1);
    assert_eq!(state.active_dispatches.len(), 1);
}

#[tokio::test]
async fn reducer_execution_context_attempts_replay_exactly() {
    let (store, ledger) = ledger("reducer-control-replay").await;
    ledger
        .admit(key("reduce-admit"), [31; 32], admission(b"reducer"))
        .await
        .unwrap();
    let occurrence = StructuralOccurrence {
        node: "work".parse().unwrap(),
        map_indices: vec![3, 1],
    };
    let first = ledger
        .dispatch_reduction(
            key("reduce-dispatch-1"),
            [32; 32],
            ReductionDispatchRequest {
                occurrence: occurrence.clone(),
                attempt: PositiveInteger::new(1).unwrap(),
                canonical_input: br#"{"task":"first"}"#.to_vec(),
            },
        )
        .await
        .unwrap()
        .value;
    let outcome = WorkerOutcome::Verified {
        output: serde_json::json!({"value":1}),
        artifacts: Vec::new(),
    };
    let outcome_bytes = serde_json::to_vec(&outcome).unwrap();
    ledger
        .settle(
            key("reduce-settle-1"),
            [33; 32],
            first.execution,
            CanonicalDigest::of(&outcome_bytes),
            Some(outcome_bytes),
        )
        .await
        .unwrap();
    let second = ledger
        .dispatch_reduction(
            key("reduce-dispatch-2"),
            [34; 32],
            ReductionDispatchRequest {
                occurrence: occurrence.clone(),
                attempt: PositiveInteger::new(2).unwrap(),
                canonical_input: br#"{"task":"second"}"#.to_vec(),
            },
        )
        .await
        .unwrap()
        .value;
    assert_eq!(first.node_instance, second.node_instance);

    let snapshot = store
        .read_prefix(&resource("reducer-control-replay"), None)
        .await
        .unwrap();
    let state = replay(&snapshot, &resource("reducer-control-replay")).unwrap();
    assert_eq!(state.execution_contexts.len(), 2);
    assert_eq!(
        state.execution_contexts[&second.execution].occurrence,
        occurrence
    );
    assert_eq!(state.execution_contexts[&second.execution].attempt.get(), 2);
    assert!(state.active_dispatches.contains_key(&second.execution));
    let durable =
        zeroshot_engine::full_v1_reducer::durable_executions_from_replay(&state, first.run)
            .unwrap();
    assert_eq!(durable.len(), 2);
    assert!(durable.iter().any(|execution| {
        execution.execution == second.execution
            && matches!(
                execution.state,
                zeroshot_engine::full_v1_reducer::DurableExecutionState::Active
            )
    }));
    assert!(
        zeroshot_engine::full_v1_reducer::durable_executions_from_replay(
            &state,
            zeroshot_engine::cluster_ledger::RunSequence::new(2).unwrap(),
        )
        .unwrap()
        .is_empty()
    );
}

#[tokio::test]
async fn replay_rejects_node_instance_aliases_across_distinct_occurrences() {
    let (store, ledger) = ledger("reducer-node-alias").await;
    ledger
        .admit(key("alias-admit"), [51; 32], admission(b"alias"))
        .await
        .unwrap();
    let first_occurrence = StructuralOccurrence {
        node: "first-work".parse().unwrap(),
        map_indices: Vec::new(),
    };
    let second_occurrence = StructuralOccurrence {
        node: "second-work".parse().unwrap(),
        map_indices: Vec::new(),
    };
    let first = ledger
        .dispatch_reduction(
            key("alias-first"),
            [52; 32],
            ReductionDispatchRequest {
                occurrence: first_occurrence,
                attempt: PositiveInteger::new(1).unwrap(),
                canonical_input: b"null".to_vec(),
            },
        )
        .await
        .unwrap()
        .value;
    let second = ledger
        .dispatch_reduction(
            key("alias-second"),
            [53; 32],
            ReductionDispatchRequest {
                occurrence: second_occurrence.clone(),
                attempt: PositiveInteger::new(1).unwrap(),
                canonical_input: b"null".to_vec(),
            },
        )
        .await
        .unwrap()
        .value;
    let mut snapshot = store
        .read_prefix(&resource("reducer-node-alias"), None)
        .await
        .unwrap();
    let dispatch_index = snapshot
        .records
        .iter()
        .position(|record| {
            matches!(
                RecordPayload::decode(record.kind, record.version, &record.payload).unwrap(),
                RecordPayload::Dispatch { execution, .. } if execution == second.execution
            )
        })
        .unwrap();
    replace_payload(
        &mut snapshot,
        dispatch_index,
        RecordPayload::Dispatch {
            run: second.run,
            node_instance: first.node_instance,
            execution: second.execution,
        },
    );
    let context_index = snapshot
        .records
        .iter()
        .position(|record| {
            matches!(
                RecordPayload::decode(record.kind, record.version, &record.payload).unwrap(),
                RecordPayload::ExecutionContext { execution, .. } if execution == second.execution
            )
        })
        .unwrap();
    replace_payload(
        &mut snapshot,
        context_index,
        RecordPayload::ExecutionContext {
            run: second.run,
            node_instance: first.node_instance,
            execution: second.execution,
            occurrence: second_occurrence,
            attempt: PositiveInteger::new(1).unwrap(),
            canonical_input: b"null".to_vec(),
        },
    );

    let aliased_response = serde_json::to_vec(&DispatchAllocation {
        run: second.run,
        node_instance: first.node_instance,
        execution: second.execution,
    })
    .unwrap();
    let stored_receipt = snapshot
        .receipts
        .iter_mut()
        .find(|receipt| {
            receipt.method == "reducer_dispatch"
                && serde_json::from_slice::<DispatchAllocation>(&receipt.response)
                    .is_ok_and(|response| response.execution == second.execution)
        })
        .unwrap();
    stored_receipt.response.clone_from(&aliased_response);
    let receipt_index = snapshot
        .records
        .iter()
        .position(|record| {
            matches!(
                RecordPayload::decode(record.kind, record.version, &record.payload).unwrap(),
                RecordPayload::MutationReceipt { ref receipt }
                    if receipt.method == "reducer_dispatch"
                        && serde_json::from_slice::<DispatchAllocation>(&receipt.response)
                            .is_ok_and(|response| response.execution == second.execution)
            )
        })
        .unwrap();
    let mut receipt = match RecordPayload::decode(
        snapshot.records[receipt_index].kind,
        snapshot.records[receipt_index].version,
        &snapshot.records[receipt_index].payload,
    )
    .unwrap()
    {
        RecordPayload::MutationReceipt { receipt } => receipt,
        _ => unreachable!(),
    };
    receipt.response = aliased_response;
    replace_payload(
        &mut snapshot,
        receipt_index,
        RecordPayload::MutationReceipt { receipt },
    );

    assert_eq!(
        replay(&snapshot, &resource("reducer-node-alias")).unwrap_err(),
        ReplayError::InvalidOrder
    );
}

#[tokio::test]
async fn reducer_control_fold_rejects_attempt_gaps_and_unmapped_voids() {
    let (_store, ledger) = ledger("reducer-control-negative").await;
    ledger
        .admit(key("negative-admit"), [41; 32], admission(b"negative"))
        .await
        .unwrap();
    let occurrence = StructuralOccurrence {
        node: "work".parse().unwrap(),
        map_indices: Vec::new(),
    };
    let gap = ledger
        .dispatch_reduction(
            key("gap"),
            [42; 32],
            ReductionDispatchRequest {
                occurrence,
                attempt: PositiveInteger::new(2).unwrap(),
                canonical_input: b"null".to_vec(),
            },
        )
        .await
        .unwrap_err();
    assert_eq!(gap.kind(), &LedgerErrorKind::InvalidLifecycle);

    let active_occurrence = StructuralOccurrence {
        node: "active-work".parse().unwrap(),
        map_indices: Vec::new(),
    };
    ledger
        .dispatch_reduction(
            key("active-attempt-1"),
            [54; 32],
            ReductionDispatchRequest {
                occurrence: active_occurrence.clone(),
                attempt: PositiveInteger::new(1).unwrap(),
                canonical_input: b"null".to_vec(),
            },
        )
        .await
        .unwrap();
    let concurrent_attempt = ledger
        .dispatch_reduction(
            key("active-attempt-2"),
            [55; 32],
            ReductionDispatchRequest {
                occurrence: active_occurrence,
                attempt: PositiveInteger::new(2).unwrap(),
                canonical_input: b"null".to_vec(),
            },
        )
        .await
        .unwrap_err();
    assert_eq!(
        concurrent_attempt.kind(),
        &LedgerErrorKind::InvalidLifecycle
    );

    let reducer_owned = ledger
        .dispatch_reduction(
            key("reducer-owned"),
            [45; 32],
            ReductionDispatchRequest {
                occurrence: StructuralOccurrence {
                    node: "reducer-work".parse().unwrap(),
                    map_indices: Vec::new(),
                },
                attempt: PositiveInteger::new(1).unwrap(),
                canonical_input: b"null".to_vec(),
            },
        )
        .await
        .unwrap()
        .value;
    let outcome = WorkerOutcome::Verified {
        output: serde_json::json!({"result":"complete"}),
        artifacts: Vec::new(),
    };
    let outcome_bytes = serde_json::to_vec(&outcome).unwrap();
    let outcome_digest = CanonicalDigest::of(&outcome_bytes);
    let missing_outcome = ledger
        .settle(
            key("missing-reducer-outcome"),
            [46; 32],
            reducer_owned.execution,
            outcome_digest,
            None,
        )
        .await
        .unwrap_err();
    assert_eq!(missing_outcome.kind(), &LedgerErrorKind::Encoding);

    let fault = FaultFactory::new(&NoopObservationSink).create(ModuleEvidence::new(
        FaultModule::Worker,
        FaultContext::Execution,
        EvidenceClass::ProcessExited,
    ));
    let reducer_safe_fault = ledger
        .record_safe_fault(
            key("reducer-safe-fault"),
            [47; 32],
            &fault,
            SafeFaultConsequence::Settle {
                execution: reducer_owned.execution,
                outcome_digest,
            },
        )
        .await
        .unwrap_err();
    assert_eq!(
        reducer_safe_fault.kind(),
        &LedgerErrorKind::InvalidSettlement
    );

    ledger
        .settle(
            key("canonical-reducer-outcome"),
            [48; 32],
            reducer_owned.execution,
            outcome_digest,
            Some(outcome_bytes),
        )
        .await
        .unwrap();
}
