//! Typed in-process watch subscription client with client-side `(runId, cursor)` dedup and
//! reconnect-from-last-delivered-cursor. NDJSON/WebSocket subscription binding is out of scope
//! for this slice, so this wraps the transport-neutral [`Dispatcher::watch`] passthrough
//! directly rather than [`crate::JsonRpcTransport`].

use std::collections::HashSet;

use openengine_cluster_protocol::{Cursor, RunId, SubscriptionCloseReason, WatchParams, WatchResult};
use openengine_cluster_server::watch::{
    PublicEventRecord, WatchEventStream, WatchHandle, WatchStreamItem,
};
use openengine_cluster_server::{BackendError, ClusterBackend, Dispatcher};

/// Admits a durable event into a `(runId, cursor)` de-dup set, returning `true` the first time
/// this pair is seen (updating `last_delivered`) or `false` for a legal at-least-once physical
/// duplicate redelivery the caller must drop. Shared by [`ReconnectingEventStream::next`]
/// (in-process) and [`crate::NdjsonReconnectingEventStream::next`] (NDJSON), which otherwise
/// source events from entirely different transports.
pub(crate) fn admit_event(
    seen: &mut HashSet<(RunId, Cursor)>,
    last_delivered: &mut Option<Cursor>,
    record: &PublicEventRecord,
) -> bool {
    let key = (record.run_id.clone(), record.cursor.clone());
    if !seen.insert(key) {
        return false;
    }
    *last_delivered = Some(record.cursor.clone());
    true
}

/// One item observed by [`ReconnectingEventStream`]: a durable public event not yet seen by this
/// stream, or a terminal close.
#[derive(Clone, Debug, PartialEq)]
pub enum EventOrClosed {
    Event(PublicEventRecord),
    Closed {
        reason: SubscriptionCloseReason,
        last_delivered_cursor: Option<Cursor>,
    },
}

/// Typed in-process watch client. Wraps a [`Dispatcher`] directly since NDJSON/WebSocket
/// subscription framing is bound by a later issue.
pub struct WatchClient<B> {
    dispatcher: Dispatcher<B>,
}

impl<B> WatchClient<B>
where
    B: ClusterBackend,
{
    #[must_use]
    pub const fn new(dispatcher: Dispatcher<B>) -> Self {
        Self { dispatcher }
    }

    pub async fn watch(
        &self,
        params: WatchParams,
    ) -> Result<(WatchResult, ReconnectingEventStream, WatchHandle), BackendError> {
        let (result, stream, handle) = self.dispatcher.watch(params.clone()).await?;
        let reconnecting = ReconnectingEventStream {
            stream,
            seen: HashSet::new(),
            last_delivered: params.from_cursor,
            subscription_params: WatchParams {
                run_id: result.run_id.clone(),
                from_cursor: None,
            },
        };
        Ok((result, reconnecting, handle))
    }

    /// Re-establishes a subscription from `stream`'s last delivered cursor, on the same run it
    /// had attached to (or still parked, if it never attached). The dedup set survives the
    /// reconnect so a duplicate delivered before and after reconnect is still suppressed once.
    pub async fn reconnect(
        &self,
        stream: ReconnectingEventStream,
    ) -> Result<(WatchResult, ReconnectingEventStream, WatchHandle), BackendError> {
        let params = WatchParams {
            run_id: stream.subscription_params.run_id.clone(),
            from_cursor: stream.last_delivered.clone(),
        };
        let (result, next_stream, handle) = self.dispatcher.watch(params).await?;
        let reconnecting = ReconnectingEventStream {
            stream: next_stream,
            seen: stream.seen,
            last_delivered: stream.last_delivered,
            subscription_params: WatchParams {
                run_id: result.run_id.clone(),
                from_cursor: None,
            },
        };
        Ok((result, reconnecting, handle))
    }
}

/// Deduplicates durable events by `(runId, cursor)` across legal at-least-once physical
/// redelivery and across reconnect.
pub struct ReconnectingEventStream {
    stream: WatchEventStream,
    seen: HashSet<(RunId, Cursor)>,
    last_delivered: Option<Cursor>,
    subscription_params: WatchParams,
}

impl ReconnectingEventStream {
    /// Returns the next logically new event, transparently dropping legal duplicate physical
    /// deliveries, or a terminal close. Returns `None` once the subscription is cancelled or
    /// otherwise permanently done.
    pub async fn next(&mut self) -> Option<EventOrClosed> {
        loop {
            match self.stream.next().await? {
                WatchStreamItem::Record(record) => {
                    self.subscription_params
                        .run_id
                        .get_or_insert_with(|| record.run_id.clone());
                    if !admit_event(&mut self.seen, &mut self.last_delivered, &record) {
                        continue;
                    }
                    return Some(EventOrClosed::Event(record));
                }
                WatchStreamItem::Closed {
                    reason,
                    last_delivered_cursor,
                } => {
                    if last_delivered_cursor.is_some() {
                        self.last_delivered = last_delivered_cursor.clone();
                    }
                    return Some(EventOrClosed::Closed {
                        reason,
                        last_delivered_cursor,
                    });
                }
            }
        }
    }

    #[must_use]
    pub fn last_delivered_cursor(&self) -> Option<&Cursor> {
        self.last_delivered.as_ref()
    }
}
