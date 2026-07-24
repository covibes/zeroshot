//! NDJSON-bound watch subscription client. Mirrors [`crate::watch::ReconnectingEventStream`]'s
//! `(runId, cursor)` dedup and reconnect-from-last-delivered-cursor semantics, but drives them
//! over [`crate::NdjsonTransport`]'s wire-framed `watch`/`event`/`subscription/cancel`/
//! `subscription/closed` notifications instead of the in-process [`Dispatcher`] passthrough.

use std::collections::HashSet;
use std::sync::atomic::Ordering;

use openengine_cluster_protocol::{
    Cursor, EventNotification, JsonRpcErrorResponse, JsonRpcNotification, JsonRpcRequest,
    JsonRpcSuccess, RequestId, RunId, SubscriptionCloseReason, SubscriptionClosedNotification,
    SubscriptionId, WatchParams, WatchResult, JSON_RPC_VERSION,
};
use openengine_cluster_server::watch::PublicEventRecord;
use serde_json::Value;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::mpsc;

use crate::watch::admit_event;
use crate::PumpedSubscription;
use crate::{validate_response_identity, ClientError, EventOrClosed, NdjsonTransport};

/// Typed NDJSON watch client. Request ids come from the shared [`NdjsonTransport`] rather than a
/// client-local counter, so independently constructed watch clients on one connection cannot
/// replace each other's pending response waiters.
pub struct NdjsonWatchClient<'a, R, W> {
    transport: &'a NdjsonTransport<R, W>,
}

impl<'a, R, W> NdjsonWatchClient<'a, R, W>
where
    R: AsyncRead + Send + Unpin + 'static,
    W: AsyncWrite + Send + Unpin + 'static,
{
    #[must_use]
    pub const fn new(transport: &'a NdjsonTransport<R, W>) -> Self {
        Self { transport }
    }

    pub async fn watch(
        &self,
        params: WatchParams,
    ) -> Result<(WatchResult, NdjsonReconnectingEventStream<'a, R, W>), ClientError> {
        let id = self.next_request_id();
        let request = serde_json::to_string(&JsonRpcRequest {
            jsonrpc: JSON_RPC_VERSION.to_owned(),
            id: id.clone(),
            method: "watch".to_owned(),
            params: params.clone(),
        })?;
        let (line, subscription) = self
            .transport
            .open_subscription(request, id.clone())
            .await?;
        let result = parse_watch_response(&line, &id)?;
        let PumpedSubscription {
            receiver,
            overflowed,
        } = subscription.expect("a successful watch response must carry a subscriptionId");
        let stream = NdjsonReconnectingEventStream {
            transport: self.transport,
            receiver,
            overflowed,
            subscription_id: result.subscription_id.clone(),
            seen: HashSet::new(),
            last_delivered: params.from_cursor,
            run_id: result.run_id.clone(),
        };
        Ok((result, stream))
    }

    fn next_request_id(&self) -> RequestId {
        self.transport.next_watch_request_id()
    }
}

fn parse_watch_response(line: &str, expected_id: &RequestId) -> Result<WatchResult, ClientError> {
    let value: Value = serde_json::from_str(line)
        .map_err(|error| ClientError::InvalidResponse(error.to_string()))?;
    if value.get("error").is_some() {
        let response: JsonRpcErrorResponse = serde_json::from_value(value)
            .map_err(|error| ClientError::InvalidResponse(error.to_string()))?;
        validate_response_identity(&response.jsonrpc, response.id.as_ref(), expected_id)?;
        return Err(ClientError::Rpc(response.error));
    }
    let response: JsonRpcSuccess<WatchResult> = serde_json::from_value(value)
        .map_err(|error| ClientError::InvalidResponse(error.to_string()))?;
    validate_response_identity(&response.jsonrpc, Some(&response.id), expected_id)?;
    Ok(response.result)
}

