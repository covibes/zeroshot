//! Direct production composition for one admission-only native cluster.

use std::num::NonZeroU64;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use async_trait::async_trait;
use openengine_cluster_protocol::{
    canonical_value_bytes, ApplyParams, ApplyResult, GetParams, GetResult, InitializeParams,
    InitializeResult, PlanParams, PlanResult, WorkerDescriptor, WorkerRef, INTERNAL_ERROR_CODE,
};
use openengine_cluster_server::admission::AdmissionCoordinator;
use openengine_cluster_server::graph_verifier::ProductionGraphVerifier;
use openengine_cluster_server::worker_registry::{WorkerRegistry, WorkerRegistryError};
use openengine_cluster_server::{BackendError, ClusterBackend, ConnectionContext};
use serde::Serialize;
use thiserror::Error;

use crate::cluster_ledger::adapters::{AdmissionRecordContext, ClusterLedgerAdapters};
use crate::cluster_ledger::record::CanonicalDigest;
use crate::cluster_ledger::store::sqlite::SqliteLedgerStore;
use crate::cluster_ledger::store::{LedgerClock, StoreError, SystemLedgerClock};
use crate::cluster_ledger::{ClusterLedger, LedgerError, LedgerErrorKind, OwnerId, ResourceId};
use crate::{NativeBackendFactory, ProductionNativeBackendFactory};

pub const NATIVE_FENCE_TTL_MS: u64 = 2_000;
pub const NATIVE_FENCE_RENEW_INTERVAL_MS: u64 = 500;
const NATIVE_RUN_TIMEOUT_MS: u64 = 60 * 60 * 1_000;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeCatalogSnapshot<'a> {
    version: u8,
    workers: &'a [WorkerDescriptor],
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeProfileSnapshot<'a> {
    descriptors: &'a [WorkerDescriptor],
}

#[derive(Clone, Debug)]
struct NativeAdmissionRegistry {
    descriptors: Arc<[WorkerDescriptor]>,
    catalog_digest: CanonicalDigest,
    profile_digest: CanonicalDigest,
}

impl NativeAdmissionRegistry {
    fn empty() -> Self {
        let descriptors: Arc<[WorkerDescriptor]> = Arc::from([]);
        let catalog = canonical_value_bytes(
            &serde_json::to_value(NativeCatalogSnapshot {
                version: 1,
                workers: &descriptors,
            })
            .expect("native catalog snapshot must serialize"),
        )
        .expect("native catalog snapshot must canonicalize");
        let profile = canonical_value_bytes(
            &serde_json::to_value(NativeProfileSnapshot {
                descriptors: &descriptors,
            })
            .expect("native profile snapshot must serialize"),
        )
        .expect("native profile snapshot must canonicalize");
        Self {
            descriptors,
            catalog_digest: CanonicalDigest::of(&catalog),
            profile_digest: CanonicalDigest::of(&profile),
        }
    }

    fn matches(&self, admission: &crate::cluster_ledger::replay::AdmissionState) -> bool {
        admission.catalog_digest == self.catalog_digest
            && admission.profile_digest == self.profile_digest
    }
}

#[async_trait]
impl WorkerRegistry for NativeAdmissionRegistry {
    async fn resolve(&self, worker: &WorkerRef) -> Result<WorkerDescriptor, WorkerRegistryError> {
        self.descriptors
            .iter()
            .find(|descriptor| descriptor.worker == *worker)
            .cloned()
            .ok_or_else(|| WorkerRegistryError::NotFound {
                worker: worker.clone(),
            })
    }
}

type NativeAdmissionCoordinator =
    AdmissionCoordinator<ProductionGraphVerifier<NativeAdmissionRegistry>, ClusterLedgerAdapters>;

#[derive(Clone)]
pub struct NativeBackend {
    admission: NativeAdmissionCoordinator,
    ledger: ClusterLedger,
    lease_healthy: Arc<AtomicBool>,
}

impl NativeBackend {
    fn new(
        admission: NativeAdmissionCoordinator,
        ledger: ClusterLedger,
        lease_healthy: Arc<AtomicBool>,
    ) -> Self {
        Self {
            admission,
            ledger,
            lease_healthy,
        }
    }

