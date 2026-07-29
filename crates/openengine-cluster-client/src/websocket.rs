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
use rustls::pki_types::CertificateDer;
use rustls::{ClientConfig, RootCertStore};
use thiserror::Error;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::TcpStream;
use tokio::sync::Mutex;
use tokio_tungstenite::tungstenite::http::{StatusCode, Uri};
use tokio_tungstenite::tungstenite::Error as TungsteniteError;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{Connector, MaybeTlsStream, WebSocketStream};
use tokio_tungstenite::connect_async_tls_with_config;

use crate::multiplex;
use crate::{PendingMap, SubscriptionMap, TransportError};

/// Options applied to one outbound WebSocket connection.
///
/// System trust roots are always loaded for `wss://`. Additional roots augment that store; they
/// never replace system roots. Plaintext is denied unless [`Self::allow_plaintext`] is called with
/// `true` for this connection.
#[derive(Debug, Default)]
pub struct WebSocketDialOptions {
    allow_plaintext: bool,
    additional_root_certificates: Vec<CertificateDer<'static>>,
}

impl WebSocketDialOptions {
    /// Explicitly opts this connection into or out of plaintext `ws://`.
    #[must_use]
    pub fn allow_plaintext(mut self, allow: bool) -> Self {
        self.allow_plaintext = allow;
        self
    }

    /// Adds a DER-encoded trust anchor for a private or local certificate authority.
    #[must_use]
    pub fn with_additional_root_certificate(
        mut self,
        certificate: CertificateDer<'static>,
    ) -> Self {
        self.additional_root_certificates.push(certificate);
        self
    }
}

/// A WebSocket transport returned by [`dial_websocket`].
pub type DialedWebSocketTransport = WebSocketTransport<MaybeTlsStream<TcpStream>>;

