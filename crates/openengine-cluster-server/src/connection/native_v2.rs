//! Connection routing for native-v2 run observation subscriptions.

use openengine_cluster_protocol::{
    Cursor, DomainErrorData, JsonRpcNotification, RequestId, RunAttachParams, RunLogsParams,
    RunLogEventNotification, RunWatchEventNotification, RunWatchParams,
    SubscriptionClosedNotification, SubscriptionId, INVALID_PARAMS, JSON_RPC_VERSION,
    SCHEMA_VIOLATION,
};
use serde_json::Value;

use super::subscription::{
    establish_subscription, run_established_subscription, EventSource, SubscriptionChannels,
};
use super::ConnectionState;
use crate::native_v2::{
    RunAttachEventStream, RunLogEventStream, RunSubscriptionItem, RunWatchEventStream,
};
use crate::{serialize_backend_error, serialize_error, serialize_success, ClusterBackend, Dispatcher};

pub(crate) async fn run_run_watch_subscription<B>(
    dispatcher: Dispatcher<B>,
    id: RequestId,
    params: Value,
    state: ConnectionState,
) where
    B: ClusterBackend,
{
    let (response, established) = dispatcher.dispatch_run_watch(id.clone(), params).await;
    run_cursor_subscription(id, state, response, established).await;
}

pub(crate) async fn run_run_logs_subscription<B>(
    dispatcher: Dispatcher<B>,
    id: RequestId,
    params: Value,
    state: ConnectionState,
) where
    B: ClusterBackend,
{
    let (response, established) = dispatcher.dispatch_run_logs(id.clone(), params).await;
    run_cursor_subscription(id, state, response, established).await;
}

trait CursorNotification: serde::Serialize {
    fn bind_subscription(&mut self, subscription_id: SubscriptionId);
    fn cursor(&self) -> Cursor;
}

impl CursorNotification for RunWatchEventNotification {
    fn bind_subscription(&mut self, subscription_id: SubscriptionId) {
        self.subscription_id = subscription_id;
    }

    fn cursor(&self) -> Cursor {
        self.cursor.clone()
    }
}

impl CursorNotification for RunLogEventNotification {
    fn bind_subscription(&mut self, subscription_id: SubscriptionId) {
        self.subscription_id = subscription_id;
    }

    fn cursor(&self) -> Cursor {
        self.cursor.clone()
    }
}

async fn run_cursor_subscription<S, E>(
    id: RequestId,
    state: ConnectionState,
    response: String,
    established: Option<(SubscriptionId, S, ())>,
) where
    S: EventSource<Item = RunSubscriptionItem<E>>,
    E: CursorNotification,
{
    let channels = subscription_channels(id, state);
    let Some((established, ())) = establish_subscription(&channels, response, established).await
    else {
        return;
    };
    let subscription_id = established.subscription_id.clone();
    let mut last_delivered_cursor = None;
    run_established_subscription(established, channels, move |item| match item {
        RunSubscriptionItem::Event(mut event) => {
            event.bind_subscription(subscription_id.clone());
            last_delivered_cursor = Some(event.cursor());
            event_notification(event)
        }
        RunSubscriptionItem::Closed { reason } => closed_notification(
            subscription_id.clone(),
            reason,
            last_delivered_cursor.clone(),
        ),
    })
    .await;
}

pub(crate) async fn run_run_attach_subscription<B>(
    dispatcher: Dispatcher<B>,
    id: RequestId,
    params: Value,
    state: ConnectionState,
) where
    B: ClusterBackend,
{
    let (response, established) = dispatcher.dispatch_run_attach(id.clone(), params).await;
    let channels = subscription_channels(id, state);
    let Some((established, ())) = establish_subscription(&channels, response, established).await
    else {
        return;
    };
    let subscription_id = established.subscription_id.clone();
    run_established_subscription(established, channels, move |item| match item {
        RunSubscriptionItem::Event(mut event) => {
            event.subscription_id = subscription_id.clone();
            event_notification(event)
        }
        RunSubscriptionItem::Closed { reason } => {
            closed_notification(subscription_id.clone(), reason, None)
        }
    })
    .await;
}

