//! Shared [`crate::SubscriptionTransport`]-generic "one unary response, then live `event`/
//! `subscription/closed` notifications with no dedup or reconnect" client machinery for
//! future-only subscription capabilities (`logs`, `agent_attach`). Generated once per capability
//! via [`impl_ndjson_event_subscription`] rather than hand-copied, so the request/parse/`next`/
//! `cancel` logic exists exactly once and is driven identically by [`crate::NdjsonTransport`] and
//! [`crate::websocket::WebSocketTransport`] alike. `watch` has different (dedup + reconnect)
//! semantics and is not implemented via this macro.
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
                let crate::PumpedSubscription {
                    receiver,
                    overflowed,
                } = subscription.expect(concat!(
                    "a successful ",
                    $method_name,
                    " response must carry a subscriptionId"
                ));
                let stream = $stream {
                    transport: self.transport,
                    receiver,
                    overflowed,
                    subscription_id: result.subscription_id.clone(),
                };
                Ok((result, stream))
            }
        }

        fn $parse_response_fn(
            line: &str,
            expected_id: &openengine_cluster_protocol::RequestId,
        ) -> Result<$result_ty, crate::ClientError> {
            let value: serde_json::Value = serde_json::from_str(line)
                .map_err(|error| crate::ClientError::InvalidResponse(error.to_string()))?;
            if value.get("error").is_some() {
                let response: openengine_cluster_protocol::JsonRpcErrorResponse =
                    serde_json::from_value(value)
                        .map_err(|error| crate::ClientError::InvalidResponse(error.to_string()))?;
                crate::validate_response_identity(
                    &response.jsonrpc,
                    response.id.as_ref(),
                    expected_id,
                )?;
                return Err(crate::ClientError::Rpc(response.error));
            }
            let response: openengine_cluster_protocol::JsonRpcSuccess<$result_ty> =
                serde_json::from_value(value)
                    .map_err(|error| crate::ClientError::InvalidResponse(error.to_string()))?;
            crate::validate_response_identity(&response.jsonrpc, Some(&response.id), expected_id)?;
            Ok(response.result)
        }

        pub struct $stream<'a, T> {
            transport: &'a T,
            receiver: tokio::sync::mpsc::Receiver<String>,
            overflowed: std::sync::Arc<std::sync::atomic::AtomicBool>,
            subscription_id: openengine_cluster_protocol::SubscriptionId,
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
                let line = match self.receiver.recv().await {
                    Some(line) => line,
                    None if self
                        .overflowed
                        .swap(false, std::sync::atomic::Ordering::AcqRel) =>
                    {
                        return Some(Ok($event_or_closed::Closed {
                            reason:
                                openengine_cluster_protocol::SubscriptionCloseReason::SlowConsumer,
                        }));
                    }
                    None => return None,
                };
                Some($parse_notification_fn(&line))
            }

            /// Sends `subscription/cancel` for this subscription. Idempotent from the caller's
            /// perspective: the server drops an unknown subscription id silently.
            pub async fn cancel(&self) -> Result<(), crate::ClientError> {
                self.transport
                    .cancel_subscription(self.subscription_id.clone())
                    .await?;
                Ok(())
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