/// Deduplicates durable events by `(runId, cursor)` across legal at-least-once physical
/// redelivery and across reconnect, exactly like [`crate::watch::ReconnectingEventStream`] but
/// sourced from wire notifications forwarded by [`NdjsonTransport`]'s pump.
pub struct NdjsonReconnectingEventStream<'a, R, W> {
    transport: &'a NdjsonTransport<R, W>,
    receiver: mpsc::Receiver<String>,
    overflowed: std::sync::Arc<std::sync::atomic::AtomicBool>,
    subscription_id: SubscriptionId,
    seen: HashSet<(RunId, Cursor)>,
    last_delivered: Option<Cursor>,
    run_id: Option<RunId>,
}

impl<'a, R, W> NdjsonReconnectingEventStream<'a, R, W>
where
    R: AsyncRead + Send + Unpin + 'static,
    W: AsyncWrite + Send + Unpin + 'static,
{
    /// Returns the next logically new event, transparently dropping legal duplicate physical
    /// deliveries, or a terminal close. Returns `None` once the subscription's channel ends
    /// (cancelled locally, or the transport's connection ended).
    pub async fn next(&mut self) -> Option<EventOrClosed> {
        loop {
            let line = match self.receiver.recv().await {
                Some(line) => line,
                None if self.overflowed.swap(false, Ordering::AcqRel) => {
                    return Some(EventOrClosed::Closed {
                        reason: SubscriptionCloseReason::SlowConsumer,
                        last_delivered_cursor: self.last_delivered.clone(),
                    });
                }
                None => return None,
            };
            let value: Value =
                serde_json::from_str(&line).expect("subscription notification must be valid JSON");
            match value.get("method").and_then(Value::as_str) {
                Some("event") => {
                    let notification: JsonRpcNotification<EventNotification> =
                        serde_json::from_value(value)
                            .expect("event notification must match the wire schema");
                    let record = PublicEventRecord {
                        run_id: notification.params.run_id,
                        cursor: notification.params.cursor,
                        event: notification.params.event,
                    };
                    self.run_id.get_or_insert_with(|| record.run_id.clone());
                    if !admit_event(&mut self.seen, &mut self.last_delivered, &record) {
                        continue;
                    }
                    return Some(EventOrClosed::Event(record));
                }
                Some("subscription/closed") => {
                    let notification: JsonRpcNotification<SubscriptionClosedNotification> =
                        serde_json::from_value(value)
                            .expect("subscription closed notification must match the wire schema");
                    if notification.params.last_delivered_cursor.is_some() {
                        self.last_delivered = notification.params.last_delivered_cursor.clone();
                    }
                    return Some(EventOrClosed::Closed {
                        reason: notification.params.reason,
                        last_delivered_cursor: notification.params.last_delivered_cursor,
                    });
                }
                other => panic!("unexpected subscription notification method {other:?}"),
            }
        }
    }

    /// Sends `subscription/cancel` for this subscription. Idempotent from the caller's
    /// perspective: the server drops an unknown subscription id silently.
    pub async fn cancel(&self) -> Result<(), ClientError> {
        self.transport
            .cancel_subscription(self.subscription_id.clone())
            .await?;
        Ok(())
    }

    #[must_use]
    pub fn last_delivered_cursor(&self) -> Option<&Cursor> {
        self.last_delivered.as_ref()
    }

    /// Re-establishes a subscription from this stream's last delivered cursor, on the same run it
    /// had attached to (or still parked, if it never attached). The dedup set survives the
    /// reconnect so a duplicate delivered before and after reconnect is still suppressed once.
    pub async fn reconnect(
        self,
    ) -> Result<(WatchResult, NdjsonReconnectingEventStream<'a, R, W>), ClientError> {
        let watch_client = NdjsonWatchClient::new(self.transport);
        let params = WatchParams {
            run_id: self.run_id,
            from_cursor: self.last_delivered,
        };
        let (result, mut stream) = watch_client.watch(params).await?;
        stream.seen = self.seen;
        Ok((result, stream))
    }
}
