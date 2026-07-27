#[path = "support/ledger.rs"]
mod ledger;

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use ledger::{key, owner, resource, temp_root};
use tokio::sync::Barrier;
use openengine_cluster_server::admission::{AdmissionStore, ControlJournal, VerifiedIoLedger};
use openengine_cluster_server::admission::{CancellationSignal, CommitProposal};
use openengine_cluster_server::lifecycle::LifecycleStore;
use zeroshot_engine::cluster_ledger::adapters::ClusterLedgerAdapters;
use zeroshot_engine::cluster_ledger::mutations::{AdmissionRequest, SafeFaultConsequence};
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
use zeroshot_engine::cluster_ledger::{ClusterLedger, LedgerErrorKind};
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
#[path = "cluster_ledger_replay/snapshot_race_store.rs"]
mod snapshot_race_store;
#[path = "cluster_ledger_replay/validation.rs"]
mod validation;
