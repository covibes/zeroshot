#[path = "support/ledger.rs"]
mod ledger;

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use openengine_cluster_protocol::{PositiveInteger, WorkerOutcome};
use ledger::{key, owner, resource, temp_root};
use tokio::sync::Barrier;
use openengine_cluster_server::admission::{AdmissionStore, ControlJournal, VerifiedIoLedger};
use openengine_cluster_server::admission::{CancellationSignal, CommitProposal};
use openengine_cluster_server::lifecycle::LifecycleStore;
use zeroshot_engine::cluster_ledger::adapters::ClusterLedgerAdapters;
use zeroshot_engine::cluster_ledger::mutations::{
    AdmissionRequest, DispatchAllocation, ExecutionVoidRequest, ReductionDispatchRequest,
    SafeFaultConsequence,
};
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
    ClusterLedger, ExecutionVoidReason, LedgerErrorKind, StructuralOccurrence,
};
use zeroshot_engine::fault::{
    EvidenceClass, FaultContext, FaultFactory, FaultModule, ModuleEvidence, RawDiagnostic,
    RedactionMarker,
};
use zeroshot_engine::observability::NoopObservationSink;

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
async fn reducer_execution_context_attempts_and_voids_replay_exactly() {
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
    ledger
        .void_execution(
            key("reduce-void-2"),
            [35; 32],
            ExecutionVoidRequest {
                execution: second.execution,
                reason: ExecutionVoidReason::ParallelJoin,
            },
        )
        .await
        .unwrap();

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
    assert!(!state.active_dispatches.contains_key(&second.execution));
    assert_eq!(
        state.execution_voids[&second.execution].reason,
        ExecutionVoidReason::ParallelJoin
    );
    let durable =
        zeroshot_engine::full_v1_reducer::durable_executions_from_replay(&state, first.run)
            .unwrap();
    assert_eq!(durable.len(), 2);
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

    let ordinary = ledger
        .dispatch(key("ordinary"), [43; 32])
        .await
        .unwrap()
        .value;
    let unmapped = ledger
        .void_execution(
            key("unmapped"),
            [44; 32],
            ExecutionVoidRequest {
                execution: ordinary.execution,
                reason: ExecutionVoidReason::ParallelJoin,
            },
        )
        .await
        .unwrap_err();
    assert_eq!(unmapped.kind(), &LedgerErrorKind::InvalidLifecycle);

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
