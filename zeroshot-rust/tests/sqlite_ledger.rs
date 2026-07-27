#[path = "support/ledger.rs"]
mod ledger;
#[path = "support/ledger_admission.rs"]
mod ledger_admission;

use std::sync::Arc;

use ledger::{key, owner, resource, temp_root};
use ledger_admission::admission_request;
use tokio::sync::Barrier;
use zeroshot_engine::cluster_ledger::mutations::{AdmissionAllocation, AdmissionRequest};
use zeroshot_engine::cluster_ledger::record::CanonicalDigest;
use zeroshot_engine::cluster_ledger::store::fake::ManualLedgerClock;
use zeroshot_engine::cluster_ledger::store::sqlite::{
    SqliteLedgerStore, APPLICATION_ID, SCHEMA_VERSION,
};
use zeroshot_engine::cluster_ledger::store::{LedgerStore, StoreError};
use zeroshot_engine::cluster_ledger::{ClusterLedger, GenerationId, LedgerErrorKind, RunSequence};
use zeroshot_engine::fault::FaultCode;

fn admission() -> AdmissionRequest {
    admission_request(
        br#"{"graph":"canonical"}"#.to_vec(),
        br#"{"input":"verified"}"#.to_vec(),
        br#"{"compiled":"canonical"}"#.to_vec(),
        10_000,
    )
}

