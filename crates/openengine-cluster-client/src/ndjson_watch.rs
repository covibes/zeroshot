//! [`SubscriptionTransport`]-generic watch subscription client. Mirrors
//! [`crate::watch::ReconnectingEventStream`]'s `(runId, cursor)` dedup and
//! reconnect-from-last-delivered-cursor semantics, but drives them over any
//! [`SubscriptionTransport`]'s wire-framed `watch`/`event`/`subscription/cancel`/
//! `subscription/closed` notifications instead of the in-process
//! [`openengine_cluster_server::Dispatcher`] passthrough.
//! [`NdjsonWatchClient`]/[`NdjsonReconnectingEventStream`] alias this machinery to
//! [`crate::NdjsonTransport`]; [`crate::websocket::WebSocketTransport`] reuses it unchanged.

use std::collections::HashSet;
use openengine_cluster_protocol::{
    Cursor, EventNotification, JsonRpcNotification, RunId, SubscriptionCloseReason, WatchParams,
    WatchResult,
};
use openengine_cluster_server::watch::PublicEventRecord;

use crate::watch::admit_event;
use crate::ndjson_subscription::{
    impl_cursor_subscription_controls, open_subscription, parse_subscription_close,
    parse_subscription_notification, PumpedLine, SubscriptionClientCore, SubscriptionStreamCore,
};
use crate::{ClientError, EventOrClosed, NdjsonTransport, SubscriptionTransport};

/// Typed watch client generic over any [`SubscriptionTransport`]. Request ids come from the
/// shared transport rather than a client-local counter, so independently constructed watch
/// clients on one connection cannot replace each other's pending response waiters.
pub struct WatchSubscriptionClient<'a, T> {
    core: SubscriptionClientCore<'a, T>,
}

/// [`WatchSubscriptionClient`] bound to [`NdjsonTransport`].
pub type NdjsonWatchClient<'a, R, W> = WatchSubscriptionClient<'a, NdjsonTransport<R, W>>;

impl<'a, T> WatchSubscriptionClient<'a, T>
where
    T: SubscriptionTransport,
{
    #[must_use]
    pub const fn new(transport: &'a T) -> Self {
        Self {
            core: SubscriptionClientCore::new(transport),
        }
    }

    pub async fn watch(
        &self,
        params: WatchParams,
    ) -> Result<(WatchResult, WatchSubscriptionEventStream<'a, T>), ClientError> {
        let (result, subscription): (WatchResult, _) =
            open_subscription(self.core.transport(), "watch", params.clone()).await?;
        let subscription = subscription.ok_or_else(|| {
            ClientError::InvalidResponse(
                "a successful watch response must carry a subscriptionId".to_owned(),
            )
        })?;
        let stream = WatchSubscriptionEventStream {
            core: SubscriptionStreamCore::new(
                self.core.transport(),
                subscription,
                result.subscription_id.clone(),
            )
            .with_last_delivered_cursor(params.from_cursor),
            seen: HashSet::new(),
            run_id: result.run_id.clone(),
            closed: false,
        };
        Ok((result, stream))
    }
}

/// Deduplicates durable events by `(runId, cursor)` across legal at-least-once physical
/// redelivery and across reconnect, exactly like [`crate::watch::ReconnectingEventStream`] but
/// sourced from wire notifications forwarded by a [`SubscriptionTransport`]'s pump.
pub struct WatchSubscriptionEventStream<'a, T> {
    core: SubscriptionStreamCore<'a, T>,
    seen: HashSet<(RunId, Cursor)>,
    run_id: Option<RunId>,
    closed: bool,
}

/// [`WatchSubscriptionEventStream`] bound to [`NdjsonTransport`].
pub type NdjsonReconnectingEventStream<'a, R, W> =
    WatchSubscriptionEventStream<'a, NdjsonTransport<R, W>>;

impl<'a, T> WatchSubscriptionEventStream<'a, T>
where
    T: SubscriptionTransport,
{
    /// Returns the next logically new event, transparently dropping legal duplicate physical
    /// deliveries, or a terminal close. Returns `None` once the subscription's channel ends
    /// (cancelled locally, or the transport's connection ended).
    pub async fn next(&mut self) -> Option<EventOrClosed> {
        self.try_next().await?.ok()
    }

    /// Fallible counterpart to [`Self::next`] for callers that need malformed peer frames
    /// distinguished from an ordinary end of stream.
    pub async fn try_next(&mut self) -> Option<Result<EventOrClosed, ClientError>> {
        if self.closed {
            return None;
        }
        loop {
            let line = match self.core.next_line().await {
                PumpedLine::Frame(line) => line,
                PumpedLine::SlowConsumer => {
                    self.closed = true;
                    return Some(Ok(EventOrClosed::Closed {
                        reason: SubscriptionCloseReason::SlowConsumer,
                        last_delivered_cursor: self.core.last_delivered_cursor().cloned(),
                    }));
                }
                PumpedLine::End => {
                    self.closed = true;
                    return None;
                }
            };
            match self.parse_notification(&line) {
                Ok(Some(event)) => return Some(Ok(event)),
                Ok(None) => {}
                Err(error) => {
                    self.closed = true;
                    return Some(Err(error));
                }
            }
        }
    }

    fn parse_notification(&mut self, line: &str) -> Result<Option<EventOrClosed>, ClientError> {
        let (method, value) = parse_subscription_notification(line)?;
        match method.as_deref() {
            Some("event") => {
                let notification: JsonRpcNotification<EventNotification> =
                    serde_json::from_value(value)
                        .map_err(|error| ClientError::InvalidResponse(error.to_string()))?;
                let record = PublicEventRecord {
                    run_id: notification.params.run_id,
                    cursor: notification.params.cursor,
                    event: notification.params.event,
                };
                self.run_id.get_or_insert_with(|| record.run_id.clone());
                if !admit_event(
                    &mut self.seen,
                    self.core.last_delivered_cursor_mut(),
                    &record,
                ) {
                    return Ok(None);
                }
                Ok(Some(EventOrClosed::Event(record)))
            }
            Some("subscription/closed") => {
                let (reason, last_delivered_cursor) =
                    parse_subscription_close(value, self.core.subscription_id())?;
                if let Some(cursor) = &last_delivered_cursor {
                    self.core.record_delivered_cursor(cursor.clone());
                }
                self.closed = true;
                Ok(Some(EventOrClosed::Closed {
                    reason,
                    last_delivered_cursor,
                }))
            }
            other => Err(ClientError::InvalidResponse(format!(
                "unexpected subscription notification method {other:?}"
            ))),
        }
    }

    impl_cursor_subscription_controls!();

    /// Re-establishes a subscription from this stream's last delivered cursor, on the same run it
    /// had attached to (or still parked, if it never attached). The dedup set survives the
    /// reconnect so a duplicate delivered before and after reconnect is still suppressed once.
    pub async fn reconnect(
        self,
    ) -> Result<(WatchResult, WatchSubscriptionEventStream<'a, T>), ClientError> {
        let watch_client = WatchSubscriptionClient::new(self.core.transport());
        let params = WatchParams {
            run_id: self.run_id,
            from_cursor: self.core.last_delivered_cursor().cloned(),
        };
        let (result, mut stream) = watch_client.watch(params).await?;
        stream.seen = self.seen;
        Ok((result, stream))
    }
}
