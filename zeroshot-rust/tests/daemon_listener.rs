use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use async_trait::async_trait;
use futures_util::{SinkExt, StreamExt};
#[path = "support/daemon.rs"]
mod daemon_support;

use daemon_support::{
    CountingBackend, CountingFactory, TempProfile, authenticated_initialize, locator_credentials,
};
use openengine_cluster_protocol::{
    ClusterStatus, GetParams, GetResult, InitializeParams, InitializeResult, ServerCapabilities,
};
use openengine_cluster_server::{BackendError, ClusterBackend, ConnectionContext};
use tokio::io::AsyncWriteExt;
use tokio::net::{TcpListener, TcpStream};
use tokio::time::timeout;
use tokio_tungstenite::accept_hdr_async;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::protocol::Message;
use zeroshot_engine::daemon_auth::{
    AuthorizationCallback, ConnectionPurpose, DAEMON_ROUTE, DaemonCredentials,
};
use zeroshot_engine::daemon_discovery::{
    CLUSTER_PROTOCOL, DAEMON_PROTOCOL, DaemonLocator, acquire_start_guard, read_locator,
    replace_locator,
};
use zeroshot_engine::daemon_listener::{
    DaemonListener, DaemonListenerError, ListenerConfig, LivenessOutcome, probe_liveness,
};
use zeroshot_engine::NativeBackendFactory;

fn test_config() -> ListenerConfig {
    ListenerConfig {
        startup_lock_timeout: Duration::from_millis(500),
        liveness_timeout: Duration::from_millis(150),
        handshake_timeout: Duration::from_millis(200),
        drain_timeout: Duration::from_millis(80),
        shutdown_timeout: Duration::from_millis(300),
        max_active_connections: 8,
        max_pending_handshakes: 8,
        max_liveness_connections: 2,
    }
}

#[derive(Clone, Copy)]
struct PanicFactory;

impl NativeBackendFactory for PanicFactory {
    type Backend = CountingBackend;

    fn create(&self) -> Self::Backend {
        panic!("controlled connection factory panic")
    }
}

#[derive(Clone, Default)]
struct PendingInitializeFactory {
    created: Arc<AtomicUsize>,
    initialize_started: Arc<AtomicUsize>,
    dropped: Arc<AtomicUsize>,
}

struct PendingInitializeBackend {
    initialize_started: Arc<AtomicUsize>,
    dropped: Arc<AtomicUsize>,
}

impl NativeBackendFactory for PendingInitializeFactory {
    type Backend = PendingInitializeBackend;

    fn create(&self) -> Self::Backend {
        self.created.fetch_add(1, Ordering::SeqCst);
        PendingInitializeBackend {
            initialize_started: Arc::clone(&self.initialize_started),
            dropped: Arc::clone(&self.dropped),
        }
    }
}

impl Drop for PendingInitializeBackend {
    fn drop(&mut self) {
        self.dropped.fetch_add(1, Ordering::SeqCst);
    }
}