#[tokio::test]
async fn sqlite_uses_required_settings_and_digest_named_database() {
    let root = temp_root("settings");
    let clock = ManualLedgerClock::new(100);
    let store = Arc::new(SqliteLedgerStore::with_clock(&root, clock).unwrap());
    let resource = resource("settings-cluster");
    store.create(&resource).await.unwrap();

    let path = store.path_for(&resource);
    assert_eq!(
        path.file_stem().unwrap().to_string_lossy().len(),
        64,
        "database stem must be the resource SHA-256"
    );
    assert_eq!(path.extension().unwrap(), "sqlite3");
    let settings = store.settings(&resource).unwrap();
    assert_eq!(settings.journal_mode.to_ascii_lowercase(), "wal");
    assert_eq!(settings.synchronous, 2);
    assert_eq!(settings.foreign_keys, 1);
    assert_eq!(settings.busy_timeout_ms, 5_000);
    assert_eq!(settings.application_id, i64::from(APPLICATION_ID));
    assert_eq!(settings.schema_version, SCHEMA_VERSION);

    drop(store);
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn missing_live_metadata_is_corruption_and_cannot_erase_records() {
    let root = temp_root("metadata-corruption");
    let store =
        Arc::new(SqliteLedgerStore::with_clock(&root, ManualLedgerClock::new(100)).unwrap());
    let resource = resource("metadata-corruption-cluster");
    let ledger = ClusterLedger::create(
        store.clone(),
        resource.clone(),
        owner("metadata-owner"),
        10_000,
    )
    .await
    .unwrap();
    ledger
        .admit(key("admit"), [1; 32], admission())
        .await
        .unwrap();
    drop(ledger);

    let connection = rusqlite::Connection::open(store.path_for(&resource)).unwrap();
    connection.execute("DELETE FROM metadata", []).unwrap();
    let record_count: i64 = connection
        .query_row("SELECT count(*) FROM records", [], |row| row.get(0))
        .unwrap();
    drop(connection);

    assert!(matches!(
        store.discover(None, 1).await,
        Err(StoreError::Corrupt(_))
    ));
    assert!(matches!(
        store.create(&resource).await,
        Err(StoreError::Corrupt(_))
    ));
    let connection = rusqlite::Connection::open(store.path_for(&resource)).unwrap();
    assert_eq!(
        connection
            .query_row::<i64, _, _>("SELECT count(*) FROM records", [], |row| row.get(0))
            .unwrap(),
        record_count
    );
    drop(connection);
    drop(store);
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn explicit_empty_removal_tombstone_allows_history_free_recreation() {
    let root = temp_root("removal-tombstone");
    let store =
        Arc::new(SqliteLedgerStore::with_clock(&root, ManualLedgerClock::new(100)).unwrap());
    let resource = resource("removed-cluster");
    store
        .create_fenced(&resource, &owner("owner"), 100)
        .await
        .unwrap();
    let connection = rusqlite::Connection::open(store.path_for(&resource)).unwrap();
    connection
        .execute_batch(
            "DELETE FROM fence;
             DELETE FROM metadata;
             INSERT INTO removal_tombstone(singleton, resource_id, removed_position)
             VALUES (1, 'removed-cluster', 0);",
        )
        .unwrap();
    drop(connection);

    assert!(store.discover(None, 1).await.unwrap().resources.is_empty());
    assert_eq!(
        store.create(&resource).await.unwrap().position,
        zeroshot_engine::cluster_ledger::store::Position::ZERO
    );
    let connection = rusqlite::Connection::open(store.path_for(&resource)).unwrap();
    assert_eq!(
        connection
            .query_row::<i64, _, _>("SELECT count(*) FROM removal_tombstone", [], |row| row
                .get(0))
            .unwrap(),
        0
    );
    drop(connection);
    drop(store);
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn invalid_fence_ttl_fails_before_sqlite_resource_creation() {
    let root = temp_root("invalid-create");
    let store =
        Arc::new(SqliteLedgerStore::with_clock(&root, ManualLedgerClock::new(100)).unwrap());
    for (label, ttl) in [("zero-ttl", 0), ("overflow-ttl", u64::MAX)] {
        let resource = resource(label);
        let creation =
            ClusterLedger::create(store.clone(), resource.clone(), owner("owner"), ttl).await;
        assert!(creation.is_err());
        assert!(!store.path_for(&resource).exists());
        assert!(matches!(
            store.open(&resource).await,
            Err(StoreError::ResourceNotFound)
        ));
    }
    drop(store);
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn concurrent_independent_creation_preserves_the_winning_resource_and_fence() {
    let root = temp_root("concurrent-create");
    let clock = ManualLedgerClock::new(100);
    let first = Arc::new(SqliteLedgerStore::with_clock(&root, clock.clone()).unwrap());
    let second = Arc::new(SqliteLedgerStore::with_clock(&root, clock).unwrap());
    let resource = resource("concurrent-create-cluster");
    let barrier = Arc::new(Barrier::new(2));

    let first_task = {
        let store = first.clone();
        let resource = resource.clone();
        let barrier = barrier.clone();
        tokio::spawn(async move {
            barrier.wait().await;
            store
                .create_fenced(&resource, &owner("first-owner"), 100)
                .await
        })
    };
    let second_task = {
        let store = second.clone();
        let resource = resource.clone();
        let barrier = barrier.clone();
        tokio::spawn(async move {
            barrier.wait().await;
            store
                .create_fenced(&resource, &owner("second-owner"), 100)
                .await
        })
    };
    let (first_result, second_result) = tokio::join!(first_task, second_task);
    let first_result = first_result.unwrap();
    let second_result = second_result.unwrap();
    let winning_fence = match (first_result, second_result) {
        (Ok((_, fence)), Err(StoreError::ResourceExists))
        | (Err(StoreError::ResourceExists), Ok((_, fence))) => fence,
        results => {
            panic!("expected one durable creator and one existing-resource result: {results:?}")
        }
    };

    assert_eq!(first.open(&resource).await.unwrap().position.get(), 0);
    assert_eq!(second.open(&resource).await.unwrap().position.get(), 0);
    first.check_fence(&winning_fence).await.unwrap();
    second.check_fence(&winning_fence).await.unwrap();

    drop(first);
    drop(second);
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn coherent_reads_observe_only_committed_prefixes_during_terminal_race() {
    let root = temp_root("coherent");
    let clock = ManualLedgerClock::new(100);
    let concrete = Arc::new(SqliteLedgerStore::with_clock(&root, clock).unwrap());
    let store: Arc<dyn LedgerStore> = concrete.clone();
    let ledger = ClusterLedger::create(
        store,
        resource("coherent-cluster"),
        owner("coherent-owner"),
        10_000,
    )
    .await
    .unwrap();
    ledger
        .admit(key("admit"), [1; 32], admission())
        .await
        .unwrap();

    let reader = ledger.clone();
    let read_task = tokio::spawn(async move {
        for _ in 0..100 {
            let state = reader.state().await.unwrap();
            assert!(state.admission.is_some());
            if state.terminal_outcome.is_some() {
                assert_eq!(state.position.get(), 5);
                assert!(state.active_dispatches.is_empty());
            } else {
                assert_eq!(state.position.get(), 3);
            }
        }
    });
    ledger
        .terminalize(key("terminal"), [2; 32], CanonicalDigest::of(b"terminal"))
        .await
        .unwrap();
    read_task.await.unwrap();

    drop(ledger);
    drop(concrete);
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn reopen_replays_and_unknown_record_version_fails_through_fault_factory() {
    let root = temp_root("reopen");
    let clock = ManualLedgerClock::new(100);
    let concrete = Arc::new(SqliteLedgerStore::with_clock(&root, clock.clone()).unwrap());
    let store: Arc<dyn LedgerStore> = concrete.clone();
    let resource = resource("reopen-cluster");
    let ledger = ClusterLedger::create(store, resource.clone(), owner("owner-a"), 5)
        .await
        .unwrap();
    ledger
        .admit(key("admit"), [1; 32], admission())
        .await
        .unwrap();
    let before = ledger.state().await.unwrap().public_bytes().unwrap();
    drop(ledger);
    clock.advance(5).unwrap();
    let reopened = ClusterLedger::open(concrete.clone(), resource.clone(), owner("owner-b"), 5)
        .await
        .unwrap();
    assert_eq!(
        before,
        reopened.state().await.unwrap().public_bytes().unwrap()
    );
    assert_corruption_fails_closed(&concrete, &resource, reopened, &clock).await;
    drop(concrete);
    std::fs::remove_dir_all(root).unwrap();
}

async fn assert_corruption_fails_closed(
    concrete: &Arc<SqliteLedgerStore>,
    resource: &zeroshot_engine::cluster_ledger::store::ResourceId,
    reopened: ClusterLedger,
    clock: &ManualLedgerClock,
) {
    let connection = rusqlite::Connection::open(concrete.path_for(resource)).unwrap();
    let original_response: Vec<u8> = connection
        .query_row("SELECT response FROM receipts LIMIT 1", [], |row| {
            row.get(0)
        })
        .unwrap();
    let forged_response = serde_json::to_vec(&AdmissionAllocation {
        generation: GenerationId::new(2).unwrap(),
        run: RunSequence::new(2).unwrap(),
    })
    .unwrap();
    connection
        .execute("UPDATE receipts SET response = ?1", [&forged_response])
        .unwrap();
    drop(connection);
    let live_receipt_error = match reopened.admit(key("admit"), [1; 32], admission()).await {
        Ok(_) => panic!("forged receipt must not satisfy a live idempotent retry"),
        Err(error) => error,
    };
    assert!(matches!(
        live_receipt_error.kind(),
        LedgerErrorKind::Replay(
            zeroshot_engine::cluster_ledger::replay::ReplayError::ReceiptCorrupt
        )
    ));
    drop(reopened);

    clock.advance(5).unwrap();
    let receipt_error =
        match ClusterLedger::open(concrete.clone(), resource.clone(), owner("owner-c"), 5).await {
            Ok(_) => panic!("corrupt receipt must not open"),
            Err(error) => error,
        };
    assert!(matches!(
        receipt_error.kind(),
        LedgerErrorKind::Replay(
            zeroshot_engine::cluster_ledger::replay::ReplayError::ReceiptCorrupt
        )
    ));
    assert_eq!(receipt_error.fault().code(), FaultCode::IntegrityFailure);

    let connection = rusqlite::Connection::open(concrete.path_for(resource)).unwrap();
    connection
        .execute("UPDATE receipts SET response = ?1", [&original_response])
        .unwrap();
    connection
        .execute("UPDATE records SET version = 99 WHERE sequence = 1", [])
        .unwrap();
    drop(connection);
    let error =
        match ClusterLedger::open(concrete.clone(), resource.clone(), owner("owner-d"), 5).await {
            Ok(_) => panic!("corrupt ledger must not open"),
            Err(error) => error,
        };
    assert!(matches!(error.kind(), LedgerErrorKind::Replay(_)));
    assert_eq!(error.fault().code(), FaultCode::IntegrityFailure);
}

#[tokio::test]
async fn independent_handles_respect_the_single_resource_fence() {
    let root = temp_root("handles");
    let clock = ManualLedgerClock::new(100);
    let first = SqliteLedgerStore::with_clock(&root, clock.clone()).unwrap();
    let second = SqliteLedgerStore::with_clock(&root, clock.clone()).unwrap();
    let resource = resource("handle-cluster");
    first.create(&resource).await.unwrap();
    let fence = first
        .acquire_fence(&resource, &owner("first"), 5)
        .await
        .unwrap();
    assert!(matches!(
        second.acquire_fence(&resource, &owner("second"), 5).await,
        Err(StoreError::FenceHeld)
    ));
    clock.advance(5).unwrap();
    let takeover = second
        .acquire_fence(&resource, &owner("second"), 5)
        .await
        .unwrap();
    assert_eq!(takeover.epoch, fence.epoch + 1);
    assert!(matches!(
        first.check_fence(&fence).await,
        Err(StoreError::StaleFence)
    ));

    drop(first);
    drop(second);
    std::fs::remove_dir_all(root).unwrap();
}
