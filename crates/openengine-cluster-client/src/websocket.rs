//! Production WebSocket transport for the typed Cluster Protocol client: demultiplexes unary
//! request/response traffic and generic `watch`/`logs`/`agent_attach` subscription notifications
//! sharing one WebSocket connection, correlating by request id and subscription id respectively.
//! [`WebSocketFrameSink`] backs [`crate::multiplex::FrameSink`], and [`WebSocketTransport`] holds
//! one [`crate::multiplex::MultiplexedTransport`] built from it -- the exact same demux state and
//! [`crate::JsonRpcTransport`]/[`crate::SubscriptionTransport`] wiring [`crate::NdjsonTransport`]
//! holds via [`crate::NdjsonFrameSink`] -- so only the underlying frame shape (NDJSON line vs.
//! `Message::Text`) differs between the two transports.

use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use futures_util::stream::{SplitSink, SplitStream};
use futures_util::{SinkExt, StreamExt};
use parking_lot::Mutex as ParkingMutex;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::Mutex;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::WebSocketStream;

use crate::multiplex;
use crate::{PendingMap, SubscriptionMap, TransportError};

/// Sends one already-serialized JSON-RPC frame as a `Message::Text` -- the
/// [`multiplex::FrameSink`] implementation backing [`WebSocketTransport`].
struct WebSocketFrameSink<S> {
    sink: Arc<Mutex<SplitSink<WebSocketStream<S>, Message>>>,
}

#[async_trait]
impl<S> multiplex::FrameSink for WebSocketFrameSink<S>
where
    S: AsyncRead + AsyncWrite + Send + Unpin + 'static,
{
    async fn send_frame(&self, frame: String) -> Result<(), TransportError> {
        let mut sink = self.sink.lock().await;
        sink.send(Message::text(frame))
            .await
            .map_err(|error| TransportError::Protocol(error.to_string()))
    }
}

/// WebSocket transport that demultiplexes unary request/response traffic and generic `watch`
/// subscription notifications sharing one connection. Holds one
/// [`multiplex::MultiplexedTransport`], which owns the demux state (write sink, pending-request
/// map, pump task, watch-id counter) and implements every [`JsonRpcTransport`]/
/// [`SubscriptionTransport`] method against it.
pub struct WebSocketTransport<S> {
    inner: multiplex::MultiplexedTransport<WebSocketFrameSink<S>>,
}

impl<S> WebSocketTransport<S>
where
    S: AsyncRead + AsyncWrite + Send + Unpin + 'static,
{
    #[must_use]
    pub fn new(ws: WebSocketStream<S>) -> Self {
        let (sink, stream) = ws.split();
        let pending: PendingMap = Arc::new(ParkingMutex::new(HashMap::new()));
        let subscriptions: SubscriptionMap = Arc::new(ParkingMutex::new(HashMap::new()));
        let sink = WebSocketFrameSink {
            sink: Arc::new(Mutex::new(sink)),
        };
        let pump = tokio::spawn(run_pump(
            stream,
            Arc::clone(&pending),
            subscriptions,
            WebSocketFrameSink {
                sink: Arc::clone(&sink.sink),
            },
        ));
        Self {
            inner: multiplex::MultiplexedTransport::new(sink, pending, pump),
        }
    }
}

multiplex::impl_multiplexed_transport!(
    WebSocketTransport<S> where
    S: AsyncRead + AsyncWrite + Send + Unpin + 'static
);

/// Drives the read half: decodes `Message::Text` frames (one JSON-RPC object per frame -- no
/// reassembly needed, unlike NDJSON's newline-delimited lines) and routes each one via
/// [`multiplex::route_and_maybe_cancel`] -- shared verbatim with [`crate::NdjsonTransport`]'s pump,
/// which routes the exact same decoded JSON bodies sourced from NDJSON lines instead of
/// `Message::Text` frames. Non-text frames (`Binary`/`Ping`/`Pong`/`Frame`) are ignored; a `Close`
/// frame or a read error ends the pump, exactly like NDJSON's stream-end handling. On stream end
/// every pending request fails and every open subscription ends (dropping its sender).
async fn run_pump<S>(
    mut stream: SplitStream<WebSocketStream<S>>,
    pending: PendingMap,
    subscriptions: SubscriptionMap,
    sink: WebSocketFrameSink<S>,
) where
    S: AsyncRead + AsyncWrite + Send + Unpin + 'static,
{
    while let Some(Ok(message)) = stream.next().await {
        let text = match message {
            Message::Text(text) => text,
            Message::Close(_) => break,
            Message::Binary(_) | Message::Ping(_) | Message::Pong(_) | Message::Frame(_) => {
                continue;
            }
        };
        multiplex::route_and_maybe_cancel(
            text.as_str().to_owned(),
            &pending,
            &subscriptions,
            &sink,
        )
        .await;
    }
    multiplex::finish_pump(&pending, &subscriptions);
}
