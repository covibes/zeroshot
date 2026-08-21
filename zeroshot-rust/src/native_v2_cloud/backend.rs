use super::*;

#[async_trait]
impl ClusterBackend for NativeV2CloudController {
    async fn initialize(
        &self,
        _context: &ConnectionContext,
        _params: InitializeParams,
    ) -> Result<InitializeResult, BackendError> {
        let graph_profiles = GraphProfileSet::new(vec![GraphProfile::Full])
            .map_err(|_| BackendError::new(INTERNAL_ERROR_CODE, "invalid capability set"))?;
        Ok(InitializeResult::new(
            ServerCapabilities {
                graph_profiles,
                logs: true,
                agent_attach: true,
            },
            ClusterStatus::empty(),
        ))
    }

    async fn get(
        &self,
        _context: &ConnectionContext,
        _params: GetParams,
    ) -> Result<GetResult, BackendError> {
        Ok(GetResult::empty())
    }

    async fn run_submit(
        &self,
        _context: &ConnectionContext,
        params: RunSubmitParams,
    ) -> Result<RunSubmitResult, BackendError> {
        let receipt = self.submit(params).await.map_err(cloud_backend_error)?;
        Ok(RunSubmitResult {
            run_id: receipt.run_id,
        })
    }

    async fn run_list(
        &self,
        _context: &ConnectionContext,
        _params: RunListParams,
    ) -> Result<RunListResult, BackendError> {
        let summaries = self.list().await.map_err(cloud_backend_error)?;
        let mut runs = Vec::with_capacity(summaries.len());
        for summary in summaries {
            runs.push(
                self.status(RunStatusParams {
                    run_id: summary.run_id,
                })
                .await
                .map_err(cloud_backend_error)?,
            );
        }
        Ok(RunListResult { runs })
    }

    async fn run_status(
        &self,
        _context: &ConnectionContext,
        params: RunStatusParams,
    ) -> Result<RunStatusResult, BackendError> {
        self.status(params).await.map_err(cloud_backend_error)
    }

    async fn run_watch(
        &self,
        _context: &ConnectionContext,
        params: RunWatchParams,
    ) -> Result<(RunWatchResult, RunWatchEventStream), BackendError> {
        let (result, source) = self.watch(params).await.map_err(cloud_backend_error)?;
        Ok((result, RunSubscriptionStream::new(WatchSource(source))))
    }

    async fn run_logs(
        &self,
        _context: &ConnectionContext,
        params: RunLogsParams,
    ) -> Result<(RunLogsResult, RunLogEventStream), BackendError> {
        let (result, source) = self.logs(params).await.map_err(cloud_backend_error)?;
        Ok((result, RunSubscriptionStream::new(LogsSource(source))))
    }

    async fn run_attach(
        &self,
        _context: &ConnectionContext,
        params: RunAttachParams,
    ) -> Result<(RunAttachResult, RunAttachEventStream), BackendError> {
        let (result, source) = self.attach(params).await.map_err(cloud_backend_error)?;
        Ok((result, RunSubscriptionStream::new(AttachSource(source))))
    }

    async fn run_force(
        &self,
        _context: &ConnectionContext,
        params: RunForceParams,
    ) -> Result<RunForceResult, BackendError> {
        self.force(params).await.map_err(cloud_backend_error)
    }
}

struct WatchSource(RunWatchSubscription);

#[async_trait]
impl RunSubscriptionSource<RunWatchEventNotification> for WatchSource {
    async fn next(&mut self) -> Option<RunSubscriptionItem<RunWatchEventNotification>> {
        match self.0.recv().await {
            Ok(Some(event)) => Some(RunSubscriptionItem::Event(event)),
            Ok(None) | Err(_) => Some(RunSubscriptionItem::Closed {
                reason: SubscriptionCloseReason::Done,
            }),
        }
    }
}

struct LogsSource(RunLogsSubscription);

#[async_trait]
impl RunSubscriptionSource<RunLogEventNotification> for LogsSource {
    async fn next(&mut self) -> Option<RunSubscriptionItem<RunLogEventNotification>> {
        match self.0.recv().await {
            Ok(Some(event)) => Some(RunSubscriptionItem::Event(event)),
            Ok(None) | Err(_) => Some(RunSubscriptionItem::Closed {
                reason: SubscriptionCloseReason::Done,
            }),
        }
    }
}