    async fn require_lease(&self) -> Result<(), BackendError> {
        if self.lease_healthy.load(Ordering::Acquire) && self.ledger.check_fence().await.is_ok() {
            return Ok(());
        }
        self.mark_lease_lost();
        Err(BackendError::new(
            INTERNAL_ERROR_CODE,
            "native cluster lease is unavailable",
        ))
    }

    fn mark_lease_lost(&self) {
        self.lease_healthy.store(false, Ordering::Release);
    }
}

#[async_trait]
impl ClusterBackend for NativeBackend {
    async fn initialize(
        &self,
        context: &ConnectionContext,
        params: InitializeParams,
    ) -> Result<InitializeResult, BackendError> {
        self.require_lease().await?;
        let result = self.admission.initialize_admission(context, params).await;
        self.require_lease().await?;
        result
    }

    async fn plan(
        &self,
        context: &ConnectionContext,
        params: PlanParams,
    ) -> Result<PlanResult, BackendError> {
        self.require_lease().await?;
        let result = self.admission.plan_admission(context, params).await;
        self.require_lease().await?;
        result
    }

    async fn apply(
        &self,
        context: &ConnectionContext,
        params: ApplyParams,
    ) -> Result<ApplyResult, BackendError> {
        self.require_lease().await?;
        let result = self.admission.apply_admission(context, params).await;
        self.require_lease().await?;
        result
    }

    async fn get(
        &self,
        context: &ConnectionContext,
        params: GetParams,
    ) -> Result<GetResult, BackendError> {
        self.require_lease().await?;
        let result = self.admission.get_admission(context, params).await;
        self.require_lease().await?;
        result
    }
}

