use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use openengine_cluster_client::{
    JsonRpcTransport, PumpedSubscription, SubscriptionTransport, TransportError,
};
use openengine_cluster_protocol::{RequestId, SubscriptionId};
use serde_json::json;
use tokio::net::TcpListener;
use tokio::sync::oneshot;
use tokio_tungstenite::accept_hdr_async;
use tokio_tungstenite::tungstenite::http::header::AUTHORIZATION;

use super::*;

type ServerRequest = tokio_tungstenite::tungstenite::handshake::server::Request;
type ServerResponse = tokio_tungstenite::tungstenite::handshake::server::Response;

struct TempRoot(PathBuf);

impl TempRoot {
    fn new() -> Self {
        let mut random = [0_u8; 8];
        getrandom::fill(&mut random).unwrap();
        let path = std::env::temp_dir().join(format!(
            "zeroshot-native-v2-target-{}-{}",
            std::process::id(),
            encode_hex(&random)
        ));
        std::fs::create_dir(&path).unwrap();
        Self(path)
    }

    fn path(&self, name: &str) -> PathBuf {
        self.0.join(name)
    }
}

impl Drop for TempRoot {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[derive(Clone, Default)]
struct MemoryRegistry {
    targets: Arc<Mutex<BTreeMap<String, TargetRecord>>>,
}

impl TargetRegistry for MemoryRegistry {
    fn insert(&self, target: TargetRecord) -> Result<(), TargetConnectorError> {
        let mut targets = self.targets.lock().unwrap();
        if targets.contains_key(&target.name) {
            return Err(TargetConnectorError::AlreadyExists(target.name));
        }
        targets.insert(target.name.clone(), target);
        Ok(())
    }

    fn get(&self, name: &str) -> Result<TargetRecord, TargetConnectorError> {
        self.targets
            .lock()
            .unwrap()
            .get(name)
            .cloned()
            .ok_or_else(|| TargetConnectorError::NotFound(name.to_owned()))
    }
}

#[derive(Clone, Debug, PartialEq)]
enum AuthorityCall {
    Discover(TargetRecord),
    Login(TargetRecord),
    Install(TargetRecord, TargetSetupDocument),
    Session(TargetRecord),
}

#[derive(Clone)]
struct FakeAuthority {
    calls: Arc<Mutex<Vec<AuthorityCall>>>,
    endpoint: String,
}

impl FakeAuthority {
    fn new(endpoint: impl Into<String>) -> Self {
        Self {
            calls: Arc::new(Mutex::new(Vec::new())),
            endpoint: endpoint.into(),
        }
    }

    fn calls(&self) -> Vec<AuthorityCall> {
        self.calls.lock().unwrap().clone()
    }
}

#[async_trait]
impl TargetControlAuthority for FakeAuthority {
    async fn discover(&self, target: &TargetRecord) -> Result<(), TargetAuthorityError> {
        self.calls
            .lock()
            .unwrap()
            .push(AuthorityCall::Discover(target.clone()));
        Ok(())
    }

    async fn login(&self, target: &TargetRecord) -> Result<(), TargetAuthorityError> {
        self.calls
            .lock()
            .unwrap()
            .push(AuthorityCall::Login(target.clone()));
        Ok(())
    }

    async fn install(
        &self,
        target: &TargetRecord,
        setup: &TargetSetupDocument,
    ) -> Result<(), TargetAuthorityError> {
        self.calls
            .lock()
            .unwrap()
            .push(AuthorityCall::Install(target.clone(), setup.clone()));
        Ok(())
    }

    async fn oecp_session(
        &self,
        target: &TargetRecord,
    ) -> Result<AuthenticatedTargetOecp, TargetAuthorityError> {
        self.calls
            .lock()
            .unwrap()
            .push(AuthorityCall::Session(target.clone()));
        AuthenticatedTargetOecp::new(self.endpoint.clone(), "access-token")
            .map_err(|error| TargetAuthorityError::new(error.to_string()))
    }
}

struct StubTransport;

#[async_trait]
impl JsonRpcTransport for StubTransport {
    async fn request(&self, _request: String) -> Result<String, TransportError> {
        Err(TransportError::Protocol("unused test transport".to_owned()))
    }
}

#[async_trait]
impl SubscriptionTransport for StubTransport {
    async fn open_subscription(
        &self,
        _request: String,
        _id: RequestId,
    ) -> Result<(String, Option<PumpedSubscription>), TransportError> {
        Err(TransportError::Protocol("unused test transport".to_owned()))
    }

