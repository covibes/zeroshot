//! Direct production composition for one narrow native cluster.

#[path = "native_execution.rs"]
mod native_execution;
#[path = "native_worker_protocol.rs"]
mod native_worker_protocol;
#[doc(hidden)]
pub use native_worker_protocol::{run_deterministic_worker, WORKER_MODE as NATIVE_WORKER_MODE};

use std::num::NonZeroU64;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use async_trait::async_trait;
use openengine_cluster_protocol::{
    canonical_value_bytes, ApplyParams, ApplyResult, GetParams, GetResult, GraphSpec,
    InitializeParams, InitializeResult, PlanParams, PlanResult, INTERNAL_ERROR_CODE,
};
use openengine_cluster_server::admission::AdmissionCoordinator;
use openengine_cluster_server::admission::GraphVerifier;
use openengine_cluster_server::{BackendError, ClusterBackend, ConnectionContext};
use thiserror::Error;

use crate::cluster_ledger::adapters::{AdmissionRecordContext, ClusterLedgerAdapters};
use crate::cluster_ledger::record::CanonicalDigest;
use crate::cluster_ledger::store::sqlite::SqliteLedgerStore;
use crate::cluster_ledger::store::{LedgerClock, StoreError, SystemLedgerClock};
use crate::cluster_ledger::{ClusterLedger, LedgerError, LedgerErrorKind, OwnerId, ResourceId};
use self::native_execution::{
    is_worker_free_graph, NativeExecutionCoordinator, NativeExecutionError, NativeExecutionProcess,
    NativeExecutionRegistry, NativeGraphVerifier,
};
use crate::{NativeBackendFactory, ProductionNativeBackendFactory};

pub const NATIVE_FENCE_TTL_MS: u64 = 2_000;
pub const NATIVE_FENCE_RENEW_INTERVAL_MS: u64 = 500;
const NATIVE_RUN_TIMEOUT_MS: u64 = 60 * 60 * 1_000;

type NativeAdmissionCoordinator = AdmissionCoordinator<NativeGraphVerifier, ClusterLedgerAdapters>;

#[derive(Clone)]
pub struct NativeBackend {
    admission: NativeAdmissionCoordinator,
    execution: NativeExecutionCoordinator,
    ledger: ClusterLedger,
    lease_healthy: Arc<AtomicBool>,
}

