//! Transport-generic native-v2 run subscription client.

use openengine_cluster_protocol::{
    Cursor, JsonRpcNotification, RunAttachEventNotification, RunAttachParams, RunAttachResult,
    RunLogEventNotification, RunLogsParams, RunLogsResult, RunWatchEventNotification,
    RunWatchParams, RunWatchResult, SubscriptionCloseReason, SubscriptionId, RUN_ATTACH_METHOD,
    RUN_LOGS_METHOD, RUN_WATCH_METHOD,
};
use serde::de::DeserializeOwned;
use serde::Serialize;
use crate::ndjson_subscription::{
    impl_cursor_subscription_controls, open_subscription, parse_subscription_close,
    parse_subscription_notification, PumpedLine, SubscriptionClientCore, SubscriptionStreamCore,
};
use crate::{ClientError, NdjsonTransport, SubscriptionTransport};

#[derive(Clone, Debug, PartialEq)]
pub enum RunSubscriptionEvent<E> {
    Event(E),
    Closed {
        reason: SubscriptionCloseReason,
        last_delivered_cursor: Option<Cursor>,
    },
}

pub struct RunSubscriptionClient<'a, T> {
    core: SubscriptionClientCore<'a, T>,
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
        Self {
            core: SubscriptionClientCore::new(transport),
        }
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
        let (result, subscription) =
            open_subscription(self.core.transport(), method, params).await?;
        let subscription_id = (shape.result_subscription_id)(&result).clone();
        let subscription = subscription.ok_or_else(|| {
            ClientError::InvalidResponse(
                "successful native-v2 subscription response had no notification stream".to_owned(),
            )
        })?;
        Ok((
            result,
            RunSubscriptionEventStream {
                core: SubscriptionStreamCore::new(
                    self.core.transport(),
                    subscription,
                    subscription_id,
                ),
                event_subscription_id: shape.event_subscription_id,
                event_cursor: shape.event_cursor,
                closed: false,
            },
        ))
    }
}

