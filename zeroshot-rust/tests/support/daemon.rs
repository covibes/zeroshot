use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use async_trait::async_trait;
use futures_util::{SinkExt, StreamExt};
use openengine_cluster_protocol::{
    ClusterStatus, GetParams, GetResult, InitializeParams, InitializeResult, JSON_RPC_VERSION,
    PROTOCOL_VERSION, ServerCapabilities,
};
use openengine_cluster_server::{BackendError, ClusterBackend, ConnectionContext};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::protocol::Message;
use zeroshot_engine::daemon_auth::DaemonCredentials;
use zeroshot_engine::daemon_discovery::DaemonLocator;
use zeroshot_engine::NativeBackendFactory;

#[path = "temp_profile.rs"]
mod temp_profile;
pub use temp_profile::TempProfile;


#[derive(Clone, Default)]
pub struct CountingFactory {
    pub created: Arc<AtomicUsize>,
    pub initialized: Arc<AtomicUsize>,
}

pub struct CountingBackend {
    initialized: Arc<AtomicUsize>,
}

impl NativeBackendFactory for CountingFactory {
    type Backend = CountingBackend;

    fn create(&self, _context: &ConnectionContext) -> Self::Backend {
        self.created.fetch_add(1, Ordering::SeqCst);
        CountingBackend {
            initialized: Arc::clone(&self.initialized),
        }
    }
}

#[async_trait]
impl ClusterBackend for CountingBackend {
    async fn initialize(
        &self,
        _context: &ConnectionContext,
        _params: InitializeParams,
    ) -> Result<InitializeResult, BackendError> {
        self.initialized.fetch_add(1, Ordering::SeqCst);
        Ok(InitializeResult::new(
            ServerCapabilities::default(),
            ClusterStatus::empty(),
        ))
    }

    async fn get(
        &self,
        _context: &ConnectionContext,
        _params: GetParams,
    ) -> Result<GetResult, BackendError> {
        Ok(GetResult {
            spec: None,
            status: ClusterStatus::empty(),
            at_cursor: None,
        })
    }
}

pub async fn authenticated_initialize(locator: &DaemonLocator) -> serde_json::Value {
    let credentials = DaemonCredentials::from_locator(locator);
    let mut request = locator
        .endpoint
        .as_str()
        .into_client_request()
        .expect("valid daemon endpoint");
    credentials
        .apply_to_request(&mut request)
        .expect("valid daemon credentials");
    let address = request
        .uri()
        .authority()
        .expect("endpoint authority")
        .as_str();
    let stream = TcpStream::connect(address)
        .await
        .expect("daemon loopback connection");
    let (mut websocket, _) = tokio_tungstenite::client_async(request, stream)
        .await
        .expect("authorized WebSocket handshake");
    websocket
        .send(Message::Text(
            serde_json::json!({
                "jsonrpc": JSON_RPC_VERSION,
                "id": 1,
                "method": "initialize",
                "params": { "protocolVersion": PROTOCOL_VERSION }
            })
            .to_string()
            .into(),
        ))
        .await
        .expect("send initialize");
    loop {
        let message = websocket
            .next()
            .await
            .expect("initialize response")
            .expect("valid initialize response frame");
        if let Message::Text(text) = message {
            return serde_json::from_str(text.as_ref()).expect("initialize JSON");
        }
    }
}

pub fn locator_credentials(locator: &DaemonLocator) -> DaemonCredentials {
    DaemonCredentials::from_locator(locator)
}