fn subscription_channels(id: RequestId, state: ConnectionState) -> SubscriptionChannels {
    let ConnectionState {
        outbound_tx,
        subscriptions,
        in_flight_ids,
    } = state;
    in_flight_ids.lock().remove(&id);
    SubscriptionChannels {
        outbound_tx,
        subscriptions,
    }
}

fn event_notification<P: serde::Serialize>(params: P) -> Option<String> {
    serde_json::to_string(&JsonRpcNotification {
        jsonrpc: JSON_RPC_VERSION.to_owned(),
        method: "event".to_owned(),
        params,
    })
    .ok()
}

fn closed_notification(
    subscription_id: SubscriptionId,
    reason: openengine_cluster_protocol::SubscriptionCloseReason,
    last_delivered_cursor: Option<openengine_cluster_protocol::Cursor>,
) -> Option<String> {
    event_notification_with_method(
        "subscription/closed",
        SubscriptionClosedNotification {
            subscription_id,
            reason,
            last_delivered_cursor,
        },
    )
}

fn event_notification_with_method<P: serde::Serialize>(method: &str, params: P) -> Option<String> {
    serde_json::to_string(&JsonRpcNotification {
        jsonrpc: JSON_RPC_VERSION.to_owned(),
        method: method.to_owned(),
        params,
    })
    .ok()
}

impl<B> Dispatcher<B>
where
    B: ClusterBackend,
{
    pub(crate) async fn dispatch_run_watch(
        &self,
        id: RequestId,
        params: Value,
    ) -> (String, Option<(SubscriptionId, RunWatchEventStream, ())>) {
        let params = match serde_json::from_value::<RunWatchParams>(params) {
            Ok(params) => params,
            Err(_) => return subscription_invalid_params(id),
        };
        match self.run_watch(params).await {
            Ok((result, stream)) => {
                let subscription_id = result.subscription_id.clone();
                (
                    serialize_success(id, result),
                    Some((subscription_id, stream, ())),
                )
            }
            Err(error) => (serialize_backend_error(id, error), None),
        }
    }

    pub(crate) async fn dispatch_run_logs(
        &self,
        id: RequestId,
        params: Value,
    ) -> (String, Option<(SubscriptionId, RunLogEventStream, ())>) {
        let params = match serde_json::from_value::<RunLogsParams>(params) {
            Ok(params) => params,
            Err(_) => return subscription_invalid_params(id),
        };
        match self.run_logs(params).await {
            Ok((result, stream)) => {
                let subscription_id = result.subscription_id.clone();
                (
                    serialize_success(id, result),
                    Some((subscription_id, stream, ())),
                )
            }
            Err(error) => (serialize_backend_error(id, error), None),
        }
    }

    pub(crate) async fn dispatch_run_attach(
        &self,
        id: RequestId,
        params: Value,
    ) -> (String, Option<(SubscriptionId, RunAttachEventStream, ())>) {
        let params = match serde_json::from_value::<RunAttachParams>(params) {
            Ok(params) => params,
            Err(_) => return subscription_invalid_params(id),
        };
        match self.run_attach(params).await {
            Ok((result, stream)) => {
                let subscription_id = result.subscription_id.clone();
                (
                    serialize_success(id, result),
                    Some((subscription_id, stream, ())),
                )
            }
            Err(error) => (serialize_backend_error(id, error), None),
        }
    }
}

fn subscription_invalid_params<S>(id: RequestId) -> (String, Option<S>) {
    (
        serialize_error(
            Some(id),
            INVALID_PARAMS,
            "Invalid params",
            Some(DomainErrorData::new(SCHEMA_VIOLATION)),
        ),
        None,
    )
}