struct AttachSource(RunAttachSubscription);

#[async_trait]
impl RunSubscriptionSource<RunAttachEventNotification> for AttachSource {
    async fn next(&mut self) -> Option<RunSubscriptionItem<RunAttachEventNotification>> {
        match self.0.recv().await {
            Ok(event) => Some(RunSubscriptionItem::Event(event)),
            Err(NativeV2ObservationError::AttachLagged) => Some(RunSubscriptionItem::Closed {
                reason: SubscriptionCloseReason::SlowConsumer,
            }),
            Err(_) => Some(RunSubscriptionItem::Closed {
                reason: SubscriptionCloseReason::Done,
            }),
        }
    }
}

fn cloud_backend_error(error: NativeV2CloudError) -> BackendError {
    match error {
        NativeV2CloudError::Admission(error) => {
            BackendError::invalid_params(GRAPH_INVALID, error.to_string(), None)
        }
        NativeV2CloudError::Ledger(RunLedgerError::SubmissionConflict { existing_run_id }) => {
            BackendError::application(
                IDEMPOTENCY_REUSE,
                "submission key identifies another run",
                Some(serde_json::json!({ "runId": existing_run_id })),
            )
        }
        NativeV2CloudError::Ledger(RunLedgerError::RunNotFound)
        | NativeV2CloudError::Observation(NativeV2ObservationError::RunNotFound) => {
            BackendError::application(NOT_FOUND, "run was not found", None)
        }
        NativeV2CloudError::Observation(NativeV2ObservationError::ExecutionNotFound) => {
            BackendError::application(NOT_FOUND, "execution was not found", None)
        }
        NativeV2CloudError::Observation(
            NativeV2ObservationError::ExecutionNotActive
            | NativeV2ObservationError::ExecutionNotLive,
        ) => BackendError::application(GONE, "execution is no longer active", None),
        _ => BackendError::new(INTERNAL_ERROR_CODE, "native-v2 operation failed"),
    }
}

pub(crate) fn submission_digest(
    submission: &RunSubmission,
) -> Result<Sha256Digest, NativeV2CloudError> {
    let bytes =
        serde_json::to_vec(submission).map_err(|_| NativeV2CloudError::SubmissionIdentity)?;
    Sha256Digest::new(format!("{:x}", Sha256::digest(bytes)))
        .map_err(|_| NativeV2CloudError::SubmissionIdentity)
}

pub(super) async fn append_runtime_lost(
    ledger: &dyn RunLedger,
    stored: &StoredRun,
) -> Result<(), RunLedgerError> {
    append_terminal_failure(ledger, stored, "runtime_lost").await
}

pub(super) async fn append_terminal_failure(
    ledger: &dyn RunLedger,
    stored: &StoredRun,
    reason: &str,
) -> Result<(), RunLedgerError> {
    if stored.snapshot.terminal.is_some() {
        return Ok(());
    }
    let mut events = stored
        .snapshot
        .active_executions()
        .map(|node| RunEvent::NodeCompleted {
            completion: NodeCompletion {
                reference: node.reference.clone(),
                outcome: WorkerOutcome::declared_failure(WorkerErrorCode::Crash),
            },
        })
        .collect::<Vec<_>>();
    events.push(RunEvent::Terminal {
        result: TerminalResult::Failed {
            reason: EnumLabel::new(reason).map_err(|_| RunLedgerError::Corrupt)?,
        },
    });
    ledger.append(&stored.snapshot.run_id, events).await?;
    Ok(())
}

#[cfg(test)]
mod backend_error_tests {
    use super::*;

    #[test]
    fn attach_lookup_failures_are_public_application_errors() {
        for (source, code) in [
            (NativeV2ObservationError::ExecutionNotFound, NOT_FOUND),
            (NativeV2ObservationError::ExecutionNotActive, GONE),
            (NativeV2ObservationError::ExecutionNotLive, GONE),
        ] {
            let error = cloud_backend_error(NativeV2CloudError::Observation(source));
            assert_eq!(error.code, code);
            assert!(error.details.is_none());
        }
    }
}
