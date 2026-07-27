use std::sync::Arc;

use zeroshot_engine::cluster_ledger::record::{
    CanonicalDigest, RecordPayload, StoredRecord, MAX_RECORD_PAYLOAD_BYTES,
};
use zeroshot_engine::cluster_ledger::store::{
    AppendBatch, AppendGuard, AppendOutcome, Fence, LedgerStore, MutationReceipt, OwnerId,
    Position, PrefixSnapshot, ResourceId, StoreError,
};

pub use super::ledger::{key, owner, resource};

pub fn cleanup_payload(label: &[u8]) -> RecordPayload {
    RecordPayload::CleanupReceipt {
        cleanup_digest: CanonicalDigest::of(label),
    }
}

pub struct OneRecordSpec<'a> {
    pub sequence: u64,
    pub previous_hash: [u8; 32],
    pub payload: RecordPayload,
    pub receipt_key: &'a str,
}

pub fn one_record_batch(resource: &ResourceId, spec: OneRecordSpec<'_>) -> AppendBatch {
    let sequence = Position::new(spec.sequence).expect("test position must be valid");
    let record = StoredRecord::build(
        resource.clone(),
        sequence,
        &spec.payload,
        spec.previous_hash,
    )
    .expect("test record must build");
    let receipt = MutationReceipt {
        idempotency_key: key(spec.receipt_key),
        method: "contract".into(),
        fingerprint: CanonicalDigest::of(spec.receipt_key.as_bytes()).as_bytes(),
        response: b"{}".to_vec(),
        committed_position: sequence,
    };
    AppendBatch::new(vec![record], Some(receipt)).expect("test batch must be valid")
}

pub async fn run_store_contract(store: Arc<dyn LedgerStore>, resource_id: &str) {
    let resource = resource(resource_id);
    let owner = owner("contract-owner");
    assert_create_and_discover(Arc::clone(&store), resource_id, &resource, &owner).await;
    let renewed = assert_fence_and_cancelled_guard(Arc::clone(&store), &resource, &owner).await;
    assert_zero_position_receipt_is_rejected(Arc::clone(&store), &resource, &renewed).await;
    let latest = assert_replay_and_range_reads(Arc::clone(&store), &resource, &renewed).await;
    assert_receipt_only_and_invalid_appends(Arc::clone(&store), &resource, &renewed, latest).await;
    assert_removal_clears_receipts(store, &resource, &renewed).await;
}

async fn assert_create_and_discover(
    store: Arc<dyn LedgerStore>,
    resource_id: &str,
    resource_ref: &ResourceId,
    owner: &OwnerId,
) {
    let invalid_resource = resource(&format!("{resource_id}-invalid-create"));
    assert!(
        store
            .create_fenced(&invalid_resource, owner, 0)
            .await
            .is_err()
    );
    assert!(store.open(&invalid_resource).await.is_err());
    assert_eq!(
        store.create(resource_ref).await.unwrap().position,
        Position::ZERO
    );
    assert!(store.create(resource_ref).await.is_err());
    assert_eq!(
        store.open(resource_ref).await.unwrap().position,
        Position::ZERO
    );

    let page = store.discover(None, 1).await.unwrap();
    assert_eq!(page.resources[0].resource, *resource_ref);
    assert!(store.discover(None, 1_025).await.is_err());
}

async fn assert_fence_and_cancelled_guard(
    store: Arc<dyn LedgerStore>,
    resource: &ResourceId,
    owner: &OwnerId,
) -> Fence {
    let fence = store.acquire_fence(resource, owner, 100).await.unwrap();
    store.check_fence(&fence).await.unwrap();
    let renewed = store.renew_fence(&fence, 200).await.unwrap();
    assert_eq!(renewed.epoch, fence.epoch);

    let cancelled_batch = one_record_batch(
        resource,
        OneRecordSpec {
            sequence: 1,
            previous_hash: [0; 32],
            payload: cleanup_payload(b"cancelled"),
            receipt_key: "contract-cancelled",
        },
    );
    assert!(matches!(
        store
            .compare_and_append_guarded(
                resource,
                &renewed,
                Position::ZERO,
                cancelled_batch,
                AppendGuard::cancelled_when(|| true),
            )
            .await,
        Err(StoreError::AppendCancelled)
    ));
    assert_eq!(store.open(resource).await.unwrap().position, Position::ZERO);
    renewed
}

