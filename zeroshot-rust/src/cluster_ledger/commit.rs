use serde::de::DeserializeOwned;
use serde::Serialize;

use crate::fault::FaultContext;

use super::mutations::CommitResult;
use super::record::{RecordPayload, StoredRecord};
use super::replay::ReplayState;
use super::store::{
    AppendBatch, AppendGuard, AppendOutcome, IdempotencyId, MutationReceipt, StoreError,
};
use super::{ClusterLedger, LedgerError, LedgerErrorKind};

pub(crate) struct MutationIdentity {
    key: IdempotencyId,
    method: &'static str,
    fingerprint: [u8; 32],
}

impl MutationIdentity {
    pub(crate) const fn new(
        key: IdempotencyId,
        method: &'static str,
        fingerprint: [u8; 32],
    ) -> Self {
        Self {
            key,
            method,
            fingerprint,
        }
    }
}

pub(crate) struct CommitRequest<'a, T> {
    context: FaultContext,
    state: &'a ReplayState,
    mutation: MutationIdentity,
    payloads: Vec<RecordPayload>,
    response: &'a T,
    guard: AppendGuard,
}

impl<'a, T> CommitRequest<'a, T> {
    pub(crate) fn new(
        context: FaultContext,
        state: &'a ReplayState,
        mutation: MutationIdentity,
        response: &'a T,
    ) -> Self {
        Self {
            context,
            state,
            mutation,
            payloads: Vec::new(),
            response,
            guard: AppendGuard::allow(),
        }
    }

    pub(crate) fn with_payloads(mut self, payloads: Vec<RecordPayload>) -> Self {
        self.payloads = payloads;
        self
    }

    pub(crate) fn guarded(mut self, guard: AppendGuard) -> Self {
        self.guard = guard;
        self
    }
}

pub(crate) struct ReceiptExpectation<'a> {
    context: FaultContext,
    method: &'a str,
    fingerprint: [u8; 32],
    replayed: bool,
}

impl<'a> ReceiptExpectation<'a> {
    pub(crate) const fn new(context: FaultContext, method: &'a str, fingerprint: [u8; 32]) -> Self {
        Self {
            context,
            method,
            fingerprint,
            replayed: true,
        }
    }

    const fn committed(mut self) -> Self {
        self.replayed = false;
        self
    }
}

struct PreparedCommit {
    key: IdempotencyId,
    method: &'static str,
    fingerprint: [u8; 32],
    receipt: MutationReceipt,
    batch: AppendBatch,
}

impl ClusterLedger {
    pub(crate) async fn commit<T>(
        &self,
        request: CommitRequest<'_, T>,
    ) -> Result<CommitResult<T>, LedgerError>
    where
        T: DeserializeOwned + Serialize,
    {
        let prepared = self.prepare_commit(&request)?;
        let outcome = self
            .store
            .compare_and_append_guarded(
                &self.resource,
                &self.fence(),
                request.state.position,
                prepared.batch.clone(),
                request.guard,
            )
            .await;
        self.resolve_commit(request.context, prepared, outcome)
            .await
    }

    fn prepare_commit<T>(
        &self,
        request: &CommitRequest<'_, T>,
    ) -> Result<PreparedCommit, LedgerError>
    where
        T: Serialize,
    {
        let MutationIdentity {
            key,
            method,
            fingerprint,
        } = &request.mutation;
        let (mut records, mut position, previous_hash) =
            self.build_mutation_records(request.context, request.state, &request.payloads)?;
        let encoded_response = serde_json::to_vec(request.response)
            .map_err(|_| self.domain_error(request.context, LedgerErrorKind::Encoding))?;
        position = position
            .checked_add(1)
            .map_err(|_| self.domain_error(request.context, LedgerErrorKind::BoundViolation))?;
        let receipt = MutationReceipt {
            idempotency_key: key.clone(),
            method: (*method).to_owned(),
            fingerprint: *fingerprint,
            response: encoded_response,
            committed_position: position,
        };
        let receipt_record = StoredRecord::build(
            self.resource.clone(),
            position,
            &RecordPayload::MutationReceipt {
                receipt: receipt.clone(),
            },
            previous_hash,
        )
        .map_err(|_| self.domain_error(request.context, LedgerErrorKind::BoundViolation))?;
        records.push(receipt_record);
        let batch = AppendBatch::new(records, Some(receipt.clone()))
            .map_err(|_| self.domain_error(request.context, LedgerErrorKind::BoundViolation))?;
        Ok(PreparedCommit {
            key: key.clone(),
            method,
            fingerprint: *fingerprint,
            receipt,
            batch,
        })
    }