#[derive(Debug, Error)]
pub enum NativeAdmissionOpenError {
    #[error("native admission storage failed: {0}")]
    Store(#[from] StoreError),
    #[error("native admission ledger failed: {0}")]
    Ledger(#[from] LedgerError),
    #[error("native admission identity does not match durable state")]
    CompositionMismatch,
}

async fn create_or_reopen_raced_resource(
    store: Arc<dyn crate::cluster_ledger::LedgerStore>,
    resource: ResourceId,
    owner: OwnerId,
) -> Result<ClusterLedger, LedgerError> {
    match ClusterLedger::create(
        Arc::clone(&store),
        resource.clone(),
        owner.clone(),
        NATIVE_FENCE_TTL_MS,
    )
    .await
    {
        Ok(ledger) => Ok(ledger),
        Err(error)
            if matches!(
                error.kind(),
                LedgerErrorKind::Storage(StoreError::ResourceExists)
            ) =>
        {
            ClusterLedger::open(store, resource, owner, NATIVE_FENCE_TTL_MS).await
        }
        Err(error) => Err(error),
    }
}

async fn open_or_create_ledger(
    store: Arc<dyn crate::cluster_ledger::LedgerStore>,
    resource: ResourceId,
    owner: OwnerId,
) -> Result<ClusterLedger, LedgerError> {
    match ClusterLedger::open(
        Arc::clone(&store),
        resource.clone(),
        owner.clone(),
        NATIVE_FENCE_TTL_MS,
    )
    .await
    {
        Ok(ledger) => Ok(ledger),
        Err(error)
            if matches!(
                error.kind(),
                LedgerErrorKind::Storage(StoreError::ResourceNotFound)
            ) =>
        {
            create_or_reopen_raced_resource(store, resource, owner).await
        }
        Err(error) => Err(error),
    }
}

impl ProductionNativeBackendFactory {
    pub async fn open(
        state_dir: &Path,
        resource: ResourceId,
        owner: OwnerId,
    ) -> Result<Self, NativeAdmissionOpenError> {
        let clock: Arc<dyn LedgerClock> = Arc::new(SystemLedgerClock);
        Self::open_with_clock(state_dir, resource, owner, clock).await
    }

    async fn open_with_clock(
        state_dir: &Path,
        resource: ResourceId,
        owner: OwnerId,
        clock: Arc<dyn LedgerClock>,
    ) -> Result<Self, NativeAdmissionOpenError> {
        let store = Arc::new(SqliteLedgerStore::with_clock(
            state_dir,
            Arc::clone(&clock),
        )?);
        let store_port: Arc<dyn crate::cluster_ledger::LedgerStore> = store;
        let ledger = open_or_create_ledger(store_port, resource, owner).await?;

        let registry = NativeAdmissionRegistry::empty();
        let recovered = ledger.state().await?;
        if recovered
            .admission
            .as_ref()
            .is_some_and(|admission| !registry.matches(admission))
        {
            return Err(NativeAdmissionOpenError::CompositionMismatch);
        }
        let admission_context = AdmissionRecordContext::new(
            registry.catalog_digest,
            registry.profile_digest,
            clock,
            NonZeroU64::new(NATIVE_RUN_TIMEOUT_MS).expect("native run timeout must be non-zero"),
        );
        let adapters = ClusterLedgerAdapters::new(ledger.clone(), admission_context);
        let coordinator =
            AdmissionCoordinator::new(ProductionGraphVerifier::new(registry), adapters);
        let lease_healthy = Arc::new(AtomicBool::new(true));
        Ok(Self {
            backend: NativeBackend::new(coordinator, ledger, lease_healthy),
        })
    }

    #[must_use]
    pub fn ledger(&self) -> &ClusterLedger {
        &self.backend.ledger
    }

    pub fn mark_lease_lost(&self) {
        self.backend.mark_lease_lost();
    }
}

impl NativeBackendFactory for ProductionNativeBackendFactory {
    type Backend = NativeBackend;

    fn create(&self) -> Self::Backend {
        self.backend.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cluster_ledger::store::fake::ManualLedgerClock;
    use openengine_cluster_protocol::{Generation, GraphSpec, IdempotencyKey};
    use serde_json::{json, Value};

    #[tokio::test]
    async fn direct_composition_reads_its_committed_snapshot() {
        let root =
            std::env::temp_dir().join(format!("zeroshot-native-direct-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let factory = ProductionNativeBackendFactory::open(
            &root,
            ResourceId::new("direct").unwrap(),
            OwnerId::new("direct-owner").unwrap(),
        )
        .await
        .unwrap();
        let backend = factory.create();
        let graph: GraphSpec = serde_json::from_value(json!({
            "profile": "openengine.graph.full/v1",
            "initialInput": {"kind": "null"},
            "policy": {"policy": "policy.default@1", "default": "deny"},
            "root": {"kind": "succeed", "name": "done", "output": {"kind": "null"}, "bindings": []}
        }))
        .unwrap();
        backend
            .apply(
                &ConnectionContext::default(),
                ApplyParams {
                    graph,
                    input: Some(Value::Null),
                    dry_run: false,
                    if_generation: Some(Generation::new(0).unwrap()),
                    idempotency_key: Some(IdempotencyKey::new("direct-apply").unwrap()),
                },
            )
            .await
            .unwrap();
        let result = backend
            .get(&ConnectionContext::default(), GetParams::default())
            .await;
        assert!(result.is_ok(), "{result:?}");
        factory.ledger().release_fence().await.unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn pure_plan_fails_closed_after_the_authoritative_fence_expires() {
        let root = std::env::temp_dir().join(format!(
            "zeroshot-native-expired-plan-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        let clock = Arc::new(ManualLedgerClock::new(1_000));
        let ledger_clock: Arc<dyn LedgerClock> = clock.clone();
        let factory = ProductionNativeBackendFactory::open_with_clock(
            &root,
            ResourceId::new("expired-plan").unwrap(),
            OwnerId::new("expired-plan-owner").unwrap(),
            ledger_clock,
        )
        .await
        .unwrap();
        let backend = factory.create();
        clock.advance(NATIVE_FENCE_TTL_MS).unwrap();
        let graph: GraphSpec = serde_json::from_value(json!({
            "profile": "openengine.graph.full/v1",
            "initialInput": {"kind": "null"},
            "policy": {"policy": "policy.default@1", "default": "deny"},
            "root": {"kind": "succeed", "name": "done", "output": {"kind": "null"}, "bindings": []}
        }))
        .unwrap();

        assert!(
            backend
                .plan(&ConnectionContext::default(), PlanParams { graph })
                .await
                .is_err()
        );

        drop(backend);
        drop(factory);
        std::fs::remove_dir_all(root).unwrap();
    }
}
