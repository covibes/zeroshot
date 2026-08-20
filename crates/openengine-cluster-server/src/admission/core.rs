use super::*;

fn checked_graph_diff(
    previous: Option<&openengine_cluster_protocol::CompiledGraphIr>,
    next: &openengine_cluster_protocol::CompiledGraphIr,
) -> Result<openengine_cluster_protocol::GraphDiff, BackendError> {
    diff_compiled_graphs(previous, next).map_err(|error| {
        BackendError::application(
            GRAPH_INVALID,
            "Graph verifier returned invalid compiled IR",
            Some(json!({ "reason": error.to_string() })),
        )
    })
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
                checked_graph_diff(None, &verified.compiled_ir)?;
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
        let idempotency_key = params.idempotency_key.ok_or_else(|| {
            BackendError::new(
                INTERNAL_ERROR_CODE,
                "Committed apply mode requires an idempotency key",
            )
        })?;
        let proposal = CommitProposal {
            graph: params.graph,
            compiled_ir: verified.compiled_ir,
            input: params.input,
            if_generation: params.if_generation,
            idempotency_key,
            fingerprint,
        };
        self.store
            .commit(proposal, &context.cancellation)
            .await
            .map_err(store_error_to_backend)
    }

    async fn finish_apply(
        &self,
        context: &ConnectionContext,
        prepared: PreparedCommit,
        diff: openengine_cluster_protocol::GraphDiff,
    ) -> Result<ApplyResult, BackendError> {
        if prepared.params.dry_run {
            return Ok(ApplyResult {
                generation: prepared.snapshot.control.generation,
                run_id: prepared.snapshot.control.run_id,
                phase: prepared.snapshot.control.phase,
                deduped: false,
                diff: Some(diff),
            });
        }
        self.commit_verified(context, prepared).await
    }

    async fn precheck_generation_or_replay(
        &self,
        params: &ApplyParams,
        fingerprint: &RequestFingerprint,
        current: Option<openengine_cluster_protocol::Generation>,
    ) -> Result<Option<ApplyResult>, BackendError> {
        let Err(generation_error) = precheck_generation(params.if_generation, current) else {
            return Ok(None);
        };
        // The receipt and snapshot are one atomic store commit. If a concurrent request won
        // between the first receipt lookup and this snapshot read, replay (or conflicting reuse)
        // retains precedence over its resulting generation change.
        if let Some(receipt) = self.replay_apply(params, fingerprint).await? {
            return Ok(Some(receipt));
        }
        Err(generation_error)
    }

    /// Initializes the admission-only surface without requiring an observation/watch port.
    pub async fn initialize_admission(
        &self,
        _context: &ConnectionContext,
        _params: InitializeParams,
    ) -> Result<InitializeResult, BackendError> {
        let (snapshot, lifecycle) = self.read_valid_snapshot().await?;
        Ok(InitializeResult::new(
            ServerCapabilities {
                logs: self.log_store.is_some(),
                ..ServerCapabilities::default()
            },
            snapshot.control.status_with_lifecycle(&lifecycle),
        ))
    }

    /// Plans one graph without requiring an observation/watch port.
    pub async fn plan_admission(
        &self,
        _context: &ConnectionContext,
        params: PlanParams,
    ) -> Result<PlanResult, BackendError> {
        match self.verifier.verify(&params.graph).await {
            Ok(verified) => {
                checked_graph_diff(None, &verified.compiled_ir)?;
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

    /// Applies one verified graph without requiring an observation/watch port.
    pub async fn apply_admission(
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
        if let Some(receipt) = self
            .precheck_generation_or_replay(&params, &fingerprint, snapshot.control.generation)
            .await?
        {
            return Ok(receipt);
        }
        let diff =
            checked_graph_diff(snapshot.control.compiled_ir.as_ref(), &verified.compiled_ir)?;
        self.finish_apply(
            context,
            PreparedCommit {
                params,
                fingerprint,
                verified,
                snapshot,
            },
            diff,
        )
        .await
    }

    /// Reads authoritative admission state without requiring an observation/watch port.
    pub async fn get_admission(
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
            terminal_result: None,
        })
    }
}