    fn build_mutation_records(
        &self,
        context: FaultContext,
        state: &ReplayState,
        payloads: &[RecordPayload],
    ) -> Result<(Vec<StoredRecord>, super::store::Position, [u8; 32]), LedgerError> {
        let mut position = state.position;
        let mut previous_hash = state.last_hash;
        let mut records = Vec::with_capacity(payloads.len().saturating_add(1));
        for payload in payloads {
            position = position
                .checked_add(1)
                .map_err(|_| self.domain_error(context, LedgerErrorKind::BoundViolation))?;
            let record =
                StoredRecord::build(self.resource.clone(), position, payload, previous_hash)
                    .map_err(|_| self.domain_error(context, LedgerErrorKind::BoundViolation))?;
            previous_hash = record.record_hash;
            records.push(record);
        }
        Ok((records, position, previous_hash))
    }

    async fn resolve_commit<T>(
        &self,
        context: FaultContext,
        prepared: PreparedCommit,
        outcome: Result<AppendOutcome, StoreError>,
    ) -> Result<CommitResult<T>, LedgerError>
    where
        T: DeserializeOwned,
    {
        match outcome {
            Ok(AppendOutcome::Committed(committed)) => {
                self.resolve_new_receipt(context, prepared, committed)
            }
            Ok(AppendOutcome::Replayed(committed)) => {
                self.resolve_replayed_receipt(context, prepared, committed)
                    .await
            }
            Ok(AppendOutcome::CommittedWithoutReceipt(_)) => {
                Err(self.domain_error(context, LedgerErrorKind::ReceiptCorrupt))
            }
            Err(StoreError::FailureInjected(
                super::store::FailPoint::AfterCommitBeforeResponse,
            )) => self.recover_receipt(context, prepared).await,
            Err(StoreError::IdempotencyConflict) => {
                Err(self.domain_error(context, LedgerErrorKind::IdempotencyConflict))
            }
            Err(StoreError::PositionConflict { .. }) => {
                Err(self.domain_error(context, LedgerErrorKind::InvalidLifecycle))
            }
            Err(error) => Err(self.store_error(context, error)),
        }
    }

    fn resolve_new_receipt<T>(
        &self,
        context: FaultContext,
        prepared: PreparedCommit,
        committed: MutationReceipt,
    ) -> Result<CommitResult<T>, LedgerError>
    where
        T: DeserializeOwned,
    {
        if committed != prepared.receipt {
            return Err(self.domain_error(context, LedgerErrorKind::ReceiptCorrupt));
        }
        self.decode_receipt(
            committed,
            ReceiptExpectation::new(context, prepared.method, prepared.fingerprint).committed(),
        )
    }

    async fn resolve_replayed_receipt<T>(
        &self,
        context: FaultContext,
        prepared: PreparedCommit,
        committed: MutationReceipt,
    ) -> Result<CommitResult<T>, LedgerError>
    where
        T: DeserializeOwned,
    {
        let recovered = self
            .require_validated_receipt(context, &prepared.key)
            .await?;
        if recovered != committed {
            return Err(self.domain_error(context, LedgerErrorKind::ReceiptCorrupt));
        }
        self.decode_receipt(
            recovered,
            ReceiptExpectation::new(context, prepared.method, prepared.fingerprint),
        )
    }

    async fn recover_receipt<T>(
        &self,
        context: FaultContext,
        prepared: PreparedCommit,
    ) -> Result<CommitResult<T>, LedgerError>
    where
        T: DeserializeOwned,
    {
        let recovered = self
            .require_validated_receipt(context, &prepared.key)
            .await?;
        self.decode_receipt(
            recovered,
            ReceiptExpectation::new(context, prepared.method, prepared.fingerprint),
        )
    }

    async fn require_validated_receipt(
        &self,
        context: FaultContext,
        key: &IdempotencyId,
    ) -> Result<MutationReceipt, LedgerError> {
        self.validated_receipt(context, key)
            .await?
            .ok_or_else(|| self.domain_error(context, LedgerErrorKind::ReceiptCorrupt))
    }

    fn decode_receipt<T>(
        &self,
        receipt: MutationReceipt,
        expectation: ReceiptExpectation<'_>,
    ) -> Result<CommitResult<T>, LedgerError>
    where
        T: DeserializeOwned,
    {
        if receipt.method != expectation.method || receipt.fingerprint != expectation.fingerprint {
            return Err(
                self.domain_error(expectation.context, LedgerErrorKind::IdempotencyConflict)
            );
        }
        let value = serde_json::from_slice(&receipt.response)
            .map_err(|_| self.domain_error(expectation.context, LedgerErrorKind::ReceiptCorrupt))?;
        Ok(CommitResult {
            value,
            position: receipt.committed_position,
            replayed: expectation.replayed,
        })
    }

    pub(crate) fn existing_receipt<T>(
        &self,
        state: &ReplayState,
        key: &IdempotencyId,
        expectation: ReceiptExpectation<'_>,
    ) -> Result<Option<CommitResult<T>>, LedgerError>
    where
        T: DeserializeOwned,
    {
        state
            .mutation_receipts
            .get(key)
            .cloned()
            .map(|receipt| self.decode_receipt(receipt, expectation))
            .transpose()
    }
}