impl NativeBackend {
    fn new(
        admission: NativeAdmissionCoordinator,
        execution: NativeExecutionCoordinator,
        ledger: ClusterLedger,
        lease_healthy: Arc<AtomicBool>,
    ) -> Self {
        Self {
            admission,
            execution,
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

    fn execution_error(error: NativeExecutionError) -> BackendError {
        let _ = error;
        BackendError::new(INTERNAL_ERROR_CODE, "native deterministic execution failed")
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
        self.execution
            .terminal_result()
            .await
            .map_err(Self::execution_error)?;
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
        let dry_run = params.dry_run;
        let result = self.admission.apply_admission(context, params).await;
        self.require_lease().await?;
        let result = result?;
        if !dry_run {
            self.execution
                .drive()
                .await
                .map_err(Self::execution_error)?;
            self.require_lease().await?;
        }
        Ok(result)
    }

    async fn get(
        &self,
        context: &ConnectionContext,
        params: GetParams,
    ) -> Result<GetResult, BackendError> {
        self.require_lease().await?;
        let terminal_result = self
            .execution
            .terminal_result()
            .await
            .map_err(Self::execution_error)?;
        let result = self
            .admission
            .get_admission(context, params)
            .await
            .map(|mut result| {
                result.terminal_result = terminal_result;
                result
            });
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
    #[error("native execution program is unavailable")]
    Executable,
    #[error("native execution state is invalid")]
    Execution,
}

async fn validate_predecessor_state(
    state: &crate::cluster_ledger::ReplayState,
    verifier: &NativeGraphVerifier,
) -> Result<bool, NativeAdmissionOpenError> {
    let Some(admission) = state.admission.as_ref() else {
        return Ok(true);
    };
    let (catalog, profile) = NativeExecutionRegistry::predecessor_digests();
    if admission.catalog_digest != catalog || admission.profile_digest != profile {
        return Ok(false);
    }
    let (graph, compiled, graph_bytes) = reverify_predecessor(admission, verifier).await?;
    if !is_worker_free_graph(&graph) {
        return Ok(false);
    }
    let Some(verified_input) = state.verified_inputs.get(&admission.run) else {
        return Ok(false);
    };
    Ok([
        compiled == admission.canonical_compiled_ir,
        graph_bytes == admission.canonical_graph,
        CanonicalDigest::of(&graph_bytes) == admission.graph_digest,
        verified_input.digest == admission.input_digest,
        CanonicalDigest::of(&verified_input.canonical_bytes) == admission.input_digest,
    ]
    .into_iter()
    .all(|matches| matches))
}

async fn reverify_predecessor(
    admission: &crate::cluster_ledger::replay::AdmissionState,
    verifier: &NativeGraphVerifier,
) -> Result<(GraphSpec, Vec<u8>, Vec<u8>), NativeAdmissionOpenError> {
    let graph: GraphSpec = serde_json::from_slice(&admission.canonical_graph)
        .map_err(|_| NativeAdmissionOpenError::CompositionMismatch)?;
    let verified = verifier
        .verify(&graph)
        .await
        .map_err(|_| NativeAdmissionOpenError::CompositionMismatch)?;
    let compiled = verified
        .compiled_ir
        .canonical_bytes()
        .map_err(|_| NativeAdmissionOpenError::CompositionMismatch)?;
    let value =
        serde_json::to_value(&graph).map_err(|_| NativeAdmissionOpenError::CompositionMismatch)?;
    let graph_bytes =
        canonical_value_bytes(&value).map_err(|_| NativeAdmissionOpenError::CompositionMismatch)?;
    Ok((graph, compiled, graph_bytes))
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

        let registry = NativeExecutionRegistry::production();
        let verifier = Arc::new(NativeGraphVerifier::new(registry.clone()));
        let recovered = ledger.state().await?;
        if !registry.matches_current(&recovered)
            && !validate_predecessor_state(&recovered, verifier.as_ref()).await?
        {
            return Err(NativeAdmissionOpenError::CompositionMismatch);
        }
        let admission_context = AdmissionRecordContext::new(
            registry.catalog_digest(),
            registry.profile_digest(),
            clock,
            NonZeroU64::new(NATIVE_RUN_TIMEOUT_MS).expect("native run timeout must be non-zero"),
        );
        let adapters = ClusterLedgerAdapters::new(ledger.clone(), admission_context);
        let coordinator = AdmissionCoordinator::from_shared(verifier.clone(), Arc::new(adapters));
        let executable =
            std::env::current_exe().map_err(|_| NativeAdmissionOpenError::Executable)?;
        let execution = NativeExecutionCoordinator::new(
            ledger.clone(),
            verifier,
            registry,
            NativeExecutionProcess {
                state_dir: state_dir.to_path_buf(),
                executable,
            },
        );
        execution
            .validate_open_state()
            .await
            .map_err(|_| NativeAdmissionOpenError::Execution)?;
        let lease_healthy = Arc::new(AtomicBool::new(true));
        Ok(Self {
            backend: NativeBackend::new(coordinator, execution, ledger, lease_healthy),
        })
    }

    #[must_use]
    pub fn ledger(&self) -> &ClusterLedger {
        &self.backend.ledger
    }

    pub fn mark_lease_lost(&self) {
        self.backend.mark_lease_lost();
    }

    pub async fn recover_pending(&self) -> Result<(), NativeAdmissionOpenError> {
        self.backend
            .execution
            .recover_pending()
            .await
            .map_err(|_| NativeAdmissionOpenError::Execution)?;
        Ok(())
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
    use openengine_cluster_protocol::GraphSpec;
    use serde_json::json;

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