async fn assert_zero_position_receipt_is_rejected(
    store: Arc<dyn LedgerStore>,
    resource: &ResourceId,
    renewed: &Fence,
) {
    let invalid_zero_batch = AppendBatch {
        records: Vec::new(),
        receipt: Some(MutationReceipt {
            idempotency_key: key("contract-zero-position"),
            method: "contract".into(),
            fingerprint: [0; 32],
            response: b"{}".to_vec(),
            committed_position: Position::ZERO,
        }),
    };
    assert!(invalid_zero_batch.validate().is_err());
    assert!(
        store
            .compare_and_append(resource, renewed, Position::ZERO, invalid_zero_batch,)
            .await
            .is_err()
    );
    assert_eq!(store.open(resource).await.unwrap().position, Position::ZERO);
}

async fn assert_replay_and_range_reads(
    store: Arc<dyn LedgerStore>,
    resource: &ResourceId,
    renewed: &Fence,
) -> PrefixSnapshot {
    append_and_replay_initial_record(&store, resource, renewed).await;
    let snapshot = assert_snapshot_and_range_reads(&store, resource).await;
    append_second_record_and_wait(
        Arc::clone(&store),
        resource,
        renewed,
        snapshot.records[0].record_hash,
    )
    .await;
    store.read_prefix(resource, None).await.unwrap()
}

async fn append_and_replay_initial_record(
    store: &Arc<dyn LedgerStore>,
    resource: &ResourceId,
    renewed: &Fence,
) {
    let batch = one_record_batch(
        resource,
        OneRecordSpec {
            sequence: 1,
            previous_hash: [0; 32],
            payload: cleanup_payload(b"contract"),
            receipt_key: "contract-1",
        },
    );
    let committed = store
        .compare_and_append(resource, renewed, Position::ZERO, batch.clone())
        .await
        .unwrap();
    assert!(matches!(committed, AppendOutcome::Committed(_)));
    let replayed = store
        .compare_and_append_guarded(
            resource,
            renewed,
            Position::ZERO,
            batch,
            AppendGuard::cancelled_when(|| true),
        )
        .await
        .unwrap();
    assert!(matches!(replayed, AppendOutcome::Replayed(_)));
}

async fn assert_snapshot_and_range_reads(
    store: &Arc<dyn LedgerStore>,
    resource: &ResourceId,
) -> PrefixSnapshot {
    let snapshot = store.read_prefix(resource, None).await.unwrap();
    assert_eq!(snapshot.position.get(), 1);
    assert_eq!(snapshot.records.len(), 1);
    assert_eq!(snapshot.receipts.len(), 1);
    assert_eq!(
        store
            .read_range(resource, Position::ZERO, 4_096)
            .await
            .unwrap()
            .len(),
        1
    );
    assert!(
        store
            .read_range(resource, Position::ZERO, 4_097)
            .await
            .is_err()
    );
    snapshot
}

async fn append_second_record_and_wait(
    store: Arc<dyn LedgerStore>,
    resource: &ResourceId,
    renewed: &Fence,
    previous_hash: [u8; 32],
) {
    let waiter_store = Arc::clone(&store);
    let waiter_resource = resource.clone();
    let waiter = tokio::spawn(async move {
        waiter_store
            .wait_for_advance(&waiter_resource, Position::new(1).unwrap(), 5_000)
            .await
            .unwrap()
    });
    let second = one_record_batch(
        resource,
        OneRecordSpec {
            sequence: 2,
            previous_hash,
            payload: cleanup_payload(b"advance"),
            receipt_key: "contract-2",
        },
    );
    store
        .compare_and_append(resource, renewed, Position::new(1).unwrap(), second)
        .await
        .unwrap();
    assert_eq!(waiter.await.unwrap().get(), 2);
    assert_eq!(
        store
            .wait_for_advance(resource, Position::new(2).unwrap(), 0)
            .await
            .unwrap()
            .get(),
        2
    );
}

