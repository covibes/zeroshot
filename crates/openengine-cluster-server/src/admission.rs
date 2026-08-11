//! Backend-neutral admission orchestration and durable-store ports.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

mod core;
mod errors;
mod ports;
mod snapshot;
use errors::{
    cancelled_error, precheck_generation, precheck_input, schema_error, store_error_to_backend,
    validate_apply_mode,
};
pub use ports::*;
use snapshot::validate_snapshot;

use async_trait::async_trait;
use openengine_cluster_protocol::{
    diff_compiled_graphs, ApplyParams, ApplyResult, DeleteParams, DeleteResult, GetParams,
    GetResult, GraphSpec, IdempotencyKey, InitializeParams, InitializeResult, LogsParams,
    LogsResult, PlanParams, PlanResult, RequestFingerprint, ResubmitParams, ResubmitResult,
    RetryParams, RetryResult, ServerCapabilities, StopParams, StopResult, SubscriptionId,
    UpdateParams, UpdateResult, WatchParams, WatchResult, GRAPH_INVALID, IDEMPOTENCY_REUSE,
    INTERNAL_ERROR_CODE, INVALID_PHASE,
};
use serde_json::json;

use crate::lifecycle::{
    delete_fingerprint, method_fingerprint, resubmit_fingerprint, retry_fingerprint,
    stop_fingerprint, update_fingerprint, LifecycleSnapshot, MutationReceipt, RetryProposal,
    StopProposal, UpdateProposal,
};
use crate::logs::{LogEventStream, LogStore, LogsHandle};
use crate::watch::{ObservationStore, WatchEventStream, WatchHandle};
use crate::{BackendError, ClusterBackend, ConnectionContext};

pub struct AdmissionCoordinator<V, S> {
    verifier: Arc<V>,
    store: Arc<S>,
    next_subscription: Arc<AtomicU64>,
    log_store: Option<Arc<dyn LogStore>>,
}

struct PreparedCommit {
    params: ApplyParams,
    fingerprint: RequestFingerprint,
    verified: VerifiedGraph,
    snapshot: AdmissionSnapshot,
}

impl<V, S> Clone for AdmissionCoordinator<V, S> {
    fn clone(&self) -> Self {
        Self {
            verifier: Arc::clone(&self.verifier),
            store: Arc::clone(&self.store),
            next_subscription: Arc::clone(&self.next_subscription),
            log_store: self.log_store.clone(),
        }
    }
}

impl<V, S> AdmissionCoordinator<V, S> {
    #[must_use]
    pub fn new(verifier: V, store: S) -> Self {
        Self {
            verifier: Arc::new(verifier),
            store: Arc::new(store),
            next_subscription: Arc::new(AtomicU64::new(1)),
            log_store: None,
        }
    }

    #[must_use]
    pub fn from_shared(verifier: Arc<V>, store: Arc<S>) -> Self {
        Self {
            verifier,
            store,
            next_subscription: Arc::new(AtomicU64::new(1)),
            log_store: None,
        }
    }

    /// Injects an optional backend `logs` port. `ServerCapabilities.logs` is `true` if and only if
    /// this has been called: enabling/disabling this capability is a construction-time choice that
    /// changes no durable admission/lifecycle state.
    #[must_use]
    pub fn with_log_store(mut self, log_store: Arc<dyn LogStore>) -> Self {
        self.log_store = Some(log_store);
        self
    }

    #[must_use]
    pub fn store(&self) -> &Arc<S> {
        &self.store
    }

    #[must_use]
    pub fn verifier(&self) -> &Arc<V> {
        &self.verifier
    }
}

