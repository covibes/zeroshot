use super::*;

#[tokio::test]
async fn corruption_and_impossible_order_fail_closed() {
    let (store, ledger) = ledger("corruption").await;
    ledger
        .admit(key("admit"), [1; 32], admission(b"graph"))
        .await
        .unwrap();
    let snapshot = store.read_prefix(ledger.resource(), None).await.unwrap();

    let mut unknown_version = snapshot.clone();
    unknown_version.records[0].version = 999;
    assert!(matches!(
        replay(&unknown_version, ledger.resource()),
        Err(ReplayError::Record(_))
    ));

    let mut gap = snapshot.clone();
    gap.records[1].sequence = Position::new(3).unwrap();
    assert!(matches!(
        replay(&gap, ledger.resource()),
        Err(ReplayError::Record(_))
    ));

    let mut hash = snapshot.clone();
    hash.records[0].record_hash[0] ^= 1;
    assert!(matches!(
        replay(&hash, ledger.resource()),
        Err(ReplayError::Record(_))
    ));

    let mut receipt = snapshot.clone();
    receipt.receipts[0].committed_position = Position::MAX;
    assert_eq!(
        replay(&receipt, ledger.resource()).unwrap_err(),
        ReplayError::ReceiptCorrupt
    );

    let mut lower_position = snapshot.clone();
    lower_position.receipts[0].committed_position =
        Position::new(lower_position.receipts[0].committed_position.get() - 1).unwrap();
    assert_eq!(
        replay(&lower_position, ledger.resource()).unwrap_err(),
        ReplayError::ReceiptCorrupt
    );

    let mut missing = snapshot.clone();
    missing.receipts.clear();
    assert_eq!(
        replay(&missing, ledger.resource()).unwrap_err(),
        ReplayError::ReceiptCorrupt
    );

    let mut missing_receipt_record = snapshot.clone();
    missing_receipt_record.records.pop();
    missing_receipt_record.position = Position::new(2).unwrap();
    missing_receipt_record.receipts.clear();
    assert_eq!(
        replay(&missing_receipt_record, ledger.resource()).unwrap_err(),
        ReplayError::ReceiptCorrupt
    );

    let mut forged = snapshot;
    forged.receipts[0].method = "dispatch".to_owned();
    forged.receipts[0].fingerprint = [9; 32];
    forged.receipts[0].response =
        serde_json::to_vec(&zeroshot_engine::cluster_ledger::DispatchAllocation {
            run: zeroshot_engine::cluster_ledger::RunSequence::new(1).unwrap(),
            node_instance: zeroshot_engine::cluster_ledger::NodeInstanceId::new(1).unwrap(),
            execution: zeroshot_engine::cluster_ledger::ExecutionId::new(1).unwrap(),
        })
        .unwrap();
    assert_eq!(
        replay(&forged, ledger.resource()).unwrap_err(),
        ReplayError::ReceiptCorrupt
    );
}

#[tokio::test]
async fn replay_rejects_receipts_whose_response_was_not_committed() {
    let (store, ledger) = ledger("forged-response").await;
    ledger
        .admit(key("admit"), [1; 32], admission(b"graph"))
        .await
        .unwrap();
    let mut snapshot = store.read_prefix(ledger.resource(), None).await.unwrap();
    let forged = zeroshot_engine::cluster_ledger::mutations::AdmissionAllocation {
        generation: zeroshot_engine::cluster_ledger::GenerationId::new(2).unwrap(),
        run: zeroshot_engine::cluster_ledger::RunSequence::new(1).unwrap(),
    };
    snapshot.receipts[0].response = serde_json::to_vec(&forged).unwrap();
    let receipt_index = snapshot
        .records
        .iter()
        .position(|record| record.kind == RecordKind::MutationReceipt)
        .unwrap();
    let forged_receipt = snapshot.receipts[0].clone();
    replace_payload(
        &mut snapshot,
        receipt_index,
        RecordPayload::MutationReceipt {
            receipt: forged_receipt,
        },
    );

    assert_eq!(
        replay(&snapshot, ledger.resource()).unwrap_err(),
        ReplayError::ReceiptCorrupt
    );
}