async fn assert_receipt_only_and_invalid_appends(
    store: Arc<dyn LedgerStore>,
    resource: &ResourceId,
    renewed: &Fence,
    latest: PrefixSnapshot,
) {
    store
        .compare_and_append(
            resource,
            renewed,
            Position::new(2).unwrap(),
            AppendBatch::new(
                Vec::new(),
                Some(MutationReceipt {
                    idempotency_key: key("contract-receipt-only"),
                    method: "contract".into(),
                    fingerprint: [7; 32],
                    response: b"{}".to_vec(),
                    committed_position: Position::new(2).unwrap(),
                }),
            )
            .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(store.open(resource).await.unwrap().position.get(), 2);

    assert_oversized_record_is_rejected(&store, resource, renewed, &latest).await;
    assert_reused_receipt_is_rejected(&store, resource, renewed, &latest).await;
    assert_conflicting_append_is_rejected(&store, resource, renewed, &latest).await;
}

async fn assert_oversized_record_is_rejected(
    store: &Arc<dyn LedgerStore>,
    resource: &ResourceId,
    renewed: &Fence,
    latest: &PrefixSnapshot,
) {
    let mut oversized_record = latest.records[1].clone();
    oversized_record.sequence = Position::new(3).unwrap();
    oversized_record.payload = vec![0; MAX_RECORD_PAYLOAD_BYTES + 1];
    let oversized_batch = AppendBatch {
        records: vec![oversized_record],
        receipt: Some(MutationReceipt {
            idempotency_key: key("contract-oversized"),
            method: "contract".into(),
            fingerprint: [8; 32],
            response: b"{}".to_vec(),
            committed_position: Position::new(3).unwrap(),
        }),
    };
    assert!(
        store
            .compare_and_append(
                resource,
                renewed,
                Position::new(2).unwrap(),
                oversized_batch,
            )
            .await
            .is_err()
    );
    assert_eq!(store.open(resource).await.unwrap().position.get(), 2);
}

async fn assert_reused_receipt_is_rejected(
    store: &Arc<dyn LedgerStore>,
    resource: &ResourceId,
    renewed: &Fence,
    latest: &PrefixSnapshot,
) {
    let mut reused = one_record_batch(
        resource,
        OneRecordSpec {
            sequence: 3,
            previous_hash: latest.records[1].record_hash,
            payload: cleanup_payload(b"reused"),
            receipt_key: "contract-1",
        },
    );
    reused.receipt.as_mut().unwrap().fingerprint = [9; 32];
    assert!(
        store
            .compare_and_append(resource, renewed, Position::new(2).unwrap(), reused,)
            .await
            .is_err()
    );
    assert_eq!(store.open(resource).await.unwrap().position.get(), 2);
}

async fn assert_conflicting_append_is_rejected(
    store: &Arc<dyn LedgerStore>,
    resource: &ResourceId,
    renewed: &Fence,
    latest: &PrefixSnapshot,
) {
    let conflicting = one_record_batch(
        resource,
        OneRecordSpec {
            sequence: 3,
            previous_hash: latest.records[1].record_hash,
            payload: cleanup_payload(b"conflict"),
            receipt_key: "contract-conflict",
        },
    );
    assert!(
        store
            .compare_and_append(resource, renewed, Position::ZERO, conflicting,)
            .await
            .is_err()
    );
    assert_eq!(store.open(resource).await.unwrap().position.get(), 2);
}

async fn assert_removal_clears_receipts(
    store: Arc<dyn LedgerStore>,
    resource: &ResourceId,
    renewed: &Fence,
) {
    store
        .remove(resource, renewed, Position::new(2).unwrap())
        .await
        .unwrap();
    assert!(store.open(resource).await.is_err());
    assert!(
        store
            .lookup_receipt(resource, &key("contract-1"))
            .await
            .is_err()
    );
}
