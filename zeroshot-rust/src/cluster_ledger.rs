use std::sync::{Arc, Mutex};

use crate::fault::{EvidenceClass, FaultContext, FaultFactory, FaultModule, ModuleEvidence};
use crate::observability::{NoopObservationSink, ObservationSink};

pub mod adapters;
mod commit;
mod error;
pub mod mutations;
pub mod record;
pub mod replay;
pub mod store;

pub use mutations::{
    AdmissionRequest, CommitResult, DispatchAllocation, SafeFaultConsequence, SafeFaultResult,
    SettlementResult,
};
pub use error::{LedgerError, LedgerErrorKind};
pub use record::{CanonicalDigest, EffectId, ExecutionId, GenerationId, NodeInstanceId, RunSequence};
pub use replay::{replay, ReplayState};
pub use store::{LedgerStore, OwnerId, ResourceId};

pub(crate) use commit::{CommitRequest, MutationIdentity, ReceiptExpectation};
use error::map_store_error;
use replay::ReplayError;
use store::{Fence, IdempotencyId, MutationReceipt, StoreError};

#[derive(Clone)]
pub struct ClusterLedger {
    store: Arc<dyn LedgerStore>,
    resource: ResourceId,
    fence: Arc<Mutex<Fence>>,
    observations: Arc<dyn ObservationSink>,
}

#[derive(Clone)]
struct LedgerAccess {
    owner: OwnerId,
    fence_ttl_ms: u64,
    observations: Arc<dyn ObservationSink>,
}

impl LedgerAccess {
    #[must_use]
    fn new(owner: OwnerId, fence_ttl_ms: u64, observations: Arc<dyn ObservationSink>) -> Self {
        Self {
            owner,
            fence_ttl_ms,
            observations,
        }
    }
}

impl ClusterLedger {
    pub async fn create(
        store: Arc<dyn LedgerStore>,
        resource: ResourceId,
        owner: OwnerId,
        fence_ttl_ms: u64,
    ) -> Result<Self, LedgerError> {
        Self::create_with_observations(
            store,
            resource,
            owner,
            fence_ttl_ms,
            Arc::new(NoopObservationSink),
        )
        .await
    }

    #[allow(clippy::too_many_arguments, reason = "frozen pre-6.7.2 public API")]
    pub async fn create_with_observations(
        store: Arc<dyn LedgerStore>,
        resource: ResourceId,
        owner: OwnerId,
        fence_ttl_ms: u64,
        observations: Arc<dyn ObservationSink>,
    ) -> Result<Self, LedgerError> {
        Self::create_with_access(
            store,
            resource,
            LedgerAccess::new(owner, fence_ttl_ms, observations),
        )
        .await
    }

    async fn create_with_access(
        store: Arc<dyn LedgerStore>,
        resource: ResourceId,
        access: LedgerAccess,
    ) -> Result<Self, LedgerError> {
        let LedgerAccess {
            owner,
            fence_ttl_ms,
            observations,
        } = access;
        let (_, fence) = store
            .create_fenced(&resource, &owner, fence_ttl_ms)
            .await
            .map_err(|error| {
                map_store_error(observations.as_ref(), FaultContext::Admission, error)
            })?;
        Ok(Self {
            store,
            resource,
            fence: Arc::new(Mutex::new(fence)),
            observations,
        })
    }

    pub async fn open(
        store: Arc<dyn LedgerStore>,
        resource: ResourceId,
        owner: OwnerId,
        fence_ttl_ms: u64,
    ) -> Result<Self, LedgerError> {
        Self::open_with_observations(
            store,
            resource,
            owner,
            fence_ttl_ms,
            Arc::new(NoopObservationSink),
        )
        .await
    }

    #[allow(clippy::too_many_arguments, reason = "frozen pre-6.7.2 public API")]
    pub async fn open_with_observations(
        store: Arc<dyn LedgerStore>,
        resource: ResourceId,
        owner: OwnerId,
        fence_ttl_ms: u64,
        observations: Arc<dyn ObservationSink>,
    ) -> Result<Self, LedgerError> {
        Self::open_with_access(
            store,
            resource,
            LedgerAccess::new(owner, fence_ttl_ms, observations),
        )
        .await
    }