#[tokio::test]
async fn replay_rejects_verified_io_that_contradicts_authoritative_records() {
    let (store, ledger) = ledger("contradictory-io").await;
    let execution = admit_and_dispatch(&ledger).await;
    let output = b"accepted-output".to_vec();
    ledger
        .settle(
            key("settle"),
            [3; 32],
            execution,
            CanonicalDigest::of(&output),
            Some(output),
        )
        .await
        .unwrap();
    let snapshot = store.read_prefix(ledger.resource(), None).await.unwrap();

    let mut forged_input = snapshot.clone();
    let input_index = forged_input
        .records
        .iter()
        .position(|record| record.kind == RecordKind::VerifiedInput)
        .unwrap();
    let different_input = b"different-verified-input".to_vec();
    replace_payload(
        &mut forged_input,
        input_index,
        RecordPayload::VerifiedInput {
            run: zeroshot_engine::cluster_ledger::RunSequence::new(1).unwrap(),
            digest: CanonicalDigest::of(&different_input),
            canonical_bytes: different_input,
        },
    );
    assert_eq!(
        replay(&forged_input, ledger.resource()).unwrap_err(),
        ReplayError::InvalidOrder
    );

    let mut forged_output = snapshot;
    let output_index = forged_output
        .records
        .iter()
        .position(|record| record.kind == RecordKind::VerifiedOutput)
        .unwrap();
    let different_output = b"different-verified-output".to_vec();
    replace_payload(
        &mut forged_output,
        output_index,
        RecordPayload::VerifiedOutput {
            run: zeroshot_engine::cluster_ledger::RunSequence::new(1).unwrap(),
            execution,
            digest: CanonicalDigest::of(&different_output),
            canonical_bytes: different_output,
        },
    );
    assert_eq!(
        replay(&forged_output, ledger.resource()).unwrap_err(),
        ReplayError::InvalidOrder
    );
}

#[tokio::test]
async fn pending_effects_block_every_terminal_transition() {
    let (store, ledger) = ledger("pending-effect-terminal").await;
    ledger
        .admit(key("admit"), [1; 32], admission(b"graph"))
        .await
        .unwrap();
    let effect = ledger
        .record_effect_intent(key("effect"), [2; 32], CanonicalDigest::of(b"request"))
        .await
        .unwrap()
        .value
        .effect;
    let pending_position = ledger.state().await.unwrap().position;

    let terminal_error = ledger
        .terminalize(key("terminal"), [3; 32], CanonicalDigest::of(b"done"))
        .await
        .unwrap_err();
    assert!(matches!(
        terminal_error.kind(),
        LedgerErrorKind::InvalidLifecycle
    ));
    assert_pending_fault_rejected(&ledger).await;
    assert_eq!(ledger.state().await.unwrap().position, pending_position);
    assert_pending_terminal_replay_rejected(store.as_ref(), &ledger).await;
    ledger
        .reconcile_effect(
            key("effect-receipt"),
            [5; 32],
            effect,
            CanonicalDigest::of(b"receipt"),
        )
        .await
        .unwrap();
    ledger
        .terminalize(key("terminal"), [3; 32], CanonicalDigest::of(b"done"))
        .await
        .unwrap();
}

async fn assert_pending_fault_rejected(ledger: &ClusterLedger) {
    let fault = FaultFactory::new(&NoopObservationSink).create(ModuleEvidence::new(
        FaultModule::Worker,
        FaultContext::Execution,
        EvidenceClass::MalformedExternalData,
    ));
    let error = ledger
        .record_safe_fault(
            key("fault-terminal"),
            [4; 32],
            &fault,
            SafeFaultConsequence::Terminal {
                outcome_digest: CanonicalDigest::of(b"faulted"),
            },
        )
        .await
        .unwrap_err();
    assert!(matches!(error.kind(), LedgerErrorKind::InvalidLifecycle));
}

async fn assert_pending_terminal_replay_rejected(store: &dyn LedgerStore, ledger: &ClusterLedger) {
    let mut forged = store.read_prefix(ledger.resource(), None).await.unwrap();
    let terminal = RecordPayload::Terminal {
        run: zeroshot_engine::cluster_ledger::RunSequence::new(1).unwrap(),
        outcome_digest: CanonicalDigest::of(b"forged-terminal"),
    };
    let position = forged.position.checked_add(1).unwrap();
    forged.records.push(
        StoredRecord::build(
            ledger.resource().clone(),
            position,
            &terminal,
            forged.records.last().unwrap().record_hash,
        )
        .unwrap(),
    );
    forged.position = position;
    assert_eq!(
        replay(&forged, ledger.resource()).unwrap_err(),
        ReplayError::InvalidOrder
    );
}

