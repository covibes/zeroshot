//! Backend-neutral admission orchestration and durable-store ports.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

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
    diff_compiled_graphs, ApplyParams, ApplyResult, GetParams, GetResult, GraphSpec,
    IdempotencyKey, InitializeParams, InitializeResult, PlanParams, PlanResult, RequestFingerprint,
    ResubmitParams, ResubmitResult, RetryParams, RetryResult, ServerCapabilities, StopParams,
    StopResult, SubscriptionId, UpdateParams, UpdateResult, WatchParams, WatchResult,
    GRAPH_INVALID, IDEMPOTENCY_REUSE, INTERNAL_ERROR_CODE, INVALID_PHASE,
};
use serde_json::json;

use crate::lifecycle::{
    method_fingerprint, resubmit_fingerprint, retry_fingerprint, stop_fingerprint,
    update_fingerprint, LifecycleSnapshot, MutationReceipt, RetryProposal, StopProposal,
    UpdateProposal,
};
use crate::watch::{ObservationStore, WatchEventStream, WatchHandle};
use crate::{BackendError, ClusterBackend, ConnectionContext};

pub struct AdmissionCoordinator<V, S> {
    verifier: Arc<V>,
    store: Arc<S>,
    next_subscription: Arc<AtomicU64>,
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
        }
    }

    #[must_use]
    pub fn from_shared(verifier: Arc<V>, store: Arc<S>) -> Self {
        Self {
            verifier,
            store,
            next_subscription: Arc::new(AtomicU64::new(1)),
        }
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

impl<V, S> AdmissionCoordinator<V, S>
where
    V: GraphVerifier,
    S: AdmissionStore,
{
    async fn read_valid_snapshot(
        &self,
    ) -> Result<(AdmissionSnapshot, LifecycleSnapshot), BackendError> {
        let (snapshot, lifecycle) = self
            .store
            .read_aggregate()
            .await
            .map_err(store_error_to_backend)?;
        validate_snapshot(&snapshot, &lifecycle)?;
        Ok((snapshot, lifecycle))
    }

    async fn verify_for_apply(&self, graph: &GraphSpec) -> Result<VerifiedGraph, BackendError> {
        match self.verifier.verify(graph).await {
            Ok(verified) => {
                diff_compiled_graphs(None, &verified.compiled_ir).map_err(|error| {
                    BackendError::application(
                        GRAPH_INVALID,
                        "Graph verifier returned invalid compiled IR",
                        Some(json!({ "reason": error.to_string() })),
                    )
                })?;
                Ok(verified)
            }
            Err(VerificationError::Rejected { diagnostics }) => Err(BackendError::application(
                GRAPH_INVALID,
                "Graph verification failed",
                Some(json!({ "diagnostics": diagnostics })),
            )),
            Err(VerificationError::Internal(message)) => {
                Err(BackendError::new(INTERNAL_ERROR_CODE, message))
            }
        }
    }

    async fn replay_if_known(
        &self,
        key: &IdempotencyKey,
        fingerprint: &RequestFingerprint,
    ) -> Result<Option<ApplyResult>, BackendError> {
        let record = self
            .store
            .lookup_idempotency(key)
            .await
            .map_err(store_error_to_backend)?;
        match record {
            Some(record) if record.fingerprint == *fingerprint => {
                let MutationReceipt::Apply(mut receipt) = record.receipt else {
                    return Err(BackendError::application(
                        IDEMPOTENCY_REUSE,
                        "Idempotency key was reused by a different method",
                        None,
                    ));
                };
                receipt.deduped = true;
                Ok(Some(receipt))
            }
            Some(_) => Err(BackendError::application(
                IDEMPOTENCY_REUSE,
                "Idempotency key was reused with different parameters",
                None,
            )),
            None => Ok(None),
        }
    }

    async fn replay_apply(
        &self,
        params: &ApplyParams,
        fingerprint: &RequestFingerprint,
    ) -> Result<Option<ApplyResult>, BackendError> {
        match &params.idempotency_key {
            Some(key) => self.replay_if_known(key, fingerprint).await,
            None => Ok(None),
        }
    }

    async fn commit_verified(
        &self,
        context: &ConnectionContext,
        prepared: PreparedCommit,
    ) -> Result<ApplyResult, BackendError> {
        let PreparedCommit {
            params,
            fingerprint,
            verified,
            snapshot,
        } = prepared;
        precheck_input(
            snapshot.control.compiled_ir.as_ref(),
            &verified.compiled_ir,
            &params.graph,
            params.input.as_ref(),
        )?;
        if context.cancellation.is_cancelled() {
            return Err(cancelled_error());
        }
        let proposal = CommitProposal {
            graph: params.graph,
            compiled_ir: verified.compiled_ir,
            input: params.input,
            if_generation: params.if_generation,
            idempotency_key: params
                .idempotency_key
                .expect("committed apply mode requires an idempotency key"),
            fingerprint,
        };
        self.store
            .commit(proposal, &context.cancellation)
            .await
            .map_err(store_error_to_backend)
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
        _context: &ConnectionContext,
        _params: InitializeParams,
    ) -> Result<InitializeResult, BackendError> {
        let (snapshot, lifecycle) = self.read_valid_snapshot().await?;
        Ok(InitializeResult::new(
            ServerCapabilities::default(),
            snapshot.control.status_with_lifecycle(&lifecycle),
        ))
    }

    async fn plan(
        &self,
        _context: &ConnectionContext,
        params: PlanParams,
    ) -> Result<PlanResult, BackendError> {
        match self.verifier.verify(&params.graph).await {
            Ok(verified) => {
                diff_compiled_graphs(None, &verified.compiled_ir).map_err(|error| {
                    BackendError::application(
                        GRAPH_INVALID,
                        "Graph verifier returned invalid compiled IR",
                        Some(json!({ "reason": error.to_string() })),
                    )
                })?;
                Ok(PlanResult {
                    ok: true,
                    diagnostics: verified.diagnostics,
                    bounds: Some(verified.compiled_ir.bounds),
                })
            }
            Err(VerificationError::Rejected { diagnostics }) => Ok(PlanResult {
                ok: false,
                diagnostics,
                bounds: None,
            }),
            Err(VerificationError::Internal(message)) => {
                Err(BackendError::new(INTERNAL_ERROR_CODE, message))
            }
        }
    }

    async fn apply(
        &self,
        context: &ConnectionContext,
        params: ApplyParams,
    ) -> Result<ApplyResult, BackendError> {
        validate_apply_mode(&params)?;
        let fingerprint = method_fingerprint("apply", &params)?;

        if let Some(receipt) = self.replay_apply(&params, &fingerprint).await? {
            return Ok(receipt);
        }

        let verified = self.verify_for_apply(&params.graph).await?;
        let (snapshot, _) = self.read_valid_snapshot().await?;
        precheck_generation(params.if_generation, snapshot.control.generation)?;

        let diff =
            diff_compiled_graphs(snapshot.control.compiled_ir.as_ref(), &verified.compiled_ir)
                .map_err(|error| {
                    BackendError::application(
                        GRAPH_INVALID,
                        "Graph verifier returned invalid compiled IR",
                        Some(json!({ "reason": error.to_string() })),
                    )
                })?;

        if params.dry_run {
            return Ok(ApplyResult {
                generation: snapshot.control.generation,
                run_id: snapshot.control.run_id,
                phase: snapshot.control.phase,
                deduped: false,
                diff: Some(diff),
            });
        }

        self.commit_verified(
            context,
            PreparedCommit {
                params,
                fingerprint,
                verified,
                snapshot,
            },
        )
        .await
    }

    async fn get(
        &self,
        _context: &ConnectionContext,
        params: GetParams,
    ) -> Result<GetResult, BackendError> {
        let (snapshot, lifecycle) = self.read_valid_snapshot().await?;
        if let Some(requested) = params.at_cursor {
            let current_cursor = lifecycle
                .latest_cursor
                .as_ref()
                .or(snapshot.control.cursor.as_ref());
            if current_cursor != Some(&requested) {
                return Err(BackendError::application(
                    INVALID_PHASE,
                    "Requested cursor is not available",
                    Some(json!({ "currentCursor": current_cursor })),
                ));
            }
        }
        let status = snapshot.control.status_with_lifecycle(&lifecycle);
        Ok(GetResult {
            spec: snapshot.control.spec,
            status,
            at_cursor: lifecycle.latest_cursor.or(snapshot.control.cursor),
        })
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
        // Replacement-input schema validation is safe to fail fast on: unlike generation/run CAS,
        // the admitted graph never changes as a side effect of resubmit, so this check's outcome
        // cannot differ between a first call and its idempotent replay. Generation/run/phase/
        // idempotency-replay checks are NOT duplicated here; they run once, atomically, inside
        // `store.resubmit` (mirroring `retry`/`update`/`stop`) so a replay is judged against the
        // request that was actually recorded rather than the coordinator's own pre-mutation read.
        if let Some(replacement_input) = params.replacement_input.as_ref() {
            let (snapshot, _) = self.read_valid_snapshot().await?;
            let graph = snapshot.control.spec.as_ref().ok_or_else(|| {
                BackendError::application(
                    INVALID_PHASE,
                    "Cluster has no admitted graph to validate replacement input against",
                    None,
                )
            })?;
            graph
                .initial_input
                .validate_value(replacement_input)
                .map_err(|error| schema_error(&error.to_string()))?;
        }
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
}
