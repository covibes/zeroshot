//! Shared [`crate::SubscriptionTransport`]-generic "one unary response, then live `event`/
//! `subscription/closed` notifications with no dedup or reconnect" client machinery for
//! future-only subscription capabilities (`logs`, `agent_attach`). Generated once per capability
//! via [`impl_ndjson_event_subscription`] rather than hand-copied, so the request/parse/`next`/
//! `cancel` logic exists exactly once and is driven identically by [`crate::NdjsonTransport`] and
//! [`crate::websocket::WebSocketTransport`] alike. `watch` has different (dedup + reconnect)
//! semantics and is not implemented via this macro.

pub(crate) enum PumpedLine {
    Frame(String),
    SlowConsumer,
    End,
}

pub(crate) struct SubscriptionClientCore<'a, T> {
    transport: &'a T,
}

impl<'a, T> SubscriptionClientCore<'a, T> {
    pub(crate) const fn new(transport: &'a T) -> Self {
        Self { transport }
    }

    pub(crate) const fn transport(&self) -> &'a T {
        self.transport
    }
}

pub(crate) struct SubscriptionStreamCore<'a, T> {
    transport: &'a T,
    receiver: tokio::sync::mpsc::Receiver<String>,
    overflowed: std::sync::Arc<std::sync::atomic::AtomicBool>,
    subscription_id: openengine_cluster_protocol::SubscriptionId,
    last_delivered_cursor: Option<openengine_cluster_protocol::Cursor>,
}

impl<'a, T> SubscriptionStreamCore<'a, T>
where
    T: crate::SubscriptionTransport,
{
    pub(crate) fn new(
        transport: &'a T,
        subscription: crate::PumpedSubscription,
        subscription_id: openengine_cluster_protocol::SubscriptionId,
    ) -> Self {
        Self {
            transport,
            receiver: subscription.receiver,
            overflowed: subscription.overflowed,
            subscription_id,
            last_delivered_cursor: None,
        }
    }

    pub(crate) fn with_last_delivered_cursor(
        mut self,
        cursor: Option<openengine_cluster_protocol::Cursor>,
    ) -> Self {
        self.last_delivered_cursor = cursor;
        self
    }

    pub(crate) async fn next_line(&mut self) -> PumpedLine {
        next_pumped_line(&mut self.receiver, self.overflowed.as_ref()).await
    }

    pub(crate) async fn cancel(&self) -> Result<(), crate::ClientError> {
        cancel_subscription(self.transport, self.subscription_id.clone()).await
    }

    pub(crate) const fn transport(&self) -> &'a T {
        self.transport
    }

    pub(crate) const fn subscription_id(&self) -> &openengine_cluster_protocol::SubscriptionId {
        &self.subscription_id
    }

    pub(crate) const fn last_delivered_cursor(
        &self,
    ) -> Option<&openengine_cluster_protocol::Cursor> {
        self.last_delivered_cursor.as_ref()
    }

    pub(crate) fn last_delivered_cursor_mut(
        &mut self,
    ) -> &mut Option<openengine_cluster_protocol::Cursor> {
        &mut self.last_delivered_cursor
    }

    pub(crate) fn record_delivered_cursor(&mut self, cursor: openengine_cluster_protocol::Cursor) {
        self.last_delivered_cursor = Some(cursor);
    }
}

macro_rules! impl_cursor_subscription_controls {
    () => {
        /// Sends `subscription/cancel` for this subscription. Idempotent from the caller's
        /// perspective: the server drops an unknown subscription id silently.
        pub async fn cancel(&self) -> Result<(), crate::ClientError> {
            self.core.cancel().await
        }

        #[must_use]
        pub fn last_delivered_cursor(&self) -> Option<&openengine_cluster_protocol::Cursor> {
            self.core.last_delivered_cursor()
        }
    };
}

pub(crate) use impl_cursor_subscription_controls;

pub(crate) async fn next_pumped_line(
    receiver: &mut tokio::sync::mpsc::Receiver<String>,
    overflowed: &std::sync::atomic::AtomicBool,
) -> PumpedLine {
    match receiver.recv().await {
        Some(line) => PumpedLine::Frame(line),
        None if overflowed.swap(false, std::sync::atomic::Ordering::AcqRel) => {
            PumpedLine::SlowConsumer
        }
        None => PumpedLine::End,
    }
}