#[tokio::test]
async fn persisted_safe_fault_never_contains_ephemeral_diagnostic_bytes() {
    let secret = "Authorization: Bearer ledger-secret";
    let (store, ledger) = ledger("redacted-fault").await;
    let execution = admit_and_dispatch(&ledger).await;
    let fault = FaultFactory::new(&NoopObservationSink).create(
        ModuleEvidence::new(
            FaultModule::Worker,
            FaultContext::Execution,
            EvidenceClass::MalformedExternalData,
        )
        .with_diagnostic(RawDiagnostic::new(RedactionMarker::Header, secret).unwrap()),
    );
    ledger
        .record_safe_fault(
            key("fault"),
            [3; 32],
            &fault,
            SafeFaultConsequence::Settle {
                execution,
                outcome_digest: CanonicalDigest::of(b"faulted"),
            },
        )
        .await
        .unwrap();
    let records = store.read_prefix(ledger.resource(), None).await.unwrap();
    let encoded = String::from_utf8(serde_json::to_vec(&records.records).unwrap()).unwrap();
    assert!(!encoded.contains(secret));
    assert!(!encoded.contains("ledger-secret"));
}

#[tokio::test]
async fn fixed_bounds_fail_before_durable_write() {
    assert!(ResourceId::new("x".repeat(MAX_IDENTIFIER_BYTES + 1)).is_err());
    assert!(IdempotencyId::new("\u{7}").is_err());
    assert!(
        serde_json::from_value::<ResourceId>(serde_json::Value::String(
            "x".repeat(MAX_IDENTIFIER_BYTES + 1)
        ))
        .is_err()
    );
    assert!(
        serde_json::from_value::<zeroshot_engine::cluster_ledger::ExecutionId>(serde_json::json!(
            0
        ))
        .is_err()
    );
    assert!(serde_json::from_value::<Position>(serde_json::json!(u64::MAX)).is_err());
    assert_eq!(MAX_DISCOVERY_PAGE, 1_024);

    let (_, ledger) = ledger("bounds").await;
    let oversized = vec![b'x'; MAX_RECORD_PAYLOAD_BYTES + 1];
    let mut request = admission(&oversized);
    request.graph_digest = CanonicalDigest::of(&oversized);
    assert!(
        ledger
            .admit(key("oversized"), [8; 32], request)
            .await
            .is_err()
    );
    assert_eq!(ledger.state().await.unwrap().position, Position::ZERO);

    let resource = resource("batch-bound");
    let payload = RecordPayload::CleanupReceipt {
        cleanup_digest: CanonicalDigest::of(b"x"),
    };
    let records = (1..=MAX_APPEND_RECORDS + 1)
        .map(|sequence| {
            StoredRecord::build(
                resource.clone(),
                Position::new(sequence as u64).unwrap(),
                &payload,
                [0; 32],
            )
            .unwrap()
        })
        .collect();
    assert!(AppendBatch::new(records, None).is_err());
}

#[test]
fn post_terminal_record_is_rejected_by_pure_replay() {
    let resource = resource("terminal-order");
    let terminal = RecordPayload::Terminal {
        run: zeroshot_engine::cluster_ledger::RunSequence::new(1).unwrap(),
        outcome_digest: CanonicalDigest::of(b"done"),
    };
    let dispatch = RecordPayload::Dispatch {
        run: zeroshot_engine::cluster_ledger::RunSequence::new(1).unwrap(),
        node_instance: zeroshot_engine::cluster_ledger::NodeInstanceId::new(1).unwrap(),
        execution: zeroshot_engine::cluster_ledger::ExecutionId::new(1).unwrap(),
    };
    let admission = RecordPayload::Admission {
        generation: zeroshot_engine::cluster_ledger::GenerationId::new(1).unwrap(),
        run: zeroshot_engine::cluster_ledger::RunSequence::new(1).unwrap(),
        graph_digest: CanonicalDigest::of(b"g"),
        input_digest: CanonicalDigest::of(b"null"),
        policy_digest: CanonicalDigest::of(b"p"),
        catalog_digest: CanonicalDigest::of(b"c"),
        profile_digest: CanonicalDigest::of(b"f"),
        absolute_deadline_ms: 1,
        canonical_graph: b"g".to_vec(),
        canonical_compiled_ir: Vec::new(),
    };
    let first = StoredRecord::build(
        resource.clone(),
        Position::new(1).unwrap(),
        &admission,
        [0; 32],
    )
    .unwrap();
    let second = StoredRecord::build(
        resource.clone(),
        Position::new(2).unwrap(),
        &terminal,
        first.record_hash,
    )
    .unwrap();
    let third = StoredRecord::build(
        resource.clone(),
        Position::new(3).unwrap(),
        &dispatch,
        second.record_hash,
    )
    .unwrap();
    let snapshot = PrefixSnapshot {
        position: Position::new(3).unwrap(),
        records: vec![first, second, third],
        receipts: Vec::<MutationReceipt>::new(),
    };
    assert_eq!(
        replay(&snapshot, &resource).unwrap_err(),
        ReplayError::PostTerminalRecord
    );
}
