//! NDJSON-bound `logs` subscription client. Drives `logs`/`event`/`subscription/cancel`/
//! `subscription/closed` notifications over [`crate::NdjsonTransport`], reusing the exact same
//! generic subscription framing [`crate::ndjson_watch`] uses. There is no dedup or reconnect logic
//! here, unlike [`crate::NdjsonReconnectingEventStream`] -- `logs` has no cursor to resume from.

use std::sync::atomic::Ordering;

use openengine_cluster_protocol::{
    JsonRpcErrorResponse, JsonRpcNotification, JsonRpcRequest, JsonRpcSuccess,
    LogEventNotification, LogRecord, LogsClosedNotification, LogsParams, LogsResult, RequestId,
    SubscriptionCloseReason, SubscriptionId, JSON_RPC_VERSION,
};
use serde_json::Value;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::mpsc;

use crate::PumpedSubscription;
use crate::{validate_response_identity, ClientError, NdjsonTransport};

/// One item observed by [`NdjsonLogsEventStream`]: a live log record, or a terminal close.
#[derive(Clone, Debug, PartialEq)]
pub enum LogEventOrClosed {
    Event(LogRecord),
    Closed { reason: SubscriptionCloseReason },
}

/// Typed NDJSON `logs` client. Request ids come from the shared [`NdjsonTransport`] rather than a
/// client-local counter, so independently constructed subscription clients on one connection
/// cannot replace each other's pending response waiters.
pub struct NdjsonLogsClient<'a, R, W> {
    transport: &'a NdjsonTransport<R, W>,
}

impl<'a, R, W> NdjsonLogsClient<'a, R, W>
where
    R: AsyncRead + Send + Unpin + 'static,
    W: AsyncWrite + Send + Unpin + 'static,
{
    #[must_use]
    pub const fn new(transport: &'a NdjsonTransport<R, W>) -> Self {
        Self { transport }
    }

    pub async fn logs(
        &self,
        params: LogsParams,
    ) -> Result<(LogsResult, NdjsonLogsEventStream<'a, R, W>), ClientError> {
        let id = self.transport.next_watch_request_id();
        let request = serde_json::to_string(&JsonRpcRequest {
            jsonrpc: JSON_RPC_VERSION.to_owned(),
            id: id.clone(),
            method: "logs".to_owned(),
            params,
        })?;
        let (line, subscription) = self
            .transport
            .open_subscription(request, id.clone())
            .await?;
        let result = parse_logs_response(&line, &id)?;
        let PumpedSubscription {
            receiver,
            overflowed,
        } = subscription;
        let stream = NdjsonLogsEventStream {
            transport: self.transport,
            receiver,
            overflowed,
            subscription_id: result.subscription_id.clone(),
        };
        Ok((result, stream))
    }
}

fn parse_logs_response(line: &str, expected_id: &RequestId) -> Result<LogsResult, ClientError> {
    let value: Value = serde_json::from_str(line)
        .map_err(|error| ClientError::InvalidResponse(error.to_string()))?;
    if value.get("error").is_some() {
        let response: JsonRpcErrorResponse = serde_json::from_value(value)
            .map_err(|error| ClientError::InvalidResponse(error.to_string()))?;
        validate_response_identity(&response.jsonrpc, response.id.as_ref(), expected_id)?;
        return Err(ClientError::Rpc(response.error));
    }
    let response: JsonRpcSuccess<LogsResult> = serde_json::from_value(value)
        .map_err(|error| ClientError::InvalidResponse(error.to_string()))?;
    validate_response_identity(&response.jsonrpc, Some(&response.id), expected_id)?;
    Ok(response.result)
}

/// Sourced from wire notifications forwarded by [`NdjsonTransport`]'s pump. Unlike
/// [`crate::NdjsonReconnectingEventStream`], there is no dedup set and no reconnect: `logs` gives
/// no cursor to resume from, so a `SLOW_CONSUMER` close simply ends the subscription.
pub struct NdjsonLogsEventStream<'a, R, W> {
    transport: &'a NdjsonTransport<R, W>,
    receiver: mpsc::Receiver<String>,
    overflowed: std::sync::Arc<std::sync::atomic::AtomicBool>,
    subscription_id: SubscriptionId,
}

impl<'a, R, W> NdjsonLogsEventStream<'a, R, W>
where
    R: AsyncRead + Send + Unpin + 'static,
    W: AsyncWrite + Send + Unpin + 'static,
{
    /// Returns the next live log record, or a terminal close. Returns `None` once the
    /// subscription's channel ends (cancelled locally, or the transport's connection ended).
    /// Returns `Some(Err(_))` if a schema-malformed or unexpected-method notification is
    /// forwarded for this subscription -- the wire pump routes by subscription id only, so
    /// peer-controlled payload shape must never panic here.
    pub async fn next(&mut self) -> Option<Result<LogEventOrClosed, ClientError>> {
        let line = match self.receiver.recv().await {
            Some(line) => line,
            None if self.overflowed.swap(false, Ordering::AcqRel) => {
                return Some(Ok(LogEventOrClosed::Closed {
                    reason: SubscriptionCloseReason::SlowConsumer,
                }));
            }
            None => return None,
        };
        Some(parse_log_notification(&line))
    }

    /// Sends `subscription/cancel` for this subscription. Idempotent from the caller's
    /// perspective: the server drops an unknown subscription id silently.
    pub async fn cancel(&self) -> Result<(), ClientError> {
        self.transport
            .cancel_subscription(self.subscription_id.clone())
            .await?;
        Ok(())
    }
}

fn parse_log_notification(line: &str) -> Result<LogEventOrClosed, ClientError> {
    let value: Value = serde_json::from_str(line)
        .map_err(|error| ClientError::InvalidResponse(error.to_string()))?;
    match value.get("method").and_then(Value::as_str) {
        Some("event") => {
            let notification: JsonRpcNotification<LogEventNotification> =
                serde_json::from_value(value)
                    .map_err(|error| ClientError::InvalidResponse(error.to_string()))?;
            Ok(LogEventOrClosed::Event(notification.params.record))
        }
        Some("subscription/closed") => {
            let notification: JsonRpcNotification<LogsClosedNotification> =
                serde_json::from_value(value)
                    .map_err(|error| ClientError::InvalidResponse(error.to_string()))?;
            Ok(LogEventOrClosed::Closed {
                reason: notification.params.reason,
            })
        }
        other => Err(ClientError::InvalidResponse(format!(
            "unexpected subscription notification method {other:?}"
        ))),
    }
}