pub(crate) fn parse_subscription_response<R>(
    line: &str,
    expected_id: &openengine_cluster_protocol::RequestId,
) -> Result<R, crate::ClientError>
where
    R: serde::de::DeserializeOwned,
{
    let value: serde_json::Value = serde_json::from_str(line)
        .map_err(|error| crate::ClientError::InvalidResponse(error.to_string()))?;
    if value.get("error").is_some() {
        let response: openengine_cluster_protocol::JsonRpcErrorResponse =
            serde_json::from_value(value)
                .map_err(|error| crate::ClientError::InvalidResponse(error.to_string()))?;
        crate::validate_response_identity(&response.jsonrpc, response.id.as_ref(), expected_id)?;
        return Err(crate::ClientError::Rpc(response.error));
    }
    let response: openengine_cluster_protocol::JsonRpcSuccess<R> = serde_json::from_value(value)
        .map_err(|error| crate::ClientError::InvalidResponse(error.to_string()))?;
    crate::validate_response_identity(&response.jsonrpc, Some(&response.id), expected_id)?;
    Ok(response.result)
}

pub(crate) fn parse_subscription_close(
    value: serde_json::Value,
    expected_id: &openengine_cluster_protocol::SubscriptionId,
) -> Result<
    (
        openengine_cluster_protocol::SubscriptionCloseReason,
        Option<openengine_cluster_protocol::Cursor>,
    ),
    crate::ClientError,
> {
    let notification: openengine_cluster_protocol::JsonRpcNotification<
        openengine_cluster_protocol::SubscriptionClosedNotification,
    > = serde_json::from_value(value)
        .map_err(|error| crate::ClientError::InvalidResponse(error.to_string()))?;
    if &notification.params.subscription_id != expected_id {
        return Err(crate::ClientError::InvalidResponse(
            "close notification subscription id mismatch".to_owned(),
        ));
    }
    Ok((
        notification.params.reason,
        notification.params.last_delivered_cursor,
    ))
}

pub(crate) fn parse_subscription_notification(
    line: &str,
) -> Result<(Option<String>, serde_json::Value), crate::ClientError> {
    let value: serde_json::Value = serde_json::from_str(line)
        .map_err(|error| crate::ClientError::InvalidResponse(error.to_string()))?;
    let method = value
        .get("method")
        .and_then(serde_json::Value::as_str)
        .map(str::to_owned);
    Ok((method, value))
}

pub(crate) async fn cancel_subscription<T>(
    transport: &T,
    id: openengine_cluster_protocol::SubscriptionId,
) -> Result<(), crate::ClientError>
where
    T: crate::SubscriptionTransport,
{
    transport.cancel_subscription(id).await?;
    Ok(())
}

pub(crate) async fn open_subscription<T, P, R>(
    transport: &T,
    method: &str,
    params: P,
) -> Result<(R, Option<crate::PumpedSubscription>), crate::ClientError>
where
    T: crate::SubscriptionTransport,
    P: serde::Serialize + Send,
    R: serde::de::DeserializeOwned,
{
    let id = transport.next_watch_request_id();
    let request = serde_json::to_string(&openengine_cluster_protocol::JsonRpcRequest {
        jsonrpc: openengine_cluster_protocol::JSON_RPC_VERSION.to_owned(),
        id: id.clone(),
        method: method.to_owned(),
        params,
    })?;
    let (line, subscription) = transport.open_subscription(request, id.clone()).await?;
    let result = parse_subscription_response(&line, &id)?;
    Ok((result, subscription))
}