pub struct RunSubscriptionEventStream<'a, T, E> {
    core: SubscriptionStreamCore<'a, T>,
    event_subscription_id: fn(&E) -> &SubscriptionId,
    event_cursor: fn(&E) -> Option<&Cursor>,
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
        let line = match self.core.next_line().await {
            PumpedLine::Frame(line) => line,
            PumpedLine::SlowConsumer => {
                self.closed = true;
                return Some(Ok(RunSubscriptionEvent::Closed {
                    reason: SubscriptionCloseReason::SlowConsumer,
                    last_delivered_cursor: self.core.last_delivered_cursor().cloned(),
                }));
            }
            PumpedLine::End => return None,
        };
        Some(self.parse_notification(&line))
    }

    fn parse_notification(&mut self, line: &str) -> Result<RunSubscriptionEvent<E>, ClientError> {
        let (method, value) = parse_subscription_notification(line)?;
        match method.as_deref() {
            Some("event") => {
                let notification: JsonRpcNotification<E> = serde_json::from_value(value)
                    .map_err(|error| ClientError::InvalidResponse(error.to_string()))?;
                let event = notification.params;
                if (self.event_subscription_id)(&event) != self.core.subscription_id() {
                    return Err(ClientError::InvalidResponse(
                        "native-v2 event subscription id mismatch".to_owned(),
                    ));
                }
                if let Some(cursor) = (self.event_cursor)(&event) {
                    self.core.record_delivered_cursor(cursor.clone());
                }
                Ok(RunSubscriptionEvent::Event(event))
            }
            Some("subscription/closed") => {
                let (reason, observed_cursor) =
                    parse_subscription_close(value, self.core.subscription_id())?;
                let last_delivered_cursor =
                    observed_cursor.or_else(|| self.core.last_delivered_cursor().cloned());
                if let Some(cursor) = &last_delivered_cursor {
                    self.core.record_delivered_cursor(cursor.clone());
                }
                self.closed = true;
                Ok(RunSubscriptionEvent::Closed {
                    reason,
                    last_delivered_cursor,
                })
            }
            other => Err(ClientError::InvalidResponse(format!(
                "unexpected subscription notification method {other:?}"
            ))),
        }
    }

    impl_cursor_subscription_controls!();
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
    use std::fmt::Debug;
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

    fn checked_result<T, E: Debug>(result: Result<T, E>) -> T {
        let mut values = result.into_iter().collect::<Vec<_>>();
        assert_eq!(values.len(), 1, "expected a successful result");
        values.swap_remove(0)
    }

    fn checked_option<T>(value: Option<T>) -> T {
        let mut values = value.into_iter().collect::<Vec<_>>();
        assert_eq!(values.len(), 1, "expected a value");
        values.swap_remove(0)
    }

    fn checked_error<T, E>(result: Result<T, E>) -> E {
        assert!(result.is_err(), "expected an error");
        let mut errors = result.err().into_iter().collect::<Vec<_>>();
        errors.swap_remove(0)
    }

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
            Err(TransportError::Protocol(
                "subscription tests use open_subscription".to_owned(),
            ))
        }
    }

    #[async_trait]
    impl SubscriptionTransport for ScriptedSubscriptionTransport {
        async fn open_subscription(
            &self,
            request: String,
            id: RequestId,
        ) -> Result<(String, Option<PumpedSubscription>), TransportError> {
            let request: JsonRpcRequest<Value> = checked_result(serde_json::from_str(&request));
            assert_eq!(request.id, id);
            assert_eq!(request.method, self.expected_method);
            let response = json!({"jsonrpc":"2.0","id":id,"result":self.result}).to_string();
            if !self.provide_stream {
                return Ok((response, None));
            }
            let (sender, receiver) = mpsc::channel(self.notifications.len().max(1));
            for notification in &self.notifications {
                checked_result(sender.try_send(notification.clone()));
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
        let error = checked_error(
            RunSubscriptionClient::new(&transport)
                .run_watch(RunWatchParams {
                    run_id: RunId::new("run-1"),
                    from_cursor: None,
                })
                .await,
        );
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
                        "title":"Protocol client test",
                        "source":{
                            "repository":"open-engine/zeroshot",
                            "branch":"main",
                            "revision":"0123456789abcdef0123456789abcdef01234567"
                        },
                        "size":"tiny",
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
                        "title":"Protocol client test",
                        "source":{
                            "repository":"open-engine/zeroshot",
                            "branch":"main",
                            "revision":"0123456789abcdef0123456789abcdef01234567"
                        },
                        "size":"tiny",
                        "status":{"phase":"running","activeExecutions":[]}
                    }
                }),
            ],
            true,
        );
        let (_, mut stream) = checked_result(
            RunSubscriptionClient::new(&transport)
                .run_watch(RunWatchParams {
                    run_id: RunId::new("run-1"),
                    from_cursor: None,
                })
                .await,
        );

        assert!(matches!(
            checked_result(checked_option(stream.next().await)),
            RunSubscriptionEvent::Event(_)
        ));
        assert_eq!(
            checked_result(checked_option(stream.next().await)),
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
        checked_result(
            RunSubscriptionClient::new(&logs)
                .run_logs(RunLogsParams {
                    run_id: RunId::new("run-1"),
                    from_cursor: None,
                    execution: None,
                })
                .await,
        );

        let attach = ScriptedSubscriptionTransport::new(
            RUN_ATTACH_METHOD,
            json!({
                "subscriptionId":"attach-1","runId":"run-1","execution":"execution-1"
            }),
            vec![],
            true,
        );
        checked_result(
            RunSubscriptionClient::new(&attach)
                .run_attach(RunAttachParams {
                    run_id: RunId::new("run-1"),
                    execution: checked_result(openengine_cluster_protocol::ExecutionRef::new(
                        "execution-1",
                    )),
                })
                .await,
        );
    }
}