#[async_trait]
impl ClusterBackend for PendingInitializeBackend {
    async fn initialize(
        &self,
        _context: &ConnectionContext,
        _params: InitializeParams,
    ) -> Result<InitializeResult, BackendError> {
        self.initialize_started.fetch_add(1, Ordering::SeqCst);
        std::future::pending().await
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

#[derive(Clone, Copy)]
struct ErrorInitializeFactory;

struct ErrorInitializeBackend;

impl NativeBackendFactory for ErrorInitializeFactory {
    type Backend = ErrorInitializeBackend;

    fn create(&self) -> Self::Backend {
        ErrorInitializeBackend
    }
}

#[async_trait]
impl ClusterBackend for ErrorInitializeBackend {
    async fn initialize(
        &self,
        _context: &ConnectionContext,
        _params: InitializeParams,
    ) -> Result<InitializeResult, BackendError> {
        Err(BackendError::application(
            "TEST_UNAVAILABLE",
            "controlled initialize failure",
            None,
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

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn zero_capacity_or_deadline_is_rejected_before_profile_or_listener_creation() {
    let mut cases = Vec::new();

    let mut config = test_config();
    config.max_active_connections = 0;
    cases.push(("active-capacity", config));
    let mut config = test_config();
    config.max_pending_handshakes = 0;
    cases.push(("handshake-capacity", config));
    let mut config = test_config();
    config.max_liveness_connections = 0;
    cases.push(("liveness-capacity", config));
    let mut config = test_config();
    config.startup_lock_timeout = Duration::ZERO;
    cases.push(("startup-lock-deadline", config));
    let mut config = test_config();
    config.liveness_timeout = Duration::ZERO;
    cases.push(("liveness-deadline", config));
    let mut config = test_config();
    config.handshake_timeout = Duration::ZERO;
    cases.push(("handshake-deadline", config));
    let mut config = test_config();
    config.drain_timeout = Duration::ZERO;
    cases.push(("drain-deadline", config));
    let mut config = test_config();
    config.shutdown_timeout = Duration::ZERO;
    cases.push(("shutdown-deadline", config));

    for (name, invalid) in cases {
        let profile = TempProfile::new(name);
        assert!(matches!(
            DaemonListener::start_with_config(
                profile.profile.clone(),
                CountingFactory::default(),
                invalid,
            )
            .await,
            Err(DaemonListenerError::InvalidConfiguration)
        ));
        assert!(
            !profile.profile.root().exists(),
            "{name} created profile resources before validation"
        );
        assert_eq!(
            read_locator(&profile.profile).expect("invalid config locator state"),
            None
        );

        let valid = ListenerConfig {
            max_active_connections: 1,
            max_pending_handshakes: 1,
            max_liveness_connections: 1,
            ..test_config()
        };
        let listener = DaemonListener::start_with_config(
            profile.profile.clone(),
            CountingFactory::default(),
            valid,
        )
        .await
        .expect("limit-plus-valid config starts");
        listener.shutdown().await.expect("valid listener shutdown");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn one_nanosecond_deadlines_pass_validation_and_leave_no_locator_or_socket() {
    let mut cases = Vec::new();
    let mut config = test_config();
    config.startup_lock_timeout = Duration::from_nanos(1);
    cases.push(("startup-lock-positive-boundary", config));
    let mut config = test_config();
    config.liveness_timeout = Duration::from_nanos(1);
    cases.push(("liveness-positive-boundary", config));
    let mut config = test_config();
    config.handshake_timeout = Duration::from_nanos(1);
    cases.push(("handshake-positive-boundary", config));
    let mut config = test_config();
    config.drain_timeout = Duration::from_nanos(1);
    cases.push(("drain-positive-boundary", config));
    let mut config = test_config();
    config.shutdown_timeout = Duration::from_nanos(1);
    cases.push(("shutdown-positive-boundary", config));

    for (name, boundary) in cases {
        let profile = TempProfile::new(name);
        let listener = DaemonListener::start_with_config(
            profile.profile.clone(),
            CountingFactory::default(),
            boundary,
        )
        .await
        .expect("positive deadline boundary passes validation");
        let address: SocketAddr = listener
            .locator()
            .endpoint
            .strip_prefix("ws://")
            .and_then(|endpoint| endpoint.strip_suffix(DAEMON_ROUTE))
            .expect("boundary endpoint")
            .parse()
            .expect("boundary address");
        assert!(matches!(
            listener.shutdown().await,
            Ok(()) | Err(DaemonListenerError::ShutdownTimeout)
        ));

        timeout(Duration::from_secs(1), async {
            loop {
                let locator_removed = read_locator(&profile.profile)
                    .expect("boundary cleanup state")
                    .is_none();
                let socket_released = match TcpListener::bind(address).await {
                    Ok(rebound) => {
                        drop(rebound);
                        true
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::AddrInUse => false,
                    Err(error) => panic!("unexpected boundary rebind failure: {error}"),
                };
                if locator_removed && socket_released {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("boundary shutdown released locator and socket");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_profile_start_has_one_owner_and_loser_cannot_remove_it() {
    let profile = TempProfile::new("concurrent-start");
    let factory = CountingFactory::default();
    let first =
        DaemonListener::start_with_config(profile.profile.clone(), factory.clone(), test_config());
    let second =
        DaemonListener::start_with_config(profile.profile.clone(), factory.clone(), test_config());
    let (first, second) = tokio::join!(first, second);

    let (owner, loser) = match (first, second) {
        (Ok(owner), Err(loser)) | (Err(loser), Ok(owner)) => (owner, loser),
        _ => panic!("expected exactly one owner and one loser"),
    };
    assert!(matches!(loser, DaemonListenerError::AlreadyRunning));
    assert_eq!(
        read_locator(&profile.profile).expect("read owner locator"),
        Some(owner.locator().clone())
    );
    assert!(factory.initialized.load(Ordering::SeqCst) >= 1);

    let response = authenticated_initialize(owner.locator()).await;
    assert_eq!(
        response["result"]["protocolVersion"],
        "openengine.cluster/v1"
    );
    owner.shutdown().await.expect("owner shutdown");
    assert_eq!(
        read_locator(&profile.profile).expect("locator removed"),
        None
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn live_initialize_error_preserves_incumbent_locator_and_prevents_second_owner() {
    let profile = TempProfile::new("live-initialize-error");
    let owner = DaemonListener::start_with_config(
        profile.profile.clone(),
        ErrorInitializeFactory,
        test_config(),
    )
    .await
    .expect("start erroring incumbent");
    let incumbent = owner.locator().clone();
    let contender_factory = CountingFactory::default();

    let contender = DaemonListener::start_with_config(
        profile.profile.clone(),
        contender_factory.clone(),
        test_config(),
    )
    .await;
    assert!(matches!(
        contender,
        Err(DaemonListenerError::LivenessIndeterminate)
    ));
    assert_eq!(
        read_locator(&profile.profile).expect("preserved erroring incumbent locator"),
        Some(incumbent.clone())
    );
    assert_eq!(contender_factory.created.load(Ordering::SeqCst), 0);
    assert_eq!(
        probe_liveness(&incumbent, Duration::from_millis(250)).await,
        LivenessOutcome::Indeterminate
    );

    owner.shutdown().await.expect("shutdown incumbent");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn raw_handshake_burst_owns_only_the_configured_pre_auth_bound() {
    let profile = TempProfile::new("pre-auth-bound");
    let config = ListenerConfig {
        handshake_timeout: Duration::from_secs(2),
        max_pending_handshakes: 2,
        ..test_config()
    };
    let listener = DaemonListener::start_with_config(
        profile.profile.clone(),
        CountingFactory::default(),
        config,
    )
    .await
    .expect("start listener");
    let address: SocketAddr = listener
        .locator()
        .endpoint
        .strip_prefix("ws://")
        .and_then(|endpoint| endpoint.strip_suffix(DAEMON_ROUTE))
        .expect("listener endpoint")
        .parse()
        .expect("listener address");

    let mut sockets = Vec::new();
    for _ in 0..2 {
        let mut socket = TcpStream::connect(address).await.expect("raw connection");
        socket.write_all(b"G").await.expect("partial handshake");
        sockets.push(socket);
    }
    timeout(Duration::from_millis(200), async {
        while listener.pending_handshakes() != config.max_pending_handshakes {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("listener admitted bounded raw handshakes");
    let incumbent = listener.locator().clone();
    let contender = DaemonListener::start_with_config(
        profile.profile.clone(),
        CountingFactory::default(),
        config,
    )
    .await;
    assert!(matches!(
        contender,
        Err(DaemonListenerError::LivenessIndeterminate)
    ));
    assert_eq!(
        read_locator(&profile.profile).expect("preserved incumbent locator"),
        Some(incumbent)
    );

    for _ in 0..16 {
        if let Ok(mut socket) = TcpStream::connect(address).await {
            let _ = socket.write_all(b"G").await;
            sockets.push(socket);
        }
        assert!(
            listener.pending_handshakes() <= config.max_pending_handshakes,
            "accepted pre-auth ownership exceeded its finite bound"
        );
        tokio::task::yield_now().await;
    }
    assert_eq!(listener.pending_handshakes(), config.max_pending_handshakes);

    drop(sockets);
    timeout(Duration::from_millis(500), listener.shutdown())
        .await
        .expect("bounded listener shutdown")
        .expect("listener shutdown");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn partial_raw_handshake_releases_its_permit_at_server_timeout_without_client_drop() {
    let profile = TempProfile::new("raw-handshake-timeout");
    let config = ListenerConfig {
        handshake_timeout: Duration::from_millis(30),
        max_pending_handshakes: 1,
        ..test_config()
    };
    let listener = DaemonListener::start_with_config(
        profile.profile.clone(),
        CountingFactory::default(),
        config,
    )
    .await
    .expect("start handshake-timeout listener");
    let address: SocketAddr = listener
        .locator()
        .endpoint
        .strip_prefix("ws://")
        .and_then(|endpoint| endpoint.strip_suffix(DAEMON_ROUTE))
        .expect("handshake-timeout endpoint")
        .parse()
        .expect("handshake-timeout address");
    let mut socket = TcpStream::connect(address)
        .await
        .expect("raw handshake connection");
    socket.write_all(b"G").await.expect("partial raw handshake");
    timeout(Duration::from_millis(200), async {
        while listener.pending_handshakes() != 1 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("raw handshake owns permit");

    timeout(Duration::from_millis(500), async {
        while listener.pending_handshakes() != 0 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("server handshake timeout released permit");
    socket
        .peer_addr()
        .expect("client socket remains owned after server timeout");

    drop(socket);
    listener.shutdown().await.expect("shutdown listener");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn ordinary_session_overflow_closes_before_backend_construction_or_dispatch() {
    let profile = TempProfile::new("active-session-bound");
    let config = ListenerConfig {
        max_active_connections: 1,
        ..test_config()
    };
    let factory = CountingFactory::default();
    let listener =
        DaemonListener::start_with_config(profile.profile.clone(), factory.clone(), config)
            .await
            .expect("start listener");
    let locator = listener.locator().clone();
    let credentials = locator_credentials(&locator);
    let address: SocketAddr = locator
        .endpoint
        .strip_prefix("ws://")
        .and_then(|endpoint| endpoint.strip_suffix(DAEMON_ROUTE))
        .expect("session endpoint")
        .parse()
        .expect("session address");

    let mut first_request = locator
        .endpoint
        .as_str()
        .into_client_request()
        .expect("first session request");
    let first_proof = credentials
        .apply_to_request(&mut first_request)
        .expect("first session proof");
    let first_stream = TcpStream::connect(address)
        .await
        .expect("first session connection");
    let (mut first, first_response) = tokio_tungstenite::client_async(first_request, first_stream)
        .await
        .expect("first session upgrade");
    assert!(first_proof.verify(&first_response));
    timeout(Duration::from_millis(200), async {
        while listener.active_sessions() != 1 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("first session owns active slot");
    first
        .send(Message::Text(
            serde_json::json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {"protocolVersion": "openengine.cluster/v1"}
            })
            .to_string()
            .into(),
        ))
        .await
        .expect("dispatch initialize");
    let first_result = timeout(Duration::from_millis(200), first.next())
        .await
        .expect("bounded initialize")
        .expect("initialize response")
        .expect("valid initialize response");
    assert!(matches!(first_result, Message::Text(_)));
    assert_eq!(factory.created.load(Ordering::SeqCst), 1);
    assert_eq!(factory.initialized.load(Ordering::SeqCst), 1);

    let mut overflow_request = locator
        .endpoint
        .as_str()
        .into_client_request()
        .expect("overflow session request");
    let overflow_proof = credentials
        .apply_to_request(&mut overflow_request)
        .expect("overflow session proof");
    let overflow_stream = TcpStream::connect(address)
        .await
        .expect("overflow session connection");
    let (mut overflow, overflow_response) =
        tokio_tungstenite::client_async(overflow_request, overflow_stream)
            .await
            .expect("authenticated overflow upgrade");
    assert!(overflow_proof.verify(&overflow_response));
    let ended = timeout(Duration::from_millis(200), overflow.next())
        .await
        .expect("overflow session closed");
    if let Some(Ok(message)) = ended {
        assert!(message.is_close());
    }
    assert_eq!(listener.active_sessions(), 1);
    assert_eq!(factory.created.load(Ordering::SeqCst), 1);
    assert_eq!(factory.initialized.load(Ordering::SeqCst), 1);

    drop(overflow);
    drop(first);
    listener.shutdown().await.expect("shutdown listener");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn liveness_is_unstarvable_by_full_sessions_and_stalled_raw_handshakes() {
    let profile = TempProfile::new("unstarvable-liveness");
    let config = ListenerConfig {
        liveness_timeout: Duration::from_millis(120),
        handshake_timeout: Duration::from_millis(500),
        drain_timeout: Duration::from_millis(50),
        max_active_connections: 1,
        ..test_config()
    };
    let factory = CountingFactory::default();
    let owner = DaemonListener::start_with_config(profile.profile.clone(), factory.clone(), config)
        .await
        .expect("start owner");
    let locator = owner.locator().clone();
    let credentials = locator_credentials(&locator);
    let mut request = locator
        .endpoint
        .as_str()
        .into_client_request()
        .expect("session request");
    let proof = credentials
        .apply_to_request(&mut request)
        .expect("session proof");
    let address: SocketAddr = request
        .uri()
        .authority()
        .expect("session authority")
        .as_str()
        .parse()
        .expect("session address");
    let stream = TcpStream::connect(address).await.expect("session connect");
    let (session, response) = tokio_tungstenite::client_async(request, stream)
        .await
        .expect("authenticated occupying session");
    assert!(proof.verify(&response));

    let mut stalled = TcpStream::connect(address)
        .await
        .expect("stalled raw connect");
    stalled.write_all(b"G").await.expect("partial handshake");
    tokio::task::yield_now().await;

    let contender =
        DaemonListener::start_with_config(profile.profile.clone(), factory, config).await;
    assert!(matches!(
        contender,
        Err(DaemonListenerError::AlreadyRunning)
    ));
    assert_eq!(
        read_locator(&profile.profile).expect("owner locator"),
        Some(locator)
    );

    drop(session);
    drop(stalled);
    timeout(Duration::from_millis(500), owner.shutdown())
        .await
        .expect("owner bounded shutdown")
        .expect("owner shutdown");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn liveness_purpose_accepts_only_initialize_before_backend_access() {
    let profile = TempProfile::new("liveness-method");
    let factory = CountingFactory::default();
    let listener =
        DaemonListener::start_with_config(profile.profile.clone(), factory.clone(), test_config())
            .await
            .expect("start listener");
    let locator = listener.locator().clone();
    let credentials = locator_credentials(&locator);
    let mut request = locator
        .endpoint
        .as_str()
        .into_client_request()
        .expect("liveness request");
    let proof = credentials
        .prepare_request(&mut request, ConnectionPurpose::Liveness)
        .expect("liveness proof");
    let address = request
        .uri()
        .authority()
        .expect("liveness authority")
        .as_str();
    let stream = TcpStream::connect(address)
        .await
        .expect("liveness connection");
    let (mut websocket, response) = tokio_tungstenite::client_async(request, stream)
        .await
        .expect("authenticated liveness upgrade");
    assert!(proof.verify(&response));
    websocket
        .send(Message::Text(
            serde_json::json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "get",
                "params": {}
            })
            .to_string()
            .into(),
        ))
        .await
        .expect("send forbidden liveness method");
    let ended = timeout(Duration::from_millis(200), websocket.next())
        .await
        .expect("liveness method rejected");
    if let Some(Ok(message)) = ended {
        assert!(message.is_close());
    }
    assert_eq!(factory.created.load(Ordering::SeqCst), 0);
    assert_eq!(factory.initialized.load(Ordering::SeqCst), 0);
    listener.shutdown().await.expect("shutdown listener");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sessions_and_liveness_inject_the_authenticated_profile_identity() {
    let profile = TempProfile::new("connection-identity");
    let expected_digest = profile.profile.digest().to_owned();
    let factory = CountingFactory::default();
    let listener =
        DaemonListener::start_with_config(profile.profile.clone(), factory.clone(), test_config())
            .await
            .expect("start listener");

    let response = authenticated_initialize(listener.locator()).await;
    assert_eq!(
        response["result"]["protocolVersion"],
        "openengine.cluster/v1"
    );
    let contender = DaemonListener::start_with_config(
        profile.profile.clone(),
        CountingFactory::default(),
        test_config(),
    )
    .await;
    assert!(matches!(
        contender,
        Err(DaemonListenerError::AlreadyRunning)
    ));

    {
        let identities = factory.identities.lock().expect("recorded identities");
        assert_eq!(identities.len(), 2, "session and liveness initialize");
        assert!(identities.iter().all(|(principal, tenant)| {
            principal == &expected_digest && tenant == &expected_digest
        }));
    }
    listener.shutdown().await.expect("shutdown listener");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn authenticated_liveness_burst_owns_only_its_reserved_capacity() {
    let profile = TempProfile::new("liveness-capacity");
    let config = ListenerConfig {
        liveness_timeout: Duration::from_secs(2),
        max_liveness_connections: 2,
        ..test_config()
    };
    let listener = DaemonListener::start_with_config(
        profile.profile.clone(),
        CountingFactory::default(),
        config,
    )
    .await
    .expect("start listener");
    let locator = listener.locator().clone();
    let credentials = locator_credentials(&locator);
    let address: SocketAddr = locator
        .endpoint
        .strip_prefix("ws://")
        .and_then(|endpoint| endpoint.strip_suffix(DAEMON_ROUTE))
        .expect("liveness endpoint")
        .parse()
        .expect("liveness address");

    let mut held = Vec::new();
    for _ in 0..config.max_liveness_connections {
        let mut request = locator
            .endpoint
            .as_str()
            .into_client_request()
            .expect("liveness request");
        let proof = credentials
            .prepare_request(&mut request, ConnectionPurpose::Liveness)
            .expect("liveness proof");
        let stream = TcpStream::connect(address)
            .await
            .expect("liveness connection");
        let (websocket, response) = tokio_tungstenite::client_async(request, stream)
            .await
            .expect("liveness upgrade");
        assert!(proof.verify(&response));
        held.push(websocket);
    }
    timeout(Duration::from_millis(200), async {
        while listener.active_liveness_connections() != config.max_liveness_connections {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("reserved liveness capacity filled");
    let contender = DaemonListener::start_with_config(
        profile.profile.clone(),
        CountingFactory::default(),
        config,
    )
    .await;
    assert!(matches!(
        contender,
        Err(DaemonListenerError::LivenessIndeterminate)
    ));
    assert_eq!(
        read_locator(&profile.profile).expect("preserved liveness owner"),
        Some(locator.clone())
    );

    let mut overflow_request = locator
        .endpoint
        .as_str()
        .into_client_request()
        .expect("overflow request");
    let overflow_proof = credentials
        .prepare_request(&mut overflow_request, ConnectionPurpose::Liveness)
        .expect("overflow proof");
    let overflow_stream = TcpStream::connect(address)
        .await
        .expect("overflow connection");
    let (mut overflow, overflow_response) =
        tokio_tungstenite::client_async(overflow_request, overflow_stream)
            .await
            .expect("authenticated overflow upgrade");
    assert!(overflow_proof.verify(&overflow_response));
    let ended = timeout(Duration::from_millis(200), overflow.next())
        .await
        .expect("overflow liveness rejected");
    if let Some(Ok(message)) = ended {
        assert!(message.is_close());
    }
    assert_eq!(
        listener.active_liveness_connections(),
        config.max_liveness_connections
    );

    drop(overflow);
    drop(held);
    timeout(Duration::from_millis(500), listener.shutdown())
        .await
        .expect("bounded liveness shutdown")
        .expect("liveness shutdown");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn authenticated_liveness_releases_its_permit_at_server_timeout_without_client_drop() {
    let profile = TempProfile::new("authenticated-liveness-timeout");
    let config = ListenerConfig {
        liveness_timeout: Duration::from_millis(30),
        max_liveness_connections: 1,
        ..test_config()
    };
    let listener = DaemonListener::start_with_config(
        profile.profile.clone(),
        CountingFactory::default(),
        config,
    )
    .await
    .expect("start liveness-timeout listener");
    let locator = listener.locator().clone();
    let credentials = locator_credentials(&locator);
    let address: SocketAddr = locator
        .endpoint
        .strip_prefix("ws://")
        .and_then(|endpoint| endpoint.strip_suffix(DAEMON_ROUTE))
        .expect("liveness-timeout endpoint")
        .parse()
        .expect("liveness-timeout address");
    let mut request = locator
        .endpoint
        .as_str()
        .into_client_request()
        .expect("liveness request");
    let proof = credentials
        .prepare_request(&mut request, ConnectionPurpose::Liveness)
        .expect("liveness proof");
    let stream = TcpStream::connect(address)
        .await
        .expect("liveness connection");
    let (websocket, response) = tokio_tungstenite::client_async(request, stream)
        .await
        .expect("authenticated liveness upgrade");
    assert!(proof.verify(&response));
    timeout(Duration::from_millis(200), async {
        while listener.active_liveness_connections() != 1 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("liveness owns permit");

    timeout(Duration::from_millis(500), async {
        while listener.active_liveness_connections() != 0 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("server liveness timeout released permit");
    websocket
        .get_ref()
        .peer_addr()
        .expect("client websocket remains owned after server timeout");

    drop(websocket);
    listener.shutdown().await.expect("shutdown listener");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn liveness_deadline_cancels_pending_initialize_dispatch_without_response_or_leak() {
    let profile = TempProfile::new("liveness-dispatch-timeout");
    let config = ListenerConfig {
        liveness_timeout: Duration::from_millis(300),
        max_liveness_connections: 1,
        ..test_config()
    };
    let factory = PendingInitializeFactory::default();
    let listener =
        DaemonListener::start_with_config(profile.profile.clone(), factory.clone(), config)
            .await
            .expect("start dispatch-timeout listener");
    let locator = listener.locator().clone();
    let credentials = locator_credentials(&locator);
    let address: SocketAddr = locator
        .endpoint
        .strip_prefix("ws://")
        .and_then(|endpoint| endpoint.strip_suffix(DAEMON_ROUTE))
        .expect("dispatch-timeout endpoint")
        .parse()
        .expect("dispatch-timeout address");
    let mut request = locator
        .endpoint
        .as_str()
        .into_client_request()
        .expect("liveness dispatch request");
    let proof = credentials
        .prepare_request(&mut request, ConnectionPurpose::Liveness)
        .expect("liveness dispatch proof");
    let stream = TcpStream::connect(address)
        .await
        .expect("liveness dispatch connection");
    let (mut websocket, response) = tokio_tungstenite::client_async(request, stream)
        .await
        .expect("authenticated liveness dispatch upgrade");
    assert!(proof.verify(&response));
    websocket
        .send(Message::Text(
            serde_json::json!({
                "jsonrpc": "2.0",
                "id": "pending-liveness",
                "method": "initialize",
                "params": {"protocolVersion": "openengine.cluster/v1"}
            })
            .to_string()
            .into(),
        ))
        .await
        .expect("send valid pending initialize");
    timeout(Duration::from_millis(200), async {
        while factory.initialize_started.load(Ordering::SeqCst) != 1
            || listener.active_liveness_connections() != 1
        {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("pending initialize dispatch started under liveness permit");

    timeout(Duration::from_millis(500), async {
        while listener.active_liveness_connections() != 0
            || factory.dropped.load(Ordering::SeqCst) != 1
        {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("absolute liveness deadline cancelled dispatch and released backend");
    assert_eq!(factory.created.load(Ordering::SeqCst), 1);
    assert_eq!(factory.initialize_started.load(Ordering::SeqCst), 1);
    assert_eq!(factory.dropped.load(Ordering::SeqCst), 1);
    assert_eq!(listener.pending_handshakes(), 0);
    assert_eq!(listener.active_sessions(), 0);

    let ended = timeout(Duration::from_millis(200), websocket.next())
        .await
        .expect("timed-out liveness connection terminated");
    if let Some(Ok(message)) = ended {
        assert!(
            !matches!(message, Message::Text(_)),
            "cancelled liveness dispatch emitted a response"
        );
    }

    drop(websocket);
    listener.shutdown().await.expect("shutdown listener");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn liveness_response_requires_exact_json_rpc_correlation_and_shape() {
    let profile = TempProfile::new("liveness-response");
    let credentials =
        DaemonCredentials::generate(profile.profile.digest()).expect("locator credentials");
    let responder = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("stale responder");
    let address = responder.local_addr().expect("responder address");
    let locator = DaemonLocator {
        endpoint: format!("ws://{address}{DAEMON_ROUTE}"),
        cluster_protocol: CLUSTER_PROTOCOL.to_owned(),
        daemon_protocol: DAEMON_PROTOCOL.to_owned(),
        profile_digest: credentials.profile_digest.clone(),
        daemon_nonce: credentials.daemon_nonce.clone(),
        capability: credentials.capability.clone(),
    };
    let initialize_result = serde_json::to_value(InitializeResult::new(
        ServerCapabilities::default(),
        ClusterStatus::empty(),
    ))
    .expect("initialize result");
    let valid = serde_json::json!({
        "jsonrpc": "2.0",
        "id": "daemon-liveness",
        "result": initialize_result.clone()
    });
    let mut wrong_protocol = valid.clone();
    wrong_protocol["result"]["protocolVersion"] = serde_json::json!("other/v1");
    let mut missing_protocol = valid.clone();
    missing_protocol["result"]
        .as_object_mut()
        .expect("result object")
        .remove("protocolVersion");
    let mut missing_capabilities = valid.clone();
    missing_capabilities["result"]
        .as_object_mut()
        .expect("result object")
        .remove("capabilities");
    let mut missing_status = valid.clone();
    missing_status["result"]
        .as_object_mut()
        .expect("result object")
        .remove("status");
    let mut unknown_result_field = valid.clone();
    unknown_result_field["result"]["unexpected"] = serde_json::json!(true);
    let mut unknown_top_level_field = valid.clone();
    unknown_top_level_field["unexpected"] = serde_json::json!(true);
    let mut result_and_error = valid.clone();
    result_and_error["error"] = serde_json::json!({"code": -32603, "message": "stale response"});
    let cases = vec![
        ("valid", valid.to_string(), true),
        (
            "wrong id with correct result",
            serde_json::json!({
                "jsonrpc": "2.0",
                "id": "other-request",
                "result": initialize_result.clone()
            })
            .to_string(),
            false,
        ),
        (
            "missing id",
            serde_json::json!({"jsonrpc": "2.0", "result": initialize_result.clone()}).to_string(),
            false,
        ),
        (
            "numeric id",
            serde_json::json!({
                "jsonrpc": "2.0",
                "id": 1,
                "result": initialize_result.clone()
            })
            .to_string(),
            false,
        ),
        (
            "wrong jsonrpc version",
            serde_json::json!({
                "jsonrpc": "1.0",
                "id": "daemon-liveness",
                "result": initialize_result.clone()
            })
            .to_string(),
            false,
        ),
        (
            "missing jsonrpc version",
            serde_json::json!({
                "id": "daemon-liveness",
                "result": initialize_result.clone()
            })
            .to_string(),
            false,
        ),
        ("top-level array", serde_json::json!([]).to_string(), false),
        (
            "missing result",
            serde_json::json!({"jsonrpc": "2.0", "id": "daemon-liveness"}).to_string(),
            false,
        ),
        (
            "non-object result",
            serde_json::json!({
                "jsonrpc": "2.0",
                "id": "daemon-liveness",
                "result": null
            })
            .to_string(),
            false,
        ),
        ("wrong protocol", wrong_protocol.to_string(), false),
        ("missing protocol", missing_protocol.to_string(), false),
        (
            "missing capabilities",
            missing_capabilities.to_string(),
            false,
        ),
        ("missing status", missing_status.to_string(), false),
        (
            "unknown result field",
            unknown_result_field.to_string(),
            false,
        ),
        (
            "unknown top-level field",
            unknown_top_level_field.to_string(),
            false,
        ),
        ("result and error", result_and_error.to_string(), false),
        (
            "error only",
            serde_json::json!({
                "jsonrpc": "2.0",
                "id": "daemon-liveness",
                "error": {"code": -32603, "message": "backend unavailable"}
            })
            .to_string(),
            false,
        ),
        ("malformed json", "{".to_owned(), false),
    ];
    let responses = cases
        .iter()
        .map(|(_, response, _)| response.clone())
        .collect::<Vec<_>>();
    let responder_task = tokio::spawn(async move {
        for response in responses {
            let (stream, _) = responder.accept().await.expect("probe connection");
            let (callback, receipt) = AuthorizationCallback::new(credentials.clone());
            let mut websocket = accept_hdr_async(stream, callback)
                .await
                .expect("authenticated responder");
            assert_eq!(receipt.take(), Some(ConnectionPurpose::Liveness));
            let request = timeout(Duration::from_millis(200), websocket.next())
                .await
                .expect("bounded initialize request")
                .expect("initialize request")
                .expect("valid initialize frame");
            let Message::Text(request) = request else {
                panic!("liveness request must be text");
            };
            let request: serde_json::Value =
                serde_json::from_str(request.as_ref()).expect("initialize JSON");
            assert_eq!(request["id"], "daemon-liveness");
            websocket
                .send(Message::Text(response.into()))
                .await
                .expect("stale response");
        }
    });

    for (name, _, expected) in &cases {
        let expected = if *name == "error only" {
            LivenessOutcome::Indeterminate
        } else if *expected {
            LivenessOutcome::Alive
        } else {
            LivenessOutcome::DefinitelyStale
        };
        assert_eq!(
            probe_liveness(&locator, Duration::from_millis(250)).await,
            expected,
            "case: {name}"
        );
    }
    timeout(Duration::from_secs(4), responder_task)
        .await
        .expect("bounded responder matrix")
        .expect("responder task");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn open_port_timeout_is_indeterminate_and_preserves_incumbent_locator() {
    let profile = TempProfile::new("initialize-only-liveness");
    let impostor = TcpListener::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0))
        .await
        .expect("impostor listener");
    let impostor_address = impostor.local_addr().expect("impostor address");
    let impostor_task = tokio::spawn(async move {
        if let Ok((socket, _)) = impostor.accept().await {
            tokio::time::sleep(Duration::from_secs(1)).await;
            drop(socket);
        }
    });
    let stale_credentials = DaemonCredentials::generate(profile.profile.digest()).expect("stale");
    let stale = DaemonLocator {
        endpoint: format!("ws://{impostor_address}{DAEMON_ROUTE}"),
        cluster_protocol: CLUSTER_PROTOCOL.to_owned(),
        daemon_protocol: DAEMON_PROTOCOL.to_owned(),
        profile_digest: stale_credentials.profile_digest,
        daemon_nonce: stale_credentials.daemon_nonce,
        capability: stale_credentials.capability,
    };
    replace_locator(&profile.profile, &stale).expect("publish stale locator");

    let contender = DaemonListener::start_with_config(
        profile.profile.clone(),
        CountingFactory::default(),
        test_config(),
    )
    .await;
    assert!(matches!(
        contender,
        Err(DaemonListenerError::LivenessIndeterminate)
    ));
    assert_eq!(
        read_locator(&profile.profile).expect("preserved ambiguous locator"),
        Some(stale)
    );
    impostor_task.abort();
    let _ = impostor_task.await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn shutdown_stops_accepting_drains_bounded_releases_port_and_removes_only_owner_locator() {
    let profile = TempProfile::new("bounded-shutdown");
    let listener = DaemonListener::start_with_config(
        profile.profile.clone(),
        CountingFactory::default(),
        ListenerConfig {
            drain_timeout: Duration::from_secs(2),
            shutdown_timeout: Duration::from_millis(30),
            ..test_config()
        },
    )
    .await
    .expect("start listener");
    let locator = listener.locator().clone();
    let credentials = locator_credentials(&locator);
    let mut request = locator
        .endpoint
        .as_str()
        .into_client_request()
        .expect("request");
    let proof = credentials
        .apply_to_request(&mut request)
        .expect("credentials");
    let address: SocketAddr = request
        .uri()
        .authority()
        .expect("authority")
        .as_str()
        .parse()
        .expect("socket address");
    assert_eq!(
        TcpListener::bind(address)
            .await
            .expect_err("live listener keeps its port")
            .kind(),
        std::io::ErrorKind::AddrInUse
    );
    let stream = TcpStream::connect(address).await.expect("connect");
    let (mut websocket, response) = tokio_tungstenite::client_async(request, stream)
        .await
        .expect("authorized idle connection");
    assert!(proof.verify(&response));

    timeout(Duration::from_millis(500), listener.shutdown())
        .await
        .expect("shutdown obeyed its drain deadline")
        .expect("bounded shutdown");
    assert_eq!(read_locator(&profile.profile).expect("locator state"), None);
    let rebound = TcpListener::bind(address).await.expect("listener released");
    drop(rebound);
    let ended = timeout(Duration::from_millis(200), websocket.next())
        .await
        .expect("idle connection terminated");
    if let Some(Ok(message)) = ended {
        assert!(message.is_close());
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn shutdown_absolute_deadline_bounds_matching_cleanup_lock_and_reports_timeout() {
    let profile = TempProfile::new("shutdown-cleanup-deadline");
    let listener = DaemonListener::start_with_config(
        profile.profile.clone(),
        CountingFactory::default(),
        ListenerConfig {
            shutdown_timeout: Duration::from_millis(60),
            ..test_config()
        },
    )
    .await
    .expect("start listener");
    let locator = listener.locator().clone();
    let cleanup_blocker =
        acquire_start_guard(&profile.profile, Duration::from_millis(100)).expect("hold lock");

    let result = timeout(Duration::from_millis(200), listener.shutdown())
        .await
        .expect("shutdown respected absolute product deadline");
    assert!(matches!(result, Err(DaemonListenerError::ShutdownTimeout)));
    assert_eq!(
        read_locator(&profile.profile).expect("locator preserved while cleanup blocked"),
        Some(locator)
    );

    drop(cleanup_blocker);
    timeout(Duration::from_millis(500), async {
        loop {
            if read_locator(&profile.profile)
                .expect("eventual cleanup state")
                .is_none()
            {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("timed-out cleanup attempt completed after lock release");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn connection_task_panic_releases_listener_and_cleans_locator_before_owner_shutdown() {
    let profile = TempProfile::new("connection-task-panic");
    let listener =
        DaemonListener::start_with_config(profile.profile.clone(), PanicFactory, test_config())
            .await
            .expect("start panic listener");
    let locator = listener.locator().clone();
    let credentials = locator_credentials(&locator);
    let address: SocketAddr = locator
        .endpoint
        .strip_prefix("ws://")
        .and_then(|endpoint| endpoint.strip_suffix(DAEMON_ROUTE))
        .expect("panic endpoint")
        .parse()
        .expect("panic address");
    let mut request = locator
        .endpoint
        .as_str()
        .into_client_request()
        .expect("panic request");
    let proof = credentials
        .apply_to_request(&mut request)
        .expect("panic authorization");
    let stream = TcpStream::connect(address).await.expect("panic connection");
    let (mut websocket, response) = tokio_tungstenite::client_async(request, stream)
        .await
        .expect("authorized panic upgrade");
    assert!(proof.verify(&response));
    let ended = timeout(Duration::from_millis(300), websocket.next())
        .await
        .expect("panicked connection terminated");
    if let Some(Ok(message)) = ended {
        assert!(message.is_close());
    }

    timeout(Duration::from_millis(300), async {
        loop {
            match TcpListener::bind(address).await {
                Ok(rebound) => {
                    drop(rebound);
                    break;
                }
                Err(error) if error.kind() == std::io::ErrorKind::AddrInUse => {
                    tokio::task::yield_now().await;
                }
                Err(error) => panic!("unexpected rebind failure: {error}"),
            }
        }
    })
    .await
    .expect("panicked accept loop released listener");
    timeout(Duration::from_millis(300), async {
        while read_locator(&profile.profile)
            .expect("automatic panic cleanup state")
            .is_some()
        {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("panicked accept loop removed its published locator");

    assert!(matches!(
        listener.shutdown().await,
        Err(DaemonListenerError::Task)
    ));
    assert_eq!(
        read_locator(&profile.profile).expect("panic cleanup state"),
        None
    );
    let rebound = TcpListener::bind(address)
        .await
        .expect("panic listener remains released");
    drop(rebound);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn crash_leaves_stale_locator_that_next_owner_cleans_without_reusing_secrets() {
    let profile = TempProfile::new("crash-handoff");
    let crashed = DaemonListener::start_with_config(
        profile.profile.clone(),
        CountingFactory::default(),
        test_config(),
    )
    .await
    .expect("start crashed listener");
    let stale = crashed.locator().clone();
    let stale_address: SocketAddr = stale
        .endpoint
        .strip_prefix("ws://")
        .and_then(|endpoint| endpoint.strip_suffix(DAEMON_ROUTE))
        .expect("stale endpoint")
        .parse()
        .expect("stale address");
    drop(crashed);
    timeout(Duration::from_millis(200), async {
        while let Ok(stream) = TcpStream::connect(stale_address).await {
            drop(stream);
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("crashed listener released");

    let replacement = DaemonListener::start_with_config(
        profile.profile.clone(),
        CountingFactory::default(),
        test_config(),
    )
    .await
    .expect("clean stale crash locator");
    assert_ne!(replacement.locator().capability, stale.capability);
    assert_ne!(replacement.locator().daemon_nonce, stale.daemon_nonce);
    let response = authenticated_initialize(replacement.locator()).await;
    assert_eq!(
        response["result"]["protocolVersion"],
        "openengine.cluster/v1"
    );
    assert_eq!(
        probe_liveness(&stale, Duration::from_millis(250)).await,
        LivenessOutcome::DefinitelyStale
    );
    assert_eq!(
        read_locator(&profile.profile).expect("replacement locator"),
        Some(replacement.locator().clone())
    );
    replacement.shutdown().await.expect("replacement shutdown");
}
