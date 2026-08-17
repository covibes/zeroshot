use super::*;

pub struct RunWatchSubscription {
    pub(super) ledger: Arc<dyn RunLedger>,
    pub(super) subscription_id: SubscriptionId,
    pub(super) run_id: RunId,
    pub(super) scanned_through: Cursor,
    pub(super) projection: RunSnapshot,
    pub(super) pending: VecDeque<RunWatchEventNotification>,
}

impl RunWatchSubscription {
    /// Returns all status transitions currently durable after the exclusive resume cursor.
    pub async fn read_available(
        &mut self,
    ) -> Result<Vec<RunWatchEventNotification>, NativeV2ObservationError> {
        self.refresh().await?;
        Ok(self.pending.drain(..).collect())
    }

    /// Waits for the next durable status transition. Dropping this value only stops observation.
    pub async fn recv(
        &mut self,
    ) -> Result<Option<RunWatchEventNotification>, NativeV2ObservationError> {
        recv_durable(self).await
    }

    async fn refresh(&mut self) -> Result<bool, NativeV2ObservationError> {
        let tail = self
            .ledger
            .snapshot_and_tail(&self.run_id, Some(&self.scanned_through))
            .await?;
        WatchFold {
            subscription_id: &self.subscription_id,
            after: cursor_sequence(&self.scanned_through)?,
            projection: &mut self.projection,
            pending: &mut self.pending,
        }
        .apply(&tail.events)?;
        self.scanned_through = tail.snapshot.cursor;
        Ok(tail.snapshot.terminal.is_some())
    }
}

pub struct RunLogsSubscription {
    pub(super) ledger: Arc<dyn RunLedger>,
    pub(super) subscription_id: SubscriptionId,
    pub(super) run_id: RunId,
    pub(super) execution: Option<ExecutionId>,
    pub(super) scanned_through: Cursor,
    pub(super) pending: VecDeque<RunLogEventNotification>,
}

impl RunLogsSubscription {
    /// Returns every currently durable matching log strictly after the resume cursor.
    pub async fn read_available(
        &mut self,
    ) -> Result<Vec<RunLogEventNotification>, NativeV2ObservationError> {
        self.refresh().await?;
        Ok(self.pending.drain(..).collect())
    }

    pub async fn recv(
        &mut self,
    ) -> Result<Option<RunLogEventNotification>, NativeV2ObservationError> {
        recv_durable(self).await
    }

    async fn refresh(&mut self) -> Result<bool, NativeV2ObservationError> {
        let tail = self
            .ledger
            .snapshot_and_tail(&self.run_id, Some(&self.scanned_through))
            .await?;
        for stored in &tail.events {
            if let Some(notification) = log_notification(
                &self.subscription_id,
                &tail.snapshot,
                self.execution,
                stored,
            )? {
                self.pending.push_back(notification);
            }
        }
        self.scanned_through = tail.snapshot.cursor;
        Ok(tail.snapshot.terminal.is_some())
    }
}

#[async_trait]
trait DurableSubscription {
    type Notification: Send;

    fn pending(&mut self) -> &mut VecDeque<Self::Notification>;
    async fn refresh_subscription(&mut self) -> Result<bool, NativeV2ObservationError>;
}

#[async_trait]
impl DurableSubscription for RunWatchSubscription {
    type Notification = RunWatchEventNotification;

    fn pending(&mut self) -> &mut VecDeque<Self::Notification> {
        &mut self.pending
    }

    async fn refresh_subscription(&mut self) -> Result<bool, NativeV2ObservationError> {
        self.refresh().await
    }
}

#[async_trait]
impl DurableSubscription for RunLogsSubscription {
    type Notification = RunLogEventNotification;

    fn pending(&mut self) -> &mut VecDeque<Self::Notification> {
        &mut self.pending
    }

    async fn refresh_subscription(&mut self) -> Result<bool, NativeV2ObservationError> {
        self.refresh().await
    }
}

async fn recv_durable<S>(
    subscription: &mut S,
) -> Result<Option<S::Notification>, NativeV2ObservationError>
where
    S: DurableSubscription + Send,
{
    loop {
        if let Some(event) = subscription.pending().pop_front() {
            return Ok(Some(event));
        }
        let terminal = subscription.refresh_subscription().await?;
        if let Some(event) = subscription.pending().pop_front() {
            return Ok(Some(event));
        }
        if terminal {
            return Ok(None);
        }
        tokio::time::sleep(POLL_INTERVAL).await;
    }
}

pub struct RunAttachSubscription {
    pub(super) subscription_id: SubscriptionId,
    pub(super) run_id: RunId,
    pub(super) execution: PublicExecutionRef,
    pub(super) initial_working: bool,
    pub(super) settled: bool,
    pub(super) receiver: ReadOnlyAttach,
}

impl RunAttachSubscription {
    pub async fn recv(&mut self) -> Result<RunAttachEventNotification, NativeV2ObservationError> {
        let event = if self.initial_working {
            self.initial_working = false;
            AgentAttachEvent::Working {}
        } else {
            match self.receiver.recv().await {
                Ok(output) => AgentAttachEvent::Output {
                    text: bounded_attach_output(&output.text),
                },
                Err(AttachReceiveError::Closed) if !self.settled => {
                    self.settled = true;
                    AgentAttachEvent::Settled {}
                }
                Err(AttachReceiveError::Closed) => {
                    return Err(NativeV2ObservationError::AttachClosed);
                }
                Err(AttachReceiveError::Lagged) => {
                    return Err(NativeV2ObservationError::AttachLagged);
                }
            }
        };
        Ok(RunAttachEventNotification {
            subscription_id: self.subscription_id.clone(),
            run_id: self.run_id.clone(),
            execution: self.execution.clone(),
            event,
        })
    }
}