macro_rules! impl_ndjson_event_subscription {
    (
        generic_client: $client:ident,
        generic_stream: $stream:ident,
        ndjson_client: $ndjson_client:ident,
        ndjson_stream: $ndjson_stream:ident,
        event_or_closed: $event_or_closed:ident,
        method_fn: $method_fn:ident,
        method_name: $method_name:literal,
        params: $params_ty:ty,
        result: $result_ty:ty,
        event: $event_ty:ty,
        event_notification: $event_notification_ty:ty,
        event_field: $event_field:ident,
        closed_notification: $closed_notification_ty:ty,
        parse_response_fn: $parse_response_fn:ident,
        parse_notification_fn: $parse_notification_fn:ident,
    ) => {
        #[derive(Clone, Debug, PartialEq)]
        pub enum $event_or_closed {
            Event($event_ty),
            Closed {
                reason: openengine_cluster_protocol::SubscriptionCloseReason,
            },
        }

        pub struct $client<'a, T> {
            transport: &'a T,
        }

        #[doc = concat!("[`", stringify!($client), "`] bound to [`crate::NdjsonTransport`].")]
        pub type $ndjson_client<'a, R, W> = $client<'a, crate::NdjsonTransport<R, W>>;

        impl<'a, T> $client<'a, T>
        where
            T: crate::SubscriptionTransport,
        {
            #[must_use]
            pub const fn new(transport: &'a T) -> Self {
                Self { transport }
            }

            pub async fn $method_fn(
                &self,
                params: $params_ty,
            ) -> Result<($result_ty, $stream<'a, T>), crate::ClientError> {
                let id = self.transport.next_watch_request_id();
                let request =
                    serde_json::to_string(&openengine_cluster_protocol::JsonRpcRequest {
                        jsonrpc: openengine_cluster_protocol::JSON_RPC_VERSION.to_owned(),
                        id: id.clone(),
                        method: $method_name.to_owned(),
                        params,
                    })?;
                let (line, subscription) = self
                    .transport
                    .open_subscription(request, id.clone())
                    .await?;
                let result = $parse_response_fn(&line, &id)?;
                let subscription = subscription.ok_or_else(|| {
                    crate::ClientError::InvalidResponse(
                        concat!(
                            "a successful ",
                            $method_name,
                            " response must carry a subscriptionId"
                        )
                        .to_owned(),
                    )
                })?;
                let stream = $stream {
                    core: crate::ndjson_subscription::SubscriptionStreamCore::new(
                        self.transport,
                        subscription,
                        result.subscription_id.clone(),
                    ),
                };
                Ok((result, stream))
            }
        }

        fn $parse_response_fn(
            line: &str,
            expected_id: &openengine_cluster_protocol::RequestId,
        ) -> Result<$result_ty, crate::ClientError> {
            crate::ndjson_subscription::parse_subscription_response(line, expected_id)
        }

        pub struct $stream<'a, T> {
            core: crate::ndjson_subscription::SubscriptionStreamCore<'a, T>,
        }

        #[doc = concat!("[`", stringify!($stream), "`] bound to [`crate::NdjsonTransport`].")]
        pub type $ndjson_stream<'a, R, W> = $stream<'a, crate::NdjsonTransport<R, W>>;

        impl<'a, T> $stream<'a, T>
        where
            T: crate::SubscriptionTransport,
        {
            /// Returns the next live event, or a terminal close. Returns `None` once the
            /// subscription's channel ends (cancelled locally, or the transport's connection
            /// ended). Returns `Some(Err(_))` if a schema-malformed or unexpected-method
            /// notification is forwarded for this subscription -- the wire pump routes by
            /// subscription id only, so peer-controlled payload shape must never panic here.
            pub async fn next(&mut self) -> Option<Result<$event_or_closed, crate::ClientError>> {
                let line = match self.core.next_line().await {
                    crate::ndjson_subscription::PumpedLine::Frame(line) => line,
                    crate::ndjson_subscription::PumpedLine::SlowConsumer => {
                        return Some(Ok($event_or_closed::Closed {
                            reason:
                                openengine_cluster_protocol::SubscriptionCloseReason::SlowConsumer,
                        }));
                    }
                    crate::ndjson_subscription::PumpedLine::End => return None,
                };
                Some($parse_notification_fn(&line))
            }

            /// Sends `subscription/cancel` for this subscription. Idempotent from the caller's
            /// perspective: the server drops an unknown subscription id silently.
            pub async fn cancel(&self) -> Result<(), crate::ClientError> {
                self.core.cancel().await
            }
        }

        fn $parse_notification_fn(line: &str) -> Result<$event_or_closed, crate::ClientError> {
            let value: serde_json::Value = serde_json::from_str(line)
                .map_err(|error| crate::ClientError::InvalidResponse(error.to_string()))?;
            match value.get("method").and_then(serde_json::Value::as_str) {
                Some("event") => {
                    let notification: openengine_cluster_protocol::JsonRpcNotification<
                        $event_notification_ty,
                    > = serde_json::from_value(value)
                        .map_err(|error| crate::ClientError::InvalidResponse(error.to_string()))?;
                    Ok($event_or_closed::Event(notification.params.$event_field))
                }
                Some("subscription/closed") => {
                    let notification: openengine_cluster_protocol::JsonRpcNotification<
                        $closed_notification_ty,
                    > = serde_json::from_value(value)
                        .map_err(|error| crate::ClientError::InvalidResponse(error.to_string()))?;
                    Ok($event_or_closed::Closed {
                        reason: notification.params.reason,
                    })
                }
                other => Err(crate::ClientError::InvalidResponse(format!(
                    "unexpected subscription notification method {other:?}"
                ))),
            }
        }
    };
}

pub(crate) use impl_ndjson_event_subscription;
