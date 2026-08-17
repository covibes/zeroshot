//! Transport-generic native-v2 run subscription client.

use std::sync::atomic::Ordering;

use openengine_cluster_protocol::{
    Cursor, JsonRpcErrorResponse, JsonRpcNotification, JsonRpcRequest, JsonRpcSuccess, RequestId,
    RunAttachEventNotification, RunAttachParams, RunAttachResult, RunLogEventNotification,
    RunLogsParams, RunLogsResult, RunWatchEventNotification, RunWatchParams, RunWatchResult,
    SubscriptionCloseReason, SubscriptionClosedNotification, SubscriptionId, JSON_RPC_VERSION,
    RUN_ATTACH_METHOD, RUN_LOGS_METHOD, RUN_WATCH_METHOD,
};
use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::Value;
use tokio::sync::mpsc;

use crate::{
    validate_response_identity, ClientError, NdjsonTransport, PumpedSubscription,
    SubscriptionTransport,
};

#[derive(Clone, Debug, PartialEq)]
pub enum RunSubscriptionEvent<E> {
    Event(E),
    Closed {
        reason: SubscriptionCloseReason,
        last_delivered_cursor: Option<Cursor>,
    },
}

pub struct RunSubscriptionClient<'a, T> {
    transport: &'a T,
}

pub type NdjsonRunSubscriptionClient<'a, R, W> = RunSubscriptionClient<'a, NdjsonTransport<R, W>>;

struct RunSubscriptionShape<R, E> {
    result_subscription_id: fn(&R) -> &SubscriptionId,
    event_subscription_id: fn(&E) -> &SubscriptionId,
    event_cursor: fn(&E) -> Option<&Cursor>,
}

impl<'a, T> RunSubscriptionClient<'a, T>
where
    T: SubscriptionTransport,
{
    #[must_use]
    pub const fn new(transport: &'a T) -> Self {
        Self { transport }
    }

    pub async fn run_watch(
        &self,
        params: RunWatchParams,
    ) -> Result<
        (
            RunWatchResult,
            RunSubscriptionEventStream<'a, T, RunWatchEventNotification>,
        ),
        ClientError,
    > {
        self.open(
            RUN_WATCH_METHOD,
            params,
            RunSubscriptionShape {
                result_subscription_id: watch_subscription_id,
                event_subscription_id: watch_event_subscription_id,
                event_cursor: watch_event_cursor,
            },
        )
        .await
    }

    pub async fn run_logs(
        &self,
        params: RunLogsParams,
    ) -> Result<
        (
            RunLogsResult,
            RunSubscriptionEventStream<'a, T, RunLogEventNotification>,
        ),
        ClientError,
    > {
        self.open(
            RUN_LOGS_METHOD,
            params,
            RunSubscriptionShape {
                result_subscription_id: logs_subscription_id,
                event_subscription_id: log_event_subscription_id,
                event_cursor: log_event_cursor,
            },
        )
        .await
    }

    pub async fn run_attach(
        &self,
        params: RunAttachParams,
    ) -> Result<
        (
            RunAttachResult,
            RunSubscriptionEventStream<'a, T, RunAttachEventNotification>,
        ),
        ClientError,
    > {
        self.open(
            RUN_ATTACH_METHOD,
            params,
            RunSubscriptionShape {
                result_subscription_id: attach_subscription_id,
                event_subscription_id: attach_event_subscription_id,
                event_cursor: no_event_cursor,
            },
        )
        .await
    }

    async fn open<P, R, E>(
        &self,
        method: &str,
        params: P,
        shape: RunSubscriptionShape<R, E>,
    ) -> Result<(R, RunSubscriptionEventStream<'a, T, E>), ClientError>
    where
        P: Serialize + Send,
        R: DeserializeOwned,
        E: DeserializeOwned,
    {
        let id = self.transport.next_watch_request_id();
        let request = serde_json::to_string(&JsonRpcRequest {
            jsonrpc: JSON_RPC_VERSION.to_owned(),
            id: id.clone(),
            method: method.to_owned(),
            params,
        })?;
        let (line, subscription) = self
            .transport
            .open_subscription(request, id.clone())
            .await?;
        let result = parse_response::<R>(&line, &id)?;
        let subscription_id = (shape.result_subscription_id)(&result).clone();
        let PumpedSubscription {
            receiver,
            overflowed,
        } = subscription.ok_or_else(|| {
            ClientError::InvalidResponse(
                "successful native-v2 subscription response had no notification stream".to_owned(),
            )
        })?;
        Ok((
            result,
            RunSubscriptionEventStream {
                transport: self.transport,
                receiver,
                overflowed,
                subscription_id,
                event_subscription_id: shape.event_subscription_id,
                event_cursor: shape.event_cursor,
                last_delivered_cursor: None,
                closed: false,
            },
        ))
    }
}

fn parse_response<R: DeserializeOwned>(
    line: &str,
    expected_id: &RequestId,
) -> Result<R, ClientError> {
    let value: Value = serde_json::from_str(line)
        .map_err(|error| ClientError::InvalidResponse(error.to_string()))?;
    if value.get("error").is_some() {
        let response: JsonRpcErrorResponse = serde_json::from_value(value)
            .map_err(|error| ClientError::InvalidResponse(error.to_string()))?;
        validate_response_identity(&response.jsonrpc, response.id.as_ref(), expected_id)?;
        return Err(ClientError::Rpc(response.error));
    }
    let response: JsonRpcSuccess<R> = serde_json::from_value(value)
        .map_err(|error| ClientError::InvalidResponse(error.to_string()))?;
    validate_response_identity(&response.jsonrpc, Some(&response.id), expected_id)?;
    Ok(response.result)
}

pub struct RunSubscriptionEventStream<'a, T, E> {
    transport: &'a T,
    receiver: mpsc::Receiver<String>,
    overflowed: std::sync::Arc<std::sync::atomic::AtomicBool>,
    subscription_id: SubscriptionId,
    event_subscription_id: fn(&E) -> &SubscriptionId,
    event_cursor: fn(&E) -> Option<&Cursor>,
    last_delivered_cursor: Option<Cursor>,
    closed: bool,
}

