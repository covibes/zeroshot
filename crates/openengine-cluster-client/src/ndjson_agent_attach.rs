//! [`crate::SubscriptionTransport`]-generic `agent/attach` subscription client. Drives
//! `agent/attach`/`event`/`subscription/cancel`/`subscription/closed` notifications over any
//! [`crate::SubscriptionTransport`], reusing the exact same generic subscription framing
//! [`crate::ndjson_watch`]/[`crate::ndjson_logs`] use. [`NdjsonAgentAttachClient`]/
//! [`NdjsonAgentAttachEventStream`] alias this machinery to [`crate::NdjsonTransport`]. There is
//! no dedup or reconnect logic here, unlike [`crate::NdjsonReconnectingEventStream`] --
//! `agent/attach` has no cursor to resume from.

use crate::ndjson_subscription::impl_ndjson_event_subscription;

impl_ndjson_event_subscription! {
    generic_client: AgentAttachSubscriptionClient,
    generic_stream: AgentAttachSubscriptionEventStream,
    ndjson_client: NdjsonAgentAttachClient,
    ndjson_stream: NdjsonAgentAttachEventStream,
    event_or_closed: AgentAttachEventOrClosed,
    method_fn: agent_attach,
    method_name: "agent/attach",
    params: openengine_cluster_protocol::AgentAttachParams,
    result: openengine_cluster_protocol::AgentAttachResult,
    event: openengine_cluster_protocol::AgentAttachEvent,
    event_notification: openengine_cluster_protocol::AgentAttachEventNotification,
    event_field: event,
    closed_notification: openengine_cluster_protocol::AgentAttachClosedNotification,
    parse_response_fn: parse_agent_attach_response,
    parse_notification_fn: parse_agent_attach_notification,
}