/// A syntactic or policy failure found before any network I/O.
#[derive(Debug, Error)]
pub enum WebSocketEndpointError {
    #[error("WebSocket endpoint is not a valid URI: {0}")]
    InvalidUri(#[from] tokio_tungstenite::tungstenite::http::uri::InvalidUri),
    #[error("WebSocket endpoint scheme must be exactly `ws` or `wss`, not `{0}`")]
    UnsupportedScheme(String),
    #[error("WebSocket endpoint must include a host")]
    MissingHost,
    #[error("WebSocket endpoint must not contain userinfo")]
    UserInfo,
    #[error("WebSocket endpoint must not contain a query")]
    Query,
    #[error("WebSocket endpoint must not contain a fragment")]
    Fragment,
}

/// Failure to establish an outbound WebSocket connection.
#[derive(Debug, Error)]
pub enum WebSocketDialError {
    #[error(transparent)]
    Endpoint(#[from] WebSocketEndpointError),
    #[error(
        "plaintext `ws://` is disabled; set `WebSocketDialOptions::allow_plaintext(true)` for this connection"
    )]
    PlaintextNotAllowed,
    #[error(
        "failed to load platform/system TLS trust roots (the `bundled-roots` feature is augmentation, not a fallback): {details}"
    )]
    SystemTrustRoots { details: String },
    #[error("a certificate loaded from the platform/system TLS trust store is invalid: {0}")]
    InvalidSystemTrustCertificate(#[source] rustls::Error),
    #[error("a configured TLS trust certificate is invalid: {0}")]
    InvalidTrustCertificate(#[source] rustls::Error),
    #[error("WebSocket redirect response {status} rejected; redirects are never followed")]
    RedirectRejected { status: StatusCode },
    #[error("WebSocket connection failed: {0}")]
    Connection(#[source] Box<TungsteniteError>),
}

/// Dials exactly the validated caller-supplied endpoint.
///
/// The endpoint is rejected before network I/O unless it has a `ws` or `wss` scheme, a host, and
/// no userinfo, query, or fragment. Redirect handshake responses are returned as errors and their
/// targets are never opened.
pub async fn dial_websocket(
    endpoint: &str,
    options: WebSocketDialOptions,
) -> Result<DialedWebSocketTransport, WebSocketDialError> {
    let (endpoint, secure) = validate_endpoint(endpoint)?;
    if !secure && !options.allow_plaintext {
        return Err(WebSocketDialError::PlaintextNotAllowed);
    }

    let connector = if secure {
        Some(build_tls_connector(options.additional_root_certificates)?)
    } else {
        None
    };
    let result = connect_async_tls_with_config(endpoint, None, false, connector).await;
    match result {
        Ok((stream, _response)) => Ok(WebSocketTransport::new(stream)),
        Err(TungsteniteError::Http(response)) if response.status().is_redirection() => {
            Err(WebSocketDialError::RedirectRejected {
                status: response.status(),
            })
        }
        Err(error) => Err(WebSocketDialError::Connection(Box::new(error))),
    }
}

fn validate_endpoint(endpoint: &str) -> Result<(Uri, bool), WebSocketEndpointError> {
    if endpoint.contains('#') {
        return Err(WebSocketEndpointError::Fragment);
    }
    let endpoint: Uri = endpoint.parse()?;
    if endpoint.query().is_some() {
        return Err(WebSocketEndpointError::Query);
    }
    let authority = endpoint
        .authority()
        .ok_or(WebSocketEndpointError::MissingHost)?;
    if authority.as_str().contains('@') {
        return Err(WebSocketEndpointError::UserInfo);
    }
    if authority.host().is_empty() {
        return Err(WebSocketEndpointError::MissingHost);
    }
    match endpoint.scheme_str() {
        Some("ws") => Ok((endpoint, false)),
        Some("wss") => Ok((endpoint, true)),
        Some(scheme) => Err(WebSocketEndpointError::UnsupportedScheme(scheme.to_owned())),
        None => Err(WebSocketEndpointError::UnsupportedScheme(
            "<missing>".to_owned(),
        )),
    }
}

fn build_tls_connector(
    additional_root_certificates: Vec<CertificateDer<'static>>,
) -> Result<Connector, WebSocketDialError> {
    let native = rustls_native_certs::load_native_certs();
    build_tls_connector_from_native(
        native.certs,
        native
            .errors
            .into_iter()
            .map(|error| error.to_string())
            .collect(),
        additional_root_certificates,
    )
}

fn build_tls_connector_from_native(
    native_certificates: Vec<CertificateDer<'static>>,
    native_errors: Vec<String>,
    additional_root_certificates: Vec<CertificateDer<'static>>,
) -> Result<Connector, WebSocketDialError> {
    if !native_errors.is_empty() {
        return Err(WebSocketDialError::SystemTrustRoots {
            details: native_errors.join("; "),
        });
    }
    if native_certificates.is_empty() {
        return Err(WebSocketDialError::SystemTrustRoots {
            details: "the platform/system trust store contained no certificates".to_owned(),
        });
    }

    let mut roots = RootCertStore::empty();
    for certificate in native_certificates {
        roots
            .add(certificate)
            .map_err(WebSocketDialError::InvalidSystemTrustCertificate)?;
    }
    #[cfg(feature = "bundled-roots")]
    roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    for certificate in additional_root_certificates {
        roots
            .add(certificate)
            .map_err(WebSocketDialError::InvalidTrustCertificate)?;
    }

    let config = ClientConfig::builder()
        .with_root_certificates(roots)
        .with_no_client_auth();
    Ok(Connector::Rustls(Arc::new(config)))
}

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

#[cfg(test)]
mod tls_trust_policy_tests {
    use rcgen::{generate_simple_self_signed, CertifiedKey};

    use super::*;

    fn generated_root() -> CertificateDer<'static> {
        let CertifiedKey { cert, .. } =
            generate_simple_self_signed(vec!["localhost".to_owned()]).unwrap();
        cert.der().clone()
    }

    fn expect_system_trust_error(
        native_certificates: Vec<CertificateDer<'static>>,
        native_errors: Vec<String>,
        additional_root_certificates: Vec<CertificateDer<'static>>,
    ) -> WebSocketDialError {
        match build_tls_connector_from_native(
            native_certificates,
            native_errors,
            additional_root_certificates,
        ) {
            Ok(_) => panic!("invalid native trust state must fail closed"),
            Err(error) => error,
        }
    }

    #[test]
    fn empty_system_roots_fail_before_additional_roots_can_rescue() {
        let error = expect_system_trust_error(Vec::new(), Vec::new(), vec![generated_root()]);

        assert!(matches!(error, WebSocketDialError::SystemTrustRoots { .. }));
    }

    #[test]
    fn partial_system_root_load_errors_fail_before_additional_roots_can_rescue() {
        let error = expect_system_trust_error(
            vec![generated_root()],
            vec!["native loader rejected one certificate".to_owned()],
            vec![generated_root()],
        );

        assert!(matches!(
            &error,
            WebSocketDialError::SystemTrustRoots { .. }
        ));
        assert!(
            error
                .to_string()
                .contains("native loader rejected one certificate")
        );
    }

    #[cfg(feature = "bundled-roots")]
    #[test]
    fn bundled_roots_do_not_fallback_when_system_roots_are_empty() {
        let error = expect_system_trust_error(Vec::new(), Vec::new(), Vec::new());

        assert!(matches!(error, WebSocketDialError::SystemTrustRoots { .. }));
    }
}