    async fn open_with_access(
        store: Arc<dyn LedgerStore>,
        resource: ResourceId,
        access: LedgerAccess,
    ) -> Result<Self, LedgerError> {
        let LedgerAccess {
            owner,
            fence_ttl_ms,
            observations,
        } = access;
        store.open(&resource).await.map_err(|error| {
            map_store_error(observations.as_ref(), FaultContext::Recovery, error)
        })?;
        let snapshot = store.read_prefix(&resource, None).await.map_err(|error| {
            map_store_error(observations.as_ref(), FaultContext::Recovery, error)
        })?;
        replay::replay(&snapshot, &resource).map_err(|error| {
            let fault = FaultFactory::new(observations.as_ref()).create(ModuleEvidence::new(
                FaultModule::Storage,
                FaultContext::Recovery,
                EvidenceClass::IntegrityFailure,
            ));
            LedgerError {
                kind: LedgerErrorKind::Replay(error),
                fault,
            }
        })?;
        let fence = store
            .acquire_fence(&resource, &owner, fence_ttl_ms)
            .await
            .map_err(|error| {
                map_store_error(observations.as_ref(), FaultContext::Recovery, error)
            })?;
        Ok(Self {
            store,
            resource,
            fence: Arc::new(Mutex::new(fence)),
            observations,
        })
    }

    #[must_use]
    pub fn resource(&self) -> &ResourceId {
        &self.resource
    }

    #[must_use]
    pub fn fence(&self) -> Fence {
        self.fence
            .lock()
            .expect("cluster ledger fence mutex must not be poisoned")
            .clone()
    }

    pub async fn renew_fence(&self, ttl_ms: u64) -> Result<Fence, LedgerError> {
        let current = self.fence();
        let renewed = self
            .store
            .renew_fence(&current, ttl_ms)
            .await
            .map_err(|error| self.store_error(FaultContext::Recovery, error))?;
        *self
            .fence
            .lock()
            .expect("cluster ledger fence mutex must not be poisoned") = renewed.clone();
        Ok(renewed)
    }

    pub async fn state(&self) -> Result<ReplayState, LedgerError> {
        self.read_state(FaultContext::Recovery).await
    }

    pub(crate) async fn validated_state(
        &self,
        context: FaultContext,
    ) -> Result<ReplayState, LedgerError> {
        self.store
            .check_fence(&self.fence())
            .await
            .map_err(|error| self.store_error(context, error))?;
        self.read_state(context).await
    }

    async fn read_state(&self, context: FaultContext) -> Result<ReplayState, LedgerError> {
        let snapshot = self
            .store
            .read_prefix(&self.resource, None)
            .await
            .map_err(|error| self.store_error(context, error))?;
        replay::replay(&snapshot, &self.resource).map_err(|error| self.replay_error(context, error))
    }

    pub async fn remove_terminal(&self) -> Result<(), LedgerError> {
        let state = self.state().await?;
        if state.terminal_outcome.is_none() {
            return Err(self.domain_error(FaultContext::Cleanup, LedgerErrorKind::TerminalRequired));
        }
        self.store
            .remove(&self.resource, &self.fence(), state.position)
            .await
            .map_err(|error| self.store_error(FaultContext::Cleanup, error))
    }

    pub(crate) async fn receipt(
        &self,
        context: FaultContext,
        key: &IdempotencyId,
    ) -> Result<Option<MutationReceipt>, LedgerError> {
        self.validated_receipt(context, key).await
    }

    async fn validated_receipt(
        &self,
        context: FaultContext,
        key: &IdempotencyId,
    ) -> Result<Option<MutationReceipt>, LedgerError> {
        Ok(self
            .validated_state(context)
            .await?
            .mutation_receipts
            .get(key)
            .cloned())
    }

    pub(crate) fn domain_error(&self, context: FaultContext, kind: LedgerErrorKind) -> LedgerError {
        let evidence = match kind {
            LedgerErrorKind::BoundViolation => EvidenceClass::ResourceExhausted,
            LedgerErrorKind::IdempotencyConflict
            | LedgerErrorKind::InvalidLifecycle
            | LedgerErrorKind::InvalidSettlement
            | LedgerErrorKind::TerminalRequired => EvidenceClass::InvariantViolation,
            LedgerErrorKind::ReceiptCorrupt | LedgerErrorKind::Encoding => {
                EvidenceClass::IntegrityFailure
            }
            LedgerErrorKind::Storage(_) | LedgerErrorKind::Replay(_) => {
                EvidenceClass::IntegrityFailure
            }
        };
        let module = if matches!(
            kind,
            LedgerErrorKind::Storage(_) | LedgerErrorKind::ReceiptCorrupt
        ) {
            FaultModule::Storage
        } else {
            FaultModule::Engine
        };
        let fault = FaultFactory::new(self.observations.as_ref())
            .create(ModuleEvidence::new(module, context, evidence));
        LedgerError { kind, fault }
    }

    fn store_error(&self, context: FaultContext, error: StoreError) -> LedgerError {
        map_store_error(self.observations.as_ref(), context, error)
    }

    fn replay_error(&self, context: FaultContext, error: ReplayError) -> LedgerError {
        let fault = FaultFactory::new(self.observations.as_ref()).create(ModuleEvidence::new(
            FaultModule::Storage,
            context,
            EvidenceClass::IntegrityFailure,
        ));
        LedgerError {
            kind: LedgerErrorKind::Replay(error),
            fault,
        }
    }
}