    async fn cancel_subscription(&self, _id: SubscriptionId) -> Result<(), TransportError> {
        Ok(())
    }

    async fn cancel_request(&self, _id: RequestId) -> Result<(), TransportError> {
        Ok(())
    }

    fn next_watch_request_id(&self) -> RequestId {
        RequestId::String("test-watch".to_owned())
    }
}

#[derive(Clone, Default)]
struct FakeDialer {
    sessions: Arc<Mutex<Vec<(TargetRecord, String)>>>,
}

#[async_trait]
impl TargetOecpDialer for FakeDialer {
    type Transport = StubTransport;

    async fn dial(
        &self,
        target: &TargetRecord,
        session: AuthenticatedTargetOecp,
    ) -> Result<Arc<Self::Transport>, TargetConnectorError> {
        self.sessions
            .lock()
            .unwrap()
            .push((target.clone(), session.endpoint().to_owned()));
        Ok(Arc::new(StubTransport))
    }
}

fn target() -> TargetRecord {
    TargetRecord {
        name: "prod".to_owned(),
        origin: "https://target.example".to_owned(),
    }
}

fn runtime_json() -> serde_json::Value {
    json!({
        "harness":"codex",
        "provider":"openai",
        "nodes":{
            "worker":{
                "kind":"agent",
                "model":"gpt-5.6",
                "env":["OPENAI_API_KEY"]
            }
        }
    })
}

fn setup_request(path: PathBuf) -> TargetSetup {
    TargetSetup {
        name: "prod".to_owned(),
        repository: "open-engine/zeroshot".to_owned(),
        runtime_config: path,
        base: Some("main".to_owned()),
        target_branch: None,
    }
}

#[test]
fn target_origins_match_the_existing_hosted_cli_contract() {
    assert_eq!(
        normalize_origin("https://target.example").unwrap(),
        "https://target.example"
    );
    assert_eq!(
        normalize_origin("http://127.0.0.1:8080").unwrap(),
        "http://127.0.0.1:8080"
    );
    for invalid in [
        "http://target.example",
        "https://user@target.example",
        "https://target.example/path",
        "https://target.example?query=1",
        "https://target.example/#fragment",
    ] {
        assert!(normalize_origin(invalid).is_err(), "accepted {invalid}");
    }
}

#[test]
fn setup_base_contract_matches_current_hosted_semantics() {
    assert_eq!(normalize_base(None, None).unwrap(), TargetBase::Default);
    assert_eq!(
        normalize_base(Some("main"), None).unwrap(),
        TargetBase::Branch {
            branch: "main".to_owned()
        }
    );
    let revision = "a".repeat(40);
    assert_eq!(
        normalize_base(Some(&revision), Some("main")).unwrap(),
        TargetBase::Revision {
            revision: revision.clone(),
            target_branch: "main".to_owned()
        }
    );
    assert!(normalize_base(Some(&revision), None).is_err());
    assert!(normalize_base(None, Some("main")).is_err());
    assert!(normalize_base(Some("main"), Some("release")).is_err());
}

#[test]
fn file_registry_round_trips_named_targets_without_credentials() {
    let root = TempRoot::new();
    let path = root.path("config/targets.json");
    let registry = FileTargetRegistry::new(path.clone());
    registry.insert(target()).unwrap();
    assert_eq!(registry.get("prod").unwrap(), target());
    assert!(matches!(
        registry.insert(target()),
        Err(TargetConnectorError::AlreadyExists(_))
    ));
    let stored = std::fs::read_to_string(path).unwrap();
    assert!(!stored.contains("token"));
    assert!(!stored.contains("runtime"));
}

#[cfg(unix)]
#[test]
fn file_registry_is_private_on_creation() {
    use std::os::unix::fs::PermissionsExt;

    let root = TempRoot::new();
    let path = root.path("config/targets.json");
    FileTargetRegistry::new(path.clone())
        .insert(target())
        .unwrap();
    assert_eq!(
        std::fs::metadata(path).unwrap().permissions().mode() & 0o777,
        0o600
    );
}

#[tokio::test]
async fn connector_preserves_add_login_setup_and_target_scoped_connect() {
    let root = TempRoot::new();
    let runtime_path = root.path("runtime.json");
    std::fs::write(&runtime_path, serde_json::to_vec(&runtime_json()).unwrap()).unwrap();
    let registry = MemoryRegistry::default();
    let authority = FakeAuthority::new("wss://target.example/oecp");
    let dialer = FakeDialer::default();
    let connector = NativeV2TargetConnector::new(registry, authority.clone(), dialer.clone());

    connector
        .add(TargetAdd {
            name: "prod".to_owned(),
            url: "https://target.example".to_owned(),
        })
        .await
        .unwrap();
    connector.login("prod").await.unwrap();
    connector.setup(setup_request(runtime_path)).await.unwrap();
    connector.connect("prod").await.unwrap();

    let calls = authority.calls();
    assert!(matches!(&calls[0], AuthorityCall::Discover(record) if record == &target()));
    assert!(matches!(&calls[1], AuthorityCall::Login(record) if record == &target()));
    let AuthorityCall::Install(record, installed) = &calls[2] else {
        panic!("expected atomic setup install");
    };
    assert_eq!(record, &target());
    assert_eq!(installed.repository, "open-engine/zeroshot");
    assert_eq!(
        serde_json::to_value(&installed.runtime).unwrap(),
        runtime_json()
    );
    assert!(matches!(&calls[3], AuthorityCall::Session(record) if record == &target()));
    assert_eq!(
        dialer.sessions.lock().unwrap().as_slice(),
        &[(target(), "wss://target.example/oecp".to_owned())]
    );
}

#[tokio::test]
async fn invalid_runtime_plan_fails_before_target_lookup_or_authority() {
    let root = TempRoot::new();
    let runtime_path = root.path("invalid.json");
    std::fs::write(&runtime_path, b"{\"harness\":\"codex\"}").unwrap();
    let authority = FakeAuthority::new("wss://target.example/oecp");
    let connector = NativeV2TargetConnector::new(
        MemoryRegistry::default(),
        authority.clone(),
        FakeDialer::default(),
    );

    let error = connector
        .setup(setup_request(runtime_path))
        .await
        .unwrap_err();
    assert!(error.to_string().contains("runtime plan file"));
    assert!(authority.calls().is_empty());
}

#[tokio::test]
#[allow(clippy::result_large_err)]
async fn websocket_dialer_sends_bearer_only_to_same_target_authority() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (sent, received) = oneshot::channel();
    let server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let websocket = accept_hdr_async(
            stream,
            move |request: &ServerRequest, response: ServerResponse| {
                let authorization = request
                    .headers()
                    .get(AUTHORIZATION)
                    .and_then(|value| value.to_str().ok())
                    .map(str::to_owned);
                let _ = sent.send(authorization);
                Ok(response)
            },
        )
        .await
        .unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        drop(websocket);
    });
    let target = TargetRecord {
        name: "local".to_owned(),
        origin: format!("http://{address}"),
    };
    let session = AuthenticatedTargetOecp::new(format!("ws://{address}/oecp"), "secret").unwrap();
    let transport = AuthenticatedOecpWebSocketDialer
        .dial(&target, session)
        .await
        .unwrap();
    assert_eq!(received.await.unwrap().as_deref(), Some("Bearer secret"));
    drop(transport);
    server.await.unwrap();
}

#[tokio::test]
async fn websocket_dialer_rejects_cross_authority_before_network() {
    let target = TargetRecord {
        name: "prod".to_owned(),
        origin: "https://target.example".to_owned(),
    };
    let session = AuthenticatedTargetOecp::new("wss://other.example/oecp", "secret").unwrap();
    let error = match AuthenticatedOecpWebSocketDialer
        .dial(&target, session)
        .await
    {
        Ok(_) => panic!("cross-authority session unexpectedly dialed"),
        Err(error) => error,
    };
    assert!(matches!(error, TargetConnectorError::InvalidOecpEndpoint));
}

#[test]
fn undefined_authority_names_the_exact_external_contract_gap() {
    assert!(UNDEFINED_TARGET_AUTHORITY.contains("capsule-scoped"));
    assert!(UNDEFINED_TARGET_AUTHORITY.contains("target-scoped run/* OECP"));
    assert!(UNDEFINED_TARGET_AUTHORITY_HELP.contains("cannot serve run/*"));
}
