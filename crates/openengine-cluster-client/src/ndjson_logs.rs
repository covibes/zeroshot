//! NDJSON-bound `logs` subscription client. Drives `logs`/`event`/`subscription/cancel`/
//! `subscription/closed` notifications over [`crate::NdjsonTransport`], reusing the exact same
//! generic subscription framing [`crate::ndjson_watch`] uses. There is no dedup or reconnect logic
//! here, unlike [`crate::NdjsonReconnectingEventStream`] -- `logs` has no cursor to resume from.

use crate::ndjson_subscription::impl_ndjson_event_subscription;

impl_ndjson_event_subscription! {
    client: NdjsonLogsClient,
    stream: NdjsonLogsEventStream,
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
