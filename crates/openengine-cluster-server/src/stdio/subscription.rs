//! Shared "establish, then forward notifications until the stream ends" machinery for every
//! `serve_ndjson` subscription kind (`watch`, `logs`, `agent_attach`). [`EventSource`] lets
//! [`run_established_subscription`] drive `watch`'s [`crate::watch::WatchEventStream`] and the
//! bounded `logs`/`agent_attach` capabilities' [`BoundedEventStream`] through exactly one
//! establish/loop/cleanup implementation despite their differently-shaped per-item payloads;
//! [`run_bounded_event_subscription`] is the `logs`/`agent_attach`-specific wrapper that also
//! knows how to encode a [`BoundedStreamItem`] into a wire notification.

use std::sync::Arc;

use openengine_cluster_protocol::{RequestId, SubscriptionCloseReason, SubscriptionId};
use tokio::sync::{mpsc, Notify};

use super::{race_cancel_or_next, ConnectionState, SubscriptionMap};
use crate::subscription_stream::{BoundedEventHandle, BoundedEventStream, BoundedStreamItem};
use crate::watch::{WatchEventStream, WatchStreamItem};

/// Minimal event-source abstraction: any stream type with an inherent `async fn next(&mut self)
/// -> Option<Item>` can be driven by [`run_established_subscription`]'s one shared loop.
pub(super) trait EventSource {
    type Item;
    async fn next(&mut self) -> Option<Self::Item>;
}

impl<E> EventSource for BoundedEventStream<E> {
    type Item = BoundedStreamItem<E>;
    async fn next(&mut self) -> Option<Self::Item> {
        BoundedEventStream::next(self).await
    }
}

impl EventSource for WatchEventStream {
    type Item = WatchStreamItem;
    async fn next(&mut self) -> Option<Self::Item> {
        WatchEventStream::next(self).await
    }
}

/// Grouped owned per-connection channels for [`run_established_subscription`], keeping that
/// function's argument count reasonable.
pub(super) struct SubscriptionChannels {
    pub(super) outbound_tx: mpsc::Sender<String>,
    pub(super) subscriptions: SubscriptionMap,
}

/// Grouped identity for an already-established subscription, keeping
/// [`run_established_subscription`]'s argument count reasonable.
pub(super) struct EstablishedSubscription<S> {
    pub(super) subscription_id: SubscriptionId,
    pub(super) stream: S,
    pub(super) cancel: Arc<Notify>,
}

/// Registers `subscription_id`'s cancellation [`Notify`] in `subscriptions` before sending
/// `response`: a `subscription/cancel` racing in while the send is backpressured must always find
/// the subscription already cancellable. Rolls the registration back and returns `false` if the
/// send fails, in which case the caller must not stream anything.
async fn register_and_send_established_response(
    channels: &SubscriptionChannels,
    subscription_id: &SubscriptionId,
    cancel: &Arc<Notify>,
    response: String,
) -> bool {
    channels
        .subscriptions
        .lock()
        .insert(subscription_id.clone(), Arc::clone(cancel));
    if channels.outbound_tx.send(response).await.is_err() {
        channels.subscriptions.lock().remove(subscription_id);
        return false;
    }
    true
}

/// Shared establishment step for every subscription kind: sends `response`, and if `established`
/// carries a minted subscription, also registers its cancellation [`Notify`] before the send (see
/// [`register_and_send_established_response`]). Returns `None` if establishment failed upstream or
/// the response send failed either way, in which case the caller must not stream anything; the
/// caller must otherwise keep the returned handle alive for the duration of streaming since
/// dropping it early would trip the underlying stream's own cancellation check before anything
/// ever streams.
pub(super) async fn establish_subscription<S, H>(
    channels: &SubscriptionChannels,
    response: String,
    established: Option<(SubscriptionId, S, H)>,
) -> Option<(EstablishedSubscription<S>, H)> {
    let Some((subscription_id, stream, handle)) = established else {
        let _ = channels.outbound_tx.send(response).await;
        return None;
    };
    let cancel = Arc::new(Notify::new());
    if !register_and_send_established_response(channels, &subscription_id, &cancel, response).await
    {
        return None;
    }
    Some((
        EstablishedSubscription {
            subscription_id,
            stream,
            cancel,
        },
        handle,
    ))
}

/// Streams an already-established subscription's [`EventSource`] until it ends (overflow, backend
/// close, or cancellation) via [`race_cancel_or_next`], encoding each item through `encode`.
/// Returning `None` from `encode` ends the subscription without sending anything -- used to drop
/// an oversized/unserializable item instead of ever falling back to a raw/unbounded wire
/// representation. Deregisters the subscription once the stream stops for any reason.
pub(super) async fn run_established_subscription<S: EventSource>(
    established: EstablishedSubscription<S>,
    channels: SubscriptionChannels,
    mut encode: impl FnMut(S::Item) -> Option<String>,
) {
    let EstablishedSubscription {
        subscription_id,
        mut stream,
        cancel,
    } = established;
    let SubscriptionChannels {
        outbound_tx,
        subscriptions,
    } = channels;
    loop {
        let Some(item) = race_cancel_or_next(&cancel, stream.next()).await else {
            break;
        };
        let Some(notification) = encode(item) else {
            break;
        };
        if outbound_tx.send(notification).await.is_err() {
            break;
        }
    }
    subscriptions.lock().remove(&subscription_id);
}

/// Grouped arguments for [`run_bounded_event_subscription`], keeping that function's argument
/// count reasonable.
pub(super) struct BoundedEventSubscriptionRequest<E> {
    pub(super) id: RequestId,
    pub(super) response: String,
    pub(super) established: Option<(SubscriptionId, BoundedEventStream<E>, BoundedEventHandle)>,
    pub(super) state: ConnectionState,
}

pub(super) async fn run_bounded_event_subscription<E>(
    request: BoundedEventSubscriptionRequest<E>,
    encode_event: impl Fn(SubscriptionId, E) -> serde_json::Result<String>,
    encode_closed: impl Fn(SubscriptionId, SubscriptionCloseReason) -> serde_json::Result<String>,
) {
    let BoundedEventSubscriptionRequest {
        id,
        response,
        established,
        state,
    } = request;
    let ConnectionState {
        outbound_tx,
        subscriptions,
        in_flight_ids,
    } = state;
    in_flight_ids.lock().remove(&id);
    let channels = SubscriptionChannels {
        outbound_tx,
        subscriptions,
    };
    let Some((established, _handle)) =
        establish_subscription(&channels, response, established).await
    else {
        return;
    };

    // A bounded oversized/unserializable event (e.g. driven by a pathologically large
    // backend-supplied subscription id) must never panic the server task -- `encode` returning
    // `None` below ends only this subscription through the shared cleanup, never falling back to
    // an unbounded or raw wire representation.
    let encode_subscription_id = established.subscription_id.clone();
    run_established_subscription(established, channels, move |item| {
        let encoded = match item {
            BoundedStreamItem::Event(event) => encode_event(encode_subscription_id.clone(), event),
            BoundedStreamItem::Closed { reason } => {
                encode_closed(encode_subscription_id.clone(), reason)
            }
        };
        encoded.ok()
    })
    .await;
}