impl<'a, T, E> RunSubscriptionEventStream<'a, T, E>
where
    T: SubscriptionTransport,
    E: DeserializeOwned,
{
    pub async fn next(&mut self) -> Option<Result<RunSubscriptionEvent<E>, ClientError>> {
        if self.closed {
            return None;
        }
        let line = match self.receiver.recv().await {
            Some(line) => line,
            None if self.overflowed.swap(false, Ordering::AcqRel) => {
                self.closed = true;
                return Some(Ok(RunSubscriptionEvent::Closed {
                    reason: SubscriptionCloseReason::SlowConsumer,
                    last_delivered_cursor: self.last_delivered_cursor.clone(),
                }));
            }
            None => return None,
        };
        Some(self.parse_notification(&line))
    }

    fn parse_notification(&mut self, line: &str) -> Result<RunSubscriptionEvent<E>, ClientError> {
        let value: Value = serde_json::from_str(line)
            .map_err(|error| ClientError::InvalidResponse(error.to_string()))?;
        match value.get("method").and_then(Value::as_str) {
            Some("event") => {
                let notification: JsonRpcNotification<E> = serde_json::from_value(value)
                    .map_err(|error| ClientError::InvalidResponse(error.to_string()))?;
                let event = notification.params;
                if (self.event_subscription_id)(&event) != &self.subscription_id {
                    return Err(ClientError::InvalidResponse(
                        "native-v2 event subscription id mismatch".to_owned(),
                    ));
                }
                if let Some(cursor) = (self.event_cursor)(&event) {
                    self.last_delivered_cursor = Some(cursor.clone());
                }
                Ok(RunSubscriptionEvent::Event(event))
            }
            Some("subscription/closed") => {
                let notification: JsonRpcNotification<SubscriptionClosedNotification> =
                    serde_json::from_value(value)
                        .map_err(|error| ClientError::InvalidResponse(error.to_string()))?;
                if notification.params.subscription_id != self.subscription_id {
                    return Err(ClientError::InvalidResponse(
                        "native-v2 close subscription id mismatch".to_owned(),
                    ));
                }
                let last_delivered_cursor = notification
                    .params
                    .last_delivered_cursor
                    .or_else(|| self.last_delivered_cursor.clone());
                self.last_delivered_cursor = last_delivered_cursor.clone();
                self.closed = true;
                Ok(RunSubscriptionEvent::Closed {
                    reason: notification.params.reason,
                    last_delivered_cursor,
                })
            }
            other => Err(ClientError::InvalidResponse(format!(
                "unexpected subscription notification method {other:?}"
            ))),
        }
    }

    pub async fn cancel(&self) -> Result<(), ClientError> {
        self.transport
            .cancel_subscription(self.subscription_id.clone())
            .await?;
        Ok(())
    }

    #[must_use]
    pub fn last_delivered_cursor(&self) -> Option<&Cursor> {
        self.last_delivered_cursor.as_ref()
    }
}