#[async_trait]
impl<V, S> ClusterBackend for AdmissionCoordinator<V, S>
where
    V: GraphVerifier,
    S: AdmissionStore + ObservationStore,
{
    async fn initialize(
        &self,
        context: &ConnectionContext,
        params: InitializeParams,
    ) -> Result<InitializeResult, BackendError> {
        self.initialize_admission(context, params).await
    }

    async fn plan(
        &self,
        context: &ConnectionContext,
        params: PlanParams,
    ) -> Result<PlanResult, BackendError> {
        self.plan_admission(context, params).await
    }

    async fn apply(
        &self,
        context: &ConnectionContext,
        params: ApplyParams,
    ) -> Result<ApplyResult, BackendError> {
        self.apply_admission(context, params).await
    }

    async fn get(
        &self,
        context: &ConnectionContext,
        params: GetParams,
    ) -> Result<GetResult, BackendError> {
        self.get_admission(context, params).await
    }

    async fn update(
        &self,
        _context: &ConnectionContext,
        params: UpdateParams,
    ) -> Result<UpdateResult, BackendError> {
        params.validate().map_err(schema_error)?;
        let fingerprint = update_fingerprint(&params)?;
        self.store
            .update_lifecycle(UpdateProposal {
                params,
                fingerprint,
            })
            .await
            .map_err(store_error_to_backend)
    }

    async fn stop(
        &self,
        _context: &ConnectionContext,
        params: StopParams,
    ) -> Result<StopResult, BackendError> {
        let fingerprint = stop_fingerprint(&params)?;
        self.store
            .stop_lifecycle(StopProposal {
                params,
                fingerprint,
            })
            .await
            .map_err(store_error_to_backend)
    }

    async fn retry(
        &self,
        _context: &ConnectionContext,
        params: RetryParams,
    ) -> Result<RetryResult, BackendError> {
        let fingerprint = retry_fingerprint(&params)?;
        self.store
            .retry_lifecycle(RetryProposal {
                params,
                fingerprint,
            })
            .await
            .map_err(store_error_to_backend)
    }

    async fn resubmit(
        &self,
        context: &ConnectionContext,
        params: ResubmitParams,
    ) -> Result<ResubmitResult, BackendError> {
        let fingerprint = resubmit_fingerprint(&params)?;
        if context.cancellation.is_cancelled() {
            return Err(cancelled_error());
        }
        self.store
            .resubmit(
                ResubmitProposal {
                    params,
                    fingerprint,
                },
                &context.cancellation,
            )
            .await
            .map_err(store_error_to_backend)
    }

    async fn delete(
        &self,
        context: &ConnectionContext,
        params: DeleteParams,
    ) -> Result<DeleteResult, BackendError> {
        let fingerprint = delete_fingerprint(&params)?;
        if context.cancellation.is_cancelled() {
            return Err(cancelled_error());
        }
        self.store
            .delete(
                DeleteProposal {
                    params,
                    fingerprint,
                },
                &context.cancellation,
            )
            .await
            .map_err(store_error_to_backend)
    }

    async fn watch(
        &self,
        _context: &ConnectionContext,
        params: WatchParams,
        queue_capacity: usize,
    ) -> Result<(WatchResult, WatchEventStream, WatchHandle), BackendError> {
        let subscription_id = SubscriptionId::new(format!(
            "sub-{}",
            self.next_subscription.fetch_add(1, Ordering::Relaxed)
        ));
        let store: Arc<dyn ObservationStore> = Arc::clone(&self.store) as Arc<dyn ObservationStore>;
        crate::watch::subscribe_and_stream(
            &store,
            crate::watch::SubscribeAndStreamRequest {
                subscription_id,
                params,
                queue_capacity,
            },
            store_error_to_backend,
        )
        .await
    }

    async fn logs(
        &self,
        _context: &ConnectionContext,
        params: LogsParams,
        queue_capacity: usize,
    ) -> Result<(LogsResult, LogEventStream, LogsHandle), BackendError> {
        let Some(log_store) = self.log_store.clone() else {
            return Err(BackendError::application(
                INVALID_PHASE,
                "Backend does not support logs",
                None,
            ));
        };
        let _ = params;
        let subscription_id = SubscriptionId::new(format!(
            "sub-{}",
            self.next_subscription.fetch_add(1, Ordering::Relaxed)
        ));
        Ok(
            crate::logs::subscribe_and_stream_logs(&log_store, subscription_id, queue_capacity)
                .await,
        )
    }
}
