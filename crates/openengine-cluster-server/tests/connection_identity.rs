use std::collections::BTreeMap;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;

use async_trait::async_trait;
use futures_util::{SinkExt, StreamExt};
use openengine_cluster_protocol::{
    ClusterStatus, GetParams, GetResult, InitializeParams, InitializeResult, ServerCapabilities,
    INVALID_PARAMS,
};
use openengine_cluster_server::admission::CancellationSignal;
use openengine_cluster_server::identity::{
    BindingAttributes, ConnectionBinding, ConnectionIdentity, ConnectionIdentityConfig,
    ConnectionIdentityResolver, ConnectionTimeSource, IdentityResolutionError, PrincipalId,
    TenantId,
};
use openengine_cluster_server::stdio::{serve_ndjson, NdjsonIo};
use openengine_cluster_server::websocket::{serve_websocket, websocket_config};
use openengine_cluster_server::{BackendError, ClusterBackend, ConnectionContext, Dispatcher};
use parking_lot::Mutex;
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::Message;

fn identity(expires_at_ms: u64) -> ConnectionIdentity {
    let mut attributes = BTreeMap::new();
    attributes.insert("transport".to_owned(), "fixture".to_owned());
    ConnectionIdentity::new(ConnectionIdentityConfig {
        principal: PrincipalId::new("principal-17"),
        tenant: TenantId::new("tenant-blue"),
        issued_at_ms: Some(10),
        expires_at_ms,
        binding_attributes: BindingAttributes::new(attributes),
    })
}

#[derive(Clone)]
struct CountingResolver {
    identity: ConnectionIdentity,
    calls: Arc<AtomicUsize>,
}

#[async_trait]
impl ConnectionIdentityResolver for CountingResolver {
    async fn resolve(&self) -> Result<ConnectionIdentity, IdentityResolutionError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Ok(self.identity.clone())
    }
}

#[derive(Clone)]
struct FixedTime(Arc<AtomicU64>);

impl FixedTime {
    fn new(now_ms: u64) -> Self {
        Self(Arc::new(AtomicU64::new(now_ms)))
    }
}

impl ConnectionTimeSource for FixedTime {
    fn now_ms(&self) -> u64 {
        self.0.load(Ordering::SeqCst)
    }
}

#[derive(Default)]
struct RecordingBackend {
    calls: AtomicUsize,
    identities: Mutex<Vec<ConnectionIdentity>>,
    cancellations: Mutex<Vec<bool>>,
}

impl RecordingBackend {
    fn record(&self, context: &ConnectionContext) {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.identities.lock().push(context.identity().clone());
        self.cancellations
            .lock()
            .push(context.cancellation.is_cancelled());
    }
}

#[async_trait]
impl ClusterBackend for RecordingBackend {
    async fn initialize(
        &self,
        context: &ConnectionContext,
        _params: InitializeParams,
    ) -> Result<InitializeResult, BackendError> {
        self.record(context);
        Ok(InitializeResult::new(
            ServerCapabilities::default(),
            ClusterStatus::empty(),
        ))
    }

    async fn get(
        &self,
        context: &ConnectionContext,
        _params: GetParams,
    ) -> Result<GetResult, BackendError> {
        self.record(context);
        Ok(GetResult::empty())
    }
}

#[test]
fn connection_identity_has_typed_read_only_shape() {
    let identity = identity(50);
    assert_eq!(identity.principal().as_str(), "principal-17");
    assert_eq!(identity.tenant().as_str(), "tenant-blue");
    assert_eq!(identity.issued_at_ms(), Some(10));
    assert_eq!(identity.expires_at_ms(), 50);
    assert_eq!(
        identity.binding_attributes().get("transport"),
        Some("fixture")
    );
    assert!(!identity.is_expired_at(49));
    assert!(identity.is_expired_at(50));
}

#[tokio::test]
async fn websocket_resolves_once_before_frames_and_keeps_identity_stable() {
    let backend = Arc::new(RecordingBackend::default());
    let resolver_calls = Arc::new(AtomicUsize::new(0));
    let resolver = CountingResolver {
        identity: identity(100),
        calls: Arc::clone(&resolver_calls),
    };
    let cancellation = CancellationSignal::default();
    let binding = ConnectionBinding::new(
        Arc::clone(&backend),
        resolver,
        FixedTime::new(99),
        cancellation.clone(),
    );
    let (client_io, server_io) = tokio::io::duplex(1 << 16);
    let server = tokio::spawn(async move {
        let ws = tokio_tungstenite::accept_async_with_config(server_io, Some(websocket_config()))
            .await
            .unwrap();
        serve_websocket(binding, ws).await
    });
    let (mut client, _) = tokio_tungstenite::client_async("ws://localhost/identity", client_io)
        .await
        .unwrap();

    for id in [1, 2] {
        client
            .send(Message::Text(
                json!({"jsonrpc":"2.0","id":id,"method":"get","params":{}})
                    .to_string()
                    .into(),
            ))
            .await
            .unwrap();
        let response = client.next().await.unwrap().unwrap();
        assert!(response.is_text());
        if id == 1 {
            cancellation.cancel();
        }
    }
    assert_eq!(resolver_calls.load(Ordering::SeqCst), 1);
    assert_eq!(backend.calls.load(Ordering::SeqCst), 2);
    assert_eq!(
        backend.identities.lock().as_slice(),
        &[identity(100), identity(100)]
    );
    assert_eq!(backend.cancellations.lock().as_slice(), &[false, true]);

    client.close(None).await.unwrap();
    server.await.unwrap().unwrap();
}

