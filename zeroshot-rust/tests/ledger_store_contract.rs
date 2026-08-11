#[path = "support/ledger.rs"]
mod ledger;
#[path = "support/ledger_contract.rs"]
mod ledger_contract;

use std::sync::Arc;

use ledger::temp_root;
use ledger_contract::{owner, resource, run_store_contract};
use zeroshot_engine::cluster_ledger::store::fake::{FakeLedgerStore, ManualLedgerClock};
use zeroshot_engine::cluster_ledger::store::sqlite::SqliteLedgerStore;
use zeroshot_engine::cluster_ledger::store::{LedgerStore, StoreError};

#[tokio::test]
async fn shared_contract_passes_for_fake_store() {
    let clock = ManualLedgerClock::new(1_000);
    let store: Arc<dyn LedgerStore> = Arc::new(FakeLedgerStore::new(clock));
    run_store_contract(store, "fake-contract").await;
}

#[tokio::test]
async fn shared_contract_passes_for_sqlite_store() {
    let root = temp_root("sqlite-contract");
    let clock = ManualLedgerClock::new(1_000);
    let store: Arc<dyn LedgerStore> =
        Arc::new(SqliteLedgerStore::with_clock(&root, clock).unwrap());
    run_store_contract(store, "sqlite-contract").await;
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn fence_expiry_takeover_and_stale_owner_rejection_are_deterministic() {
    for sqlite in [false, true] {
        let clock = ManualLedgerClock::new(10);
        let root = temp_root("fence");
        let store: Arc<dyn LedgerStore> = if sqlite {
            Arc::new(SqliteLedgerStore::with_clock(&root, clock.clone()).unwrap())
        } else {
            Arc::new(FakeLedgerStore::new(clock.clone()))
        };
        let resource = resource(if sqlite { "sqlite-fence" } else { "fake-fence" });
        store.create(&resource).await.unwrap();
        let first = store
            .acquire_fence(&resource, &owner("first"), 5)
            .await
            .unwrap();
        assert!(matches!(
            store.acquire_fence(&resource, &owner("second"), 5).await,
            Err(StoreError::FenceHeld)
        ));
        clock.advance(5).unwrap();
        assert!(matches!(
            store.check_fence(&first).await,
            Err(StoreError::FenceExpired)
        ));
        let second = store
            .acquire_fence(&resource, &owner("second"), 5)
            .await
            .unwrap();
        assert_eq!(second.epoch, first.epoch + 1);
        assert!(matches!(
            store.check_fence(&first).await,
            Err(StoreError::StaleFence)
        ));
        drop(store);
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[tokio::test]
async fn exact_release_preserves_epoch_and_rejects_stale_renew_or_release() {
    for sqlite in [false, true] {
        let clock = ManualLedgerClock::new(20);
        let root = temp_root("release-fence");
        let store: Arc<dyn LedgerStore> = if sqlite {
            Arc::new(SqliteLedgerStore::with_clock(&root, clock.clone()).unwrap())
        } else {
            Arc::new(FakeLedgerStore::new(clock.clone()))
        };
        let resource = resource(if sqlite {
            "sqlite-release-fence"
        } else {
            "fake-release-fence"
        });
        store.create(&resource).await.unwrap();
        let first = store
            .acquire_fence(&resource, &owner("first"), 50)
            .await
            .unwrap();
        store.release_fence(&first).await.unwrap();

        let second = store
            .acquire_fence(&resource, &owner("second"), 50)
            .await
            .unwrap();
        assert_eq!(second.epoch, first.epoch + 1);
        assert!(matches!(
            store.renew_fence(&first, 50).await,
            Err(StoreError::StaleFence)
        ));
        assert!(matches!(
            store.release_fence(&first).await,
            Err(StoreError::StaleFence)
        ));

        drop(store);
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[tokio::test]
async fn renewal_keeps_in_flight_same_epoch_operations_valid_but_release_exact() {
    for sqlite in [false, true] {
        let clock = ManualLedgerClock::new(30);
        let root = temp_root("renewed-fence-operation");
        let store: Arc<dyn LedgerStore> = if sqlite {
            Arc::new(SqliteLedgerStore::with_clock(&root, clock.clone()).unwrap())
        } else {
            Arc::new(FakeLedgerStore::new(clock.clone()))
        };
        let resource = resource(if sqlite {
            "sqlite-renewed-operation"
        } else {
            "fake-renewed-operation"
        });
        store.create(&resource).await.unwrap();
        let acquired = store
            .acquire_fence(&resource, &owner("owner"), 50)
            .await
            .unwrap();
        let renewed = store.renew_fence(&acquired, 100).await.unwrap();

        store.check_fence(&acquired).await.unwrap();
        store
            .compare_and_append(
                &resource,
                &acquired,
                zeroshot_engine::cluster_ledger::store::Position::ZERO,
                ledger_contract::one_record_batch(
                    &resource,
                    ledger_contract::OneRecordSpec {
                        sequence: 1,
                        previous_hash: [0; 32],
                        payload: ledger_contract::cleanup_payload(b"renewed-operation"),
                        receipt_key: "renewed-operation",
                    },
                ),
            )
            .await
            .unwrap();
        assert!(matches!(
            store.release_fence(&acquired).await,
            Err(StoreError::StaleFence)
        ));
        store.release_fence(&renewed).await.unwrap();

        drop(store);
        std::fs::remove_dir_all(root).unwrap();
    }
}