fn watch_subscription_id(result: &RunWatchResult) -> &SubscriptionId {
    &result.subscription_id
}

fn logs_subscription_id(result: &RunLogsResult) -> &SubscriptionId {
    &result.subscription_id
}

fn attach_subscription_id(result: &RunAttachResult) -> &SubscriptionId {
    &result.subscription_id
}

fn watch_event_subscription_id(event: &RunWatchEventNotification) -> &SubscriptionId {
    &event.subscription_id
}

fn log_event_subscription_id(event: &RunLogEventNotification) -> &SubscriptionId {
    &event.subscription_id
}

fn attach_event_subscription_id(event: &RunAttachEventNotification) -> &SubscriptionId {
    &event.subscription_id
}

fn watch_event_cursor(event: &RunWatchEventNotification) -> Option<&Cursor> {
    Some(&event.cursor)
}

fn log_event_cursor(event: &RunLogEventNotification) -> Option<&Cursor> {
    Some(&event.cursor)
}

fn no_event_cursor(_event: &RunAttachEventNotification) -> Option<&Cursor> {
    None
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicI64, Ordering};
    use std::sync::Arc;

    use async_trait::async_trait;
    use openengine_cluster_protocol::{
        JsonRpcRequest, RequestId, RunId, RunWatchParams, SubscriptionId,
    };
    use serde_json::{json, Value};
    use tokio::sync::mpsc;

    use super::*;
    use crate::{JsonRpcTransport, PumpedSubscription, TransportError};

    struct ScriptedSubscriptionTransport {
        result: Value,
        notifications: Vec<String>,
        provide_stream: bool,
        expected_method: &'static str,
        next_id: AtomicI64,
    }

    impl ScriptedSubscriptionTransport {
        fn new(
            expected_method: &'static str,
            result: Value,
            notifications: Vec<Value>,
            provide_stream: bool,
        ) -> Self {
            Self {
                result,
                notifications: notifications
                    .into_iter()
                    .map(|value| value.to_string())
                    .collect(),
                provide_stream,
                expected_method,
                next_id: AtomicI64::new(1),
            }
        }
    }

    #[async_trait]
    impl JsonRpcTransport for ScriptedSubscriptionTransport {
        async fn request(&self, _request: String) -> Result<String, TransportError> {
            unreachable!("subscription tests use open_subscription")
        }
    }

    #[async_trait]
    impl SubscriptionTransport for ScriptedSubscriptionTransport {
        async fn open_subscription(
            &self,
            request: String,
            id: RequestId,
        ) -> Result<(String, Option<PumpedSubscription>), TransportError> {
            let request: JsonRpcRequest<Value> = serde_json::from_str(&request).unwrap();
            assert_eq!(request.id, id);
            assert_eq!(request.method, self.expected_method);
            let response = json!({"jsonrpc":"2.0","id":id,"result":self.result}).to_string();
            if !self.provide_stream {
                return Ok((response, None));
            }
            let (sender, receiver) = mpsc::channel(self.notifications.len().max(1));
            for notification in &self.notifications {
                sender.try_send(notification.clone()).unwrap();
            }
            drop(sender);
            Ok((
                response,
                Some(PumpedSubscription {
                    receiver,
                    overflowed: Arc::new(std::sync::atomic::AtomicBool::new(false)),
                }),
            ))
        }

        async fn cancel_subscription(&self, _id: SubscriptionId) -> Result<(), TransportError> {
            Ok(())
        }

        async fn cancel_request(&self, _id: RequestId) -> Result<(), TransportError> {
            Ok(())
        }

        fn next_watch_request_id(&self) -> RequestId {
            RequestId::Integer(self.next_id.fetch_add(1, Ordering::Relaxed))
        }
    }

    fn watch_result() -> Value {
        json!({"subscriptionId":"watch-1","runId":"run-1","atCursor":"v2:7"})
    }

    #[tokio::test]
    async fn successful_subscription_without_a_stream_is_an_invalid_response() {
        let transport =
            ScriptedSubscriptionTransport::new(RUN_WATCH_METHOD, watch_result(), vec![], false);
        let error = RunSubscriptionClient::new(&transport)
            .run_watch(RunWatchParams {
                run_id: RunId::new("run-1"),
                from_cursor: None,
            })
            .await
            .err()
            .expect("missing stream must fail");
        assert!(matches!(error, ClientError::InvalidResponse(_)));
    }

    #[tokio::test]
    async fn close_retains_the_local_cursor_and_is_terminal() {
        let transport = ScriptedSubscriptionTransport::new(
            RUN_WATCH_METHOD,
            watch_result(),
            vec![
                json!({
                    "jsonrpc":"2.0","method":"event","params":{
                        "subscriptionId":"watch-1","runId":"run-1","cursor":"v2:8",
                        "status":{"phase":"running","activeExecutions":[]}
                    }
                }),
                json!({
                    "jsonrpc":"2.0","method":"subscription/closed","params":{
                        "subscriptionId":"watch-1","reason":"done"
                    }
                }),
                json!({
                    "jsonrpc":"2.0","method":"event","params":{
                        "subscriptionId":"watch-1","runId":"run-1","cursor":"v2:9",
                        "status":{"phase":"running","activeExecutions":[]}
                    }
                }),
            ],
            true,
        );
        let (_, mut stream) = RunSubscriptionClient::new(&transport)
            .run_watch(RunWatchParams {
                run_id: RunId::new("run-1"),
                from_cursor: None,
            })
            .await
            .unwrap();

        assert!(matches!(
            stream.next().await.unwrap().unwrap(),
            RunSubscriptionEvent::Event(_)
        ));
        assert_eq!(
            stream.next().await.unwrap().unwrap(),
            RunSubscriptionEvent::Closed {
                reason: SubscriptionCloseReason::Done,
                last_delivered_cursor: Some(Cursor::new("v2:8")),
            }
        );
        assert!(stream.next().await.is_none());
        assert_eq!(stream.last_delivered_cursor(), Some(&Cursor::new("v2:8")));
    }

    #[tokio::test]
    async fn logs_and_attach_use_their_run_scoped_method_names() {
        let logs = ScriptedSubscriptionTransport::new(
            RUN_LOGS_METHOD,
            json!({"subscriptionId":"logs-1","runId":"run-1","atCursor":"v2:1"}),
            vec![],
            true,
        );
        RunSubscriptionClient::new(&logs)
            .run_logs(RunLogsParams {
                run_id: RunId::new("run-1"),
                from_cursor: None,
                execution: None,
            })
            .await
            .unwrap();

        let attach = ScriptedSubscriptionTransport::new(
            RUN_ATTACH_METHOD,
            json!({
                "subscriptionId":"attach-1","runId":"run-1","execution":"execution-1"
            }),
            vec![],
            true,
        );
        RunSubscriptionClient::new(&attach)
            .run_attach(RunAttachParams {
                run_id: RunId::new("run-1"),
                execution: openengine_cluster_protocol::ExecutionRef::new("execution-1").unwrap(),
            })
            .await
            .unwrap();
    }
}