#[tokio::test]
async fn websocket_expiry_at_boundary_closes_4401_without_backend_calls() {
    let backend = Arc::new(RecordingBackend::default());
    let resolver_calls = Arc::new(AtomicUsize::new(0));
    let binding = ConnectionBinding::new(
        Arc::clone(&backend),
        CountingResolver {
            identity: identity(50),
            calls: Arc::clone(&resolver_calls),
        },
        FixedTime::new(50),
        Default::default(),
    );
    let (client_io, server_io) = tokio::io::duplex(1 << 16);
    let server = tokio::spawn(async move {
        let ws = tokio_tungstenite::accept_async_with_config(server_io, Some(websocket_config()))
            .await
            .unwrap();
        serve_websocket(binding, ws).await
    });
    let (mut client, _) = tokio_tungstenite::client_async("ws://localhost/identity", client_io)
        .await
        .unwrap();
    client
        .send(Message::Text(
            json!({"jsonrpc":"2.0","id":1,"method":"get","params":{}})
                .to_string()
                .into(),
        ))
        .await
        .unwrap();

    let close = client.next().await.unwrap().unwrap();
    let Message::Close(Some(frame)) = close else {
        panic!("expired connection must receive a close frame");
    };
    assert_eq!(frame.code, CloseCode::Library(4401));
    assert_eq!(resolver_calls.load(Ordering::SeqCst), 1);
    assert_eq!(backend.calls.load(Ordering::SeqCst), 0);
    server.await.unwrap().unwrap();
}

#[tokio::test]
async fn ndjson_expiry_emits_one_terminal_diagnostic_and_closes() {
    let backend = Arc::new(RecordingBackend::default());
    let binding = ConnectionBinding::new(
        Arc::clone(&backend),
        CountingResolver {
            identity: identity(50),
            calls: Arc::new(AtomicUsize::new(0)),
        },
        FixedTime::new(50),
        Default::default(),
    );
    let (mut client_input, server_input) = tokio::io::duplex(1 << 16);
    let (server_output, mut client_output) = tokio::io::duplex(1 << 16);
    let (server_diagnostics, mut client_diagnostics) = tokio::io::duplex(1 << 16);
    let server = tokio::spawn(serve_ndjson(
        binding,
        NdjsonIo::new(server_input, server_output, server_diagnostics),
    ));
    client_input
        .write_all(b"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"get\",\"params\":{}}\n")
        .await
        .unwrap();
    server.await.unwrap().unwrap();

    let mut diagnostics = String::new();
    client_diagnostics
        .read_to_string(&mut diagnostics)
        .await
        .unwrap();
    assert_eq!(
        diagnostics,
        "cluster protocol connection identity expired\n"
    );
    let mut output = String::new();
    client_output.read_to_string(&mut output).await.unwrap();
    assert!(output.is_empty());
    assert_eq!(backend.calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn identity_shaped_params_are_invalid_and_cannot_change_context() {
    let expected_identity = identity(u64::MAX);
    let backend = Arc::new(RecordingBackend::default());
    let dispatcher = Dispatcher::from_shared(
        Arc::clone(&backend),
        ConnectionContext::new(expected_identity, Default::default()),
    );

    for (index, params) in [
        json!({"principal":"attacker"}),
        json!({"tenant":"other-tenant"}),
        json!({"expiresAt":u64::MAX}),
    ]
    .into_iter()
    .enumerate()
    {
        let response: Value = serde_json::from_str(
            &dispatcher
                .dispatch(
                    &json!({
                        "jsonrpc":"2.0",
                        "id":index as u64,
                        "method":"get",
                        "params":params
                    })
                    .to_string(),
                )
                .await,
        )
        .unwrap();
        assert_eq!(response["error"]["code"], INVALID_PARAMS);
    }
    assert_eq!(backend.calls.load(Ordering::SeqCst), 0);
}
