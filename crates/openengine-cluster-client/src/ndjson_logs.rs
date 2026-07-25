//! [`crate::SubscriptionTransport`]-generic `logs` subscription client. Drives `logs`/`event`/
//! `subscription/cancel`/`subscription/closed` notifications over any [`crate::SubscriptionTransport`],
//! reusing the exact same generic subscription framing [`crate::ndjson_watch`] uses.
//! [`NdjsonLogsClient`]/[`NdjsonLogsEventStream`] alias this machinery to [`crate::NdjsonTransport`].
//! There is no dedup or reconnect logic here, unlike [`crate::NdjsonReconnectingEventStream`] --
//! `logs` has no cursor to resume from.

use crate::ndjson_subscription::impl_ndjson_event_subscription;

impl_ndjson_event_subscription! {
    generic_client: LogsSubscriptionClient,
    generic_stream: LogsSubscriptionEventStream,
    ndjson_client: NdjsonLogsClient,
    ndjson_stream: NdjsonLogsEventStream,
    event_or_closed: LogEventOrClosed,
    method_fn: logs,
    method_name: "logs",
    params: openengine_cluster_protocol::LogsParams,
    result: openengine_cluster_protocol::LogsResult,
    event: openengine_cluster_protocol::LogRecord,
    event_notification: openengine_cluster_protocol::LogEventNotification,
    event_field: record,
    closed_notification: openengine_cluster_protocol::LogsClosedNotification,
    parse_response_fn: parse_logs_response,
    parse_notification_fn: parse_log_notification,
}
